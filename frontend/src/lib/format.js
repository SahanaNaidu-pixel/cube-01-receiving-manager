/*
 * Formatters and small pure helpers shared by every page.
 *
 *   formatDateTime(v) / formatDate(v) / formatRelative(v)   '—' for empty/invalid
 *   formatBytes(n)  formatNumber(n)  formatPercent(ratio)  formatLatency(ms)
 *   toUiVerdict(v)  → 'PASS' | 'FAIL' | 'UNCERTAIN' | 'NOT_ANALYZED'
 *        PASS→PASS, EXCEPTION/FAIL→FAIL, UNCERTAIN/PENDING_REVIEW→UNCERTAIN, null/''/NOT_ANALYZED→NOT_ANALYZED
 *   verdictOf(inspection) → UI verdict of an inspection view (uses `verdict`, falls back to decisions)
 *   humanize('open_issues') → 'Open issues'
 *   RANGE_OPTIONS, rangeToDates(range, {date_from, date_to}) → {date_from, date_to} (YYYY-MM-DD, UTC)
 *   listParamsFromQuery(query, keys) → API params from hash query (range → dates, page/page_size kept)
 */

const EMPTY = '—';

const toDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export function formatDateTime(value) {
  const date = toDate(value);
  return date ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : (value ? String(value) : EMPTY);
}

export function formatDate(value) {
  // Plain YYYY-MM-DD strings are calendar dates: format them without a timezone shift.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: 'medium' });
  }
  const date = toDate(value);
  return date ? date.toLocaleDateString(undefined, { dateStyle: 'medium' }) : (value ? String(value) : EMPTY);
}

/** "3 min ago", "in 2 h", falls back to the date for anything older than 7 days. */
export function formatRelative(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return EMPTY;
  const diff = (date.getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs > 7 * 86400) return formatDate(date);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return EMPTY;
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return EMPTY;
  return Number(value).toLocaleString();
}

/** formatPercent(0.873) → '87%'. */
export function formatPercent(ratio, digits = 0) {
  if (ratio === null || ratio === undefined || Number.isNaN(Number(ratio))) return EMPTY;
  return `${(Number(ratio) * 100).toFixed(digits)}%`;
}

export function formatLatency(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return EMPTY;
  return Number(ms) >= 1000 ? `${(Number(ms) / 1000).toFixed(2)} s` : `${Math.round(Number(ms))} ms`;
}

/** 'open_issues' → 'Open issues'; 'PENDING_REVIEW' → 'Pending review'. */
export function humanize(value) {
  if (value === null || value === undefined || value === '') return EMPTY;
  const text = String(value).replace(/[_.-]+/g, ' ').trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function truncate(value, max = 60) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Map any stored/contract/UI verdict onto the four UI verdicts. */
export function toUiVerdict(value) {
  switch (String(value || '').toUpperCase()) {
    case 'PASS':
    case 'ACCEPT':
      return 'PASS';
    case 'FAIL':
    case 'EXCEPTION':
    case 'REJECT':
      return 'FAIL';
    case 'UNCERTAIN':
    case 'PENDING_REVIEW':
      return 'UNCERTAIN';
    default:
      return 'NOT_ANALYZED';
  }
}

export const VERDICT_LABELS = {
  PASS: 'Pass',
  FAIL: 'Fail',
  UNCERTAIN: 'Uncertain',
  NOT_ANALYZED: 'Not analyzed',
};

export const verdictLabel = (value) => VERDICT_LABELS[toUiVerdict(value)];

/** UI verdict of an inspection view: prefers the backend `verdict`, else the override/final decision. */
export function verdictOf(inspection) {
  if (!inspection) return 'NOT_ANALYZED';
  if (inspection.verdict !== undefined) return toUiVerdict(inspection.verdict);
  return toUiVerdict(inspection.override_decision || inspection.final_decision);
}

// ── date ranges ──

export const RANGE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

/** Date → 'YYYY-MM-DD' in UTC (the API filters on UTC calendar days). */
export const isoDay = (date) => date.toISOString().slice(0, 10);

/**
 * Convert a range preset into inclusive UTC day bounds for list endpoints.
 * 'custom' passes the given dates through; 'all'/unknown returns {} (no filter).
 */
export function rangeToDates(range, custom = {}) {
  const today = new Date();
  const daysAgo = (n) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - n);
    return isoDay(d);
  };
  switch (range) {
    case 'today': return { date_from: daysAgo(0), date_to: daysAgo(0) };
    case '7d': return { date_from: daysAgo(6), date_to: daysAgo(0) };
    case '30d': return { date_from: daysAgo(29), date_to: daysAgo(0) };
    case 'custom': return { date_from: custom.date_from || undefined, date_to: custom.date_to || undefined };
    default: return {};
  }
}

/**
 * Build API list params from the hash query. `keys` = filter names the endpoint accepts.
 * A `range` preset becomes date_from/date_to (explicit date_from/date_to in the query win).
 * page/page_size are converted to numbers.
 *
 *   listParamsFromQuery({verdict: 'FAIL', range: '7d', page: '2'}, ['verdict', 'q'])
 *   → {verdict: 'FAIL', date_from: '…', date_to: '…', page: 2, page_size: 25}
 */
export function listParamsFromQuery(query = {}, keys = [], { pageSize = 25 } = {}) {
  const params = {};
  keys.forEach((key) => { if (query[key] !== undefined && query[key] !== '') params[key] = query[key]; });
  const dates = query.range ? rangeToDates(query.range, query) : {};
  const from = query.date_from || dates.date_from;
  const to = query.date_to || dates.date_to;
  if (from) params.date_from = from;
  if (to) params.date_to = to;
  params.page = Math.max(1, Number(query.page) || 1);
  params.page_size = Math.min(200, Math.max(1, Number(query.page_size) || pageSize));
  return params;
}
