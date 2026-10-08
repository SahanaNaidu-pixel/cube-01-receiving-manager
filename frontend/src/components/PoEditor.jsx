import { PO_PRESETS } from '../constants';
import { Card, Icon } from './Shared';

// The editor works on a "form" copy of the PO: numbers may be strings mid-edit and
// components are a comma-separated string. toPoPayload() converts it for the API.
export const poToForm = (po) => ({ ...po, expected_components: (po.expected_components || []).join(', ') });

export function toPoPayload(form) {
  const num = (value) => (value === '' || value === null || value === undefined ? value : Number(value));
  return {
    po_id: String(form.po_id || '').trim(),
    sku: String(form.sku || '').trim(),
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

export function poWarnings(form) {
  const po = toPoPayload(form);
  const warnings = [];
  ['po_id', 'sku', 'product_name', 'variant'].forEach((field) => {
    if (!po[field]) warnings.push(`${field.replace(/_/g, ' ')} is empty.`);
  });
  const { expected_cartons: cartons, units_per_carton: perCarton, expected_quantity: qty } = po;
  if ([cartons, perCarton, qty].every((value) => Number.isFinite(value)) && cartons * perCarton !== qty) {
    warnings.push(`Cartons × units/carton = ${cartons * perCarton}, but expected quantity is ${qty}.`);
  }
  return warnings;
}

const FIELDS = [
  { name: 'po_id', label: 'PO ID' },
  { name: 'sku', label: 'SKU' },
  { name: 'product_name', label: 'Product name' },
  { name: 'variant', label: 'Variant' },
  { name: 'expected_quantity', label: 'Expected quantity', type: 'number' },
  { name: 'expected_cartons', label: 'Expected cartons', type: 'number' },
  { name: 'units_per_carton', label: 'Units / carton', type: 'number' },
  { name: 'expected_components', label: 'Components (comma-separated)' },
];

export default function PoEditor({ form, setForm, open, onToggle, disabled }) {
  const presetIndex = PO_PRESETS.findIndex((preset) => preset.po_id === form.po_id);
  const matchesPreset = presetIndex >= 0
    && JSON.stringify(toPoPayload(poToForm(PO_PRESETS[presetIndex]))) === JSON.stringify(toPoPayload(form));
  const warnings = poWarnings(form);
  const summary = `${form.po_id || '—'} • ${form.product_name || '—'} • ${form.expected_quantity || 0} units / ${form.expected_cartons || 0} cartons`;

  return (
    <Card
      title="Purchase order line"
      sub="Authoritative expected values (Rule 5) — the agent never takes them from the camera"
      actions={(
        <button type="button" className="btn-theme" onClick={onToggle} aria-expanded={open} aria-controls="po-spec">
          <Icon name="file" size={15} /> {open ? 'Hide specification' : 'Edit specification'}
        </button>
      )}
    >
      <div className="field">
        <label htmlFor="po-preset" className="field-label">Active inbound PO</label>
        <select
          id="po-preset"
          className="filter-select full"
          value={matchesPreset ? String(presetIndex) : 'custom'}
          disabled={disabled}
          onChange={(event) => {
            const preset = PO_PRESETS[Number(event.target.value)];
            if (preset) setForm(poToForm(preset));
          }}
        >
          {PO_PRESETS.map((preset, index) => (
            <option key={preset.po_id} value={String(index)}>
              {preset.po_id} • {preset.product_name} • {preset.expected_quantity} units / {preset.expected_cartons} cartons
            </option>
          ))}
          {!matchesPreset && <option value="custom">Edited: {summary}</option>}
        </select>
      </div>

      <dl className="po-summary">
        <div><dt>SKU</dt><dd className="mono">{form.sku || '—'}</dd></div>
        <div><dt>Variant</dt><dd>{form.variant || '—'}</dd></div>
        <div><dt>Expected qty</dt><dd>{form.expected_quantity || 0}</dd></div>
        <div><dt>Cartons × units</dt><dd>{form.expected_cartons || 0} × {form.units_per_carton || 0}</dd></div>
        <div><dt>Components</dt><dd>{form.expected_components || '—'}</dd></div>
      </dl>

      {open && (
        <div id="po-spec" className="form-grid">
          {FIELDS.map((field) => (
            <div key={field.name} className="field">
              <label htmlFor={`po-${field.name}`} className="field-label">{field.label}</label>
              <input
                id={`po-${field.name}`}
                className="filter-input full"
                type={field.type || 'text'}
                min={field.type === 'number' ? 0 : undefined}
                value={form[field.name] ?? ''}
                disabled={disabled}
                onChange={(event) => setForm((current) => ({ ...current, [field.name]: event.target.value }))}
              />
            </div>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="alert alert-warning" role="status">
          <Icon name="alert" size={16} />
          <div className="alert-text">{warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>
        </div>
      )}
    </Card>
  );
}
