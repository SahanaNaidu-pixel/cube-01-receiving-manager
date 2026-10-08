/*
 * Intake form state + validation for the New Inspection wizard (steps 1–3), mirroring the backend models:
 * PurchaseOrder (backend/app/models/po.py) and Shipment / Carton (backend/app/models/intake.py, docs/API.md).
 * Pure functions only — no API calls here.
 */
import { isInt, isValidDay, num, splitList, SEAL_CONDITIONS, VISIBLE_CONDITIONS } from './helpers';

const MAX_TEXT = 200;
const MAX_COUNT = 1000000;
export const MAX_CARTONS = 200;

export const EMPTY_SHIPMENT = {
  po_number: '', shipment_id: '', supplier: '', expected_delivery_date: '', warehouse: '', asn: '',
};

export const EMPTY_PRODUCT = {
  sku: '', asin: '', product_name: '', expected_quantity: '', variant: '', units_per_carton: '',
  expected_cartons: '', expected_components: '', po_line: '',
};

let cartonSeq = 0;
export function emptyCarton(index = 0) {
  cartonSeq += 1;
  return {
    key: `c${cartonSeq}`,
    carton_id: index ? `C-${String(index).padStart(2, '0')}` : '',
    expected_units: '', carton_type: '', weight_kg: '', dimensions_cm: '',
    seal_condition: 'unknown', visible_condition: 'unknown', notes: '',
  };
}

const text = (value) => String(value ?? '').trim();

function checkText(errors, form, key, { required = false, max = MAX_TEXT, label = 'This field' } = {}) {
  const value = text(form[key]);
  if (required && !value) errors[key] = `${label} is required.`;
  else if (value.length > max) errors[key] = `At most ${max} characters.`;
}

function checkCount(errors, form, key, { required = false, min = 0, label = 'This field' } = {}) {
  const value = num(form[key]);
  if (value === undefined) {
    if (required) errors[key] = `${label} is required.`;
    return;
  }
  if (!isInt(value) || value < min || value > MAX_COUNT) errors[key] = `Whole number from ${min} to ${MAX_COUNT.toLocaleString()}.`;
}

/** Step 1 — shipment / PO header. */
export function validateShipment(form) {
  const errors = {};
  checkText(errors, form, 'po_number', { required: true, label: 'PO number' });
  ['shipment_id', 'supplier', 'warehouse', 'asn'].forEach((key) => checkText(errors, form, key));
  const day = text(form.expected_delivery_date);
  if (day && !isValidDay(day)) errors.expected_delivery_date = 'Use a valid date (YYYY-MM-DD).';
  return errors;
}

/** Step 2 — product / PO line. Returns {errors, warnings}. */
export function validateProduct(form) {
  const errors = {};
  checkText(errors, form, 'sku', { required: true, label: 'SKU' });
  checkText(errors, form, 'product_name', { required: true, label: 'Product name' });
  checkText(errors, form, 'variant', { required: true, label: 'Variant' });
  checkText(errors, form, 'asin');
  checkText(errors, form, 'po_line');
  checkCount(errors, form, 'expected_quantity', { required: true, label: 'Expected quantity' });
  checkCount(errors, form, 'units_per_carton', { required: true, min: 1, label: 'Units per carton' });
  checkCount(errors, form, 'expected_cartons', { required: true, label: 'Expected cartons' });
  const components = splitList(form.expected_components);
  if (components.length > 50) errors.expected_components = 'At most 50 components.';
  else if (components.some((c) => c.length > MAX_TEXT)) errors.expected_components = `Each component at most ${MAX_TEXT} characters.`;

  const warnings = [];
  const qty = num(form.expected_quantity);
  const upc = num(form.units_per_carton);
  const cartons = num(form.expected_cartons);
  if (!errors.expected_quantity && !errors.units_per_carton && !errors.expected_cartons
    && [qty, upc, cartons].every((v) => v !== undefined) && qty !== upc * cartons) {
    warnings.push(`Expected quantity (${qty}) is not cartons × units per carton (${cartons} × ${upc} = ${cartons * upc}). The quantity and carton checks compare against these values as entered.`);
  }
  return { errors, warnings };
}

/** Step 3 — carton rows. Returns {rows: {key: {field: msg}}, general}. */
export function validateCartons(cartons) {
  const rows = {};
  let general = '';
  if (cartons.length > MAX_CARTONS) general = `At most ${MAX_CARTONS} cartons per inspection.`;
  const seen = new Map();
  cartons.forEach((carton) => {
    const errors = {};
    const id = text(carton.carton_id);
    if (!id) errors.carton_id = 'Carton ID is required.';
    else if (id.length > MAX_TEXT) errors.carton_id = `At most ${MAX_TEXT} characters.`;
    else if (seen.has(id.toLowerCase())) errors.carton_id = 'Duplicate carton ID.';
    seen.set(id.toLowerCase(), true);
    checkCount(errors, carton, 'expected_units');
    const weight = num(carton.weight_kg);
    if (weight !== undefined && (Number.isNaN(weight) || weight < 0)) errors.weight_kg = 'A number ≥ 0.';
    checkText(errors, carton, 'carton_type');
    const dims = text(carton.dimensions_cm);
    if (dims.length > MAX_TEXT) errors.dimensions_cm = `At most ${MAX_TEXT} characters.`;
    else if (dims && !/^\d+(\.\d+)?\s*[x×]\s*\d+(\.\d+)?\s*[x×]\s*\d+(\.\d+)?$/i.test(dims)) errors.dimensions_cm = 'Format L x W x H, e.g. 40x30x30.';
    if (text(carton.notes).length > 500) errors.notes = 'At most 500 characters.';
    if (!SEAL_CONDITIONS.includes(carton.seal_condition)) errors.seal_condition = 'Pick a seal condition.';
    if (!VISIBLE_CONDITIONS.includes(carton.visible_condition)) errors.visible_condition = 'Pick a condition.';
    if (Object.keys(errors).length) rows[carton.key] = errors;
  });
  return { rows, general };
}

const opt = (value) => (text(value) ? text(value) : undefined);

/** Build the POST /api/inspections body from the three intake forms. */
export function buildCreatePayload(shipmentForm, productForm, cartons) {
  const po = {
    po_id: text(shipmentForm.po_number),
    sku: text(productForm.sku),
    product_name: text(productForm.product_name),
    expected_quantity: num(productForm.expected_quantity),
    variant: text(productForm.variant),
    units_per_carton: num(productForm.units_per_carton),
    expected_cartons: num(productForm.expected_cartons),
    expected_components: splitList(productForm.expected_components),
  };
  if (opt(productForm.asin)) po.asin = opt(productForm.asin);
  if (opt(productForm.po_line)) po.po_line = opt(productForm.po_line);

  const shipment = {};
  ['shipment_id', 'supplier', 'expected_delivery_date', 'warehouse', 'asn'].forEach((key) => {
    if (opt(shipmentForm[key])) shipment[key] = opt(shipmentForm[key]);
  });

  const cartonList = cartons.map((c) => {
    const row = { carton_id: text(c.carton_id), seal_condition: c.seal_condition, visible_condition: c.visible_condition };
    if (num(c.expected_units) !== undefined) row.expected_units = num(c.expected_units);
    if (num(c.weight_kg) !== undefined) row.weight_kg = num(c.weight_kg);
    ['carton_type', 'dimensions_cm', 'notes'].forEach((key) => { if (opt(c[key])) row[key] = opt(c[key]); });
    return row;
  });

  return { po, shipment: Object.keys(shipment).length ? shipment : undefined, cartons: cartonList };
}

/** Rebuild the three intake forms from a stored inspection (draft resume after refresh). */
export function formsFromInspection(inspection) {
  const po = inspection?.po || {};
  const ship = inspection?.shipment || {};
  return {
    shipment: {
      po_number: po.po_id || '',
      shipment_id: ship.shipment_id || '',
      supplier: ship.supplier || '',
      expected_delivery_date: ship.expected_delivery_date || '',
      warehouse: ship.warehouse || '',
      asn: ship.asn || '',
    },
    product: {
      sku: po.sku || '',
      asin: po.asin || '',
      product_name: po.product_name || '',
      expected_quantity: po.expected_quantity ?? '',
      variant: po.variant || '',
      units_per_carton: po.units_per_carton ?? '',
      expected_cartons: po.expected_cartons ?? '',
      expected_components: (po.expected_components || []).join(', '),
      po_line: po.po_line || '',
    },
    cartons: (inspection?.cartons || []).map((c) => ({
      ...emptyCarton(),
      carton_id: c.carton_id || '',
      expected_units: c.expected_units ?? '',
      carton_type: c.carton_type || '',
      weight_kg: c.weight_kg ?? '',
      dimensions_cm: c.dimensions_cm || '',
      seal_condition: c.seal_condition || 'unknown',
      visible_condition: c.visible_condition || 'unknown',
      notes: c.notes || '',
    })),
  };
}

/** Product form from a PO line (GET /api/purchase-orders/{po}). */
export function productFromPoLine(line) {
  return {
    sku: line.sku || '',
    asin: line.asin || '',
    product_name: line.product_name || '',
    expected_quantity: line.expected_quantity ?? '',
    variant: line.variant || '',
    units_per_carton: line.units_per_carton ?? '',
    expected_cartons: line.expected_cartons ?? '',
    expected_components: (line.expected_components || []).join(', '),
    po_line: line.line !== undefined && line.line !== null ? String(line.line) : '',
  };
}

/**
 * Product form patch from a catalogue product (GET /api/products). Products carry no expected quantity or
 * carton count, so those stay as the operator entered them.
 */
export function productFromCatalogue(product, current) {
  return {
    ...current,
    sku: product.sku || '',
    asin: product.asin || '',
    product_name: product.product_name || '',
    variant: product.variant || current.variant || '',
    units_per_carton: product.units_per_carton ?? current.units_per_carton,
    expected_components: (product.expected_components || []).join(', '),
  };
}

export function shipmentFromPo(po, current) {
  return {
    ...current,
    po_number: po.po_number || '',
    supplier: po.supplier || current.supplier || '',
    expected_delivery_date: po.expected_delivery_date || current.expected_delivery_date || '',
    warehouse: po.warehouse || current.warehouse || '',
  };
}
