/*
 * Catalogue forms (modals): product create/edit, purchase order create with a line editor, catalogue import.
 * Every submit hits the real API; validation mirrors the backend models (backend/app/api/catalogue.py).
 */
import { useMemo, useState } from 'react';
import {
  createProduct, createPurchaseOrder, importCatalogueFile, importSampleCatalogue, listProducts, updateProduct,
} from '../../services/api';
import { useApi } from '../../hooks/useAsync';
import { pathFor } from '../../lib/router';
import { formatNumber } from '../../lib/format';
import { AsyncButton, FileDropzone, Icon, KeyValueGrid, Link, Modal } from '../../components/ui';
import { FieldError, parseIntField, splitList } from './shared';

const MAX_TEXT = 200;

function TextField({ label, value, onChange, error, required, disabled, type = 'text', placeholder, hint, ...rest }) {
  return (
    <label className="field">
      <span className="field-label">{label}{required && <span className="ops-req" aria-hidden="true"> *</span>}</span>
      <input
        className={`filter-input full ${error ? 'ops-invalid' : ''}`}
        type={type}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        required={required}
        {...rest}
      />
      {hint && !error && <span className="hint">{hint}</span>}
      <FieldError>{error}</FieldError>
    </label>
  );
}

function textErrors(values, fields, errors) {
  fields.forEach((field) => {
    if (values[field] && String(values[field]).length > MAX_TEXT) errors[field] = `At most ${MAX_TEXT} characters.`;
  });
}

// ── Product ────────────────────────────────────────────────────────────────

const EMPTY_PRODUCT = { sku: '', asin: '', product_name: '', variant: '', colour: '', units_per_carton: '', expected_components: '', supplier: '' };

function productToForm(product) {
  if (!product) return { ...EMPTY_PRODUCT };
  return {
    sku: product.sku || '',
    asin: product.asin || '',
    product_name: product.product_name || '',
    variant: product.variant || '',
    colour: product.colour || '',
    units_per_carton: product.units_per_carton ?? '',
    expected_components: (product.expected_components || []).join(', '),
    supplier: product.supplier || '',
  };
}

function validateProduct(form) {
  const errors = {};
  if (!form.sku.trim()) errors.sku = 'SKU is required.';
  if (!form.product_name.trim()) errors.product_name = 'Product name is required.';
  const units = parseIntField(form.units_per_carton);
  if (Number.isNaN(units) || (units !== undefined && (units < 1 || units > 1000000))) errors.units_per_carton = 'Whole number from 1 to 1,000,000.';
  if (splitList(form.expected_components).length > 50) errors.expected_components = 'At most 50 components.';
  textErrors(form, ['sku', 'asin', 'product_name', 'variant', 'colour', 'supplier'], errors);
  return errors;
}

/** mode: 'create' | 'edit'. onSaved(product) after a successful POST/PUT. */
export function ProductFormModal({ mode = 'create', product, onClose, onSaved }) {
  const [form, setForm] = useState(() => productToForm(product));
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const editing = mode === 'edit';

  const submit = async () => {
    const found = validateProduct(form);
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length) throw new Error('Fix the highlighted fields.');
    const blank = (v) => (String(v).trim() ? String(v).trim() : null);
    const body = {
      asin: blank(form.asin),
      product_name: form.product_name.trim(),
      variant: blank(form.variant),
      colour: blank(form.colour),
      units_per_carton: parseIntField(form.units_per_carton) ?? null,
      expected_components: splitList(form.expected_components),
      supplier: blank(form.supplier),
    };
    try {
      return editing ? await updateProduct(product.sku, body) : await createProduct({ sku: form.sku.trim(), ...body });
    } catch (err) {
      setServerError(err);
      throw err;
    }
  };

  return (
    <Modal
      title={editing ? `Edit product ${product.sku}` : 'New product'}
      subtitle={editing ? 'PUT /api/products/{sku} — the SKU cannot be renamed.' : 'POST /api/products — SKUs are unique within your organisation.'}
      onClose={onClose}
      wide
      footer={(
        <>
          <button type="button" className="btn-theme" onClick={onClose}>Cancel</button>
          <AsyncButton
            variant="primary"
            icon="check"
            label={editing ? 'Save changes' : 'Create product'}
            loadingLabel="Saving…"
            successToast={(saved) => `Product ${saved?.sku || form.sku} ${editing ? 'updated' : 'created'}`}
            errorToast={editing ? 'Could not update product' : 'Could not create product'}
            onClick={submit}
            onSuccess={(saved) => onSaved?.(saved)}
            resetAfter={0}
          />
        </>
      )}
    >
      <div className="stack ops-form">
        {serverError?.status === 409 && (
          <div className="alert alert-warning" role="alert">
            <Icon name="alert" size={16} />
            <span className="alert-text">{serverError.message} <Link to={pathFor('products', form.sku.trim())}>Open the existing product</Link>.</span>
          </div>
        )}
        {serverError && serverError.status !== 409 && (
          <div className="alert alert-danger" role="alert"><Icon name="alert" size={16} /><span className="alert-text">{serverError.message}</span></div>
        )}
        <div className="form-grid">
          <TextField label="SKU" required value={form.sku} onChange={set('sku')} error={errors.sku} disabled={editing} placeholder="SKU-TOWEL-BLU" />
          <TextField label="ASIN" value={form.asin} onChange={set('asin')} error={errors.asin} placeholder="B0…" />
          <TextField label="Product name" required value={form.product_name} onChange={set('product_name')} error={errors.product_name} />
          <TextField label="Variant" value={form.variant} onChange={set('variant')} error={errors.variant} placeholder="e.g. 1kg vanilla" />
          <TextField label="Colour" value={form.colour} onChange={set('colour')} error={errors.colour} />
          <TextField label="Units per carton" type="number" min="1" value={form.units_per_carton} onChange={set('units_per_carton')} error={errors.units_per_carton} />
          <TextField label="Supplier" value={form.supplier} onChange={set('supplier')} error={errors.supplier} />
        </div>
        <TextField
          label="Expected components"
          value={form.expected_components}
          onChange={set('expected_components')}
          error={errors.expected_components}
          placeholder="tub, scoop"
          hint="Comma-separated. Checked by the components check during inspection."
        />
      </div>
    </Modal>
  );
}

// ── Purchase order ─────────────────────────────────────────────────────────

let lineSeq = 0;
const newLine = (number) => {
  lineSeq += 1;
  return { key: `l${lineSeq}`, line: String(number), sku: '', product_name: '', variant: '', expected_quantity: '', units_per_carton: '', expected_cartons: '' };
};

function validatePo(form, lines) {
  const errors = { lines: {} };
  if (!form.po_number.trim()) errors.po_number = 'PO number is required.';
  if (form.po_number.length > MAX_TEXT) errors.po_number = `At most ${MAX_TEXT} characters.`;
  if (form.expected_delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(form.expected_delivery_date)) errors.expected_delivery_date = 'Use YYYY-MM-DD.';
  textErrors(form, ['supplier', 'warehouse'], errors);
  if (!lines.length) errors.form = 'Add at least one line.';
  const seen = new Set();
  lines.forEach((line) => {
    const e = {};
    const number = line.line.trim();
    if (!number) e.line = 'Required';
    else if (seen.has(number)) e.line = 'Duplicate';
    seen.add(number);
    if (!line.sku.trim()) e.sku = 'Required';
    const qty = parseIntField(line.expected_quantity);
    if (qty === undefined) e.expected_quantity = 'Required';
    else if (Number.isNaN(qty) || qty < 0 || qty > 1000000) e.expected_quantity = '0 – 1,000,000';
    const units = parseIntField(line.units_per_carton);
    if (Number.isNaN(units) || (units !== undefined && units < 1)) e.units_per_carton = '≥ 1';
    const cartons = parseIntField(line.expected_cartons);
    if (Number.isNaN(cartons) || (cartons !== undefined && cartons < 0)) e.expected_cartons = '≥ 0';
    if (Object.keys(e).length) errors.lines[line.key] = e;
  });
  const has = errors.po_number || errors.expected_delivery_date || errors.form || errors.supplier || errors.warehouse || Object.keys(errors.lines).length;
  return has ? errors : null;
}

export function PurchaseOrderFormModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ po_number: '', supplier: '', expected_delivery_date: '', warehouse: '' });
  const [lines, setLines] = useState(() => [newLine(1)]);
  const [errors, setErrors] = useState(null);
  const [serverError, setServerError] = useState(null);
  const products = useApi(() => listProducts({ page_size: 200 }), []);
  const bySku = useMemo(() => {
    const map = new Map();
    (products.data?.items || []).forEach((p) => map.set(String(p.sku).toUpperCase(), p));
    return map;
  }, [products.data]);

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const setLine = (key, field, value) => setLines((list) => list.map((line) => {
    if (line.key !== key) return line;
    const next = { ...line, [field]: value };
    if (field === 'sku') {
      const product = bySku.get(value.trim().toUpperCase());
      if (product) {
        if (!line.product_name) next.product_name = product.product_name || '';
        if (!line.variant) next.variant = product.variant || '';
        if (!line.units_per_carton && product.units_per_carton) next.units_per_carton = String(product.units_per_carton);
      }
    }
    if ((field === 'expected_quantity' || field === 'units_per_carton') && !line.cartonsTouched) {
      const qty = parseIntField(field === 'expected_quantity' ? value : next.expected_quantity);
      const units = parseIntField(field === 'units_per_carton' ? value : next.units_per_carton);
      if (qty >= 0 && units >= 1) next.expected_cartons = String(Math.ceil(qty / units));
    }
    if (field === 'expected_cartons') next.cartonsTouched = true;
    return next;
  }));
  const addLine = () => setLines((list) => [...list, newLine(Math.max(0, ...list.map((l) => Number(l.line) || 0)) + 1)]);
  const removeLine = (key) => setLines((list) => list.filter((l) => l.key !== key));

  const submit = async () => {
    const found = validatePo(form, lines);
    setErrors(found);
    setServerError(null);
    if (found) throw new Error('Fix the highlighted fields.');
    const blank = (v) => (String(v).trim() ? String(v).trim() : null);
    const body = {
      po_number: form.po_number.trim(),
      supplier: blank(form.supplier),
      expected_delivery_date: blank(form.expected_delivery_date),
      warehouse: blank(form.warehouse),
      lines: lines.map((line) => {
        const out = {
          line: /^\d+$/.test(line.line.trim()) ? Number(line.line.trim()) : line.line.trim(),
          sku: line.sku.trim(),
          expected_quantity: parseIntField(line.expected_quantity),
        };
        if (line.product_name.trim()) out.product_name = line.product_name.trim();
        if (line.variant.trim()) out.variant = line.variant.trim();
        const units = parseIntField(line.units_per_carton);
        if (units !== undefined) out.units_per_carton = units;
        const cartons = parseIntField(line.expected_cartons);
        if (cartons !== undefined) out.expected_cartons = cartons;
        return out;
      }),
    };
    try {
      return await createPurchaseOrder(body);
    } catch (err) {
      setServerError(err);
      throw err;
    }
  };

  const lineErr = (key, field) => errors?.lines?.[key]?.[field];

  return (
    <Modal
      title="New purchase order"
      subtitle="POST /api/purchase-orders — received quantities and discrepancies are derived from inspections."
      onClose={onClose}
      wide
      footer={(
        <>
          <button type="button" className="btn-theme" onClick={onClose}>Cancel</button>
          <AsyncButton
            variant="primary"
            icon="check"
            label="Create purchase order"
            loadingLabel="Creating…"
            successToast={(po) => `Purchase order ${po?.po_number || form.po_number} created`}
            errorToast="Could not create purchase order"
            onClick={submit}
            onSuccess={(po) => onSaved?.(po)}
            resetAfter={0}
          />
        </>
      )}
    >
      <div className="stack ops-form">
        {serverError?.status === 409 && (
          <div className="alert alert-warning" role="alert">
            <Icon name="alert" size={16} />
            <span className="alert-text">{serverError.message} <Link to={pathFor('purchase-orders', form.po_number.trim())}>Open {form.po_number.trim()}</Link> or choose another PO number.</span>
          </div>
        )}
        {serverError && serverError.status !== 409 && (
          <div className="alert alert-danger" role="alert"><Icon name="alert" size={16} /><span className="alert-text">{serverError.message}</span></div>
        )}
        <div className="form-grid">
          <TextField label="PO number" required value={form.po_number} onChange={set('po_number')} error={errors?.po_number} placeholder="PO-7100" />
          <TextField label="Supplier" value={form.supplier} onChange={set('supplier')} error={errors?.supplier} />
          <TextField label="Expected delivery" type="date" value={form.expected_delivery_date} onChange={set('expected_delivery_date')} error={errors?.expected_delivery_date} />
          <TextField label="Warehouse" value={form.warehouse} onChange={set('warehouse')} error={errors?.warehouse} />
        </div>

        <div className="ops-lines">
          <div className="ops-lines-head">
            <strong>Line items</strong>
            <span className="hint">
              {products.data ? `Typing a catalogue SKU fills name, variant and units/carton (${formatNumber(products.data.total)} products loaded).` : products.error ? 'Catalogue not loaded — enter lines manually.' : 'Loading catalogue…'}
            </span>
          </div>
          {errors?.form && <FieldError>{errors.form}</FieldError>}
          <datalist id="ops-po-skus">
            {(products.data?.items || []).map((p) => <option key={p.sku} value={p.sku}>{p.product_name}</option>)}
          </datalist>
          <div className="table-wrapper">
            <table className="data-table ops-line-table">
              <thead>
                <tr>
                  <th>Line</th><th>SKU *</th><th>Product name</th><th>Variant</th><th>Expected qty *</th><th>Units / carton</th><th>Cartons</th><th aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key}>
                    {[
                      ['line', 'text', 'ops-w-xs'], ['sku', 'text', 'ops-w-md'], ['product_name', 'text', 'ops-w-md'], ['variant', 'text', 'ops-w-sm'],
                      ['expected_quantity', 'number', 'ops-w-sm'], ['units_per_carton', 'number', 'ops-w-sm'], ['expected_cartons', 'number', 'ops-w-sm'],
                    ].map(([field, type, cls]) => (
                      <td key={field}>
                        <input
                          className={`filter-input full ${cls} ${lineErr(line.key, field) ? 'ops-invalid' : ''}`}
                          type={type}
                          min={type === 'number' ? 0 : undefined}
                          value={line[field]}
                          list={field === 'sku' ? 'ops-po-skus' : undefined}
                          aria-label={`Line ${line.line} ${field.replace(/_/g, ' ')}`}
                          aria-invalid={Boolean(lineErr(line.key, field))}
                          onChange={(event) => setLine(line.key, field, event.target.value)}
                        />
                        <FieldError>{lineErr(line.key, field)}</FieldError>
                      </td>
                    ))}
                    <td>
                      <button type="button" className="ui-icon-btn" onClick={() => removeLine(line.key)} disabled={lines.length === 1} aria-label={`Remove line ${line.line}`}>
                        <Icon name="trash" size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn-theme" onClick={addLine}><Icon name="plus" size={14} /> Add line</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Catalogue import ───────────────────────────────────────────────────────

export function ImportCatalogueModal({ onClose, onImported }) {
  const [files, setFiles] = useState([]);
  const [result, setResult] = useState(null);
  const ready = files.find((item) => item.status !== 'rejected');

  const done = (source) => (body) => {
    setResult({ ...body, source });
    onImported?.(body);
  };

  return (
    <Modal
      title="Import catalogue"
      subtitle="POST /api/catalogue/import — upserts products and purchase orders."
      onClose={onClose}
      wide
      footer={<button type="button" className="btn-theme" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>}
    >
      <div className="stack ops-form">
        <p className="hint">
          CSV with the columns of <span className="mono">data/receiving_sample.csv</span> (required: po_number, po_line, sku,
          product_title, qty_ordered, cartons_ordered, units_per_carton_ordered). UTF-8, up to 5 MB. Rows for existing SKUs and
          PO lines are updated in place.
        </p>
        <FileDropzone
          items={files}
          onChange={(items) => { setFiles(items.slice(-1)); setResult(null); }}
          accept={['.csv', 'text/csv']}
          maxSizeMb={5}
          maxFiles={1}
          multiple={false}
          label="Drop a catalogue CSV here"
          hint="CSV"
        />
        <div className="row-actions">
          <AsyncButton
            variant="primary"
            icon="upload"
            label="Import file"
            loadingLabel="Importing…"
            disabled={!ready}
            successToast={(body) => `Imported ${body.rows} row(s)`}
            errorToast="Import failed"
            onClick={() => importCatalogueFile(ready.file)}
            onSuccess={done(ready?.file?.name || 'upload')}
          />
          <AsyncButton
            icon="database"
            label="Import bundled sample data (data/receiving_sample.csv — dummy suppliers)"
            loadingLabel="Importing sample…"
            successToast={(body) => `Sample imported: ${body.rows} row(s)`}
            errorToast="Sample import failed"
            onClick={() => importSampleCatalogue()}
            onSuccess={done('data/receiving_sample.csv')}
          />
        </div>
        {result && (
          <div className="ops-import-result" role="status">
            <div className="ops-import-title"><Icon name="checkCircle" size={16} /> Imported from <span className="mono">{result.source}</span></div>
            <KeyValueGrid columns={3} items={[
              { label: 'CSV rows', value: formatNumber(result.rows) },
              { label: 'Products upserted', value: formatNumber(result.products) },
              { label: 'Purchase orders upserted', value: formatNumber(result.purchase_orders) },
            ]} />
            <div className="row-actions">
              <Link to="purchase-orders" className="detail-btn" onClick={onClose}>View purchase orders</Link>
              <Link to="products" className="detail-btn" onClick={onClose}>View products</Link>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
