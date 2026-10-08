/*
 * Building blocks shared by the inspection pages. All data comes from the API; nothing is simulated.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchInspectionImageUrl, getHealth, uploadInspectionImages } from '../../services/api';
import { useApp } from '../../context/AppContext';
import { useAsync } from '../../hooks/useAsync';
import { formatBytes, formatDateTime, formatPercent, verdictLabel } from '../../lib/format';
import { pathFor } from '../../lib/router';
import {
  FileDropzone, Icon, Link, Modal, StatusBadge, VerdictBadge, createFileItems, updateFileItem, useToast,
} from '../../components/ui';
import {
  CAPTURE_VIEWS, DEFAULT_EXTENSIONS, DEMO_SCENARIOS, VISION_UNAVAILABLE_MESSAGE, checkImageFile, checkLabel,
  confidenceSummary, countByStatus, displayValue, recommendedAction, viewLabel,
} from './helpers';

// ── environment ──

/**
 * Backend environment facts the inspection pages need: demo mode, vision provider, upload limits.
 * Prefers /api/system/info (already loaded by AppContext); falls back to the public /api/health for demo_mode.
 */
export function useInspectionEnv() {
  const { systemInfo } = useApp();
  const env = systemInfo?.environment;
  const health = useAsync(() => getHealth(), [], { enabled: !env });
  const demoMode = env ? Boolean(env.demo_mode) : health.data ? Boolean(health.data.demo_mode) : false;
  return {
    known: Boolean(env || health.data),
    demoMode,
    visionProvider: env?.vision_provider ?? null,
    visionModel: env?.vision_model ?? null,
    maxSizeMb: env?.max_image_size_mb || 10,
    maxImages: env?.upload_max_images || 20,
    extensions: (env?.allowed_extensions?.length ? env.allowed_extensions : DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()),
    peers: env?.a2a_peers || [],
    role: systemInfo?.principal?.role || null,
    operator: systemInfo?.principal?.operator_id || null,
  };
}

// ── form field ──

export function Field({ id, label, error, hint, required, children, span }) {
  return (
    <div className={`field insp-field ${error ? 'has-error' : ''}`} style={span ? { gridColumn: '1 / -1' } : undefined}>
      <label htmlFor={id} className="field-label">{label}{required && <span className="insp-req" aria-hidden="true"> *</span>}</label>
      {children}
      {error ? <span id={`${id}-err`} className="insp-field-error" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** Controlled text/number input bound to form[name]. */
export function TextInput({ id, form, name, setForm, errors = {}, type = 'text', disabled, placeholder, min, step, maxLength }) {
  return (
    <input
      id={id}
      className="filter-input full"
      type={type}
      value={form[name] ?? ''}
      min={min}
      step={step}
      maxLength={maxLength}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={Boolean(errors[name])}
      aria-describedby={errors[name] ? `${id}-err` : undefined}
      onChange={(event) => setForm((current) => ({ ...current, [name]: event.target.value }))}
    />
  );
}

// ── verdict / checks ──

export function ConfidenceMeter({ value }) {
  if (typeof value !== 'number') return <span className="hint">—</span>;
  const tone = value >= 0.85 ? 'good' : value >= 0.6 ? 'warn' : 'bad';
  return (
    <span className={`insp-conf tone-${tone}`} title={`Confidence ${formatPercent(value, 1)}`}>
      <span className="insp-conf-bar"><span style={{ width: `${Math.round(value * 100)}%` }} /></span>
      <span className="insp-conf-num">{formatPercent(value)}</span>
    </span>
  );
}

const STATUS_TONE = { PASS: 'success', FAIL: 'danger', UNCERTAIN: 'warning', NOT_REQUIRED: 'neutral' };
const STATUS_TEXT = { PASS: 'Pass', FAIL: 'Fail', UNCERTAIN: 'Uncertain', NOT_REQUIRED: 'Not required' };
const SEVERITY = { FAIL: 'high', UNCERTAIN: 'medium', PASS: 'none', NOT_REQUIRED: 'none' };

export function CheckStatusBadge({ status }) {
  return <StatusBadge status={status} tone={STATUS_TONE[status] || 'neutral'} label={STATUS_TEXT[status] || status} />;
}

/** Where a check's verdict came from: AI vision model, operator counts, rules (PO arithmetic), or not run. */
export function SourceTag({ modelVersion }) {
  if (!modelVersion) return null;
  if (modelVersion === 'operator') return <span className="insp-source src-operator" title="Decided from operator input, not AI">Operator</span>;
  if (modelVersion === 'rules') return <span className="insp-source src-rules" title="Decided by rules from the PO data">Rules</span>;
  if (modelVersion === 'none' || modelVersion === 'unavailable') return <span className="insp-source">No model</span>;
  return <span className="insp-source src-model" title={`Vision model ${modelVersion}`}>{modelVersion}</span>;
}

function EvidenceLinks({ check }) {
  const images = check.image_ids || [];
  const operator = (check.evidence_ids || []).some((id) => String(id).startsWith('OPR-'));
  if (!images.length && !operator) return <span className="hint">—</span>;
  return (
    <span className="insp-evlinks">
      {images.map((id) => <Link key={id} to={pathFor('evidence', id)} className="link mono">{id}</Link>)}
      {operator && <span className="insp-source src-operator">Operator count</span>}
    </span>
  );
}

/** Per-check table: expected, observed, status, reason code, reason, confidence, evidence, recommended action. */
export function ChecksTable({ checks, showAction = true }) {
  if (!checks.length) return <p className="hint">No checks yet — the inspection has not been run.</p>;
  return (
    <div className="table-wrapper ui-table-wrapper">
      <table className="data-table ui-data-table insp-checks">
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Expected</th>
            <th scope="col">Observed</th>
            <th scope="col">Status</th>
            <th scope="col">Reason</th>
            <th scope="col">Confidence</th>
            <th scope="col">Evidence</th>
            {showAction && <th scope="col">Recommended action</th>}
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check.check_name} className={`insp-sev-${SEVERITY[check.status] || 'none'}`}>
              <td>
                <div className="cell-strong">{checkLabel(check.check_name)}</div>
                <div className="insp-cell-sub"><span className="mono">{check.check_key}</span> <SourceTag modelVersion={check.model_version} /></div>
              </td>
              <td className="mono">{displayValue(check.expected_value)}</td>
              <td className="mono">{displayValue(check.observed_value)}</td>
              <td><CheckStatusBadge status={check.status} /></td>
              <td className="insp-reason">
                {check.reason_code && <div className="mono insp-code">{check.reason_code}</div>}
                <div>{check.reason}</div>
              </td>
              <td><ConfidenceMeter value={check.confidence} /></td>
              <td><EvidenceLinks check={check} /></td>
              {showAction && <td className="insp-action">{recommendedAction(check)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Big verdict banner with check counts and a confidence summary. */
export function VerdictBanner({ verdict, checks, children, failureReason }) {
  const counts = countByStatus(checks);
  const conf = confidenceSummary(checks);
  return (
    <div className={`insp-verdict v-${verdict}`}>
      <div className="insp-verdict-main">
        <span className="insp-verdict-label">Overall verdict</span>
        <span className="insp-verdict-value">{verdictLabel(verdict)}</span>
      </div>
      <div className="insp-verdict-stats">
        <span><strong>{counts.PASS}</strong> pass</span>
        <span><strong>{counts.FAIL}</strong> fail</span>
        <span><strong>{counts.UNCERTAIN}</strong> uncertain</span>
        {counts.NOT_REQUIRED > 0 && <span><strong>{counts.NOT_REQUIRED}</strong> not required</span>}
        {conf && <span title={`Across ${conf.count} decided checks`}>confidence min <strong>{formatPercent(conf.min)}</strong> · avg <strong>{formatPercent(conf.avg)}</strong></span>}
      </div>
      {failureReason && <div className="insp-verdict-note"><Icon name="clock" size={14} /> {failureReason}</div>}
      {children}
    </div>
  );
}

export function VisionUnavailableAlert() {
  return (
    <div className="alert alert-warning" role="status">
      <Icon name="alert" size={16} />
      <span className="alert-text">{VISION_UNAVAILABLE_MESSAGE}</span>
    </div>
  );
}

// ── evidence images (fetched with the API key) ──

export function EvidenceThumb({ inspectionId, imageId, alt, onClick, className = '' }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setFailed(false);
    fetchInspectionImageUrl(inspectionId, imageId)
      .then((value) => { objectUrl = value; if (active) setUrl(value); else URL.revokeObjectURL(value); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [inspectionId, imageId]);
  const body = failed
    ? <span className="insp-thumb-ph"><Icon name="alert" size={18} /><span>Image unavailable</span></span>
    : url ? <img src={url} alt={alt || imageId} /> : <span className="insp-thumb-ph"><span className="spinner ui-spinner-accent" aria-hidden="true" /></span>;
  if (!onClick) return <span className={`insp-thumb ${className}`}>{body}</span>;
  return <button type="button" className={`insp-thumb ${className}`} onClick={onClick} aria-label={`Open ${alt || imageId}`}>{body}</button>;
}

/** Lightbox for one evidence file: large image, metadata, readings, links. */
export function EvidenceLightbox({ inspectionId, file, onClose, onPrev, onNext }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'ArrowLeft' && onPrev) onPrev();
      if (event.key === 'ArrowRight' && onNext) onNext();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onPrev, onNext]);
  return (
    <Modal
      wide
      title={file.filename || file.image_id}
      subtitle={`${viewLabel(file.view)} · ${file.image_id} · ${formatBytes(file.file_size)}`}
      onClose={onClose}
      footer={(
        <>
          {onPrev && <button type="button" className="btn-theme" onClick={onPrev}><Icon name="chevronLeft" size={14} /> Previous</button>}
          {onNext && <button type="button" className="btn-theme" onClick={onNext}>Next <Icon name="chevronRight" size={14} /></button>}
          <Link to={pathFor('evidence', file.image_id)} className="btn-primary"><Icon name="external" size={14} /> Evidence detail</Link>
        </>
      )}
    >
      <div className="insp-lightbox">
        <EvidenceThumb key={file.image_id} inspectionId={inspectionId} imageId={file.image_id} alt={file.filename} className="insp-lightbox-img" />
        <div className="insp-lightbox-side">
          <dl className="insp-mini-kv">
            <dt>Analysis</dt><dd><StatusBadge status={file.analysis_status} /></dd>
            <dt>Uploaded</dt><dd>{formatDateTime(file.uploaded_at)}{file.uploaded_by ? ` by ${file.uploaded_by}` : ''}</dd>
            <dt>Source</dt><dd>{file.source === 'a2a' ? 'A2A message' : 'Upload'}</dd>
            <dt>SHA-256</dt><dd className="mono insp-break">{file.sha256_digest || '—'}</dd>
            <dt>Linked checks</dt><dd>{file.linked_checks?.length ? file.linked_checks.join(', ') : '—'}</dd>
            <dt>Linked issues</dt>
            <dd>{file.linked_issue_ids?.length
              ? file.linked_issue_ids.map((id) => <Link key={id} to={pathFor('issues', id)} className="link mono insp-gap">{id}</Link>)
              : '—'}</dd>
          </dl>
          <ReadingsList readings={file.readings} />
        </div>
      </div>
    </Modal>
  );
}

export function ReadingsList({ readings }) {
  if (!readings?.length) return <p className="hint">No readings recorded for this image (not analysed, or perception unavailable).</p>;
  return (
    <div className="insp-readings">
      <span className="field-label">Readings from this image</span>
      <ul>
        {readings.map((r) => (
          <li key={r.evidence_id}>
            <span className="mono">{r.check_type}</span>: <strong>{r.observation}</strong>
            <ConfidenceMeter value={r.confidence} />
            {r.description && <div className="hint">{r.description}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── manual observations ──

const MANUAL_FIELDS = [
  { name: 'observed_sku', label: 'Observed SKU' },
  { name: 'observed_variant', label: 'Observed variant' },
  { name: 'observed_quantity', label: 'Counted units (total)', type: 'number' },
  { name: 'observed_cartons', label: 'Counted cartons', type: 'number' },
  { name: 'observed_units_per_carton', label: 'Units per carton', type: 'number' },
  { name: 'damage', label: 'Damage seen', hint: 'Comma-separated (e.g. crushing, water) or "none"' },
  { name: 'components_present', label: 'Components present', hint: 'Comma-separated' },
  { name: 'components_missing', label: 'Components missing', hint: 'Comma-separated' },
];

export function ManualObservationsForm({ form, setForm, errors = {}, disabled, idPrefix = 'mo' }) {
  return (
    <div className="insp-manual">
      <div className="insp-manual-head">
        <span className="insp-source src-operator">Operator</span>
        <strong>Operator counts — recorded as your own evidence, not AI</strong>
      </div>
      <p className="hint">Leave a field blank if you did not count it. Counts are fused with any photo readings; where they disagree the check becomes Uncertain.</p>
      <div className="form-grid">
        {MANUAL_FIELDS.map((f) => (
          <Field key={f.name} id={`${idPrefix}-${f.name}`} label={f.label} error={errors[f.name]} hint={f.hint}>
            <TextInput id={`${idPrefix}-${f.name}`} form={form} name={f.name} setForm={setForm} errors={errors} type={f.type} min={f.type ? 0 : undefined} step={f.type ? 1 : undefined} disabled={disabled} />
          </Field>
        ))}
        <Field id={`${idPrefix}-note`} label="Note" error={errors.note} span>
          <textarea id={`${idPrefix}-note`} className="filter-input full" rows={2} value={form.note} disabled={disabled}
            onChange={(e) => setForm((c) => ({ ...c, note: e.target.value }))} maxLength={2000} />
        </Field>
      </div>
    </div>
  );
}

export function ScenarioPicker({ value, onChange, disabled }) {
  return (
    <div className="insp-demo">
      <div className="insp-manual-head">
        <span className="ui-badge tone-hold">Demo mode</span>
        <strong>Demo scenario</strong>
      </div>
      <p className="hint">The backend is running with DEMO_MODE=true: perception is simulated from the scenario below, not read from your photos.</p>
      <div className="chip-group" role="radiogroup" aria-label="Demo scenario">
        {DEMO_SCENARIOS.map((s) => (
          <button key={s.key} type="button" role="radio" aria-checked={value === s.key} disabled={disabled}
            className={`chip ${value === s.key ? 'active' : ''}`} onClick={() => onChange(value === s.key ? '' : s.key)}>
            {s.label}
            <span className={`chip-outcome o-${s.expected === 'PENDING_REVIEW' ? 'UNCERTAIN' : s.expected}`}>{s.expected === 'EXCEPTION' ? 'Fail' : s.expected === 'PASS' ? 'Pass' : 'Uncertain'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── evidence uploader ──

/**
 * Upload photos to an existing inspection: per-batch view classification (overridable per file), client checks
 * mirroring the backend, per-file status, returned image ids. Calls onUploaded(images) after each successful batch.
 */
export function EvidenceUploader({ inspectionId, existingCount = 0, onUploaded, onQueueChange }) {
  const env = useInspectionEnv();
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [batchView, setBatchView] = useState('carton');
  const [busy, setBusy] = useState(false);
  const checked = useRef(new Set());

  const remaining = Math.max(0, env.maxImages - existingCount);
  const ready = items.filter((i) => i.status === 'ready');
  useEffect(() => { onQueueChange?.(ready.length); }, [ready.length, onQueueChange]);

  // Deep checks (magic bytes etc.) for newly added files.
  useEffect(() => {
    items.forEach((item) => {
      if (item.status !== 'ready' || checked.current.has(item.id)) return;
      checked.current.add(item.id);
      checkImageFile(item.file, { extensions: env.extensions, maxSizeMb: env.maxSizeMb }).then((reason) => {
        if (reason) setItems((list) => updateFileItem(list, item.id, { status: 'rejected', message: reason }));
      });
    });
  }, [items, env.extensions, env.maxSizeMb]);

  const onChange = (next) => {
    // New items take the current batch view.
    setItems(next.map((item) => (item.meta.view ? item : { ...item, meta: { ...item.meta, view: batchView } })));
  };

  const upload = async () => {
    const queue = items.filter((i) => i.status === 'ready');
    if (!queue.length) return;
    setBusy(true);
    const views = [...new Set(queue.map((i) => i.meta.view || 'other'))];
    let uploaded = 0;
    for (const view of views) {
      const group = queue.filter((i) => (i.meta.view || 'other') === view);
      const ids = new Set(group.map((i) => i.id));
      setItems((list) => list.map((i) => (ids.has(i.id) ? { ...i, status: 'uploading', message: '' } : i)));
      try {
        const result = await uploadInspectionImages(inspectionId, group.map((i) => i.file), view);
        const images = result?.images || [];
        setItems((list) => list.map((i) => {
          if (!ids.has(i.id)) return i;
          const index = group.findIndex((g) => g.id === i.id);
          const image = images[index];
          return { ...i, status: 'done', message: image ? `${image.image_id} · ${viewLabel(image.image_type)}` : 'Uploaded', meta: { ...i.meta, image } };
        }));
        uploaded += images.length;
        onUploaded?.(images);
      } catch (error) {
        setItems((list) => list.map((i) => (ids.has(i.id) ? { ...i, status: 'error', message: error.message } : i)));
        toast.error(error, `Upload of ${viewLabel(view).toLowerCase()} photos failed`);
      }
    }
    setBusy(false);
    if (uploaded) toast.success(`${uploaded} photo(s) uploaded`);
  };

  const retryFailed = () => setItems((list) => list.map((i) => (i.status === 'error' ? { ...i, status: 'ready', message: '' } : i)));
  const failedCount = items.filter((i) => i.status === 'error').length;
  const accept = useMemo(() => env.extensions, [env.extensions]);

  return (
    <div className="stack insp-uploader">
      <div className="insp-batch">
        <span className="field-label">Classify the next files as</span>
        <div className="segmented-control" role="radiogroup" aria-label="Capture view for new files">
          {CAPTURE_VIEWS.map((v) => (
            <button key={v.key} type="button" role="radio" aria-checked={batchView === v.key}
              className={batchView === v.key ? 'active' : ''} onClick={() => setBatchView(v.key)} title={v.hint}>
              {v.label}
            </button>
          ))}
        </div>
        <span className="hint">{CAPTURE_VIEWS.find((v) => v.key === batchView)?.hint}</span>
      </div>
      <FileDropzone
        items={items}
        onChange={onChange}
        accept={accept}
        maxSizeMb={env.maxSizeMb}
        maxFiles={remaining || undefined}
        disabled={busy || remaining === 0}
        label={remaining === 0 ? `Image limit reached (${env.maxImages} per inspection)` : 'Drop delivery photos here or browse'}
        hint={`${env.extensions.join(', ')} · ${remaining} of ${env.maxImages} slots left`}
        renderExtra={(item) => (
          <label className="insp-file-view">
            <span className="sr-only">View for {item.file.name}</span>
            <select className="filter-select" value={item.meta.view || 'other'} disabled={item.status !== 'ready'}
              onChange={(e) => setItems((list) => updateFileItem(list, item.id, { meta: { ...item.meta, view: e.target.value } }))}>
              {CAPTURE_VIEWS.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
            </select>
          </label>
        )}
      />
      <div className="ui-button-row">
        <button type="button" className="btn-primary" onClick={upload} disabled={busy || !ready.length}>
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="upload" size={15} />}
          {busy ? 'Uploading…' : `Upload ${ready.length || ''} photo(s)`}
        </button>
        {failedCount > 0 && !busy && <button type="button" className="btn-theme" onClick={retryFailed}><Icon name="refresh" size={14} /> Retry {failedCount} failed</button>}
        {items.some((i) => ['done', 'rejected'].includes(i.status)) && !busy && (
          <button type="button" className="detail-btn" onClick={() => setItems((list) => list.filter((i) => !['done', 'rejected'].includes(i.status)))}>Clear finished</button>
        )}
      </div>
    </div>
  );
}

export { createFileItems, VerdictBadge };

// ── run outcome notice ──

/**
 * Says honestly how the latest verdict was reached. `outcome` comes from runOutcome() (helpers.js).
 * Shows exactly VISION_UNAVAILABLE_MESSAGE when no provider could analyse the photos and no operator counts exist.
 */
export function RunOutcomeNotice({ outcome }) {
  if (!outcome || outcome.kind === 'not_run' || outcome.kind === 'complete') return null;
  if (outcome.kind === 'pending_review') {
    if (outcome.visionStatus === 'unavailable' || !outcome.failureReason || outcome.failureReason === VISION_UNAVAILABLE_MESSAGE) {
      return <VisionUnavailableAlert />;
    }
    return (
      <div className="alert alert-warning" role="status">
        <Icon name="alert" size={16} />
        <span className="alert-text">{outcome.failureReason} — manual review required.</span>
      </div>
    );
  }
  if (outcome.kind === 'operator_only') {
    return (
      <div className="alert alert-hold" role="status">
        <Icon name="info" size={16} />
        <span className="alert-text">
          Vision analysis was not available{outcome.visionReason && outcome.visionReason !== VISION_UNAVAILABLE_MESSAGE ? ` (${outcome.visionReason})` : ''}. This verdict is based on
          operator counts only — checks without an operator reading stay Uncertain.
        </span>
      </div>
    );
  }
  if (outcome.kind === 'demo') {
    return (
      <div className="alert alert-hold" role="status">
        <Icon name="flask" size={16} />
        <span className="alert-text">
          Demo mode: perception was simulated by the backend demo provider{outcome.operator ? ' and fused with your operator counts' : ''}; it was not read from the uploaded photos.
        </span>
      </div>
    );
  }
  return null;
}

// ── small inputs ──

/** Value that settles `delay` ms after the last change. */
export function useDebounced(value, delay = 350) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** Text input bound to an external value (e.g. a URL query key); onCommit fires debounced and on Enter. */
export function DebouncedInput({ value = '', onCommit, placeholder, label, delay = 400, className = 'filter-input' }) {
  const [text, setText] = useState(value || '');
  const sent = useRef(value || '');
  const timer = useRef(null);
  useEffect(() => {
    if ((value || '') !== sent.current) { sent.current = value || ''; setText(value || ''); }
  }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const commit = (next) => {
    window.clearTimeout(timer.current);
    if (next === sent.current) return;
    sent.current = next;
    onCommit(next);
  };
  return (
    <label className="insp-filter-input">
      <span className="sr-only">{label || placeholder}</span>
      <input
        type="text"
        className={className}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => commit(next.trim()), delay);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(text.trim()); }}
      />
    </label>
  );
}
