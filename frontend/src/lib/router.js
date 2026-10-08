/*
 * Hash router.
 *
 *   #/                                  → landing page
 *   #/app/<page>                        → workspace page (e.g. #/app/inspections)
 *   #/app/<page>/<param>[/<param>…]     → detail page (e.g. #/app/inspections/INS-1, #/app/cartons/INS-1/C-01)
 *   #/app/<page>?verdict=FAIL&range=7d  → query-string filters live in the hash
 *
 * API:
 *   useRoute()                 → {area, page, params, id, query, path, hash}  (re-renders on hash change)
 *   navigate(path, query?, {replace?})
 *                              path: '/app/inspections', 'inspections' (shorthand for /app/…) or '/' (landing)
 *   buildHref(path, query?)    → '#/app/inspections?verdict=FAIL' (for <a href>; see components/ui/Link.jsx)
 *   setQuery(patch, {replace?})→ merge into the current route's query; null/'' removes a key
 *   parseHash(hash)            → route object (pure)
 *
 * Old hashes from the first UI are redirected (see ALIASES).
 */
import { useSyncExternalStore } from 'react';

/** Old/alternate page keys → canonical page keys. */
export const ALIASES = {
  scanner: 'new-inspection',
  ledger: 'inspections',
  benchmark: 'help',
  rules: 'help',
  'review-queue': 'reviews',
  issues: 'exceptions',
  health: 'system-health',
  activity: 'agent-activity',
  'a2a-integration': 'a2a',
};

/** Page keys that are also used verbatim for detail routes (never rewritten when they carry an id). */
const DETAIL_KEYS = new Set(['issues']);

const decode = (value) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

function parseQuery(text) {
  const query = {};
  new URLSearchParams(text || '').forEach((value, key) => { query[key] = value; });
  return query;
}

function stringifyQuery(query = {}) {
  const search = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Pure: turn a location hash into a route object. Detail ids are URI-decoded. */
export function parseHash(hash = '') {
  const raw = String(hash).replace(/^#/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decode);
  const query = parseQuery(queryPart);
  if (segments[0] !== 'app') {
    return { area: 'landing', page: 'landing', params: [], id: null, query, path: '/', hash: raw, aliased: false };
  }
  const requested = segments[1] || 'dashboard';
  const page = ALIASES[requested] || requested;
  const params = segments.slice(2);
  // Detail routes keep their own key (#/app/issues/<id>, #/app/reviews/<id>), so only list hashes are aliased.
  const aliased = page !== requested && !(params.length && DETAIL_KEYS.has(requested));
  return {
    area: 'app',
    page,
    params,
    id: params[0] ?? null,
    query,
    path: `/app/${[aliased ? page : requested, ...params.map(encodeURIComponent)].join('/')}`,
    hash: raw,
    aliased,
  };
}

function normalizePath(path) {
  if (!path || path === '/' || path === '#/' || path === '#') return '/';
  let value = String(path).replace(/^#/, '');
  if (!value.startsWith('/')) value = `/app/${value}`;
  return value;
}

/** Build an href for an <a>: buildHref('inspections', {verdict: 'FAIL'}) → '#/app/inspections?verdict=FAIL'. */
export function buildHref(path, query) {
  return `#${normalizePath(path)}${stringifyQuery(query)}`;
}

/** Build a path from segments, encoding each one: pathFor('cartons', insId, cartonId) → '/app/cartons/INS-1/C%2F1'. */
export function pathFor(page, ...params) {
  return `/app/${[page, ...params.filter((p) => p !== undefined && p !== null && p !== '').map((p) => encodeURIComponent(String(p)))].join('/')}`;
}

/** Navigate to a path (+ optional query). replace=true swaps the history entry instead of pushing. */
export function navigate(path, query, { replace = false } = {}) {
  const href = buildHref(path, query);
  if (replace) {
    const url = `${window.location.pathname}${window.location.search}${href}`;
    window.history.replaceState(window.history.state, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (window.location.hash === href) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = href;
  }
}

/** Merge a patch into the current query string. Keys set to null/undefined/'' are removed. */
export function setQuery(patch, { replace = true } = {}) {
  const route = parseHash(window.location.hash);
  const next = { ...route.query, ...patch };
  Object.keys(next).forEach((key) => {
    if (next[key] === undefined || next[key] === null || next[key] === '') delete next[key];
  });
  navigate(route.area === 'landing' ? '/' : route.path, next, { replace });
}

// ── subscription (useSyncExternalStore) ──
let cachedHash = null;
let cachedRoute = null;

function snapshot() {
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseHash(hash);
  }
  return cachedRoute;
}

function subscribe(callback) {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

/** React hook: the current route; re-renders whenever the hash changes. */
export function useRoute() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Rewrite an aliased hash (e.g. #/app/scanner) to its canonical form without adding a history entry. */
export function canonicalizeHash() {
  const route = parseHash(window.location.hash);
  if (route.area === 'app' && route.aliased) navigate(route.path, route.query, { replace: true });
}
