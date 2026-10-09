import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeInspectionStream,
  createInspection,
  getInspection,
  overrideInspection,
  uploadPhotosOneByOne,
} from '../services/api';
import { prepareImage } from '../services/imagePrep';
import {
  CAPTURE_VIEWS,
  checkCategory,
  checkLabel,
  checkMeta,
  decisionMeta,
  effectiveDecision,
  fmtValue,
  formatBytes,
  formatTime,
  inspectedAt,
  isAnalyzed,
  nextStep,
  poSignature,
  shortHash,
  viewLabel,
  viewLongLabel,
} from '../constants';
import PoEditor, { hasPoErrors, toPoPayload } from './PoEditor';
import AgentConsole, { TRACE_HIDDEN } from './AgentConsole';
import CheckBoard from './CheckBoard';
import Pipeline, { stationStates } from './Pipeline';
import { CheckStatus, DecisionPill, EvidenceImage, Icon, Panel, VerifyIntegrity } from './Shared';

const PHASE_TEXT = {
  creating: 'Opening inspection…',
  uploading: 'Uploading evidence…',
  analyzing: 'Running inspection…',
  overriding: 'Recording override…',
};
const EMPTY_RUN = { events: [], waiting: null, startedAt: 0, elapsed: 0 };
const CHECK_TYPE = {
  sku_check: 'sku', carton_check: 'carton', units_per_carton_check: 'units_per_carton', quantity_check: 'quantity',
  variant_check: 'variant', damage_check: 'damage', component_check: 'components',
};
const SHORT = { sku: 'SKU', carton: 'CTN', units_per_carton: 'U/C', quantity: 'QTY', variant: 'VAR', damage: 'DMG', components: 'KIT' };
const MIN_CONFIDENCE = 0.6; // mirrors the backend floor; used only to grey out weak reads in the evidence list
const DEFAULT_LIMITS = { max_image_size_mb: 10, upload_max_images: 20 }; // backend defaults until /api/health reports them
const DISPOSITION = {
  putaway: 'Release the delivery to putaway.',
  quarantine: 'Quarantine the delivery and raise a supplier claim for the failed checks.',
  hold_for_review: 'Hold the delivery for a person to review before putaway.',
};
const STEPS = [
  { n: 1, key: 'po', label: 'Shipment & PO', sub: 'Expected values' },
  { n: 2, key: 'evidence', label: 'Evidence', sub: 'Upload photos' },
  { n: 3, key: 'analysis', label: 'Analysis', sub: 'Run inspection' },
  { n: 4, key: 'results', label: 'Results', sub: 'Verdict & evidence' },
];

const latestRecord = (...records) =>
  records.filter(Boolean).sort((a, b) => (b.version || 0) - (a.version || 0))[0] || null;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

// How the photos voted: each candidate value's share of the evidence weight, with the 70% bar it must clear.
function EvidenceSplit({ consensus }) {
  const votes = Object.entries(consensus?.votes || {}).sort((a, b) => b[1] - a[1]);
  if (votes.length < 2) return null;
  const total = votes.reduce((sum, [, weight]) => sum + weight, 0) || 1;
  return (
    <div className="split" aria-label={`Photos split; winning share ${Math.round((consensus.share || 0) * 100)}%`}>
      <div className="split__bar">
        {votes.map(([value, weight]) => <span key={value} className="split__seg" style={{ '--w': `${(weight / total) * 100}%` }} title={`${value}: ${weight}`} />)}
        <span className="split__mark" title="A value needs 70% of the weight" />
      </div>
      <div className="split__legend">{votes.map(([value, weight]) => <span key={value}>{value} · {Math.round((weight / total) * 100)}%</span>)}</div>
    </div>
  );
}

function EvidenceItem({ check, index, reads, photoName }) {
  const meta = checkMeta(check.status);
  const category = check.status === 'FAIL' ? checkCategory(check.check_name) : '';
  const hint = check.status === 'UNCERTAIN' ? nextStep(check) : '';
  // Counts from close-ups are kept as evidence but do not vote on the shipment total.
  const partial = new Set((check.measurements?.excluded_partial_view_readings || []).map((r) => r.image_id));
  return (
    <li className={`evid__item evid__item--${meta.tone}`} style={{ '--i': index }}>
      <div className="evid__head">
        <h3>{checkLabel(check.check_name)}</h3>
        {category && <span className="tag tag--fail">{category}</span>}
        {typeof check.confidence === 'number' && check.confidence > 0 && <span className="tag mono" title="Confidence reported by the backend for this check">conf {Math.round(check.confidence * 100)}%</span>}
        <CheckStatus status={check.status} />
      </div>
      <div className="evid__vals">
        <span><em>Expected</em>{fmtValue(check.expected_value)}</span>
        <span><em>Observed</em>{fmtValue(check.observed_value)}</span>
      </div>
      <p className="evid__reason">{check.reason}{check.reason_code && <code>{check.reason_code}</code>}</p>
      {hint && <p className="evid__hint"><Icon name="camera" size={13} /> {hint}</p>}
      <EvidenceSplit consensus={check.measurements?.consensus} />
      {reads.length > 0 && (
        <div className="evid__reads">
          {reads.map((read) => (
            <span key={read.evidence_id} className={`read ${read.confidence < MIN_CONFIDENCE || partial.has(read.image_id) ? 'read--weak' : ''}`}
              title={`${read.description}${read.confidence < MIN_CONFIDENCE ? ' (below the 0.6 confidence floor: not counted)'
                : partial.has(read.image_id) ? ' (partial view: kept as evidence, not counted as the shipment total)' : ''}`}>
              <i>{photoName(read.image_id)}</i><b>{read.observation}</b><i>{Math.round(read.confidence * 100)}%</i>
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function SetupNotice({ perception }) {
  if (!perception) return null;
  const state = perception.probe || (perception.mode === 'live' ? 'unknown' : 'not_configured');
  if (state === 'ok' || state === 'reachable' || state === 'unknown') return null;
  const title = {
    not_configured: 'Vision is not configured. Real photos cannot be read yet.',
    key_rejected: 'The AI provider rejected the server\'s API key.',
    model_not_found: `Model "${perception.model}" is not available for this key.`,
    no_access: `This key has no access to "${perception.model}".`,
    unreachable: 'The server cannot reach the AI endpoint.',
    rate_limited: 'The AI key is rate-limited or out of quota.',
    error: 'The AI provider check failed.',
  }[state] || 'Vision is not ready.';
  return (
    <div className="alert alert--hold" role="status">
      <Icon name="key" size={16} />
      <div className="alert__text">
        <strong>{title}</strong>
        Inspections still run, but the photos are not read: the result is <b>UNCERTAIN · Not analyzed</b> and the delivery is held for a person (fail-open). {perception.probe_detail}
        {state === 'not_configured' && (
          <ol>
            <li>Put a key in the repo-root <code>.env</code>: <code>AI_API_KEY=sk-…</code> (OpenAI), or set <code>OPENAI_BASE_URL</code> for an OpenAI-compatible server.</li>
            <li>Pick a vision model with <code>AI_MODEL</code> (now <code>{perception.model}</code>).</li>
            <li>Restart the backend. The status in the top bar re-checks the key with the provider automatically.</li>
          </ol>
        )}
      </div>
    </div>
  );
}

function Stepper({ step, reachable, complete, onGo }) {
  return (
    <nav className="stepper" aria-label="Inspection steps">
      <ol>
        {STEPS.map((item) => {
          const state = item.n === step ? 'current' : complete[item.n] ? 'done' : 'todo';
          return (
            <li key={item.key} className={`stepper__item is-${state}`}>
              <button type="button" disabled={!reachable[item.n]} onClick={() => onGo(item.n)} aria-current={item.n === step ? 'step' : undefined}>
                <span className="stepper__n">{state === 'done' ? <Icon name="check" size={14} /> : item.n}</span>
                <span className="stepper__text"><b>{item.label}</b><small>{item.sub}</small></span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default function ScannerView({
  poForm, setPoForm, inspection, setInspection, analysis, setAnalysis, perception, limits, onChanged, onError, onLiveChange, onNavigate,
}) {
  const [step, setStep] = useState(1);
  const [showPoErrors, setShowPoErrors] = useState(false);
  const [queue, setQueue] = useState([]);
  const [preparing, setPreparing] = useState(0);
  const [phase, setPhase] = useState('');
  const [upload, setUpload] = useState(null); // { done, total } while photos are being stored
  const [selectedView, setSelectedView] = useState(CAPTURE_VIEWS[0].key);
  const [dragging, setDragging] = useState(false);
  const [fileErrors, setFileErrors] = useState([]);
  const [runError, setRunError] = useState('');
  const [run, setRun] = useState(EMPTY_RUN);
  const [overrideDecision, setOverrideDecision] = useState('EXCEPTION');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const cameraRef = useRef(null);
  const topRef = useRef(null);
  const maxMb = limits?.max_image_size_mb || DEFAULT_LIMITS.max_image_size_mb;
  const maxImages = limits?.upload_max_images || DEFAULT_LIMITS.upload_max_images;

  // Revoke queued thumbnail URLs on unmount.
  const queueRef = useRef(queue);
  queueRef.current = queue;
  useEffect(() => () => queueRef.current.forEach((item) => URL.revokeObjectURL(item.url)), []);

  // A different inspection on screen (opened from history) gets a clean trace and lands on the right step;
  // ids this view created keep theirs.
  const ownIdRef = useRef(null);
  useEffect(() => {
    const id = inspection?.inspection_id || null;
    if (id !== ownIdRef.current) {
      ownIdRef.current = id;
      setRun(EMPTY_RUN);
      setRunError('');
      if (inspection) setStep(isAnalyzed(inspection) ? 4 : inspection.images?.length ? 3 : 2);
      else setStep(1);
    }
  }, [inspection?.inspection_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const analyzing = phase === 'analyzing';
  useEffect(() => { onLiveChange?.(analyzing); }, [analyzing, onLiveChange]);

  // Wall-clock timer while the agent runs (each event also carries the server's own t_ms).
  useEffect(() => {
    if (!analyzing) return undefined;
    const timer = setInterval(() => setRun((current) => ({ ...current, elapsed: Date.now() - current.startedAt })), 200);
    return () => clearInterval(timer);
  }, [analyzing]);

  const goStep = (n) => {
    setStep(n);
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const busy = Boolean(phase) || preparing > 0;
  const analyzed = isAnalyzed(inspection);
  const poDirty = Boolean(inspection) && poSignature(toPoPayload(poForm)) !== poSignature(inspection.po);
  const uploaded = poDirty ? [] : inspection?.images || [];
  const hasEvidence = queue.length > 0 || uploaded.length > 0;
  const poInvalid = hasPoErrors(poForm);
  const visionOk = perception && perception.mode === 'live' && !['key_rejected', 'model_not_found', 'no_access', 'unreachable'].includes(perception.probe);
  const hasPallet = [...uploaded.map((i) => i.image_type), ...queue.map((q) => q.view)].includes('pallet');

  const logLocal = (message) =>
    setRun((current) => ({ ...current, events: [...current.events, { type: 'local', message }] }));

  const addFiles = async (files) => {
    if (!files.length || phase) return; // preparing more photos while earlier ones resize is fine
    const problems = [];
    const room = maxImages - uploaded.length - queue.length - preparing;
    if (files.length > room) {
      problems.push(`This inspection accepts at most ${maxImages} photos; ${Math.max(0, room)} more can be added.`);
      files = files.slice(0, Math.max(0, room));
    }
    setPreparing((count) => count + files.length);
    const view = selectedView;
    for (const raw of files) {
      try {
        const prepared = await prepareImage(raw);
        if (prepared.file.size > maxMb * 1048576) throw new Error(`${raw.name}: ${formatBytes(prepared.file.size)} is over the ${maxMb} MB limit.`);
        setQueue((current) => [...current, {
          id: `${Date.now()}-${Math.random()}`, view, file: prepared.file, note: prepared.note, url: URL.createObjectURL(prepared.file),
        }]);
      } catch (error) {
        problems.push(error.message);
      } finally {
        setPreparing((count) => count - 1);
      }
    }
    setFileErrors(problems);
  };

  const removeQueued = (ids) => {
    setQueue((current) => {
      current.filter((item) => ids.includes(item.id)).forEach((item) => URL.revokeObjectURL(item.url));
      return current.filter((item) => !ids.includes(item.id));
    });
  };

  const resetInspection = () => {
    removeQueued(queue.map((item) => item.id));
    setInspection(null);
    setAnalysis(null);
    setRun(EMPTY_RUN);
    setRunError('');
    setFileErrors([]);
    setOverrideReason('');
    setOverrideNote('');
    setShowPoErrors(false);
    goStep(1);
  };

  const ensureInspection = async () => {
    if (inspection && !poDirty) return inspection;
    setPhase('creating');
    const created = await createInspection(toPoPayload(poForm));
    ownIdRef.current = created.inspection_id;
    setInspection(created);
    setAnalysis(null);
    logLocal(`Inspection ${created.inspection_id} opened for ${created.po?.po_id}.`);
    onChanged();
    return created;
  };

  const uploadQueue = async (target) => {
    const items = [...queue];
    setPhase('uploading');
    setUpload({ done: 0, total: items.length });
    try {
      await uploadPhotosOneByOne(target.inspection_id, items, (done, total, item, stored) => {
        setUpload({ done, total });
        removeQueued([item.id]);
        logLocal(`Server stored ${viewLabel(item.view).toLowerCase()} photo ${done}/${total}${stored?.sha256_digest ? `, SHA-256 ${shortHash(stored.sha256_digest)}` : ''}.`);
      });
    } finally {
      setUpload(null);
      // Even if a later photo failed, show the photos that did reach the record.
      const refreshed = await getInspection(target.inspection_id).catch(() => null);
      if (refreshed) setInspection(refreshed);
      target = refreshed || target;
    }
    return target;
  };

  // Step 2 action: persist the queued photos now (the server confirms each one).
  const handleUpload = async () => {
    onError('');
    setFileErrors([]);
    try {
      const target = await ensureInspection();
      if (queue.length) await uploadQueue(target);
      onChanged();
    } catch (error) {
      setFileErrors([error.message || 'Upload failed.']);
    } finally {
      setPhase('');
    }
  };

  const handleRun = async () => {
    if (busy) return; // guard against double submission
    onError('');
    setRunError('');
    setRun(EMPTY_RUN);
    try {
      let target = await ensureInspection();
      if (queue.length) target = await uploadQueue(target);
      setRun((current) => ({ ...current, startedAt: Date.now(), elapsed: 0 }));
      setPhase('analyzing');
      const result = await analyzeInspectionStream(target.inspection_id, '', (event) => {
        setRun((current) => {
          if (event.type === 'heartbeat') return { ...current, waiting: event };
          return { ...current, waiting: TRACE_HIDDEN.has(event.type) ? current.waiting : null, events: [...current.events, event] };
        });
      });
      setAnalysis(result);
      try {
        setInspection(await getInspection(target.inspection_id));
      } catch (error) {
        onError(`Analysis was recorded, but reloading the inspection failed: ${error.message}`);
      }
      onChanged();
      setPhase('');
      goStep(4);
      return;
    } catch (error) {
      setRunError(error.message || 'Inspection failed.');
      setRun((current) => ({
        ...current,
        waiting: null,
        events: error.streamed ? current.events : [...current.events, { type: 'error', message: error.message }],
      }));
      onChanged();
    }
    setPhase('');
  };

  const handleOverride = async () => {
    if (!overrideReason.trim()) {
      setOverrideNote('A reason is required for every override.');
      return;
    }
    setOverrideNote('');
    onError('');
    setPhase('overriding');
    try {
      const result = await overrideInspection(inspection.inspection_id, overrideDecision, overrideReason.trim());
      setAnalysis((current) => (current ? { ...current, record: result.record } : current));
      setInspection(await getInspection(inspection.inspection_id));
      setOverrideReason('');
      onChanged();
    } catch (error) {
      setOverrideNote(error.message);
    } finally {
      setPhase('');
    }
  };

  // ---- derive the live picture from real streamed events ---------------------------------------------
  const ev = run.events;
  const live = useMemo(() => {
    const has = (type) => ev.some((event) => event.type === type);
    const last = (type) => [...ev].reverse().find((event) => event.type === type);
    const inModel = (has('perception') && !has('perception_done') && !has('perception_failed'))
      || (has('second_look') && !has('second_look_done') && !has('second_look_failed'));
    const readingEvents = ev.filter((event) => event.type === 'model_reading');
    const currentStage = has('second_look') && !has('second_look_done') ? 'second_look' : 'perception';
    const stageReads = readingEvents.filter((event) => (event.stage || 'perception') === currentStage);
    const reading = inModel ? stageReads[stageReads.length - 1]?.image_id : null;
    const observed = {};
    ev.filter((event) => event.type === 'model_observation').forEach((event) => {
      observed[event.image_id] = [...new Set([...(observed[event.image_id] || []), event.check_type])];
    });
    const photos = Object.fromEntries(ev.filter((event) => event.type === 'photo').map((event) => [event.image_id, event]));
    const modelDone = ev.filter((event) => event.type === 'perception_done' || event.type === 'second_look_done');
    const tokensIn = modelDone.reduce((sum, event) => sum + (event.input_tokens || 0), 0);
    const tokensOut = modelDone.reduce((sum, event) => sum + (event.output_tokens || 0), 0);
    const modelMs = modelDone.reduce((sum, event) => sum + (event.model_ms || 0), 0);
    const progress = last('model_progress');
    return {
      inModel, reading, observed, photos,
      readIds: new Set(stageReads.map((event) => event.image_id).filter((id) => id !== reading)),
      tokensIn, tokensOut, modelMs, streamedChars: progress?.chars || 0,
      checks: ev.filter((event) => event.type === 'check').map((event) => event.check),
      decision: last('decision')?.decision,
      status: [...ev].reverse().find((event) => !TRACE_HIDDEN.has(event.type)),
    };
  }, [ev]);

  const checks = analyzing ? live.checks : (poDirty ? [] : inspection?.checks || []);
  const decision = analyzing ? live.decision : (analyzed && !poDirty ? effectiveDecision(inspection) : null);
  const record = latestRecord(inspection?.record, analysis?.record);
  const failureReason = analyzing ? '' : analysis?.failure_reason || record?.outcome?.failure_reason;
  const modelVersion = record?.checks?.find((check) => check.model_version && check.model_version !== 'rules')?.model_version;
  const overrides = inspection?.overrides?.length ? inspection.overrides : record?.overrides || [];
  const evidence = poDirty ? [] : (analyzing ? [] : inspection?.evidence || analysis?.evidence || []);
  const photoName = (imageId) => {
    const index = uploaded.findIndex((image) => image.image_id === imageId);
    return index >= 0 ? `#${index + 1} ${viewLabel(uploaded[index].image_type)}` : imageId;
  };
  const meta = decision ? decisionMeta(decision) : null;
  const states = stationStates({
    events: poDirty ? [] : ev, phase, hasInspection: Boolean(inspection) && !poDirty, hasPhotos: uploaded.length > 0, analyzed: analyzed && !poDirty,
  });
  const expected = (() => {
    const po = toPoPayload(poForm);
    return {
      sku_check: po.sku, carton_check: po.expected_cartons, units_per_carton_check: po.units_per_carton,
      quantity_check: po.expected_quantity, variant_check: po.variant, damage_check: 'none', component_check: po.expected_components,
    };
  })();
  const failed = checks.filter((check) => check.status === 'FAIL');
  const uncertain = checks.filter((check) => check.status === 'UNCERTAIN');
  const showResults = analyzed && !poDirty;

  const reachable = { 1: !busy, 2: !busy && !poInvalid, 3: !busy && !poInvalid && hasEvidence, 4: !busy && showResults };
  const complete = { 1: !poInvalid && (Boolean(inspection) && !poDirty), 2: uploaded.length > 0 && !queue.length, 3: showResults, 4: false };

  const continueFromPo = () => {
    if (poInvalid) { setShowPoErrors(true); return; }
    goStep(2);
  };

  const runLabel = phase ? PHASE_TEXT[phase]
    : preparing ? 'Preparing photos…'
      : showResults && !queue.length ? 'Re-run inspection' : 'Run inspection';
  const headline = analyzing ? (live.reading ? 'Reading photos' : live.inModel ? 'Vision model working' : 'Applying rules')
    : phase === 'uploading' ? 'Uploading evidence' : phase === 'creating' ? 'Opening inspection'
      : runError ? 'Inspection did not complete'
        : meta ? 'Inspection complete' : 'Ready to run';
  const message = analyzing ? (run.waiting && !live.reading ? run.waiting.message : live.status?.message || 'Starting…')
    : upload ? `Uploading photo ${Math.min(upload.done + 1, upload.total)} of ${upload.total}…`
      : runError ? runError
        : meta ? (inspection?.agent_summary || meta.line)
          : `${uploaded.length + queue.length} photo(s) will be analyzed against PO ${toPoPayload(poForm).po_id || '—'} in one batched vision call.`;

  return (
    <div className="workspace" ref={topRef}>
      <Stepper step={step} reachable={reachable} complete={complete} onGo={goStep} />

      {inspection && (
        <div className="context-bar">
          <span className="context-bar__id mono">{inspection.inspection_id}</span>
          <span className="muted">PO <b className="mono">{inspection.po?.po_id}</b> · {inspection.po?.product_name}</span>
          {showResults && <DecisionPill decision={effectiveDecision(inspection)} />}
          <span className="muted context-bar__time">Created {formatTime(inspection.created_at)}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={resetInspection} disabled={busy}>
            <Icon name="plus" size={14} /> Start new inspection
          </button>
        </div>
      )}
      {poDirty && (
        <div className="alert alert--warn" role="status">
          <Icon name="alert" size={16} />
          <span className="alert__text">
            The PO line changed after inspection {inspection.inspection_id} was opened. The next upload or run opens a fresh inspection
            {inspection.images?.length ? ' (photos already stored stay with the original inspection)' : ''}.
          </span>
        </div>
      )}

      {/* ---- Step 1: shipment & PO ------------------------------------------------------------------ */}
      {step === 1 && (
        <Panel title="Shipment and purchase-order information" icon="clipboard"
          sub="Enter the PO line this delivery is checked against. Fields marked * are required by the backend inspection schema.">
          <PoEditor form={poForm} setForm={setPoForm} disabled={busy} showErrors={showPoErrors} />
          <div className="step-actions">
            <span className="muted">{poInvalid && showPoErrors ? 'Fix the highlighted fields to continue.' : ''}</span>
            <button type="button" className="btn btn--primary" onClick={continueFromPo} disabled={busy}>
              Continue to evidence <Icon name="chevronRight" size={16} />
            </button>
          </div>
        </Panel>
      )}

      {/* ---- Step 2: evidence -------------------------------------------------------------------------- */}
      {step === 2 && (
        <Panel title="Image and evidence upload" icon="camera"
          actions={<span className="tag">{uploaded.length} stored · {queue.length} queued · max {maxImages}</span>}
          sub="Choose what the next photos show, then add them. Photos are queued in this browser until the server confirms the upload.">
          <div className="views" role="group" aria-label="Evidence category for the next photos">
            {CAPTURE_VIEWS.map((view) => (
              <button key={view.key} type="button" aria-pressed={selectedView === view.key} disabled={Boolean(phase)}
                className={`view-chip ${selectedView === view.key ? 'is-on' : ''}`} onClick={() => setSelectedView(view.key)}>
                <Icon name={view.icon} size={14} />{view.label}
              </button>
            ))}
          </div>
          <p className="view-hint">{CAPTURE_VIEWS.find((view) => view.key === selectedView)?.hint}</p>

          <label className={`drop ${dragging ? 'is-over' : ''} ${phase ? 'is-disabled' : ''}`}
            onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer?.files || [])); }}>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic" multiple disabled={Boolean(phase)}
              onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; addFiles(files); }} />
            <span className="drop__icon"><Icon name="upload" size={22} /></span>
            <strong>{preparing ? `Preparing ${preparing} photo(s)…` : <>Drop <u>{viewLongLabel(selectedView).toLowerCase()}</u> photos here, or click to browse</>}</strong>
            <small>JPEG, PNG or WebP · up to {maxMb} MB each · large phone photos are resized to 2048 px and EXIF-rotated in the browser</small>
          </label>
          <div className="drop__actions">
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden
              onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; addFiles(files); }} />
            <button type="button" className="btn btn--sm" disabled={Boolean(phase)} onClick={() => cameraRef.current?.click()}>
              <Icon name="camera" size={14} /> Use camera
            </button>
          </div>

          {fileErrors.length > 0 && (
            <div className="alert alert--fail" role="alert" style={{ marginTop: 12 }}>
              <Icon name="alert" size={16} />
              <div className="alert__text">{fileErrors.map((problem) => <div key={problem}>{problem}</div>)}</div>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFileErrors([])}>Dismiss</button>
            </div>
          )}

          {upload && (
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={upload.total} aria-valuenow={upload.done}
              aria-label="Upload progress">
              <div className="progress__bar"><i style={{ width: `${(upload.done / upload.total) * 100}%` }} /></div>
              <span>{upload.done} of {upload.total} confirmed by the server</span>
            </div>
          )}

          {(queue.length > 0 || uploaded.length > 0) && (
            <div className="shots">
              {uploaded.map((image, index) => (
                <figure key={image.image_id} className="shot">
                  <EvidenceImage inspectionId={inspection.inspection_id} imageId={image.image_id} alt={image.filename} />
                  <span className="shot__state shot__state--ok"><Icon name="check" size={10} /> stored #{index + 1}</span>
                  <figcaption><b>{viewLabel(image.image_type)}</b><span title={image.sha256_digest}>{shortHash(image.sha256_digest)}</span></figcaption>
                </figure>
              ))}
              {queue.map((item) => (
                <figure key={item.id} className="shot shot--queued">
                  <img src={item.url} alt={`Queued ${viewLabel(item.view)} photo ${item.file.name}`} />
                  <span className="shot__state">queued</span>
                  <figcaption><b>{viewLabel(item.view)}</b><span>{item.note || `${item.file.name} · ${formatBytes(item.file.size)}`}</span></figcaption>
                  <button type="button" className="shot__x" disabled={Boolean(phase)} onClick={() => removeQueued([item.id])} aria-label={`Remove ${item.file.name}`}>
                    <Icon name="x" size={12} />
                  </button>
                </figure>
              ))}
            </div>
          )}
          {uploaded.length > 0 && (
            <p className="field__help" style={{ marginTop: 8 }}>Stored photos are part of the inspection's evidence and cannot be removed (the backend has no delete endpoint). To change evidence, start a new inspection.</p>
          )}
          {hasEvidence && !hasPallet && (
            <div className="alert alert--info" style={{ marginTop: 12 }}>
              <Icon name="layers" size={16} />
              <span className="alert__text">No receiving / pallet photo yet. Without one view of every carton, the carton count and total quantity checks stay <b>UNCERTAIN</b>.</span>
            </div>
          )}
          {!hasEvidence && (
            <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>Recommended set: one pallet photo with every carton in frame, a label close-up, a carton exterior and an opened unit.</p>
          )}

          <div className="step-actions">
            <button type="button" className="btn btn--ghost" onClick={() => goStep(1)} disabled={busy}><Icon name="chevronLeft" size={16} /> Back</button>
            <div className="step-actions__end">
              {queue.length > 0 && (
                <button type="button" className="btn" onClick={handleUpload} disabled={busy} aria-busy={phase === 'uploading'}>
                  {phase === 'uploading' || phase === 'creating' ? <span className="spinner" aria-hidden="true" /> : <Icon name="upload" size={15} />}
                  Upload {queue.length} photo{queue.length === 1 ? '' : 's'}
                </button>
              )}
              <button type="button" className="btn btn--primary" onClick={() => goStep(3)} disabled={busy || !hasEvidence}>
                Continue to analysis <Icon name="chevronRight" size={16} />
              </button>
            </div>
          </div>
        </Panel>
      )}

      {/* ---- Step 3: analysis -------------------------------------------------------------------------- */}
      {step === 3 && (
        <>
          <section className="panel" aria-label="Inspection run">
            <div className="runbar">
              <div className="runbar__state" aria-live="polite">
                <div className="eyebrow">Receiving agent{perception?.model ? ` · ${perception.model}` : ''}</div>
                <h2 className="runbar__title">
                  {(analyzing || phase === 'uploading') && <span className="live-dot" aria-hidden="true" />}{headline}
                </h2>
                <p className={`runbar__msg ${runError ? 'is-error' : ''}`}>{message}</p>
                <div className="runbar__stats">
                  <div className="stat"><b>{secs(run.elapsed || 0)}</b><span>elapsed</span></div>
                  {live.modelMs > 0 && <div className="stat"><b>{secs(live.modelMs)}</b><span>model</span></div>}
                  {(live.streamedChars > 0 || live.tokensOut > 0) && (
                    <div className="stat"><b>{live.tokensOut || `${(live.streamedChars / 1000).toFixed(1)}k`}</b><span>{live.tokensOut ? 'tokens out' : 'chars streamed'}</span></div>
                  )}
                  {live.tokensIn > 0 && <div className="stat"><b>{live.tokensIn.toLocaleString()}</b><span>tokens in</span></div>}
                  <div className="stat"><b>{checks.length}/7</b><span>checks</span></div>
                  <div className="stat"><b>{uploaded.length + queue.length}</b><span>photos</span></div>
                </div>
              </div>
              <div className="runbar__actions">
                <button type="button" className="btn btn--primary btn--lg" onClick={handleRun} disabled={busy || !hasEvidence} aria-busy={busy}>
                  {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name={runError ? 'refresh' : 'play'} size={16} />}
                  {runError && !busy ? 'Retry inspection' : runLabel}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => goStep(2)} disabled={busy}>
                  <Icon name="chevronLeft" size={14} /> Back to evidence
                </button>
              </div>
            </div>
            <Pipeline states={states} />
          </section>

          {runError && !busy && (
            <div className="alert alert--fail" role="alert">
              <Icon name="alert" size={16} />
              <span className="alert__text">
                <strong>The inspection did not complete.</strong>
                {runError} Your PO line and stored photos are kept; you can retry safely.
              </span>
            </div>
          )}
          <SetupNotice perception={perception} />
          {!visionOk && perception && (
            <p className="muted" style={{ fontSize: 13 }}>With vision unavailable, a run ends <b>UNCERTAIN · Not analyzed</b> without reading the photos.</p>
          )}

          {uploaded.length > 0 && (analyzing || Object.keys(live.photos).length > 0) && (
            <Panel title="Photo stage" icon="scan"
              actions={<span className="tag">{live.reading ? 'model reading highlighted photo' : live.inModel ? 'all photos in one model call' : 'per-photo readings'}</span>}>
              <div className="stage">
                {uploaded.map((image, index) => {
                  const reported = live.photos[image.image_id];
                  const isReading = live.reading === image.image_id;
                  const chips = reported ? reported.observations?.filter((o) => o.observation !== null).map((o) => o.check_type)
                    : live.observed[image.image_id] || [];
                  return (
                    <figure key={image.image_id}
                      className={`stage__photo ${isReading ? 'is-reading' : ''} ${live.inModel && !isReading && !live.readIds.has(image.image_id) ? 'is-waiting' : ''} ${reported || live.readIds.has(image.image_id) ? 'is-read' : ''}`}>
                      <EvidenceImage inspectionId={inspection.inspection_id} imageId={image.image_id} alt={`${viewLabel(image.image_type)} photo ${index + 1}`} />
                      <div className="stage__label">
                        <span>#{index + 1} {viewLabel(image.image_type)}</span>
                        {isReading && <span className="is-accent">reading</span>}
                        {reported && <span>{reported.visibility}{reported.shows_whole_shipment ? '' : ' · partial'}</span>}
                      </div>
                      {chips.length > 0 && <div className="stage__chips">{chips.map((c) => <span key={c}>{SHORT[c] || c}</span>)}</div>}
                    </figure>
                  );
                })}
              </div>
            </Panel>
          )}

          <div className="grid-2">
            <Panel title="Checks" icon="ruler" sub="Each row fills in only when the server streams that check's result.">
              <CheckBoard checks={checks} expected={expected} running={analyzing} />
            </Panel>
            <Panel title="Agent trace" icon="stream" actions={analyzing ? <span className="chip chip--live"><span className="chip__dot" />live</span> : null}>
              <AgentConsole events={ev} waiting={run.waiting} />
            </Panel>
          </div>
        </>
      )}

      {/* ---- Step 4: results --------------------------------------------------------------------------- */}
      {step === 4 && !showResults && (
        <Panel>
          <div className="empty">
            <span className="empty__icon"><Icon name="clipboard" size={22} /></span>
            <h3>No result yet</h3>
            <p>Run the inspection to see the verdict and evidence.</p>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => goStep(hasEvidence ? 3 : 1)}>Go to {hasEvidence ? 'analysis' : 'step 1'}</button>
          </div>
        </Panel>
      )}
      {step === 4 && showResults && meta && (
        <>
          <section className={`panel verdict verdict--${meta.tone}`} aria-label="Inspection verdict">
            <div className="verdict__mark">
              <Icon name={meta.tone === 'pass' ? 'check' : meta.tone === 'fail' ? 'x' : 'help'} size={30} />
            </div>
            <div className="verdict__body">
              <div className="verdict__eyebrow">Overall verdict</div>
              <div className="verdict__title">
                <h2>{meta.label}</h2>
                {meta.qualifier && <span className={`tag tag--${meta.tone === 'hold' ? 'hold' : meta.tone}`}>{meta.qualifier}</span>}
                {inspection?.override_decision && <span className="tag tag--accent">Operator override</span>}
                {analysis?.demo_mode && <span className="tag">Scripted demo reading</span>}
              </div>
              <p className="verdict__summary">{inspection?.agent_summary}</p>
              {failureReason && (
                <div className="alert alert--hold"><Icon name="clock" size={16} />
                  <span className="alert__text">The photos were not read: {String(failureReason).replace(/\.+$/, '')}. Held for a person.</span></div>
              )}
              <dl className="meta">
                <div><dt>Inspection ID</dt><dd>{inspection.inspection_id}</dd></div>
                <div><dt>Verdict recorded</dt><dd>{formatTime(inspectedAt(inspection))}</dd></div>
                <div><dt>Disposition</dt><dd>{record?.outcome?.disposition?.replace(/_/g, ' ') || '—'}</dd></div>
                <div><dt>Prep hold</dt><dd>{record?.outcome?.prep_hold ? (record.outcome.hold_reasons || []).join(', ') || 'yes' : 'released'}</dd></div>
                <div><dt>Vision model</dt><dd>{modelVersion || '—'}</dd></div>
                <div><dt>Evidence record</dt><dd>{record ? `v${record.version} · ${shortHash(record.content_hash)}` : '—'}</dd></div>
              </dl>
            </div>
            <div className="verdict__side">
              <div className="verdict__counts">
                <span className="count count--pass"><b>{checks.filter((c) => c.status === 'PASS').length}</b>passed</span>
                <span className="count count--fail"><b>{failed.length}</b>failed</span>
                <span className="count count--warn"><b>{uncertain.length}</b>uncertain</span>
              </div>
              {record && <VerifyIntegrity inspectionId={inspection.inspection_id} />}
            </div>
          </section>

          <div className="grid-2">
            <Panel title="Recommended next action" icon="truck">
              <p className="next-action">{DISPOSITION[record?.outcome?.disposition] || meta.line}</p>
              {failed.length > 0 && (
                <ul className="issue-list">
                  {failed.map((check) => (
                    <li key={check.check_name} className="issue issue--fail">
                      <Icon name="x" size={14} />
                      <span><b>{checkLabel(check.check_name)}</b> — expected {fmtValue(check.expected_value)}, observed {fmtValue(check.observed_value)}.
                        {checkCategory(check.check_name) && <span className="tag tag--fail" style={{ marginLeft: 6 }}>{checkCategory(check.check_name)}</span>}</span>
                    </li>
                  ))}
                </ul>
              )}
              {uncertain.length > 0 && (
                <ul className="issue-list">
                  {uncertain.map((check) => (
                    <li key={check.check_name} className="issue issue--warn">
                      <Icon name="help" size={14} />
                      <span><b>{checkLabel(check.check_name)}</b> — {nextStep(check) || check.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
              {failed.length === 0 && uncertain.length === 0 && <p className="muted" style={{ fontSize: 13 }}>No discrepancies were identified.</p>}
              <p className="field__help" style={{ marginTop: 10 }}>Derived from the sealed record's outcome and each check's backend reason code.</p>
            </Panel>
          </div>
          <Panel title="Expected vs observed" icon="ruler" sub="Expected values come from the PO line; observed values only from what the photos showed.">
            <CheckBoard checks={checks} expected={expected} running={false} />
          </Panel>

          <Panel title="Evidence by check" icon="search"
            sub="What each photo reported for each check, and how the photos voted. Struck-through reads did not count: below the 0.6 confidence floor, or a count from a partial view.">
            {checks.length > 0 ? (
              <ol className="evid">
                {checks.map((check, index) => (
                  <EvidenceItem key={check.check_name} check={check} index={index} photoName={photoName}
                    reads={evidence.filter((e) => e.check_type === CHECK_TYPE[check.check_name])} />
                ))}
              </ol>
            ) : <p className="muted">No checks recorded.</p>}
          </Panel>

          {uploaded.length > 0 && (
            <Panel title="Supporting images" icon="image" actions={<button type="button" className="btn btn--ghost btn--sm" onClick={() => onNavigate?.('evidence')}>Open Evidence Center</button>}>
              <div className="shots shots--lg">
                {uploaded.map((image, index) => (
                  <figure key={image.image_id} className="shot">
                    <EvidenceImage inspectionId={inspection.inspection_id} imageId={image.image_id} alt={image.filename} />
                    <span className="shot__state">#{index + 1}</span>
                    <figcaption><b>{viewLongLabel(image.image_type)}</b><span>{image.image_id} · {shortHash(image.sha256_digest)}</span></figcaption>
                  </figure>
                ))}
              </div>
            </Panel>
          )}

          <Panel title="Override verdict" icon="user"
            sub="Disagree with the agent? Record what you saw. Overrides are appended to the sealed record, never overwritten. PASS requires an approver key.">
            <div className="override">
              <div className="field">
                <label className="field__label" htmlFor="override-decision">New verdict</label>
                <select id="override-decision" className="input select" value={overrideDecision} disabled={busy} onChange={(event) => setOverrideDecision(event.target.value)}>
                  <option value="PASS">PASS (approver only)</option>
                  <option value="EXCEPTION">FAIL (exception)</option>
                  <option value="UNCERTAIN">UNCERTAIN</option>
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="override-reason">Reason<span className="req" aria-hidden="true">*</span></label>
                <input id="override-reason" className="input" value={overrideReason} disabled={busy} maxLength={2000} aria-required="true"
                  onChange={(event) => setOverrideReason(event.target.value)} placeholder="What did you see on the dock that the agent didn't?" />
              </div>
              <button type="button" className="btn btn--primary" onClick={handleOverride} disabled={busy}>
                {phase === 'overriding' ? <span className="spinner" aria-hidden="true" /> : <Icon name="pen" size={15} />}
                {phase === 'overriding' ? 'Recording…' : 'Record override'}
              </button>
            </div>
            {overrideNote && <div className="verify__result verify__result--bad" role="alert" style={{ marginTop: 10 }}>{overrideNote}</div>}
            {overrides.length > 0 && (
              <ol className="history">
                {overrides.map((item) => (
                  <li key={item.override_id || item.created_at}>
                    <div className="history__head">
                      <strong>{decisionMeta(item.from_verdict).label} → {decisionMeta(item.to_verdict).label}</strong>
                      <span>{item.operator_id || 'operator'}{item.role ? ` (${item.role})` : ''} · {formatTime(item.created_at)}</span>
                    </div>
                    <div>{item.reason}</div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <div className="step-actions step-actions--plain">
            <button type="button" className="btn btn--ghost" onClick={() => goStep(3)} disabled={busy}><Icon name="activity" size={15} /> View analysis run</button>
            <div className="step-actions__end">
              <button type="button" className="btn" onClick={() => onNavigate?.('history')}><Icon name="list" size={15} /> Inspection history</button>
              <button type="button" className="btn btn--primary" onClick={resetInspection} disabled={busy}><Icon name="plus" size={15} /> Start new inspection</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
