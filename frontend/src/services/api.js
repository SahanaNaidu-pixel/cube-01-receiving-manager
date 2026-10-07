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
async function request(path, { method = 'GET', json, body, raw = false, messages = {}, fallback = 'Request failed' } = {}) {
  const headers = { 'X-API-Key': getApiKey() };
  if (json !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch {
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
