// Sample PO lines to start from. They are example data (not from any real supplier); edit the manifest or
// type your own PO line before inspecting a real delivery.
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
  { key: 'correct_shipment', label: 'Clean shipment', expected: 'PASS' },
  { key: 'short_shipment', label: 'Short shipment', expected: 'EXCEPTION' },
  { key: 'wrong_variant', label: 'Wrong variant', expected: 'EXCEPTION' },
  { key: 'damaged_carton', label: 'Crushed carton', expected: 'EXCEPTION' },
  { key: 'water_damage', label: 'Water damage', expected: 'EXCEPTION' },
  { key: 'missing_component', label: 'Missing cap', expected: 'EXCEPTION' },
  { key: 'barcode_glare', label: 'Barcode glare', expected: 'UNCERTAIN' },
  { key: 'ambiguous', label: 'Ambiguous view', expected: 'UNCERTAIN' },
  { key: 'perception_failure', label: 'Model outage (fail-open)', expected: 'PENDING_REVIEW' },
];

// Display mapping. The API values (PASS, EXCEPTION, UNCERTAIN, PENDING_REVIEW) are never changed; the UI shows the
// three receiving verdicts PASS / FAIL / UNCERTAIN. EXCEPTION is the backend's FAIL. PENDING_REVIEW means the photos
// were NOT read (perception unavailable), so it is shown as UNCERTAIN with an explicit "not analyzed" qualifier.
// stamp/line = the disposition recorded in the sealed record's outcome.
export const DECISION_META = {
  PASS: { label: 'PASS', verdict: 'PASS', tone: 'pass', stamp: 'Accept', line: 'Released to putaway', qualifier: '' },
  EXCEPTION: { label: 'FAIL', verdict: 'FAIL', tone: 'fail', stamp: 'Reject', line: 'Quarantine and raise a supplier claim', qualifier: 'Exception' },
  UNCERTAIN: { label: 'UNCERTAIN', verdict: 'UNCERTAIN', tone: 'warn', stamp: 'Review', line: 'Held for a person to review', qualifier: '' },
  PENDING_REVIEW: { label: 'UNCERTAIN', verdict: 'UNCERTAIN', tone: 'hold', stamp: 'Hold', line: 'Photos not analyzed; held for review', qualifier: 'Not analyzed' },
  NOT_ANALYZED: { label: 'Not inspected', verdict: 'DRAFT', tone: 'neutral', stamp: '—', line: 'No analysis has run yet', qualifier: '' },
};

// Verdict filter groups used by the dashboard and history.
export const VERDICT_GROUPS = [
  { key: 'PASS', label: 'PASS', tone: 'pass', decisions: ['PASS'] },
  { key: 'FAIL', label: 'FAIL', tone: 'fail', decisions: ['EXCEPTION'] },
  { key: 'UNCERTAIN', label: 'UNCERTAIN', tone: 'warn', decisions: ['UNCERTAIN', 'PENDING_REVIEW'] },
  { key: 'DRAFT', label: 'Not inspected', tone: 'neutral', decisions: ['NOT_ANALYZED'] },
];

export const CHECK_META = {
  PASS: { label: 'Pass', tone: 'pass', icon: 'check' },
  FAIL: { label: 'Fail', tone: 'fail', icon: 'x' },
  UNCERTAIN: { label: 'Unsure', tone: 'warn', icon: 'help' },
  NOT_REQUIRED: { label: 'N/A', tone: 'neutral', icon: 'minus' },
};

export const decisionMeta = (value) => DECISION_META[value] || { label: String(value || '—').replace(/_/g, ' '), tone: 'neutral', stamp: '—', line: '' };
export const checkMeta = (value) => CHECK_META[value] || { label: String(value || '—').replace(/_/g, ' '), tone: 'neutral', icon: 'minus' };

export const CHECKS = [
  { key: 'sku_check', label: 'SKU', short: 'SKU' },
  { key: 'carton_check', label: 'Cartons', short: 'CTN' },
  { key: 'units_per_carton_check', label: 'Units / carton', short: 'U/C' },
  { key: 'quantity_check', label: 'Total units', short: 'QTY' },
  { key: 'variant_check', label: 'Variant', short: 'VAR' },
  { key: 'damage_check', label: 'Condition', short: 'DMG' },
  { key: 'component_check', label: 'Components', short: 'KIT' },
];
export const checkLabel = (name) => CHECKS.find((check) => check.key === name)?.label
  || String(name).replace(/_check$/, '').replace(/_/g, ' ');

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

// What the operator can do about an UNCERTAIN check, keyed by the backend reason code (and check where it matters).
// Purely a lookup on the real reason; nothing is inferred about the photos.
const NEXT_STEP = {
  'NOT_OBSERVED:carton_check': 'Add a pallet photo that shows every carton in one frame.',
  'NOT_OBSERVED:quantity_check': 'Add a pallet photo with every carton, plus a carton label showing units per carton.',
  'NOT_OBSERVED:units_per_carton_check': 'Add a close-up of a carton label that prints the pack quantity.',
  'NOT_OBSERVED:sku_check': 'Add a sharp close-up of the shipping or product label.',
  'NOT_OBSERVED:variant_check': 'Add a photo of an opened unit or the variant line on the label.',
  'NOT_OBSERVED:damage_check': 'Add a photo of the carton exteriors.',
  'NOT_OBSERVED:component_check': 'Add a photo of an opened unit with its parts laid out.',
  OCR_AMBIGUOUS: 'Check the label by eye: the read differs only in look-alike characters.',
  IDENTIFIER_TYPE: 'Only a barcode number was read. Photograph the printed SKU text.',
  VIEWS_DISAGREE: 'Photos disagree. Retake the conflicting view in good light, or decide by eye.',
  READINGS_DISAGREE: 'Direct count and cartons × units disagree. Recount on the dock.',
  UNCORROBORATED_COUNT: 'Add a pallet photo (all cartons) and a label with units per carton to confirm the count.',
  LOW_VISIBILITY: 'A photo was too unclear to judge. Retake it closer, without glare.',
  PARTIAL_MATCH: 'The read only partly matches the PO. Confirm the variant by eye.',
  MINOR_MARKS: 'Only cosmetic marks were seen. Decide whether they matter.',
  UNRECOGNIZED_READING: 'The model used wording the rules do not recognise. Decide by eye.',
  PO_INCONSISTENT: 'Fix the PO line: cartons × units per carton must equal the total.',
  PO_FIELD_MISSING: 'Fill in the missing PO field.',
  PERCEPTION_UNAVAILABLE: 'The photos were not read. Fix the vision setup and re-run.',
};
export const nextStep = (check) => NEXT_STEP[`${check.reason_code}:${check.check_name}`] || NEXT_STEP[check.reason_code] || '';

// image_type values follow the backend contract enum.
export const CAPTURE_VIEWS = [
  { key: 'pallet', label: 'Receiving / pallet', short: 'Pallet', hint: 'Whole delivery with every carton in frame. Needed for carton count and total quantity.', icon: 'layers' },
  { key: 'label', label: 'Shipping label', short: 'Label', hint: 'Close-up of the shipping or product label: SKU and pack quantity.', icon: 'tag' },
  { key: 'carton', label: 'Carton & damage', short: 'Carton', hint: 'Carton exteriors and any packaging damage: crushing, tears, water.', icon: 'box' },
  { key: 'unit', label: 'Product unit', short: 'Unit', hint: 'An opened product unit: colour and variant.', icon: 'package' },
  { key: 'other', label: 'Components / other', short: 'Other', hint: 'Kit components laid out, or any additional supporting evidence.', icon: 'grid' },
];

export const viewLabel = (key) => CAPTURE_VIEWS.find((view) => view.key === key)?.short || String(key || '').replace(/_/g, ' ');
export const viewLongLabel = (key) => CAPTURE_VIEWS.find((view) => view.key === key)?.label || viewLabel(key);

export const PO_FIELDS = ['po_id', 'po_line', 'sku', 'asin', 'unit_id', 'product_name', 'variant', 'expected_quantity', 'expected_cartons', 'units_per_carton', 'expected_components'];

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

export const verdictGroup = (inspection) => {
  const decision = effectiveDecision(inspection);
  return VERDICT_GROUPS.find((group) => group.decisions.includes(decision))?.key || 'DRAFT';
};

// When the shipment's latest verdict was produced: the sealed record's timestamp, else the last update.
export const inspectedAt = (inspection) => inspection?.record?.created_at || inspection?.updated_at || inspection?.created_at;

const QUANTITY_CHECKS = new Set(['quantity_check', 'carton_check', 'units_per_carton_check']);
const MISMATCH_CHECKS = new Set(['damage_check', 'sku_check', 'variant_check', 'component_check']);
export const hasQuantityDiscrepancy = (inspection) => (inspection?.checks || []).some((c) => c.status === 'FAIL' && QUANTITY_CHECKS.has(c.check_name));
export const hasDamageOrMismatch = (inspection) => (inspection?.checks || []).some((c) => c.status === 'FAIL' && MISMATCH_CHECKS.has(c.check_name));

export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

export const formatTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

export const timeAgo = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const s = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return date.toLocaleDateString();
};

export const shortHash = (hash) => (hash ? `${String(hash).slice(0, 12)}…` : '—');

export const fmtValue = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};
