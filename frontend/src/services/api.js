/*
 * Receiving Manager API client — one function per endpoint in docs/API.md and docs/A2A.md.
 *
 * Conventions (see src/README.md):
 *  - Every function returns the parsed JSON body (or a Blob/download result for exports/images).
 *  - Every failure throws an `ApiError` with:
 *      .status     HTTP status (0 = backend unreachable / network failure)
 *      .code       backend error.code (e.g. NOT_FOUND, VALIDATION_ERROR) or NETWORK_ERROR / HTTP_<status>
 *      .requestId  X-Request-ID response header, else error.request_id from the body
 *      .details    backend error.details object ({} when absent)
 *      .message    the backend `detail` string (or a clear fallback)
 *  - List functions take a plain params object; null/undefined/'' values are dropped from the query.
 *  - The API key is read from localStorage on every call (set from the operator panel).
 */

// Production builds without VITE_API_BASE_URL call the same origin (e.g. Vercel, where /api is served by the app).
// Only the dev server falls back to localhost.
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://localhost:8000' : '')).replace(/\/+$/, '');
const KEY_STORAGE = 'receivingApiKey';

/** Human-readable base URL ("same origin" when empty). */
export function getApiBaseUrl() {
  return API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : '');
}

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
    /* storage blocked: the key only lives for this page session */
  }
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', requestId = '', details = {}, path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details || {};
    this.path = path;
  }
}

const DEFAULT_STATUS_MESSAGES = {
  400: 'The request was rejected as invalid.',
  401: 'API key missing or invalid. Set your API key in the operator panel and press Connect.',
  403: 'This API key is not allowed to perform this action.',
  404: 'Not found.',
  409: 'This action conflicts with the current state.',
  413: 'The upload is too large.',
  422: 'Some fields are invalid.',
  500: 'The backend hit an internal error.',
  503: 'The backend is unavailable or not configured.',
};

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

/** Build "?a=1&b=2" from an object, dropping empty values. Arrays become comma-separated. */
export function toQueryString(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      if (value.length) search.set(key, value.join(','));
      return;
    }
    search.set(key, typeof value === 'boolean' ? String(value) : String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

const enc = (value) => encodeURIComponent(String(value));

/**
 * Single request helper.
 *  - json: object sent as application/json
 *  - body: FormData / Blob sent as-is
 *  - query: params object appended to the path
 *  - raw: return the Response instead of parsed JSON
 *  - okStatuses: extra non-2xx statuses whose body should be returned (e.g. /ready 503)
 */
async function request(path, { method = 'GET', json, body, query, raw = false, okStatuses = [], signal, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  const key = auth ? getApiKey() : '';
  if (key) headers['X-API-Key'] = key;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const fullPath = `${path}${query ? toQueryString(query) : ''}`;

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${fullPath}`, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(
      `Backend unreachable at ${getApiBaseUrl()}. Check that the API is running and that VITE_API_BASE_URL / CORS are configured.`,
      { status: 0, code: 'NETWORK_ERROR', path: fullPath },
    );
  }

  const headerRequestId = response.headers.get('X-Request-ID') || '';

  if (!response.ok && !okStatuses.includes(response.status)) {
    let detail = '';
    let error = {};
    try {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text);
        detail = formatDetail(parsed.detail) || parsed.error?.message || '';
        error = parsed.error || {};
      } catch {
        detail = text.slice(0, 300);
      }
    } catch {
      /* body unreadable */
    }
    const message = detail || DEFAULT_STATUS_MESSAGES[response.status] || `Request failed (HTTP ${response.status})`;
    throw new ApiError(message, {
      status: response.status,
      code: error.code || `HTTP_${response.status}`,
      requestId: headerRequestId || error.request_id || '',
      details: error.details || {},
      path: fullPath,
    });
  }

  if (raw) return response;
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('The backend returned a response that is not JSON.', {
      status: response.status, code: 'INVALID_RESPONSE', requestId: headerRequestId, path: fullPath,
    });
  }
}

// ── Health (public) ─────────────────────────────────────────────────────────

/** GET /api/health → {status, service, version, demo_mode} (liveness). */
export const getHealth = (options) => request('/api/health', { auth: false, ...options });
/** Back-compat alias used by the older views. */
export const healthCheck = getHealth;

/** GET /api/ready → {status: HEALTHY|DEGRADED|UNAVAILABLE, checked_at, components[]}. A 503 body is returned, not thrown. */
export const getReady = (options) => request('/api/ready', { auth: false, okStatuses: [503], ...options });

/**
 * Frontend ↔ backend connectivity probe: times GET /api/ready from this browser.
 * Resolves (never throws for HTTP/network problems) to
 * {reachable, latencyMs, httpStatus, requestId, ready (body|null), error (ApiError|null), checkedAt}.
 */
export async function probeBackend() {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  try {
    const response = await request('/api/ready', { auth: false, raw: true, okStatuses: [503] });
    const latencyMs = Math.round(performance.now() - started);
    let ready = null;
    try { ready = await response.json(); } catch { /* not JSON */ }
    return {
      reachable: true,
      latencyMs,
      httpStatus: response.status,
      requestId: response.headers.get('X-Request-ID') || '',
      ready,
      error: null,
      checkedAt,
    };
  } catch (error) {
    return {
      reachable: error?.status > 0,
      latencyMs: Math.round(performance.now() - started),
      httpStatus: error?.status ?? 0,
      requestId: error?.requestId || '',
      ready: null,
      error,
      checkedAt,
    };
  }
}

// ── System ──────────────────────────────────────────────────────────────────

/** GET /api/system/info → agent, versions, environment (no secrets), principal, storage. Also validates the key. */
export const getSystemInfo = (options) => request('/api/system/info', options);

// ── Inspections ─────────────────────────────────────────────────────────────

/**
 * GET /api/inspections. params: q, verdict (PASS|FAIL|UNCERTAIN|NOT_ANALYZED), status, supplier, sku, po,
 * shipment_id, date_from, date_to (YYYY-MM-DD), has_open_issues (bool), sort, order, page, page_size.
 * → {items, count, total, page, page_size}
 */
export const listInspections = (params = {}, options) => request('/api/inspections', { query: params, ...options });

/** POST /api/inspections {po, shipment?, cartons?} → 201 inspection view. */
export const createInspection = (po, { shipment, cartons } = {}) => {
  const json = { po };
  if (shipment) json.shipment = shipment;
  if (cartons && cartons.length) json.cartons = cartons;
  return request('/api/inspections', { method: 'POST', json });
};

/** GET /api/inspections/{id} → view + issues, review_tasks, evidence_files. */
export const getInspection = (id, options) => request(`/api/inspections/${enc(id)}`, options);

/** POST /api/inspections/{id}/images (multipart: files[], image_type). */
export function uploadInspectionImages(id, files, imageType = 'other') {
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  formData.append('image_type', imageType);
  return request(`/api/inspections/${enc(id)}/images`, { method: 'POST', body: formData });
}

/** POST /api/inspections/{id}/run {manual_observations?, scenario?} — the canonical analysis run. */
export function runInspection(id, { manual_observations, scenario } = {}) {
  const json = {};
  if (manual_observations) json.manual_observations = manual_observations;
  if (scenario) json.scenario = scenario;
  return request(`/api/inspections/${enc(id)}/run`, { method: 'POST', json });
}

/** Back-compat: older views call analyzeInspection(id, scenario). Uses the canonical /run route. */
export const analyzeInspection = (id, scenario = '') => runInspection(id, scenario ? { scenario } : {});

/** POST /api/inspections/{id}/review {reason, assigned_to?} → 201 review task (manual). */
export const requestInspectionReview = (id, reason, assignedTo) =>
  request(`/api/inspections/${enc(id)}/review`, {
    method: 'POST',
    json: assignedTo ? { reason, assigned_to: assignedTo } : { reason },
  });

/** POST /api/inspections/{id}/override {decision, reason}. PASS needs an approver key (403 otherwise). */
export const overrideInspection = (id, decision, reason) =>
  request(`/api/inspections/${enc(id)}/override`, { method: 'POST', json: { decision, reason } });

/** POST /api/inspections/{id}/notes {text} → 201 note. */
export const addInspectionNote = (id, text) =>
  request(`/api/inspections/${enc(id)}/notes`, { method: 'POST', json: { text } });

/** POST /api/inspections/{id}/handoff {target_agent} → agent activity entry (delivered | failed | not_configured). */
export const handoffInspection = (id, targetAgent) =>
  request(`/api/inspections/${enc(id)}/handoff`, { method: 'POST', json: { target_agent: targetAgent } });

/** GET /api/inspections/{id}/verify → {integrity_verified, records, problems, …}. */
export const verifyInspection = (id) => request(`/api/inspections/${enc(id)}/verify`);

/** GET /api/inspections/{id}/audit → audit events for this inspection. */
export const getInspectionAudit = (id, params = {}) =>
  request(`/api/inspections/${enc(id)}/audit`, { query: params });

function filenameFromDisposition(header, fallback) {
  if (!header) return fallback;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : fallback;
}

/** Save a Blob to disk via a temporary object URL + <a download>. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Let the browser start the download before the URL is released.
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** GET /api/inspections/{id}/export?format=json|csv|html → {blob, filename, contentType}. */
export async function exportInspection(id, format = 'json') {
  const response = await request(`/api/inspections/${enc(id)}/export`, { query: { format }, raw: true });
  const blob = await response.blob();
  return {
    blob,
    filename: filenameFromDisposition(response.headers.get('Content-Disposition'), `inspection-${id}.${format}`),
    contentType: response.headers.get('Content-Type') || blob.type,
  };
}

/** Fetch the export with the API key and trigger a browser download. Resolves to {filename, size}. */
export async function downloadInspectionExport(id, format = 'json') {
  const { blob, filename } = await exportInspection(id, format);
  saveBlob(blob, filename);
  return { filename, size: blob.size };
}

/** GET /api/inspections/{id}/images/{image_id} → Blob (needs the key, so <img src> cannot load it directly). */
export async function fetchInspectionImageBlob(id, imageId) {
  const response = await request(`/api/inspections/${enc(id)}/images/${enc(imageId)}`, { raw: true });
  return response.blob();
}

/** Same as above but returns an object URL. The caller must URL.revokeObjectURL() it. */
export async function fetchInspectionImageUrl(id, imageId) {
  return URL.createObjectURL(await fetchInspectionImageBlob(id, imageId));
}

// ── Issues (exceptions) ─────────────────────────────────────────────────────

/** GET /api/issues. params: status, severity, issue_type, inspection_id, sku, po, q, date_from, date_to, page, page_size. */
export const listIssues = (params = {}, options) => request('/api/issues', { query: params, ...options });

/** GET /api/issues/{id} → issue + inspection summary + evidence file metadata. */
export const getIssue = (id, options) => request(`/api/issues/${enc(id)}`, options);

/** POST /api/issues/{id}/actions {action: start_review|resolve|reopen|assign, note?, assigned_to?}. 409 on invalid transition. */
export const issueAction = (id, action, { note, assigned_to: assignedTo } = {}) => {
  const json = { action };
  if (note) json.note = note;
  if (assignedTo) json.assigned_to = assignedTo;
  return request(`/api/issues/${enc(id)}/actions`, { method: 'POST', json });
};

/** POST /api/issues/{id}/notes {text} → 201. */
export const addIssueNote = (id, text) => request(`/api/issues/${enc(id)}/notes`, { method: 'POST', json: { text } });

/** POST /api/issues/{id}/evidence {image_id} — link an image of the same inspection. */
export const linkIssueEvidence = (id, imageId) =>
  request(`/api/issues/${enc(id)}/evidence`, { method: 'POST', json: { image_id: imageId } });

// ── Review tasks ────────────────────────────────────────────────────────────

/** GET /api/reviews. params: status (comma-separated ok, e.g. "open,evidence_requested"), q, date_from, date_to, page, page_size. */
export const listReviews = (params = {}, options) => request('/api/reviews', { query: params, ...options });

/** GET /api/reviews/{id} → task + inspection view. */
export const getReview = (id, options) => request(`/api/reviews/${enc(id)}`, options);

/** POST /api/reviews/{id}/decision {decision: PASS|FAIL|UNCERTAIN, note}. PASS needs approver (403). */
export const decideReview = (id, decision, note) =>
  request(`/api/reviews/${enc(id)}/decision`, { method: 'POST', json: { decision, note } });

/** POST /api/reviews/{id}/request-evidence {note} → status evidence_requested. */
export const requestReviewEvidence = (id, note) =>
  request(`/api/reviews/${enc(id)}/request-evidence`, { method: 'POST', json: { note } });

/** POST /api/reviews/{id}/notes {text} → 201. */
export const addReviewNote = (id, text) => request(`/api/reviews/${enc(id)}/notes`, { method: 'POST', json: { text } });

/** POST /api/reviews/{id}/assign {assigned_to}. */
export const assignReview = (id, assignedTo) =>
  request(`/api/reviews/${enc(id)}/assign`, { method: 'POST', json: { assigned_to: assignedTo } });

// ── Evidence ────────────────────────────────────────────────────────────────

/** GET /api/evidence. params: inspection_id, view, analysis_status, q, date_from, date_to, page, page_size. */
export const listEvidence = (params = {}, options) => request('/api/evidence', { query: params, ...options });

/** GET /api/evidence/{image_id}. File bytes: fetchInspectionImageUrl(inspection_id, image_id). */
export const getEvidence = (id, options) => request(`/api/evidence/${enc(id)}`, options);

// ── Products ────────────────────────────────────────────────────────────────

/** GET /api/products. params: q, page, page_size. */
export const listProducts = (params = {}, options) => request('/api/products', { query: params, ...options });
/** POST /api/products → 201 (409 duplicate SKU). */
export const createProduct = (product) => request('/api/products', { method: 'POST', json: product });
/** GET /api/products/{sku} → product + inspections summary list. */
export const getProduct = (sku, options) => request(`/api/products/${enc(sku)}`, options);
/** PUT /api/products/{sku}. */
export const updateProduct = (sku, product) => request(`/api/products/${enc(sku)}`, { method: 'PUT', json: product });

// ── Purchase orders ─────────────────────────────────────────────────────────

/** GET /api/purchase-orders. params: q, status, supplier, page, page_size (as supported). */
export const listPurchaseOrders = (params = {}, options) => request('/api/purchase-orders', { query: params, ...options });
/** POST /api/purchase-orders → 201. */
export const createPurchaseOrder = (po) => request('/api/purchase-orders', { method: 'POST', json: po });
/** GET /api/purchase-orders/{po_number} → PO with lines (received_quantity, discrepancy). */
export const getPurchaseOrder = (poNumber, options) => request(`/api/purchase-orders/${enc(poNumber)}`, options);

// ── Catalogue import ────────────────────────────────────────────────────────

/** POST /api/catalogue/import (multipart `file`, CSV) → {products, purchase_orders, rows}. */
export function importCatalogueFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  return request('/api/catalogue/import', { method: 'POST', body: formData });
}

/** POST /api/catalogue/import {source: "sample"} → imports data/receiving_sample.csv. */
export const importSampleCatalogue = () => request('/api/catalogue/import', { method: 'POST', json: { source: 'sample' } });

// ── Shipments & cartons (derived from inspections) ──────────────────────────

/** GET /api/shipments. params: q, supplier, date_from, date_to, page, page_size (as supported). */
export const listShipments = (params = {}, options) => request('/api/shipments', { query: params, ...options });
/** GET /api/shipments/{shipment_id} → shipment + inspections. */
export const getShipment = (id, options) => request(`/api/shipments/${enc(id)}`, options);

/** GET /api/cartons. params: inspection_id, shipment_id, po, sku, condition, page, page_size. */
export const listCartons = (params = {}, options) => request('/api/cartons', { query: params, ...options });
/** GET /api/cartons/{inspection_id}/{carton_id}. */
export const getCarton = (inspectionId, cartonId, options) =>
  request(`/api/cartons/${enc(inspectionId)}/${enc(cartonId)}`, options);

// ── Dashboard ───────────────────────────────────────────────────────────────

/** GET /api/dashboard?range=today|7d|30d|all|custom&date_from&date_to. */
export const getDashboard = (params = {}, options) => request('/api/dashboard', { query: params, ...options });

// ── Audit ───────────────────────────────────────────────────────────────────

/** GET /api/audit. params: entity_type, entity_id, inspection_id, action, actor, date_from, date_to, page, page_size. */
export const listAudit = (params = {}, options) => request('/api/audit', { query: params, ...options });

// ── Agent / A2A ─────────────────────────────────────────────────────────────

/** GET /api/agent/capabilities → agent card (same body as /.well-known/agent.json). */
export const getAgentCapabilities = (options) => request('/api/agent/capabilities', options);

/** GET /.well-known/agent.json (public discovery). */
export const getAgentCard = (options) => request('/.well-known/agent.json', { auth: false, ...options });

const newId = (prefix) => {
  const random = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`).replace(/-/g, '');
  return `${prefix}-${random.slice(0, 16)}`;
};

/**
 * Build a cube.a2a.v1 request envelope (docs/A2A.md). `sender` defaults to a UI console identity so the
 * activity log shows where the message came from.
 */
export function buildA2AEnvelope(operation, payload = {}, {
  sender = { agent_id: 'receiving_ui_console', version: '1.0.0' },
  recipient = { agent_id: 'receiving_manager' },
  correlationId,
  messageId,
} = {}) {
  return {
    a2a_version: 'cube.a2a.v1',
    message_id: messageId || newId('msg'),
    correlation_id: correlationId || newId('corr'),
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sender,
    recipient,
    operation,
    payload,
  };
}

/**
 * POST /api/agent/receive with a full envelope. Resolves to the response envelope (status completed|failed —
 * protocol failures are HTTP 200 and are NOT thrown; transport/auth failures throw ApiError).
 */
export const sendAgentMessage = (envelope) => request('/api/agent/receive', { method: 'POST', json: envelope });

/** GET /api/agent/activity. params: direction, operation, status, agent, correlation_id, date_from, date_to, page, page_size. */
export const listAgentActivity = (params = {}, options) => request('/api/agent/activity', { query: params, ...options });

/** GET /api/agent/activity/{request_id} → activity item with request/response envelopes. */
export const getAgentActivity = (requestId, options) => request(`/api/agent/activity/${enc(requestId)}`, options);

/** Read a File as base64 (no data: prefix) for A2A `images[].content_base64`. */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;base64,/, ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}
