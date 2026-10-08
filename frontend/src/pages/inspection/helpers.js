/*
 * Pure helpers shared by the inspection pages (wizard, detail, history).
 * Nothing here invents data: every value is derived from an API response.
 */
import { CAPTURE_VIEWS as LEGACY_CAPTURE_VIEWS, SCENARIOS, PERCEPTION_FAILURE_SCENARIO } from '../../constants';
import { toUiVerdict } from '../../lib/format';

/** Exact text required whenever no vision provider can analyse the photos. */
export const VISION_UNAVAILABLE_MESSAGE = 'Vision analysis unavailable — manual review required.';

/** Capture views = the backend contract enum pallet|carton|unit|label|other (labels from the first UI). */
export const CAPTURE_VIEWS = [
  { key: 'pallet', label: 'Pallet', hint: 'Whole shipment / carton count', icon: 'layers' },
  { key: 'carton', label: 'Carton', hint: 'Carton exterior, seal, damage', icon: 'box' },
  { key: 'unit', label: 'Unit', hint: 'Opened unit: variant, components', icon: 'package' },
  { key: 'label', label: 'Label', hint: 'Shipping label / barcode / SKU', icon: 'tag' },
  { key: 'other', label: 'Other', hint: 'Kit components, paperwork, anything else', icon: 'grid' },
];
export const viewLabel = (key) => CAPTURE_VIEWS.find((v) => v.key === key)?.label
  || LEGACY_CAPTURE_VIEWS.find((v) => v.key === key)?.label
  || String(key || 'other').replace(/_/g, ' ');

/** Demo scenarios the backend demo provider knows (only offered when the backend reports demo_mode). */
export const DEMO_SCENARIOS = [
  ...SCENARIOS,
  { key: PERCEPTION_FAILURE_SCENARIO, label: 'Perception failure drill', expected: 'PENDING_REVIEW' },
];

export const SEAL_CONDITIONS = ['unknown', 'intact', 'broken', 'resealed'];
export const VISIBLE_CONDITIONS = ['unknown', 'good', 'crushed', 'torn', 'punctured', 'wet', 'open', 'label_damaged'];

export const HANDOFF_TARGETS = [
  { value: 'prep_manager', label: 'Prep Manager (02)' },
  { value: 'recovery_manager', label: 'Recovery Manager (05)' },
  { value: 'returns_manager', label: 'Returns Manager' },
  { value: 'pack_manager', label: 'Pack Manager' },
];

/** check_name → human label + record check_key (mirrors backend CHECK_KEYS). */
export const CHECK_INFO = {
  sku_check: { key: 'identity', label: 'Product identity (SKU)' },
  carton_check: { key: 'carton_count', label: 'Carton count' },
  units_per_carton_check: { key: 'units_per_carton', label: 'Units per carton' },
  quantity_check: { key: 'total_quantity', label: 'Total quantity' },
  variant_check: { key: 'variant', label: 'Variant' },
  damage_check: { key: 'carton_damage', label: 'Damage' },
  component_check: { key: 'components', label: 'Components' },
  carton_condition_check: { key: 'carton_condition', label: 'Carton condition (intake)' },
};
const KEY_TO_NAME = Object.fromEntries(Object.entries(CHECK_INFO).map(([name, info]) => [info.key, name]));

export const checkLabel = (nameOrKey) => {
  const name = CHECK_INFO[nameOrKey] ? nameOrKey : KEY_TO_NAME[nameOrKey];
  if (name) return CHECK_INFO[name].label;
  return String(nameOrKey || 'Check').replace(/_check$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
};

/**
 * Merge the inspection's engine checks (confidence, evidence_ids) with the sealed record's checks (check_key,
 * image_ids, model_version). Returns [] for an inspection that has not been run.
 */
export function mergedChecks(inspection) {
  if (!inspection) return [];
  const recordChecks = inspection.record?.checks || [];
  const byName = Object.fromEntries(recordChecks.map((c) => [c.check_name, c]));
  const engine = inspection.checks || [];
  if (!engine.length) {
    return recordChecks.map((c) => ({
      check_name: c.check_name, check_key: c.check_key, status: c.verdict, expected_value: c.expected_state,
      observed_value: c.observed_state, reason_code: c.reason_code, reason: c.reason, confidence: null,
      evidence_ids: c.evidence_ids || [], image_ids: c.image_ids || [], model_version: c.model_version,
      measurements: c.measurements || {},
    }));
  }
  return engine.map((c) => {
    const rec = byName[c.check_name] || {};
    return {
      ...c,
      check_key: rec.check_key || CHECK_INFO[c.check_name]?.key || c.check_name,
      image_ids: rec.image_ids || [],
      model_version: rec.model_version || null,
    };
  });
}

/** Display any expected/observed value ('—' when absent). */
export function displayValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Confidence summary across decided checks (NOT_REQUIRED excluded). Null when nothing to summarise. */
export function confidenceSummary(checks) {
  const decided = checks.filter((c) => c.status !== 'NOT_REQUIRED' && typeof c.confidence === 'number');
  if (!decided.length) return null;
  const values = decided.map((c) => c.confidence);
  return {
    min: Math.min(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    count: decided.length,
  };
}

export function countByStatus(checks) {
  const counts = { PASS: 0, FAIL: 0, UNCERTAIN: 0, NOT_REQUIRED: 0 };
  checks.forEach((c) => { counts[c.status] = (counts[c.status] || 0) + 1; });
  return counts;
}

/**
 * Recommended next action for a check, derived only from its verdict + check type + reason code.
 * Guidance for the operator — never presented as a finding.
 */
export function recommendedAction(check) {
  const name = check.check_name;
  const code = String(check.reason_code || '');
  if (check.status === 'PASS') return 'No action — matches the PO.';
  if (check.status === 'NOT_REQUIRED') return 'No action — not required for this PO line.';
  if (check.status === 'UNCERTAIN') {
    if (code === 'PERCEPTION_UNAVAILABLE') return 'Count manually (operator counts) or send to human review.';
    if (code === 'VIEWS_DISAGREE') return 'Recount — operator and photo readings disagree; send to review if unresolved.';
    if (code === 'DAMAGE_REVIEW_REQUIRED') return 'Inspect the damage and decide in the review queue.';
    if (code.startsWith('PO_')) return 'Correct the PO line data, then re-run.';
    return 'Capture clearer evidence or send to review.';
  }
  // FAIL
  switch (name) {
    case 'quantity_check':
    case 'units_per_carton_check':
      return 'Count again / raise shortage or overage with the supplier.';
    case 'carton_check':
      return 'Recount cartons against the ASN / raise a carton discrepancy with the carrier or supplier.';
    case 'sku_check':
      return 'Quarantine — wrong item received; contact the supplier.';
    case 'variant_check':
      return 'Quarantine — wrong variant; raise a substitution claim with the supplier.';
    case 'damage_check':
    case 'carton_condition_check':
      return 'Photograph the damage, quarantine affected cartons, file a carrier/supplier damage claim.';
    case 'component_check':
      return 'Hold — missing components; request replacements from the supplier.';
    default:
      return 'Hold the shipment and resolve the exception before putaway.';
  }
}

export function overallRecommendation(uiVerdict) {
  switch (uiVerdict) {
    case 'PASS': return 'Release for putaway.';
    case 'FAIL': return 'Quarantine — resolve the failed checks (see each row) before putaway.';
    case 'UNCERTAIN': return 'Hold for review — capture clearer evidence, add operator counts, or decide in the review queue.';
    default: return 'Run the inspection to get a verdict.';
  }
}

/** Number field parse: '' → undefined, otherwise Number (NaN kept so validation can flag it). */
export const num = (value) => (value === '' || value === null || value === undefined ? undefined : Number(value));
export const isInt = (value) => Number.isInteger(value);
export const splitList = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
export const isValidDay = (text) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
};

// ── Manual observations (operator counts) ──

export const EMPTY_MANUAL = {
  observed_sku: '', observed_quantity: '', observed_cartons: '', observed_units_per_carton: '',
  observed_variant: '', damage: '', components_present: '', components_missing: '', note: '',
};

export function manualToForm(manual) {
  if (!manual) return { ...EMPTY_MANUAL };
  const list = (v) => (Array.isArray(v) ? v.join(', ') : v || '');
  return {
    observed_sku: manual.observed_sku || '',
    observed_quantity: manual.observed_quantity ?? '',
    observed_cartons: manual.observed_cartons ?? '',
    observed_units_per_carton: manual.observed_units_per_carton ?? '',
    observed_variant: manual.observed_variant || '',
    damage: list(manual.damage),
    components_present: list(manual.components_present),
    components_missing: list(manual.components_missing),
    note: manual.note || '',
  };
}

/** Validate the operator form → {errors, payload|null}. payload is null when every field is empty. */
export function manualFromForm(form) {
  const errors = {};
  const payload = {};
  ['observed_sku', 'observed_variant'].forEach((key) => {
    const v = String(form[key] || '').trim();
    if (v.length > 200) errors[key] = 'At most 200 characters.';
    else if (v) payload[key] = v;
  });
  ['observed_quantity', 'observed_cartons', 'observed_units_per_carton'].forEach((key) => {
    const v = num(form[key]);
    if (v === undefined) return;
    if (!isInt(v) || v < 0 || v > 1000000) errors[key] = 'Whole number from 0 to 1,000,000.';
    else payload[key] = v;
  });
  const damage = splitList(form.damage);
  if (damage.length > 50) errors.damage = 'At most 50 entries.';
  else if (damage.length === 1 && damage[0].toLowerCase() === 'none') payload.damage = 'none';
  else if (damage.length) payload.damage = damage;
  ['components_present', 'components_missing'].forEach((key) => {
    const list = splitList(form[key]);
    if (list.length > 50) errors[key] = 'At most 50 entries.';
    else if (list.length) payload[key] = list;
  });
  const note = String(form.note || '').trim();
  if (note.length > 2000) errors.note = 'At most 2000 characters.';
  else if (note) payload.note = note;
  return { errors, payload: Object.keys(payload).length ? payload : null };
}

export const hasReadings = (payload) => Boolean(payload && Object.entries(payload).some(([k, v]) => (
  k !== 'note' && v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)
)));

// ── Upload checks mirroring backend/app/services/uploads.py ──

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
export const DEFAULT_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

function sniff(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Deep check of one file (the same rules the backend applies): extension allowed, not empty, within size,
 * magic bytes are a supported image and agree with the extension. Resolves to '' (ok) or a reason.
 */
export async function checkImageFile(file, { extensions = DEFAULT_EXTENSIONS, maxSizeMb } = {}) {
  const name = file.name || '';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  if (!ext) return `No file extension; allowed: ${extensions.join(', ')}`;
  if (!extensions.includes(ext)) return `Unsupported extension ${ext}`;
  if (!file.size) return 'File is empty';
  if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) return `Larger than ${maxSizeMb} MB`;
  if (file.type && !['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'].includes(file.type)) return `Unsupported type ${file.type}`;
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const detected = sniff(head);
    if (!detected) return 'Not a valid JPEG, PNG or WebP image';
    if (MIME_BY_EXT[ext] && MIME_BY_EXT[ext] !== detected) return 'File content does not match its extension';
  } catch {
    return 'File could not be read';
  }
  return '';
}

export const uiVerdictOf = (inspection) => (inspection?.record ? toUiVerdict(inspection.verdict ?? inspection.record?.outcome?.verdict) : 'NOT_ANALYZED');

export const ACTIVE_REVIEW = new Set(['open', 'evidence_requested']);

// ── run outcome (how the verdict was reached) ──

/**
 * Classify how the latest run reached its verdict, from a POST /run response or an inspection view (record).
 *   kind: 'not_run' | 'complete' (vision) | 'demo' (demo provider) | 'operator_only' (vision unavailable, operator
 *         counts decided) | 'pending_review' (no perception and no operator counts — nothing decided)
 */
export function runOutcome(source) {
  if (!source) return { kind: 'not_run' };
  if (source.analysis_status) {
    return {
      kind: source.analysis_status === 'pending_review' ? 'pending_review' : source.analysis_status,
      visionStatus: source.vision_status || null,
      visionReason: source.vision_failure_reason || null,
      failureReason: source.failure_reason || null,
      operator: Boolean(source.manual_observations && hasReadings(source.manual_observations)),
    };
  }
  const record = source.record;
  if (!record) return { kind: 'not_run' };
  const perception = record.perception || {};
  const pending = record.stage === 'pending_review' || record.status === 'pending_review';
  const visionStatus = perception.vision_status || null;
  let kind = 'complete';
  if (pending) kind = 'pending_review';
  else if (visionStatus && visionStatus !== 'ok') kind = 'operator_only';
  else if (perception.vision_provider === 'demo') kind = 'demo';
  return {
    kind,
    visionStatus,
    visionReason: perception.vision_failure_reason || null,
    failureReason: record.outcome?.failure_reason || null,
    operator: Boolean(perception.operator_observations),
    provider: perception.vision_provider || null,
  };
}
