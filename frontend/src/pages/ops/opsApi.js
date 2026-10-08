/*
 * Local API helpers for the Orders & Stock / Integration pages (src/pages/ops/).
 * They complement services/api.js where a page needs more than the parsed body:
 *
 *   postEnvelopeTimed(envelope) → POST /api/agent/receive and capture HTTP status, latency, X-Request-ID,
 *                                 X-Correlation-ID and X-Idempotent-Replay alongside the response envelope.
 *                                 Never throws: transport/auth failures resolve with { error: ApiError }.
 *   getJsonTimed(path, {auth})  → GET with the same capture (used for agent-card discovery steps).
 *   buildCurl(envelope)         → copy-pasteable curl, API key replaced by $RECEIVING_API_KEY.
 *   newA2AId(prefix)            → msg-/corr- ids in the format buildA2AEnvelope uses.
 *   stripImages(envelope)       → copy with images[].content_base64 replaced by a size marker (for display).
 */
import { API_BASE_URL, ApiError, getApiBaseUrl, getApiKey } from '../../services/api';

export const A2A_ENDPOINT = '/api/agent/receive';

export function newA2AId(prefix) {
  const random = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`).replace(/-/g, '');
  return `${prefix}-${random.slice(0, 16)}`;
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { text: text.slice(0, 2000) }; }
}

function errorFrom(response, body, path) {
  const detail = typeof body?.detail === 'string' ? body.detail : (body?.error?.message || body?.text || '');
  return new ApiError(detail || `Request failed (HTTP ${response.status})`, {
    status: response.status,
    code: body?.error?.code || `HTTP_${response.status}`,
    requestId: response.headers.get('X-Request-ID') || body?.error?.request_id || '',
    details: body?.error?.details || {},
    path,
  });
}

async function timedFetch(path, init, { auth = true } = {}) {
  const headers = { Accept: 'application/json', ...(init.headers || {}) };
  const key = auth ? getApiKey() : '';
  if (key) headers['X-API-Key'] = key;
  const started = performance.now();
  const sentAt = new Date().toISOString();
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  } catch {
    return {
      ok: false,
      httpStatus: 0,
      latencyMs: Math.round(performance.now() - started),
      sentAt,
      requestId: '',
      correlationId: '',
      replayed: false,
      body: null,
      error: new ApiError(`Backend unreachable at ${getApiBaseUrl()}. Check that the API is running and CORS allows this origin.`, { status: 0, code: 'NETWORK_ERROR', path }),
    };
  }
  const body = await readBody(response);
  const latencyMs = Math.round(performance.now() - started);
  return {
    ok: response.ok,
    httpStatus: response.status,
    latencyMs,
    sentAt,
    requestId: response.headers.get('X-Request-ID') || body?.request_id || '',
    correlationId: response.headers.get('X-Correlation-ID') || body?.correlation_id || '',
    replayed: response.headers.get('X-Idempotent-Replay') === 'true',
    body,
    error: response.ok ? null : errorFrom(response, body, path),
  };
}

/** POST a cube.a2a.v1 envelope. Resolves to {ok, httpStatus, latencyMs, requestId, correlationId, replayed, body, error}. */
export function postEnvelopeTimed(envelope) {
  return timedFetch(A2A_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

/** GET a JSON path with timing (auth=false for public discovery). */
export function getJsonTimed(path, { auth = true } = {}) {
  return timedFetch(path, { method: 'GET' }, { auth });
}

/** Display copy of an envelope without image bytes. */
export function stripImages(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const images = envelope.payload?.images;
  if (!Array.isArray(images)) return envelope;
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      images: images.map((image) => (typeof image?.content_base64 === 'string' && !image.content_base64.startsWith('<')
        ? { ...image, content_base64: `<${image.content_base64.length.toLocaleString()} base64 chars>` }
        : image)),
    },
  };
}

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
export const CURL_INLINE_LIMIT = 200 * 1024;

/**
 * curl for an envelope. Large bodies (images) are referenced as @envelope.json so the command stays usable;
 * the caller offers the envelope as a download in that case.
 */
export function buildCurl(envelope) {
  const body = JSON.stringify(envelope);
  const url = `${getApiBaseUrl()}${A2A_ENDPOINT}`;
  const inline = body.length <= CURL_INLINE_LIMIT;
  const lines = [
    `curl -sS -X POST ${shellQuote(url)}`,
    '  -H "X-API-Key: $RECEIVING_API_KEY"',
    "  -H 'Content-Type: application/json'",
    inline ? `  --data-binary ${shellQuote(body)}` : '  --data-binary @envelope.json',
  ];
  return { command: lines.join(' \\\n'), inline, bytes: body.length };
}

export async function copyText(text) {
  await navigator.clipboard.writeText(text);
}
