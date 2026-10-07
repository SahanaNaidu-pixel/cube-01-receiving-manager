export const PO_PRESETS = [
  {
    po_id: 'PO-9001',
    sku: 'BLUE-BOTTLE-001',
    product_name: 'Blue Bottle',
    expected_quantity: 24,
    variant: 'Blue',
    units_per_carton: 12,
    expected_cartons: 2,
    expected_components: ['cap', 'label'],
  },
  {
    po_id: 'PO-9002',
    sku: 'STEEL-TUMBLER-020',
    product_name: 'Steel Tumbler 20oz',
    expected_quantity: 48,
    variant: 'Silver',
    units_per_carton: 12,
    expected_cartons: 4,
    expected_components: ['lid', 'straw'],
  },
  {
    po_id: 'PO-9003',
    sku: 'PROTEIN-KIT-VAN',
    product_name: 'Protein Starter Kit',
    expected_quantity: 30,
    variant: 'Vanilla',
    units_per_carton: 6,
    expected_cartons: 5,
    expected_components: ['scoop', 'seal'],
  },
];

// Keys must match the backend demo scenarios exactly.
export const SCENARIOS = [
  { key: 'correct_shipment', label: 'Clean Shipment', expected: 'PASS' },
  { key: 'short_shipment', label: 'Short Shipment', expected: 'EXCEPTION' },
  { key: 'wrong_variant', label: 'Wrong Variant', expected: 'EXCEPTION' },
  { key: 'damaged_carton', label: 'Crushed Carton', expected: 'EXCEPTION' },
  { key: 'water_damage', label: 'Water Damage', expected: 'EXCEPTION' },
  { key: 'missing_component', label: 'Missing Cap', expected: 'EXCEPTION' },
  { key: 'barcode_glare', label: 'Barcode Glare', expected: 'UNCERTAIN' },
  { key: 'ambiguous', label: 'Ambiguous View', expected: 'UNCERTAIN' },
];

export const PERCEPTION_FAILURE_SCENARIO = 'perception_failure';

// Visible labels + badge tones. The API values (PASS, EXCEPTION, ...) are never changed.
export const DECISION_META = {
  PASS: { label: 'Passed', tone: 'success' },
  EXCEPTION: { label: 'Exception', tone: 'danger' },
  UNCERTAIN: { label: 'Uncertain', tone: 'warning' },
  PENDING_REVIEW: { label: 'Pending · Hold', tone: 'hold' },
  NOT_ANALYZED: { label: 'Not inspected', tone: 'neutral' },
};

export const CHECK_META = {
  PASS: { label: 'Passed', tone: 'success' },
  FAIL: { label: 'Failed', tone: 'danger' },
  UNCERTAIN: { label: 'Uncertain', tone: 'warning' },
  NOT_REQUIRED: { label: 'Not required', tone: 'neutral' },
};

export const decisionMeta = (value) => DECISION_META[value] || { label: String(value || '—').replace(/_/g, ' '), tone: 'neutral' };
export const checkMeta = (value) => CHECK_META[value] || { label: String(value || '—').replace(/_/g, ' '), tone: 'neutral' };

// Receiving exception categories, derived from the backend check names.
const CHECK_CATEGORY = {
  quantity_check: 'Over/Short',
  carton_check: 'Over/Short',
  units_per_carton_check: 'Over/Short',
  damage_check: 'Damaged',
  sku_check: 'Wrong item',
  variant_check: 'Wrong item',
  component_check: 'Missing parts',
};
export const checkCategory = (checkName) => CHECK_CATEGORY[checkName] || '';

// Categories in which the inspection has at least one FAILED check (override-independent agent findings).
export const failedCategories = (inspection) =>
  [...new Set((inspection?.checks || []).filter((check) => check.status === 'FAIL').map((check) => checkCategory(check.check_name)).filter(Boolean))];

// image_type values follow the backend contract enum.
export const CAPTURE_VIEWS = [
  { key: 'pallet', label: 'Pallet Overview', hint: 'Whole shipment / carton count', icon: 'layers' },
  { key: 'carton', label: 'Carton Exterior', hint: 'Damage / crushing', icon: 'box' },
  { key: 'label', label: 'Shipping Label', hint: 'Barcode / SKU match', icon: 'tag' },
  { key: 'unit', label: 'Opened Unit', hint: 'Color / variant view', icon: 'package' },
  { key: 'other', label: 'Kit Components', hint: 'Accessories check', icon: 'grid' },
];

export const viewLabel = (key) => CAPTURE_VIEWS.find((view) => view.key === key)?.label || String(key || '').replace(/_/g, ' ');

export const PO_FIELDS = ['po_id', 'sku', 'product_name', 'variant', 'expected_quantity', 'expected_cartons', 'units_per_carton', 'expected_components'];

// Stable comparison key so a PO edit after creation forces a fresh inspection.
export function poSignature(po) {
  if (!po) return '';
  return JSON.stringify(PO_FIELDS.map((field) => {
    const value = po[field];
    if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
    return value === undefined || value === null ? '' : String(value).trim();
  }));
}

export const isAnalyzed = (inspection) =>
  Boolean(inspection && (inspection.record || (inspection.checks || []).length > 0));

export const effectiveDecision = (inspection) =>
  (isAnalyzed(inspection) ? inspection.override_decision || inspection.final_decision : 'NOT_ANALYZED');

export const formatTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

export const shortHash = (hash) => (hash ? `${String(hash).slice(0, 12)}…` : '—');

// Steps emitted by POST /analyze/stream, in pipeline order.
export const PIPELINE_STEPS = [
  { key: 'validate', label: 'Validate' },
  { key: 'quality', label: 'Photo quality' },
  { key: 'barcode', label: 'Barcode' },
  { key: 'perception', label: 'AI perception' },
  { key: 'rules', label: 'Rules' },
  { key: 'seal', label: 'Seal record' },
];

// Server image-quality issue codes -> operator-facing labels.
const QUALITY_LABELS = {
  too_small: 'Low resolution',
  low_resolution: 'Low resolution',
  too_dark: 'Too dark',
  overexposed: 'Overexposed',
  too_bright: 'Overexposed',
  glare: 'Glare',
  blurry: 'Blurry',
};
export const qualityLabel = (issue) => {
  const text = QUALITY_LABELS[issue] || String(issue || '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
// Unique labels for an image's quality issues (empty when OK or not assessed).
export const qualityIssues = (quality) => [...new Set((quality?.issues || []).map(qualityLabel))];
export const needsRetake = (quality) => Boolean(quality) && (quality.ok === false || qualityIssues(quality).length > 0);

// Client-side pre-check before upload: the long edge should be at least this many pixels.
export const MIN_LONG_EDGE = 640;
