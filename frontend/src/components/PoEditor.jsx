import { PO_PRESETS } from '../constants';
import { Icon } from './Shared';

// The editor works on a "form" copy of the PO: numbers may be strings mid-edit and
// components are a comma-separated string. toPoPayload() converts it for the API.
export const poToForm = (po) => ({
  ...po,
  asin: po.asin || '',
  po_line: po.po_line || '',
  unit_id: po.unit_id || '',
  expected_components: (po.expected_components || []).join(', '),
});

export function toPoPayload(form) {
  const num = (value) => (value === '' || value === null || value === undefined ? value : Number(value));
  const optional = (value) => String(value || '').trim() || null;
  return {
    po_id: String(form.po_id || '').trim(),
    po_line: optional(form.po_line),
    sku: String(form.sku || '').trim(),
    asin: optional(form.asin),
    unit_id: optional(form.unit_id),
    product_name: String(form.product_name || '').trim(),
    variant: String(form.variant || '').trim(),
    expected_quantity: num(form.expected_quantity),
    units_per_carton: num(form.units_per_carton),
    expected_cartons: num(form.expected_cartons),
    expected_components: String(form.expected_components || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

// Blocking errors, mirroring the backend PurchaseOrder schema (required strings, integers, units/carton >= 1).
export function poErrors(form) {
  const po = toPoPayload(form);
  const errors = {};
  if (!po.po_id) errors.po_id = 'Purchase order number is required.';
  if (!po.sku) errors.sku = 'Expected SKU is required.';
  if (!po.product_name) errors.product_name = 'Product name is required.';
  if (!po.variant) errors.variant = 'Variant is required.';
  const int = (field, label, min) => {
    const value = po[field];
    if (value === '' || value === null || value === undefined) errors[field] = `${label} is required.`;
    else if (!Number.isInteger(value)) errors[field] = `${label} must be a whole number.`;
    else if (value < min) errors[field] = `${label} must be at least ${min}.`;
  };
  int('expected_quantity', 'Expected quantity', 0);
  int('expected_cartons', 'Expected cartons', 0);
  int('units_per_carton', 'Units per carton', 1);
  return errors;
}

// Non-blocking: the backend accepts it, but the quantity check will be held UNCERTAIN.
export function poWarnings(form) {
  const po = toPoPayload(form);
  const { expected_cartons: cartons, units_per_carton: perCarton, expected_quantity: qty } = po;
  if ([cartons, perCarton, qty].every((value) => Number.isInteger(value)) && cartons * perCarton !== qty) {
    return [`Cartons × units per carton = ${cartons * perCarton}, but the expected quantity is ${qty}. The quantity check will be held as UNCERTAIN (PO_INCONSISTENT).`];
  }
  return [];
}

const SECTIONS = [
  {
    title: 'Purchase order',
    fields: [
      { name: 'po_id', label: 'PO number', required: true, placeholder: 'e.g. PO-9001', mono: true },
      { name: 'po_line', label: 'PO line', placeholder: 'Optional', help: 'Recorded in the sealed record subject.' },
    ],
  },
  {
    title: 'Expected product',
    fields: [
      { name: 'sku', label: 'Expected SKU', required: true, placeholder: 'e.g. BLUE-BOTTLE-001', mono: true },
      { name: 'asin', label: 'ASIN', placeholder: 'Optional', mono: true },
      { name: 'product_name', label: 'Product name', required: true, full: true },
      { name: 'variant', label: 'Variant', required: true, placeholder: 'e.g. Blue', help: 'Colour, size or flavour the PO specifies.' },
      { name: 'unit_id', label: 'Unit ID', placeholder: 'Optional', mono: true, help: 'Join key shared with the other CUBE stages.' },
    ],
  },
  {
    title: 'Expected quantities',
    fields: [
      { name: 'expected_quantity', label: 'Expected quantity', required: true, type: 'number', min: 0, help: 'Total units on the PO line.' },
      { name: 'expected_cartons', label: 'Expected cartons', required: true, type: 'number', min: 0 },
      { name: 'units_per_carton', label: 'Units per carton', required: true, type: 'number', min: 1 },
      { name: 'expected_components', label: 'Expected components', full: true, placeholder: 'e.g. cap, label', help: 'Comma-separated. Each listed part must be seen to pass the component check.' },
    ],
  },
];

export default function PoEditor({ form, setForm, disabled, showErrors }) {
  const presetIndex = PO_PRESETS.findIndex((preset) => preset.po_id === form.po_id);
  const matchesPreset = presetIndex >= 0
    && JSON.stringify(toPoPayload(poToForm(PO_PRESETS[presetIndex]))) === JSON.stringify(toPoPayload(form));
  const errors = poErrors(form);
  const warnings = poWarnings(form);

  return (
    <div className="po-form">
      <div className="field po-form__preset">
        <label htmlFor="po-preset" className="field__label">Start from a sample PO line</label>
        <select id="po-preset" className="input select" value={matchesPreset ? String(presetIndex) : 'custom'} disabled={disabled}
          onChange={(event) => { const preset = PO_PRESETS[Number(event.target.value)]; if (preset) setForm(poToForm(preset)); }}>
          {PO_PRESETS.map((preset, index) => (
            <option key={preset.po_id} value={String(index)}>{preset.po_id} · {preset.product_name} (sample data)</option>
          ))}
          {!matchesPreset && <option value="custom">Custom PO line</option>}
        </select>
        <span className="field__help">Sample lines are example data for demonstration. Enter the real PO line before inspecting a delivery.</span>
      </div>

      {SECTIONS.map((section) => (
        <fieldset key={section.title} className="form-section" disabled={disabled}>
          <legend>{section.title}</legend>
          <div className="form-grid">
            {section.fields.map((field) => {
              const error = showErrors ? errors[field.name] : '';
              const id = `po-${field.name}`;
              return (
                <div key={field.name} className={`field ${field.full ? 'field--full' : ''} ${error ? 'has-error' : ''}`}>
                  <label htmlFor={id} className="field__label">
                    {field.label}{field.required ? <span className="req" aria-hidden="true">*</span> : <span className="opt">optional</span>}
                  </label>
                  <input id={id} className={`input ${field.mono ? 'mono' : ''}`}
                    type={field.type || 'text'} min={field.min} step={field.type === 'number' ? 1 : undefined}
                    inputMode={field.type === 'number' ? 'numeric' : undefined} placeholder={field.placeholder}
                    required={field.required} aria-required={field.required || undefined} aria-invalid={Boolean(error) || undefined}
                    aria-describedby={error || field.help ? `${id}-help` : undefined}
                    value={form[field.name] ?? ''}
                    onChange={(event) => setForm((current) => ({ ...current, [field.name]: event.target.value }))} />
                  {(error || field.help) && <span id={`${id}-help`} className={error ? 'field__error' : 'field__help'}>{error || field.help}</span>}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}

      {warnings.length > 0 && (
        <div className="alert alert--warn" role="status">
          <Icon name="alert" size={16} />
          <div className="alert__text">{warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>
        </div>
      )}
      <div className="alert alert--info">
        <Icon name="info" size={16} />
        <span className="alert__text">
          These are the authoritative <b>expected</b> values. Received quantity, carton condition and variant are <b>observed</b> from
          the photos by the agent, never typed in. The vision model reads the photos without seeing the SKU, counts or variant;
          the rules engine compares afterwards. Supplier and shipment references are not part of the backend inspection schema, so they are not collected here.
        </span>
      </div>
    </div>
  );
}

export const hasPoErrors = (form) => Object.keys(poErrors(form)).length > 0;
