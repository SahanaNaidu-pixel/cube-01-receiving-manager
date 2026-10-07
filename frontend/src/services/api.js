const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
const KEY_STORAGE = 'receivingApiKey';

// Each key maps server-side to one organization + operator (and role). It is set from the
// operator panel and kept in localStorage; VITE_RECEIVING_API_KEY is a local-dev fallback only.
export function getApiKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || import.meta.env.VITE_RECEIVING_API_KEY || '';
  } catch {
    return import.meta.env.VITE_RECEIVING_API_KEY || '';
  }
}

export function setApiKey(value) {
  try {
    if (value) localStorage.setItem(KEY_STORAGE, value);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage blocked: the key only lives for this request cycle */
  }
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function formatDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === 'string') return item;
        const field = (item.loc || []).filter((part) => part !== 'body').join('.');
        return field ? `${field}: ${item.msg}` : item.msg;
      })
      .join('; ');
  }
  return JSON.stringify(detail);
}

const DEFAULT_STATUS_MESSAGES = {
  401: 'API key missing or invalid. Set your API key in the operator panel and press Connect.',
  503: 'Backend unavailable or not configured (503).',
};

// Single request helper: adds the key, parses JSON errors {detail} into readable text,
// and lets callers supply friendlier messages per status code.
async function request(path, { method = 'GET', json, body, raw = false, messages = {}, fallback = 'Request failed', signal, headers: extra = {} } = {}) {
  const headers = { 'X-API-Key': getApiKey(), ...extra };
  if (json !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(`Cannot reach the backend at ${API_BASE_URL}. Is it running?`, 0);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      try {
        detail = formatDetail(JSON.parse(text).detail);
      } catch {
        detail = text.slice(0, 300);
      }
    } catch {
      /* body unreadable */
    }
    const friendly = messages[response.status] || DEFAULT_STATUS_MESSAGES[response.status];
    const message = friendly
      ? (detail && detail !== friendly ? `${friendly} (${detail})` : friendly)
      : detail || `${fallback} (HTTP ${response.status})`;
    throw new ApiError(message, response.status);
  }

  return raw ? response : response.json();
}

export const healthCheck = () => request('/api/health', { fallback: 'Health check failed' });
export const getHealth = healthCheck;

export const listInspections = () => request('/api/inspections', { fallback: 'Could not load inspections' });

export const createInspection = (po) =>
  request('/api/inspections', { method: 'POST', json: { po }, fallback: 'Failed to create inspection' });

export const getInspection = (id) =>
  request(`/api/inspections/${encodeURIComponent(id)}`, {
    messages: { 404: 'Inspection not found' },
    fallback: 'Could not load inspection',
  });

export function uploadInspectionImages(id, files, imageType = 'receiving_photo') {
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  formData.append('image_type', imageType);
  return request(`/api/inspections/${encodeURIComponent(id)}/images`, {
    method: 'POST',
    body: formData,
    fallback: 'Failed to upload images',
  });
}

export function analyzeInspection(id, scenario = '') {
  const query = scenario ? `?scenario=${encodeURIComponent(scenario)}` : '';
  return request(`/api/inspections/${encodeURIComponent(id)}/analyze${query}`, {
    method: 'POST',
    fallback: 'Analysis failed',
  });
}

// Parses one SSE block ("event:" / multiple "data:" lines) into { event, data }.
function parseSseBlock(block) {
  let event = 'message';
  const data = [];
  block.split('\n').forEach((line) => {
    if (!line || line.startsWith(':')) return;
    const index = line.indexOf(':');
    const field = index < 0 ? line : line.slice(0, index);
    let value = index < 0 ? '' : line.slice(index + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  });
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) };
  } catch {
    return { event, data: data.join('\n') };
  }
}

// POST /analyze/stream (SSE over fetch, since EventSource cannot send headers or POST).
// onStep receives each {step, status, message, data}; resolves with the same object POST /analyze returns.
// Falls back to the plain POST /analyze when the backend has no stream endpoint (404/405).
export async function analyzeInspectionStream(id, scenario = '', onStep, { signal } = {}) {
  const query = scenario ? `?scenario=${encodeURIComponent(scenario)}` : '';
  let response;
  try {
    response = await request(`/api/inspections/${encodeURIComponent(id)}/analyze/stream${query}`, {
      method: 'POST',
      raw: true,
      signal,
      headers: { Accept: 'text/event-stream' },
      fallback: 'Analysis failed',
    });
  } catch (error) {
    if (error.status === 404 || error.status === 405) return analyzeInspection(id, scenario);
    throw error;
  }
  if ((response.headers.get('content-type') || '').includes('application/json')) return response.json();

  let result = null;
  let lastError = '';
  const handle = (block) => {
    const parsed = parseSseBlock(block);
    if (!parsed) return;
    const { event, data } = parsed;
    if (event === 'step' && data && typeof data === 'object') {
      if (data.status === 'error') lastError = data.message || lastError;
      onStep?.(data);
    } else if (event === 'result') {
      result = data;
    } else if (event === 'error') {
      const detail = typeof data === 'object' ? formatDetail(data.detail) || data.message : data;
      throw new ApiError(detail || 'Analysis failed', data?.status || 500);
    }
  };

  if (!response.body?.getReader) {
    (await response.text()).replace(/\r\n?/g, '\n').split('\n\n').forEach(handle);
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        // Normalize CRLF / CR; a trailing CR waits for the next chunk in case it is half of a CRLF.
        buffer = done
          ? (buffer + decoder.decode()).replace(/\r\n?/g, '\n')
          : (buffer + decoder.decode(value, { stream: true })).replace(/\r\n|\r(?!$)/g, '\n');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          handle(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
        }
        if (done) break;
      }
      if (buffer.trim()) handle(buffer);
    } catch (error) {
      reader.cancel().catch(() => {});
      throw error;
    }
  }

  if (!result) {
    throw new ApiError(`The analysis stream ended without a result${lastError ? ` (${lastError})` : ''}. Reload the inspection to see whether it was recorded.`, 0);
  }
  return result;
}

export const overrideInspection = (id, decision, reason) =>
  request(`/api/inspections/${encodeURIComponent(id)}/override`, {
    method: 'POST',
    json: { decision, reason },
    messages: {
      403: decision === 'PASS' ? 'PASS override requires an approver key' : 'This API key is not allowed to override',
      409: 'Analyze before overriding',
    },
    fallback: 'Override failed',
  });

export const verifyInspection = (id) =>
  request(`/api/inspections/${encodeURIComponent(id)}/verify`, { fallback: 'Integrity check failed' });

// <img src> cannot send headers, so fetch the image with the key and hand back an object URL.
export async function fetchInspectionImageUrl(id, imageId) {
  const response = await request(
    `/api/inspections/${encodeURIComponent(id)}/images/${encodeURIComponent(imageId)}`,
    { raw: true, fallback: 'Image not available' },
  );
  return URL.createObjectURL(await response.blob());
}
