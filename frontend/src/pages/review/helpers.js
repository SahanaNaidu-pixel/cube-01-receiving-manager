/*
 * Small pure helpers for the review / exceptions / evidence / audit pages.
 */
import { pathFor } from '../../lib/router';

/** 'open,in_review' → ['open', 'in_review'] (trimmed, empty dropped). */
export function parseList(value) {
  if (!value) return [];
  return String(value).split(',').map((part) => part.trim()).filter(Boolean);
}

/** ['a','b'] → 'a,b' ('' when empty so setQuery removes the key). */
export const joinList = (list) => (list && list.length ? list.join(',') : '');

/** Machine check verdict → highlight tone. */
export function checkTone(verdict) {
  switch (String(verdict || '').toUpperCase()) {
    case 'FAIL': return 'danger';
    case 'UNCERTAIN': return 'warning';
    case 'PASS': return 'success';
    default: return 'neutral';
  }
}

/** FAIL first, then UNCERTAIN, then the rest (stable). */
export function sortChecks(checks = []) {
  const rank = { FAIL: 0, UNCERTAIN: 1, PASS: 2 };
  return [...checks].map((c, i) => [c, i])
    .sort(([a, ia], [b, ib]) => ((rank[a.verdict] ?? 3) - (rank[b.verdict] ?? 3)) || ia - ib)
    .map(([c]) => c);
}

/** Render an expected/observed state (string | number | list | object | null). */
export function stateText(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Detail route for an audit entity, or null when the entity has no page. */
export function entityPath(entityType, entityId, event = {}) {
  if (!entityId) return null;
  switch (entityType) {
    case 'inspection': return pathFor('inspections', entityId);
    case 'review_task': return pathFor('reviews', entityId);
    case 'issue': return pathFor('issues', entityId);
    case 'product': return pathFor('products', entityId);
    case 'purchase_order': return pathFor('purchase-orders', entityId);
    case 'agent_activity': return event.request_id ? pathFor('agent-activity', event.request_id) : null;
    default: return null;
  }
}

export const ENTITY_LABELS = {
  inspection: 'Inspection',
  review_task: 'Review task',
  issue: 'Issue',
  agent_activity: 'Agent activity',
  product: 'Product',
  purchase_order: 'Purchase order',
  catalogue: 'Catalogue',
};

/** True when an ApiError says the operation was refused for role reasons. */
export const isForbidden = (error) => error?.status === 403;
