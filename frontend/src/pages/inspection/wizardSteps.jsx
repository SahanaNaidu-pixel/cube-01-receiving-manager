/*
 * The seven step panels of the New Inspection wizard. State lives in NewInspectionPage; these render forms and
 * call back. Every list/lookup is a real API call.
 */
import { useState } from 'react';
import { listProducts, listPurchaseOrders, requestInspectionReview } from '../../services/api';
import { useApi } from '../../hooks/useAsync';
import { formatBytes, formatDateTime, humanize } from '../../lib/format';
import { pathFor } from '../../lib/router';
import { AsyncButton, EmptyState, ErrorState, Icon, Link, LoadingState, StatusBadge, VerdictBadge } from '../../components/ui';
import {
  ChecksTable, EvidenceThumb, EvidenceUploader, Field, ManualObservationsForm, RunOutcomeNotice, ScenarioPicker,
  TextInput, VerdictBanner, VisionUnavailableAlert, useDebounced,
} from './components';
import { ACTIVE_REVIEW, SEAL_CONDITIONS, VISIBLE_CONDITIONS, hasReadings, overallRecommendation, viewLabel } from './helpers';
import { MAX_CARTONS, emptyCarton } from './intake';

export const STEPS = [
  { n: 1, key: 'shipment', label: 'Shipment / PO' },
  { n: 2, key: 'product', label: 'Product' },
  { n: 3, key: 'cartons', label: 'Cartons' },
  { n: 4, key: 'evidence', label: 'Evidence' },
  { n: 5, key: 'inspect', label: 'Inspection' },
  { n: 6, key: 'verdict', label: 'Verdict' },
  { n: 7, key: 'review', label: 'Review' },
];

export function Stepper({ step, maxReachable, onGo }) {
  return (
    <ol className="insp-stepper" aria-label="Inspection steps">
      {STEPS.map((s) => {
        const state = s.n === step ? 'current' : s.n < step ? 'done' : 'todo';
        const reachable = s.n <= maxReachable;
        return (
          <li key={s.key} className={`insp-step is-${state}`}>
            <button type="button" onClick={() => onGo(s.n)} disabled={!reachable} aria-current={s.n === step ? 'step' : undefined}>
              <span className="insp-step-num">{state === 'done' ? <Icon name="check" size={13} /> : s.n}</span>
              <span className="insp-step-label">{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function LockedNotice({ inspectionId }) {
  if (!inspectionId) return null;
  return (
    <div className="alert alert-hold" role="status">
      <Icon name="shield" size={16} />
      <span className="alert-text">
        Intake saved as <span className="mono">{inspectionId}</span>. It is part of the inspection record and cannot be edited here — start a new inspection to change it.
      </span>
    </div>
  );
}

// ── step 1 ──

export function StepShipment({ form, setForm, errors, locked, inspectionId, selectedPo, onPickPo, prefillNotes }) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const pos = useApi(() => listPurchaseOrders({ q, page_size: 12 }), [q], { enabled: !locked });
  const items = pos.data?.items || [];
  return (
    <div className="stack">
      <LockedNotice inspectionId={inspectionId} />
      {prefillNotes.map((note) => (
        <div key={note} className="alert alert-warning" role="status"><Icon name="alert" size={16} /><span className="alert-text">{note}</span></div>
      ))}
      {!locked && (
        <div className="insp-picker">
          <div className="insp-picker-head">
            <span className="field-label">Start from an existing purchase order</span>
            <input type="search" className="filter-input" placeholder="Search PO number or supplier…" value={search}
              onChange={(e) => setSearch(e.target.value)} aria-label="Search purchase orders" />
          </div>
          {pos.error ? <ErrorState error={pos.error} onRetry={pos.reload} title="Could not load purchase orders" compact />
            : pos.loading && !items.length ? <LoadingState label="Loading purchase orders…" compact />
              : !items.length ? (
                <p className="hint">
                  {q ? `No purchase order matches “${q}”.` : 'No purchase orders yet.'} Enter the PO below, or{' '}
                  <Link to="purchase-orders">import a catalogue on the Purchase Orders page</Link>.
                </p>
              ) : (
                <div className="insp-pick-list" role="list">
                  {items.map((po) => (
                    <button key={po.po_number} type="button" role="listitem"
                      className={`insp-pick ${selectedPo?.po_number === po.po_number ? 'active' : ''}`} onClick={() => onPickPo(po)}>
                      <span className="mono cell-strong">{po.po_number}</span>
                      <span className="hint">{po.supplier || 'No supplier'} · {po.lines?.length || 0} line(s)</span>
                      <StatusBadge status={po.status} />
                    </button>
                  ))}
                </div>
              )}
        </div>
      )}
      <fieldset className="insp-fieldset" disabled={locked}>
        <legend className="sr-only">Shipment and purchase order</legend>
        <div className="form-grid">
          <Field id="f-po" label="PO number" required error={errors.po_number}>
            <TextInput id="f-po" form={form} name="po_number" setForm={setForm} errors={errors} maxLength={200} placeholder="PO-7000" />
          </Field>
          <Field id="f-shipment" label="Shipment ID" error={errors.shipment_id}>
            <TextInput id="f-shipment" form={form} name="shipment_id" setForm={setForm} errors={errors} maxLength={200} />
          </Field>
          <Field id="f-supplier" label="Supplier" error={errors.supplier}>
            <TextInput id="f-supplier" form={form} name="supplier" setForm={setForm} errors={errors} maxLength={200} />
          </Field>
          <Field id="f-date" label="Expected delivery date" error={errors.expected_delivery_date}>
            <TextInput id="f-date" form={form} name="expected_delivery_date" setForm={setForm} errors={errors} type="date" />
          </Field>
          <Field id="f-wh" label="Warehouse" error={errors.warehouse}>
            <TextInput id="f-wh" form={form} name="warehouse" setForm={setForm} errors={errors} maxLength={200} />
          </Field>
          <Field id="f-asn" label="ASN" error={errors.asn} hint="Advance shipping notice reference">
            <TextInput id="f-asn" form={form} name="asn" setForm={setForm} errors={errors} maxLength={200} />
          </Field>
        </div>
      </fieldset>
    </div>
  );
}

// ── step 2 ──

export function StepProduct({ form, setForm, errors, warnings, locked, inspectionId, selectedPo, onPickLine, onPickProduct }) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const products = useApi(() => listProducts({ q, page_size: 12 }), [q], { enabled: !locked });
  const items = products.data?.items || [];
  const lines = selectedPo?.lines || [];
  return (
    <div className="stack">
      <LockedNotice inspectionId={inspectionId} />
      {!locked && lines.length > 0 && (
        <div className="insp-picker">
          <span className="field-label">Lines on {selectedPo.po_number}</span>
          <div className="insp-pick-list" role="list">
            {lines.map((line) => (
              <button key={`${line.line}-${line.sku}`} type="button" role="listitem"
                className={`insp-pick ${form.sku === line.sku ? 'active' : ''}`} onClick={() => onPickLine(line)}>
                <span className="mono cell-strong">{line.sku}</span>
                <span className="hint">Line {line.line ?? '—'} · {line.product_name} · {line.expected_quantity} units</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!locked && (
        <div className="insp-picker">
          <div className="insp-picker-head">
            <span className="field-label">Pick from the product catalogue</span>
            <input type="search" className="filter-input" placeholder="Search SKU, ASIN or name…" value={search}
              onChange={(e) => setSearch(e.target.value)} aria-label="Search products" />
          </div>
          {products.error ? <ErrorState error={products.error} onRetry={products.reload} title="Could not load products" compact />
            : products.loading && !items.length ? <LoadingState label="Loading catalogue…" compact />
              : !items.length ? (
                <p className="hint">
                  {q ? `No product matches “${q}”.` : 'The product catalogue is empty.'}{' '}
                  <Link to="purchase-orders">Import a catalogue on the Purchase Orders page</Link>, or enter the product below.
                </p>
              ) : (
                <div className="insp-pick-list" role="list">
                  {items.map((p) => (
                    <button key={p.sku} type="button" role="listitem" className={`insp-pick ${form.sku === p.sku ? 'active' : ''}`} onClick={() => onPickProduct(p)}>
                      <span className="mono cell-strong">{p.sku}</span>
                      <span className="hint">{p.product_name}{p.variant ? ` · ${p.variant}` : ''}{p.units_per_carton ? ` · ${p.units_per_carton}/carton` : ''}</span>
                    </button>
                  ))}
                </div>
              )}
          {items.length > 0 && <p className="hint">Catalogue products have no expected quantity or carton count — enter those from the PO.</p>}
        </div>
      )}
      <fieldset className="insp-fieldset" disabled={locked}>
        <legend className="sr-only">Product</legend>
        <div className="form-grid">
          <Field id="p-sku" label="SKU" required error={errors.sku}>
            <TextInput id="p-sku" form={form} name="sku" setForm={setForm} errors={errors} maxLength={200} />
          </Field>
          <Field id="p-asin" label="ASIN" error={errors.asin}>
            <TextInput id="p-asin" form={form} name="asin" setForm={setForm} errors={errors} maxLength={200} />
          </Field>
          <Field id="p-name" label="Product name" required error={errors.product_name}>
            <TextInput id="p-name" form={form} name="product_name" setForm={setForm} errors={errors} maxLength={200} />
          </Field>
          <Field id="p-variant" label="Variant" required error={errors.variant} hint="Colour / size / flavour as on the PO">
            <TextInput id="p-variant" form={form} name="variant" setForm={setForm} errors={errors} maxLength={200} />
          </Field>
          <Field id="p-qty" label="Expected quantity" required error={errors.expected_quantity}>
            <TextInput id="p-qty" form={form} name="expected_quantity" setForm={setForm} errors={errors} type="number" min={0} step={1} />
          </Field>
          <Field id="p-upc" label="Units per carton" required error={errors.units_per_carton}>
            <TextInput id="p-upc" form={form} name="units_per_carton" setForm={setForm} errors={errors} type="number" min={1} step={1} />
          </Field>
          <Field id="p-cartons" label="Expected cartons" required error={errors.expected_cartons}>
            <TextInput id="p-cartons" form={form} name="expected_cartons" setForm={setForm} errors={errors} type="number" min={0} step={1} />
          </Field>
          <Field id="p-line" label="PO line" error={errors.po_line}>
            <TextInput id="p-line" form={form} name="po_line" setForm={setForm} errors={errors} maxLength={200} />
          </Field>
          <Field id="p-comp" label="Expected components" error={errors.expected_components} hint="Comma-separated, e.g. cap, label" span>
            <TextInput id="p-comp" form={form} name="expected_components" setForm={setForm} errors={errors} />
          </Field>
        </div>
      </fieldset>
      {warnings.map((w) => (
        <div key={w} className="alert alert-warning" role="status"><Icon name="info" size={16} /><span className="alert-text">{w}</span></div>
      ))}
    </div>
  );
}

// ── step 3 ──

export function StepCartons({ cartons, setCartons, errors, locked, inspectionId, expectedCartons }) {
  const update = (key, patch) => setCartons((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const add = (count = 1) => setCartons((list) => {
    const next = [...list];
    for (let i = 0; i < count && next.length < MAX_CARTONS; i += 1) next.push(emptyCarton(next.length + 1));
    return next;
  });
  const missing = Math.max(0, Math.min(MAX_CARTONS, Number(expectedCartons) || 0) - cartons.length);
  return (
    <div className="stack">
      <LockedNotice inspectionId={inspectionId} />
      <p className="hint">
        Optional. Record each carton as received at the dock. Seal and visible condition feed the <strong>carton condition</strong> check
        (operator evidence); without cartons that check is “not required”.
      </p>
      {errors.general && <div className="alert alert-danger" role="alert"><Icon name="alert" size={16} /><span className="alert-text">{errors.general}</span></div>}
      {cartons.length === 0 && <EmptyState icon="box" title="No cartons recorded" message="Add a row per carton, or continue without cartons." compact />}
      {cartons.length > 0 && (
        <div className="table-wrapper ui-table-wrapper">
          <table className="data-table ui-data-table insp-carton-table">
            <thead>
              <tr>
                <th scope="col">Carton ID *</th><th scope="col">Expected units</th><th scope="col">Type</th><th scope="col">Weight kg</th>
                <th scope="col">Dimensions cm</th><th scope="col">Seal</th><th scope="col">Visible condition</th><th scope="col">Notes</th>
                <th scope="col"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {cartons.map((c, index) => {
                const e = errors.rows?.[c.key] || {};
                const cell = (name, props = {}) => (
                  <td>
                    <input className="filter-input full" aria-label={`Carton ${index + 1} ${humanize(name)}`} value={c[name]} disabled={locked}
                      aria-invalid={Boolean(e[name])} onChange={(ev) => update(c.key, { [name]: ev.target.value })} {...props} />
                    {e[name] && <span className="insp-field-error" role="alert">{e[name]}</span>}
                  </td>
                );
                return (
                  <tr key={c.key}>
                    {cell('carton_id', { maxLength: 200 })}
                    {cell('expected_units', { type: 'number', min: 0, step: 1 })}
                    {cell('carton_type', { maxLength: 200, placeholder: 'e.g. RSC' })}
                    {cell('weight_kg', { type: 'number', min: 0, step: 0.1 })}
                    {cell('dimensions_cm', { maxLength: 200, placeholder: '40x30x30' })}
                    <td>
                      <select className="filter-select full" aria-label={`Carton ${index + 1} seal condition`} value={c.seal_condition} disabled={locked}
                        onChange={(ev) => update(c.key, { seal_condition: ev.target.value })}>
                        {SEAL_CONDITIONS.map((v) => <option key={v} value={v}>{humanize(v)}</option>)}
                      </select>
                    </td>
                    <td>
                      <select className="filter-select full" aria-label={`Carton ${index + 1} visible condition`} value={c.visible_condition} disabled={locked}
                        onChange={(ev) => update(c.key, { visible_condition: ev.target.value })}>
                        {VISIBLE_CONDITIONS.map((v) => <option key={v} value={v}>{humanize(v)}</option>)}
                      </select>
                    </td>
                    {cell('notes', { maxLength: 500 })}
                    <td>
                      {!locked && (
                        <button type="button" className="ui-icon-btn" aria-label={`Remove carton ${index + 1}`}
                          onClick={() => setCartons((list) => list.filter((x) => x.key !== c.key))}>
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!locked && (
        <div className="ui-button-row">
          <button type="button" className="btn-theme" onClick={() => add(1)} disabled={cartons.length >= MAX_CARTONS}><Icon name="plus" size={14} /> Add carton</button>
          {missing > 0 && (
            <button type="button" className="detail-btn" onClick={() => add(missing)}>
              Add {missing} row(s) to match the {expectedCartons} expected cartons
            </button>
          )}
          <span className="hint">{cartons.length} of {MAX_CARTONS} max</span>
        </div>
      )}
    </div>
  );
}

// ── step 4 ──

export function StepEvidence({ inspection, onUploaded }) {
  const images = inspection?.images || [];
  return (
    <div className="stack">
      <p className="hint">
        Upload delivery photos and classify each by view. Files are checked here with the same rules as the backend (type, size, image
        signature) and stored against <span className="mono">{inspection.inspection_id}</span>. Photos are optional if you will enter operator counts in the next step.
      </p>
      {images.length > 0 && (
        <div>
          <span className="field-label">Stored on the inspection ({images.length})</span>
          <ul className="insp-stored-list">
            {images.map((img) => (
              <li key={img.image_id}>
                <EvidenceThumb inspectionId={inspection.inspection_id} imageId={img.image_id} alt={img.filename} />
                <div>
                  <Link to={pathFor('evidence', img.image_id)} className="link mono">{img.image_id}</Link>
                  <div className="hint">{viewLabel(img.image_type)} · {img.filename} · {formatBytes(img.file_size)}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <EvidenceUploader inspectionId={inspection.inspection_id} existingCount={images.length} onUploaded={onUploaded} />
    </div>
  );
}

// ── step 5 ──

export function StepRun({ inspection, env, manualForm, setManualForm, manualErrors, scenario, setScenario, run, runError, onRun, formError }) {
  const running = run.state === 'running';
  const images = inspection?.images || [];
  return (
    <div className="stack">
      <div className="insp-run-summary">
        <span><strong>{images.length}</strong> photo(s)</span>
        <span>Vision provider: <strong className="mono">{env.visionProvider || (env.known ? 'unknown' : '…')}</strong>{env.visionModel ? ` (${env.visionModel})` : ''}</span>
        {inspection.record && <span>Last run: <VerdictBadge verdict={inspection.verdict} /> · {formatDateTime(inspection.record.created_at)}</span>}
      </div>
      {env.visionProvider === 'none' && !hasReadings(manualFromFormSafe(manualForm)) && <VisionUnavailableAlert />}
      <ManualObservationsForm form={manualForm} setForm={setManualForm} errors={manualErrors} disabled={running} idPrefix="w" />
      {env.demoMode && <ScenarioPicker value={scenario} onChange={setScenario} disabled={running} />}
      {formError && <div className="alert alert-danger" role="alert"><Icon name="alert" size={16} /><span className="alert-text">{formError}</span></div>}
      <div className="ui-button-row">
        <button type="button" className="btn-primary" onClick={onRun} disabled={running}>
          {running ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={15} />}
          {running ? 'Running inspection…' : inspection.record ? 'Re-run inspection' : 'Run inspection'}
        </button>
        <span className={`insp-run-state s-${run.state}`} aria-live="polite">
          {run.state === 'running' && 'Running — the backend is analysing the evidence.'}
          {run.state === 'completed' && 'Completed.'}
          {run.state === 'failed' && 'Failed.'}
        </span>
      </div>
      {run.state === 'failed' && runError && <ErrorState error={runError} title="The run failed" onRetry={onRun} />}
      {run.state === 'completed' && run.result && <RunOutcomeNotice outcome={run.outcome} />}
    </div>
  );
}

// Tolerant read of the manual form for the "vision unavailable" hint (validation errors ignored).
function manualFromFormSafe(form) {
  const out = {};
  Object.entries(form || {}).forEach(([k, v]) => { if (k !== 'note' && String(v ?? '').trim()) out[k] = v; });
  return out;
}

// ── step 6 ──

export function StepVerdict({ inspection, checks, outcome, uiVerdict }) {
  if (!inspection.record) {
    return <EmptyState icon="play" title="Not run yet" message="Run the inspection in the previous step to get a verdict." compact />;
  }
  return (
    <div className="stack">
      <VerdictBanner verdict={uiVerdict} checks={checks}>
        <div className="insp-verdict-rec"><Icon name="arrowRight" size={14} /> {overallRecommendation(uiVerdict)}</div>
      </VerdictBanner>
      <RunOutcomeNotice outcome={outcome} />
      {inspection.agent_summary && <p className="insp-summary">{inspection.agent_summary}</p>}
      <ChecksTable checks={checks} />
      <p className="hint">
        Record <span className="mono">{inspection.record.record_id}</span> v{inspection.record.version} · analysed by {inspection.record.analyzed_by || '—'} ·
        {' '}{formatDateTime(inspection.record.created_at)}. Recommended actions are guidance derived from each check’s result, not findings.
      </p>
    </div>
  );
}

// ── step 7 ──

export function StepReview({ inspection, onCreated }) {
  const task = inspection.review_task;
  const active = task && ACTIVE_REVIEW.has(task.status);
  const [reason, setReason] = useState('');
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState('');
  const issues = (inspection.issues || []).filter((i) => i.status === 'open' || i.status === 'in_review');
  const create = () => {
    const text = reason.trim();
    if (!text) { setError('Give a reason for the review.'); return Promise.reject(new Error('Give a reason for the review.')); }
    if (text.length > 2000) { setError('At most 2000 characters.'); return Promise.reject(new Error('Reason too long.')); }
    setError('');
    return requestInspectionReview(inspection.inspection_id, text, assignee.trim() || undefined);
  };
  return (
    <div className="stack">
      {active ? (
        <div className="alert alert-hold" role="status">
          <Icon name="inbox" size={16} />
          <span className="alert-text">
            Review task <Link to={pathFor('reviews', task.task_id)} className="link mono">{task.task_id}</Link> is {humanize(task.status).toLowerCase()}
            {task.trigger ? ` (trigger: ${humanize(task.trigger).toLowerCase()})` : ''} — the shipment is held until a reviewer decides.
          </span>
        </div>
      ) : (
        <div className="insp-review-form">
          {task && (
            <p className="hint">
              Latest review task <Link to={pathFor('reviews', task.task_id)} className="link mono">{task.task_id}</Link> is {humanize(task.status).toLowerCase()}
              {task.resolution ? ` (${task.resolution})` : ''}.
            </p>
          )}
          {!task && inspection.record && <p className="hint">No review task was opened automatically for this verdict. Send it to the review queue if a person should check it.</p>}
          {!inspection.record && <p className="hint">The inspection has not been run; you can still ask a person to review it.</p>}
          <div className="form-grid">
            <Field id="rv-reason" label="Reason for review" required error={error} span>
              <textarea id="rv-reason" className="filter-input full" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Field id="rv-assign" label="Assign to (optional)">
              <input id="rv-assign" className="filter-input full" maxLength={200} value={assignee} onChange={(e) => setAssignee(e.target.value)} />
            </Field>
          </div>
          <AsyncButton variant="primary" icon="send" label="Create review task" loadingLabel="Creating…" successLabel="Created"
            onClick={create} successToast={(t) => `Review task ${t?.task_id || ''} created`} errorToast="Could not create the review task"
            onSuccess={() => { setReason(''); setAssignee(''); onCreated(); }} />
        </div>
      )}
      {issues.length > 0 && (
        <div>
          <span className="field-label">Open exceptions from this run</span>
          <ul className="insp-link-list">
            {issues.map((i) => (
              <li key={i.issue_id}>
                <Link to={pathFor('issues', i.issue_id)} className="link mono">{i.issue_id}</Link> <StatusBadge status={i.severity} tone={i.severity === 'high' ? 'danger' : 'warning'} /> {i.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ui-button-row">
        <Link to={pathFor('inspections', inspection.inspection_id)} className="btn-primary"><Icon name="external" size={14} /> Open inspection detail</Link>
      </div>
    </div>
  );
}
