/*
 * Building blocks of the A2A Integration console (A2APage):
 *   <DeliveryPill exchange />        Sending… → Delivered (completed | protocol failure) | Failed (HTTP / network)
 *   <ExchangeView exchange />        HTTP status, latency, ids, replay flag, links, request + response envelopes
 *   <CurlBox envelope />             copy-as-curl ($RECEIVING_API_KEY placeholder), envelope.json download when large
 *   <IdField />                      editable message/correlation id with regenerate + pattern check
 *   <InspectForm />                  receiving.inspect PO / shipment / cartons / demo scenario form
 *   <ImageAttach />                  image dropzone with a per-image capture view
 */
import { useMemo, useState } from 'react';
import { listProducts, listPurchaseOrders, saveBlob } from '../../services/api';
import { useApi } from '../../hooks/useAsync';
import { pathFor } from '../../lib/router';
import { formatBytes, formatLatency } from '../../lib/format';
import {
  EmptyState, FileDropzone, Icon, JsonViewer, KeyValueGrid, Link, StatusBadge, VerdictBadge, updateFileItem,
} from '../../components/ui';
import { buildCurl, copyText, newA2AId, stripImages } from './opsApi';
import { FieldError } from './shared';
import {
  DEMO_SCENARIOS, ID_PATTERN, IMAGE_ACCEPT, IMAGE_VIEWS, SEAL_CONDITIONS, VISIBLE_CONDITIONS, formFromPoLine, referenceForm,
} from './a2aModel';

// ── delivery state ─────────────────────────────────────────────────────────

export function deliveryOf(exchange) {
  if (!exchange) return null;
  if (exchange.state === 'sending') return { tone: 'info', label: 'Sending…', sending: true };
  const res = exchange.result;
  if (!res) return null;
  if (res.httpStatus === 0) return { tone: 'danger', label: 'Failed — backend unreachable' };
  if (!res.ok) return { tone: 'danger', label: `Failed — HTTP ${res.httpStatus}${res.error?.code ? ` ${res.error.code}` : ''}` };
  if (res.body?.status === 'completed') return { tone: 'success', label: `Delivered · completed${res.replayed ? ' (idempotent replay)' : ''}` };
  if (res.body?.status === 'failed') return { tone: 'warning', label: `Delivered · protocol error ${res.body?.error?.code || ''}`.trim() };
  return { tone: 'neutral', label: `HTTP ${res.httpStatus}` };
}

export function DeliveryPill({ exchange }) {
  const d = deliveryOf(exchange);
  if (!d) return null;
  return (
    <span className={`ui-badge tone-${d.tone} ops-delivery`} role="status" aria-live="polite">
      {d.sending ? <span className="spinner ui-spinner-accent ui-spinner-xs" aria-hidden="true" /> : <Icon name={d.tone === 'success' ? 'check' : d.tone === 'danger' ? 'xCircle' : 'info'} size={12} />}
      {d.label}
    </span>
  );
}

function ResultSummary({ body }) {
  const result = body?.result;
  if (!result) return null;
  if (body.operation === 'receiving.inspect') {
    return (
      <KeyValueGrid columns={3} dense items={[
        { label: 'Verdict', value: <VerdictBadge verdict={result.verdict} /> },
        { label: 'Decision', value: result.decision },
        { label: 'Prep hold', value: result.prep_hold },
        { label: 'Inspection', value: result.inspection_id ? <Link to={pathFor('inspections', result.inspection_id)} className="link mono">{result.inspection_id}</Link> : null },
        { label: 'Review task', value: result.review_task_id ? <Link to={pathFor('reviews', result.review_task_id)} className="link mono">{result.review_task_id}</Link> : 'None' },
        { label: 'Issues', value: result.issues?.length ? result.issues.map((i) => `${i.check_key} (${i.reason_code})`).join(', ') : 'None' },
        { label: 'Sealed record', value: result.record?.record_id, mono: true, hideEmpty: true },
        { label: 'Record schema', value: result.record?.schema_version, hideEmpty: true },
      ]} />
    );
  }
  if (body.operation === 'agent.ping') {
    return <KeyValueGrid columns={2} dense items={[{ label: 'pong', value: result.pong }, { label: 'ready', value: result.ready }]} />;
  }
  if (body.operation === 'receiving.verify_record') {
    return (
      <KeyValueGrid columns={3} dense items={[
        { label: 'Integrity verified', value: <StatusBadge status={result.integrity_verified ? 'ok' : 'failed'} label={result.integrity_verified ? 'Verified' : 'Not verified'} /> },
        { label: 'Records', value: result.records },
        { label: 'Problems', value: result.problems?.length ? result.problems : 'None' },
      ]} />
    );
  }
  if (body.operation === 'receiving.get_record') {
    return (
      <KeyValueGrid columns={3} dense items={[
        { label: 'Inspection', value: <Link to={pathFor('inspections', result.inspection_id)} className="link mono">{result.inspection_id}</Link> },
        { label: 'Verdict', value: <VerdictBadge verdict={result.verdict} /> },
        { label: 'Record', value: result.record ? `${result.record.record_id} (${result.record.schema_version})` : null, mono: true },
      ]} />
    );
  }
  return null;
}

/** exchange = { state: 'sending'|'done', envelope (as sent), result (postEnvelopeTimed) } */
export function ExchangeView({ exchange, compact = false }) {
  if (!exchange) return null;
  const res = exchange.result;
  const body = res?.body;
  const inspectionId = body?.result?.inspection_id;
  // The body's request_id names the stored activity entry (on an idempotent replay the header id is a new request).
  const activityId = body?.request_id || res?.requestId;
  return (
    <div className="ops-exchange ops-stack-sm">
      <div className="ops-exchange-head">
        <DeliveryPill exchange={exchange} />
        {res && (
          <span className="ops-exchange-meta">
            <span>HTTP <strong>{res.httpStatus || '—'}</strong></span>
            <span>Latency <strong>{formatLatency(res.latencyMs)}</strong></span>
            {res.requestId && <span>Request <span className="mono">{res.requestId}</span></span>}
            {res.correlationId && <span>Correlation <span className="mono">{res.correlationId}</span></span>}
            {res.replayed && <StatusBadge status="replay" tone="hold" label="X-Idempotent-Replay: true" />}
          </span>
        )}
      </div>
      {res && (
        <div className="row-actions">
          {inspectionId && <Link to={pathFor('inspections', inspectionId)} className="detail-btn"><Icon name="external" size={13} /> Inspection {inspectionId}</Link>}
          {res.ok && activityId && <Link to={pathFor('agent-activity', activityId)} className="detail-btn"><Icon name="activity" size={13} /> Activity entry</Link>}
          {res.correlationId && <Link to="agent-activity" query={{ correlation_id: res.correlationId }} className="detail-btn"><Icon name="list" size={13} /> Conversation</Link>}
        </div>
      )}
      {res?.error && (
        <div className="alert alert-danger" role="alert">
          <Icon name="alert" size={16} />
          <span className="alert-text">{res.error.message}{res.error.requestId ? ` (request ${res.error.requestId})` : ''}</span>
        </div>
      )}
      {body?.status === 'failed' && body.error && (
        <div className="alert alert-warning" role="alert">
          <Icon name="alert" size={16} />
          <span className="alert-text"><strong>{body.error.code}</strong>: {body.error.message}{body.error.retryable ? ' (retryable)' : ''}</span>
        </div>
      )}
      {body?.status === 'completed' && <ResultSummary body={body} />}
      <div className={compact ? 'ops-stack-sm' : 'ops-envelopes'}>
        {exchange.envelope && <JsonViewer data={stripImages(exchange.envelope)} title="Request envelope (sent)" defaultDepth={compact ? 1 : 2} maxHeight={compact ? 260 : 420} />}
        {body ? <JsonViewer data={body} title={res.ok ? 'Response envelope' : 'Error body'} defaultDepth={compact ? 1 : 2} maxHeight={compact ? 320 : 420} />
          : exchange.state === 'sending' ? <div className="ops-waiting"><span className="spinner ui-spinner-accent" aria-hidden="true" /> Waiting for the Receiving Manager…</div> : null}
      </div>
    </div>
  );
}

// ── curl ────────────────────────────────────────────────────────────────────

export function CurlBox({ envelope, disabledReason }) {
  const [copied, setCopied] = useState('');
  const curl = useMemo(() => (envelope ? buildCurl(envelope) : null), [envelope]);
  if (!envelope) return <p className="hint">{disabledReason || 'Fix the envelope to generate the curl command.'}</p>;
  const copy = async () => {
    try { await copyText(curl.command); setCopied('ok'); } catch { setCopied('fail'); }
  };
  return (
    <div className="ops-curl">
      <pre className="ops-pre" aria-label="curl command">{curl.command}</pre>
      <div className="row-actions">
        <button type="button" className="detail-btn" onClick={copy}><Icon name={copied === 'ok' ? 'check' : 'copy'} size={13} /> {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy failed — select the text' : 'Copy curl'}</button>
        {!curl.inline && (
          <button type="button" className="detail-btn" onClick={() => saveBlob(new Blob([JSON.stringify(envelope)], { type: 'application/json' }), 'envelope.json')}>
            <Icon name="download" size={13} /> Download envelope.json ({formatBytes(curl.bytes)})
          </button>
        )}
        <span className="hint">Export <span className="mono">RECEIVING_API_KEY</span> first; the key is never embedded.{!curl.inline && ' The body is large (images), so curl reads it from envelope.json.'}</span>
      </div>
    </div>
  );
}

// ── ids ─────────────────────────────────────────────────────────────────────

export function IdField({ label, value, onChange, prefix, optional = false, hint }) {
  const invalid = value ? !ID_PATTERN.test(value) : !optional;
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="ops-id-field">
        <input className={`filter-input full mono ${invalid ? 'ops-invalid' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} spellCheck={false} />
        <button type="button" className="ui-icon-btn" onClick={() => onChange(newA2AId(prefix))} aria-label={`Generate a new ${label}`} title="Generate a new id"><Icon name="refresh" size={13} /></button>
      </span>
      {invalid ? <FieldError>{value ? 'Use 1–128 chars of A–Z a–z 0–9 . _ : -' : 'Required'}</FieldError> : hint && <span className="hint">{hint}</span>}
    </label>
  );
}

// ── receiving.inspect form ──────────────────────────────────────────────────

function Input({ label, value, onChange, error, type = 'text', required, placeholder, list }) {
  return (
    <label className="field">
      <span className="field-label">{label}{required && <span className="ops-req" aria-hidden="true"> *</span>}</span>
      <input className={`filter-input full ${error ? 'ops-invalid' : ''}`} type={type} value={value} placeholder={placeholder} list={list}
        onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} />
      <FieldError>{error}</FieldError>
    </label>
  );
}

let cartonSeq = 0;

/** Catalogue PO line picker (real POs/products) + editable PO, shipment, cartons and (demo mode) scenario. */
export function InspectForm({ form, onChange, errors = {}, demoMode, showShipment = true }) {
  const pos = useApi(() => listPurchaseOrders({ page_size: 200 }), []);
  const products = useApi(() => listProducts({ page_size: 200 }), []);
  const set = (key) => (value) => onChange({ ...form, [key]: value });
  const options = useMemo(() => (pos.data?.items || []).flatMap((po) => (po.lines || []).map((line) => ({
    value: `${po.po_number}|${line.line}|${line.sku}`, label: `${po.po_number} · line ${line.line} · ${line.sku}${line.product_name ? ` — ${line.product_name}` : ''}`, po, line,
  }))), [pos.data]);
  const pick = (value) => {
    if (value === '__reference') { onChange({ ...referenceForm(), scenario: form.scenario, cartons: form.cartons }); return; }
    const option = options.find((o) => o.value === value);
    if (!option) return;
    const product = (products.data?.items || []).find((p) => String(p.sku).toUpperCase() === String(option.line.sku).toUpperCase());
    onChange({ ...formFromPoLine(option.po, option.line, product), scenario: form.scenario, cartons: form.cartons });
  };
  const setCarton = (key, field, value) => onChange({ ...form, cartons: form.cartons.map((c) => (c.key === key ? { ...c, [field]: value } : c)) });
  const addCarton = () => {
    cartonSeq += 1;
    onChange({ ...form, cartons: [...form.cartons, { key: `c${cartonSeq}`, carton_id: `C-${String(form.cartons.length + 1).padStart(2, '0')}`, expected_units: form.units_per_carton || '', seal_condition: 'intact', visible_condition: 'good' }] });
  };

  return (
    <div className="ops-stack-sm">
      <label className="field">
        <span className="field-label">Fill from</span>
        <select className="filter-select full" value="" onChange={(e) => pick(e.target.value)} aria-label="Fill the PO from a catalogue line">
          <option value="">{pos.loading ? 'Loading catalogue POs…' : pos.error ? `Catalogue unavailable (${pos.error.message})` : `Choose a catalogue PO line (${options.length})…`}</option>
          <option value="__reference">Demo reference line PO-9001 · BLUE-BOTTLE-001 (what demo scenarios expect)</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {!pos.loading && !pos.error && options.length === 0 && <span className="hint">No catalogue POs yet — import the sample on Purchase Orders, or type the PO below.</span>}
      </label>
      <div className="form-grid">
        <Input label="po_id" required value={form.po_id} onChange={set('po_id')} error={errors.po_id} />
        <Input label="sku" required value={form.sku} onChange={set('sku')} error={errors.sku} />
        <Input label="product_name" required value={form.product_name} onChange={set('product_name')} error={errors.product_name} />
        <Input label="variant" required value={form.variant} onChange={set('variant')} error={errors.variant} />
        <Input label="expected_quantity" required type="number" value={form.expected_quantity} onChange={set('expected_quantity')} error={errors.expected_quantity} />
        <Input label="units_per_carton" required type="number" value={form.units_per_carton} onChange={set('units_per_carton')} error={errors.units_per_carton} />
        <Input label="expected_cartons" required type="number" value={form.expected_cartons} onChange={set('expected_cartons')} error={errors.expected_cartons} />
        <Input label="po_line" value={form.po_line} onChange={set('po_line')} />
      </div>
      <Input label="expected_components (comma-separated)" value={form.expected_components} onChange={set('expected_components')} placeholder="cap, label" />
      {showShipment && (
        <details className="ops-details">
          <summary>Shipment & cartons (optional)</summary>
          <div className="ops-stack-sm">
            <div className="form-grid">
              <Input label="shipment_id" value={form.shipment_id} onChange={set('shipment_id')} />
              <Input label="supplier" value={form.supplier} onChange={set('supplier')} />
              <Input label="asn" value={form.asn} onChange={set('asn')} />
              <Input label="warehouse" value={form.warehouse} onChange={set('warehouse')} />
              <Input label="expected_delivery_date" type="date" value={form.expected_delivery_date} onChange={set('expected_delivery_date')} error={errors.expected_delivery_date} />
            </div>
            {form.cartons.length > 0 && (
              <div className="table-wrapper">
                <table className="data-table ops-line-table">
                  <thead><tr><th>carton_id</th><th>expected_units</th><th>seal_condition</th><th>visible_condition</th><th aria-label="Remove" /></tr></thead>
                  <tbody>
                    {form.cartons.map((c) => (
                      <tr key={c.key}>
                        <td><input className="filter-input full ops-w-sm" value={c.carton_id} onChange={(e) => setCarton(c.key, 'carton_id', e.target.value)} aria-label="carton_id" /></td>
                        <td><input className="filter-input full ops-w-xs" type="number" min="0" value={c.expected_units} onChange={(e) => setCarton(c.key, 'expected_units', e.target.value)} aria-label="expected_units" /></td>
                        <td><select className="filter-select full" value={c.seal_condition} onChange={(e) => setCarton(c.key, 'seal_condition', e.target.value)} aria-label="seal_condition">{SEAL_CONDITIONS.map((v) => <option key={v}>{v}</option>)}</select></td>
                        <td><select className="filter-select full" value={c.visible_condition} onChange={(e) => setCarton(c.key, 'visible_condition', e.target.value)} aria-label="visible_condition">{VISIBLE_CONDITIONS.map((v) => <option key={v}>{v}</option>)}</select></td>
                        <td><button type="button" className="ui-icon-btn" onClick={() => onChange({ ...form, cartons: form.cartons.filter((x) => x.key !== c.key) })} aria-label={`Remove carton ${c.carton_id}`}><Icon name="trash" size={13} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <FieldError>{errors.cartons}</FieldError>
            <button type="button" className="btn-theme ops-self-start" onClick={addCarton}><Icon name="plus" size={14} /> Add carton</button>
          </div>
        </details>
      )}
      {demoMode && (
        <label className="field">
          <span className="field-label">Demo scenario (DEMO_MODE only — simulated perception)</span>
          <select className="filter-select full" value={form.scenario} onChange={(e) => set('scenario')(e.target.value)}>
            <option value="">None (server default: correct_shipment)</option>
            {DEMO_SCENARIOS.map((s) => <option key={s.key} value={s.key}>{s.label} ({s.key}) → expected {s.expected}</option>)}
            <option value="perception_failure">Perception failure (perception_failure)</option>
          </select>
          <span className="hint">The backend reports demo_mode=true, so the demo provider replaces vision. Scenarios are written for the PO-9001 reference line.</span>
        </label>
      )}
    </div>
  );
}

// ── images ──────────────────────────────────────────────────────────────────

export function ImageAttach({ items, onChange, maxSizeMb, maxFiles, label = 'Attach delivery photos (sent as base64 in images[])' }) {
  return (
    <FileDropzone
      items={items}
      onChange={(next) => onChange(next.map((item) => (item.meta?.view ? item : { ...item, meta: { ...item.meta, view: 'other' } })))}
      accept={IMAGE_ACCEPT}
      maxSizeMb={maxSizeMb}
      maxFiles={maxFiles}
      label={label}
      hint="JPEG, PNG or WebP"
      renderExtra={(item) => (
        <label className="ops-inline-field">
          <span className="hint">view</span>
          <select className="filter-select" value={item.meta?.view || 'other'} onChange={(e) => onChange(updateFileItem(items, item.id, { meta: { ...item.meta, view: e.target.value } }))} aria-label={`Capture view of ${item.file.name}`}>
            {IMAGE_VIEWS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      )}
    />
  );
}

export function NoResponseYet({ text = 'Nothing sent yet.' }) {
  return <EmptyState compact icon="send" title={text} />;
}
