/*
 * Enumerations used by the review / exceptions / evidence / audit pages. Values mirror docs/API.md and the
 * backend services (reviews.py, issues.py, audit.py, decision_engine.py). Labels are UI-only.
 */

export const REVIEW_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'evidence_requested', label: 'Evidence requested' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

/** Queue tabs. `status` is what goes into the hash query (and to the API); 'all' sends no status filter. */
export const REVIEW_TABS = [
  { key: 'active', label: 'Needs action', status: 'open,evidence_requested' },
  { key: 'open', label: 'Open', status: 'open' },
  { key: 'evidence_requested', label: 'Evidence requested', status: 'evidence_requested' },
  { key: 'completed', label: 'Completed', status: 'completed' },
  { key: 'cancelled', label: 'Cancelled', status: 'cancelled' },
  { key: 'all', label: 'All', status: 'all' },
];

export const REVIEW_TRIGGERS = {
  uncertain: 'Uncertain checks',
  perception_unavailable: 'Vision unavailable',
  manual: 'Manual request',
};

export const ISSUE_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'in_review', label: 'In review' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'superseded', label: 'Superseded' },
];

export const ISSUE_SEVERITIES = [
  { value: 'high', label: 'High (FAIL)' },
  { value: 'medium', label: 'Medium (UNCERTAIN)' },
  { value: 'low', label: 'Low' },
];

/** Reason codes the decision engine emits for FAIL / UNCERTAIN checks (issue_type = reason_code). */
export const ISSUE_TYPES = [
  'SKU_MISMATCH',
  'COUNT_MISMATCH',
  'VARIANT_MISMATCH',
  'DAMAGE_VISIBLE',
  'DAMAGE_REVIEW_REQUIRED',
  'COMPONENT_MISSING',
  'CARTON_CONDITION_REPORTED',
  'LOW_VISIBILITY',
  'NOT_OBSERVED',
  'VIEWS_DISAGREE',
  'READINGS_DISAGREE',
  'INVALID_READING',
  'PERCEPTION_UNAVAILABLE',
  'PO_FIELD_MISSING',
  'PO_INCONSISTENT',
  'UNSPECIFIED',
];

/** Allowed issue transitions (backend services/issues.py TRANSITIONS). */
export const ISSUE_TRANSITIONS = {
  start_review: ['open'],
  resolve: ['open', 'in_review'],
  reopen: ['resolved'],
  assign: ['open', 'in_review', 'resolved'],
};

export const EVIDENCE_VIEWS = [
  { value: 'pallet', label: 'Pallet' },
  { value: 'carton', label: 'Carton' },
  { value: 'unit', label: 'Unit' },
  { value: 'label', label: 'Label' },
  { value: 'other', label: 'Other' },
];

export const ANALYSIS_STATUSES = [
  { value: 'analyzed', label: 'Analyzed' },
  { value: 'not_analyzed', label: 'Not analyzed' },
  { value: 'perception_unavailable', label: 'Vision unavailable' },
];

export const VISION_UNAVAILABLE_MESSAGE = 'Vision analysis unavailable — manual review required.';

export const AUDIT_ENTITY_TYPES = [
  { value: 'inspection', label: 'Inspection' },
  { value: 'review_task', label: 'Review task' },
  { value: 'issue', label: 'Issue' },
  { value: 'agent_activity', label: 'Agent activity' },
  { value: 'product', label: 'Product' },
  { value: 'purchase_order', label: 'Purchase order' },
  { value: 'catalogue', label: 'Catalogue' },
];

export const AUDIT_ACTIONS = [
  'inspection.created',
  'evidence.uploaded',
  'inspection.run',
  'inspection.overridden',
  'issue.created',
  'issue.superseded',
  'issue.review_started',
  'issue.resolved',
  'issue.reopened',
  'issue.assigned',
  'issue.evidence_linked',
  'review.created',
  'review.updated',
  'review.assigned',
  'review.evidence_requested',
  'review.decided',
  'review.cancelled',
  'note.added',
  'a2a.received',
  'a2a.handoff',
  'product.created',
  'product.updated',
  'purchase_order.created',
  'catalogue.imported',
];
