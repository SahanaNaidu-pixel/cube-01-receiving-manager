/*
 * A2A console model: sender presets, per-operation example payloads, the receiving.inspect form <-> payload mapping,
 * client-side envelope checks mirroring backend/app/services/a2a.py, and the demo scenario catalogue
 * (keys must match backend/app/services/vision.py _demo_scenarios — DEMO_MODE only).
 */
import { fileToBase64 } from '../../services/api';

export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const SENDER_PRESETS = [
  { value: 'prep_manager', label: 'prep_manager (CUBE Prep 02)' },
  { value: 'recovery_manager', label: 'recovery_manager (CUBE Recovery 05)' },
  { value: 'returns_manager', label: 'returns_manager (CUBE Returns)' },
  { value: 'pack_manager', label: 'pack_manager (CUBE Pack)' },
  { value: 'custom', label: 'Custom agent id…' },
];

/** Used only until the live agent card loads (or if it cannot be loaded). */
export const FALLBACK_OPERATIONS = ['receiving.inspect', 'receiving.get_record', 'receiving.verify_record', 'agent.ping'];

export const IMAGE_VIEWS = ['pallet', 'carton', 'unit', 'label', 'other'];
export const SEAL_CONDITIONS = ['intact', 'broken', 'resealed', 'unknown'];
export const VISIBLE_CONDITIONS = ['good', 'crushed', 'torn', 'punctured', 'wet', 'open', 'label_damaged', 'unknown'];
export const IMAGE_ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];

/** Demo scenarios (DEMO_MODE only). Expected decisions assume the PO-9001 / BLUE-BOTTLE-001 reference line. */
export const DEMO_SCENARIOS = [
  { key: 'correct_shipment', label: 'Clean shipment', expected: 'PASS' },
  { key: 'short_shipment', label: 'Short shipment', expected: 'EXCEPTION' },
  { key: 'wrong_variant', label: 'Wrong variant', expected: 'EXCEPTION' },
  { key: 'damaged_carton', label: 'Crushed carton', expected: 'EXCEPTION' },
  { key: 'water_damage', label: 'Water damage', expected: 'EXCEPTION' },
  { key: 'missing_component', label: 'Missing cap', expected: 'EXCEPTION' },
  { key: 'barcode_glare', label: 'Barcode glare', expected: 'UNCERTAIN' },
  { key: 'ambiguous', label: 'Ambiguous view', expected: 'UNCERTAIN' },
];

/** The PO line the demo scenarios are written against (backend demo catalogue). Editable example, not stored data. */
export const REFERENCE_PO = {
  po_id: 'PO-9001',
  sku: 'BLUE-BOTTLE-001',
  product_name: 'Blue Bottle',
  expected_quantity: 24,
  variant: 'Blue',
  units_per_carton: 12,
  expected_cartons: 2,
  expected_components: ['cap', 'label'],
};

export const EMPTY_INSPECT_FORM = {
  po_id: '', sku: '', product_name: '', variant: '', expected_quantity: '', units_per_carton: '', expected_cartons: '',
  expected_components: '', po_line: '',
  shipment_id: '', supplier: '', asn: '', warehouse: '', expected_delivery_date: '',
  cartons: [],
  scenario: '',
};

export function referenceForm() {
  return {
    ...EMPTY_INSPECT_FORM,
    ...Object.fromEntries(Object.entries(REFERENCE_PO).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)])),
  };
}

/** Fill the inspect form from a catalogue PO line (+ product for components). */
export function formFromPoLine(po, line, product) {
  const qty = line.expected_quantity ?? '';
  const units = line.units_per_carton ?? product?.units_per_carton ?? '';
  const cartons = line.expected_cartons ?? (qty !== '' && units ? Math.ceil(qty / units) : '');
  return {
    ...EMPTY_INSPECT_FORM,
    po_id: po.po_number,
    po_line: line.line !== undefined && line.line !== null ? String(line.line) : '',
    sku: line.sku || '',
    product_name: line.product_name || product?.product_name || '',
    variant: line.variant || product?.variant || '',
    expected_quantity: String(qty),
    units_per_carton: String(units),
    expected_cartons: String(cartons),
    expected_components: (line.expected_components || product?.expected_components || []).join(', '),
    supplier: po.supplier || '',
    warehouse: po.warehouse || '',
    expected_delivery_date: po.expected_delivery_date || '',
  };
}

const intOr = (value) => {
  if (value === '' || value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
};
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && v !== null));

/** Form → receiving.inspect payload (without images; they are attached at send time). */
export function inspectPayloadFromForm(form) {
  const po = clean({
    po_id: form.po_id.trim(),
    sku: form.sku.trim(),
    product_name: form.product_name.trim(),
    variant: form.variant.trim(),
    expected_quantity: intOr(form.expected_quantity),
    units_per_carton: intOr(form.units_per_carton),
    expected_cartons: intOr(form.expected_cartons),
    po_line: form.po_line.trim(),
  });
  po.expected_components = form.expected_components.split(',').map((s) => s.trim()).filter(Boolean);
  const payload = { po };
  const shipment = clean({
    shipment_id: form.shipment_id.trim(), supplier: form.supplier.trim(), asn: form.asn.trim(),
    warehouse: form.warehouse.trim(), expected_delivery_date: form.expected_delivery_date.trim(),
  });
  if (Object.keys(shipment).length) payload.shipment = shipment;
  const cartons = form.cartons
    .filter((c) => c.carton_id.trim())
    .map((c) => clean({
      carton_id: c.carton_id.trim(), expected_units: intOr(c.expected_units),
      seal_condition: c.seal_condition, visible_condition: c.visible_condition,
    }));
  if (cartons.length) payload.cartons = cartons;
  if (form.scenario) payload.scenario = form.scenario;
  return payload;
}

/** Best-effort payload → form (JSON tab → Form tab). */
export function formFromInspectPayload(payload = {}) {
  const po = payload.po || {};
  const ship = payload.shipment || {};
  const str = (v) => (v === undefined || v === null ? '' : String(v));
  return {
    ...EMPTY_INSPECT_FORM,
    po_id: str(po.po_id), sku: str(po.sku), product_name: str(po.product_name), variant: str(po.variant),
    expected_quantity: str(po.expected_quantity), units_per_carton: str(po.units_per_carton),
    expected_cartons: str(po.expected_cartons), po_line: str(po.po_line),
    expected_components: Array.isArray(po.expected_components) ? po.expected_components.join(', ') : '',
    shipment_id: str(ship.shipment_id), supplier: str(ship.supplier), asn: str(ship.asn), warehouse: str(ship.warehouse),
    expected_delivery_date: str(ship.expected_delivery_date),
    cartons: Array.isArray(payload.cartons) ? payload.cartons.map((c, i) => ({
      key: `c${i}-${Date.now()}`, carton_id: str(c.carton_id), expected_units: str(c.expected_units),
      seal_condition: c.seal_condition || 'unknown', visible_condition: c.visible_condition || 'unknown',
    })) : [],
    scenario: str(payload.scenario),
  };
}

/** Validation of the inspect form against the contract (a2a_request.v1 receiving.inspect po requirements). */
export function inspectFormErrors(form) {
  const errors = {};
  ['po_id', 'sku', 'product_name', 'variant'].forEach((k) => { if (!form[k].trim()) errors[k] = 'Required'; });
  const intField = (k, min) => {
    const v = form[k];
    if (v === '' || v === null || v === undefined) { errors[k] = 'Required'; return; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) errors[k] = `Whole number ≥ ${min}`;
  };
  intField('expected_quantity', 0);
  intField('units_per_carton', 1);
  intField('expected_cartons', 0);
  if (form.expected_delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(form.expected_delivery_date)) errors.expected_delivery_date = 'YYYY-MM-DD';
  const ids = form.cartons.map((c) => c.carton_id.trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) errors.cartons = 'carton_id values must be unique';
  return errors;
}

export function examplePayload(operation, { latestInspectionId } = {}) {
  switch (operation) {
    case 'agent.ping': return {};
    case 'receiving.get_record':
    case 'receiving.verify_record':
      return { inspection_id: latestInspectionId || 'INS-REPLACE-ME' };
    case 'receiving.inspect': return inspectPayloadFromForm(referenceForm());
    default: return {};
  }
}

/** Mirrors the backend envelope checks so obvious mistakes are flagged before sending (the server still decides). */
export function envelopeProblems({ senderId, messageId, correlationId, operation }) {
  const problems = [];
  if (!ID_PATTERN.test(senderId || '')) problems.push('sender.agent_id must be 1–128 chars of [A-Za-z0-9._:-]');
  if (!ID_PATTERN.test(messageId || '')) problems.push('message_id must be 1–128 chars of [A-Za-z0-9._:-]');
  if (correlationId && !ID_PATTERN.test(correlationId)) problems.push('correlation_id must be 1–128 chars of [A-Za-z0-9._:-]');
  if (!operation) problems.push('operation is required');
  return problems;
}

/** Dropzone items → A2A images[] (base64, no data: prefix). */
export async function imagesFromItems(items) {
  const ready = items.filter((item) => item.status !== 'rejected');
  return Promise.all(ready.map(async (item) => ({
    view: item.meta?.view || 'other',
    filename: item.file.name,
    content_base64: await fileToBase64(item.file),
  })));
}

/** Canvas-generated placeholder PNG for demo-scenario regression only (the scenario, not the pixels, drives the result). */
export function placeholderPng(label) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) { reject(new Error('Canvas is not available in this browser.')); return; }
    ctx.fillStyle = '#101c2b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#edf4ff';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText('Demo-scenario placeholder', 40, 150);
    ctx.font = '26px sans-serif';
    ctx.fillText(label, 40, 205);
    ctx.font = '18px sans-serif';
    ctx.fillText('Not a real photo — DEMO_MODE regression only', 40, 260);
    canvas.toBlob((blob) => {
      if (blob) resolve(new File([blob], `scenario-${label}.png`, { type: 'image/png' }));
      else reject(new Error('Could not generate the placeholder image.'));
    }, 'image/png');
  });
}
