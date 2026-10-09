// Production builds without VITE_API_BASE_URL call the same origin (e.g. Vercel, where /api is served by the app).
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://localhost:8000' : '');
const KEY_STORAGE = 'receivingApiKey';
export const apiBaseUrl = () => API_BASE_URL || window.location.origin;

// In-memory log of this browser session's real API calls (method, path, status, duration). Feeds the
// Agent Activity page; nothing is persisted and nothing is invented.
const REQUEST_LOG_LIMIT = 200;
const requestLog = [];
const logListeners = new Set();
export const getRequestLog = () => requestLog.slice();
export function subscribeRequestLog(listener) {
  logListeners.add(listener);
  return () => logListeners.delete(listener);
}
function logRequest(entry) {
  requestLog.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), ...entry });
  if (requestLog.length > REQUEST_LOG_LIMIT) requestLog.length = REQUEST_LOG_LIMIT;
  logListeners.forEach((listener) => listener());
}

// Each key maps server-side to one organization + operator (and role). It is set from the
// operator panel and kept in localStorage; VITE_RECEIVING_API_KEY is a local-dev fallback only.
// A stored empty string means "signed out", so the dev fallback key does not silently sign the operator back in.
export function getApiKey() {
  try {
    const stored = localStorage.getItem(KEY_STORAGE);
    return stored !== null ? stored : import.meta.env.VITE_RECEIVING_API_KEY || '';
  } catch {
    return import.meta.env.VITE_RECEIVING_API_KEY || '';
  }
}

export function setApiKey(value) {
  try {
    localStorage.setItem(KEY_STORAGE, value || '');
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
async function request(path, { method = 'GET', json, body, raw = false, messages = {}, fallback = 'Request failed' } = {}) {
  const headers = { 'X-API-Key': getApiKey() };
  if (json !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  const started = performance.now();
  const logPath = path.split('?')[0];
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch {
    logRequest({ method, path: logPath, status: 0, ms: Math.round(performance.now() - started), error: 'Network error' });
    throw new ApiError(`Cannot reach the backend at ${apiBaseUrl()}. Is it running?`, 0);
  }
  const ms = Math.round(performance.now() - started);

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
    logRequest({ method, path: logPath, status: response.status, ms, error: message });
    throw new ApiError(message, response.status);
  }

  logRequest({ method, path: logPath, status: response.status, ms });
  return raw ? response : response.json();
}

// probe=true asks the backend to really check the AI key/model with the provider (cached server-side).
export const healthCheck = ({ probe = false, force = false } = {}) => {
  const query = probe ? `?probe=true${force ? '&force=true' : ''}` : '';
  return request(`/api/health${query}`, { fallback: 'Health check failed' });
};

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

// One photo per request: keeps every request far below serverless body limits (Vercel: 4.5 MB) and gives
// real per-file progress. Calls onProgress(done, total, file) after each file is stored and hashed.
export async function uploadPhotosOneByOne(id, items, onProgress) {
  const stored = [];
  for (const [index, item] of items.entries()) {
    const result = await uploadInspectionImages(id, [item.file], item.view);
    stored.push(...(result.images || []));
    onProgress?.(index + 1, items.length, item, result.images?.[0]);
  }
  return stored;
}

export function analyzeInspection(id, scenario = '') {
  const query = scenario ? `?scenario=${encodeURIComponent(scenario)}` : '';
  return request(`/api/inspections/${encodeURIComponent(id)}/analyze${query}`, {
    method: 'POST',
    fallback: 'Analysis failed',
  });
}

// Streams the agent's real pipeline steps (NDJSON) and calls onEvent for each one. Resolves with the final
// result from the `done` event; rejects on an `error` event or a broken stream.
export async function analyzeInspectionStream(id, scenario, onEvent) {
  const query = scenario ? `?scenario=${encodeURIComponent(scenario)}` : '';
  const response = await request(`/api/inspections/${encodeURIComponent(id)}/analyze/stream${query}`, {
    method: 'POST',
    raw: true,
    fallback: 'Analysis failed',
  });
  if (!response.body) throw new ApiError('This browser cannot read streamed responses.', 0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (line) => {
    if (!line.trim()) return undefined;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new ApiError('The analysis stream sent an unreadable line. Check the inspection ledger.', 0);
    }
    onEvent(event);
    if (event.type === 'error') {
      const error = new ApiError(event.message, event.status || 500);
      error.streamed = true; // already shown in the trace by onEvent
      throw error;
    }
    return event.type === 'done' ? event.result : undefined;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = done ? '' : lines.pop(); // at end of stream the last line counts even without a newline
      for (const line of lines) {
        const result = handle(line);
        if (result !== undefined) return result;
      }
      if (done) throw new ApiError('The analysis stream ended without a result. Check the inspection ledger.', 0);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
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
