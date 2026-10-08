import { useEffect, useRef, useState } from 'react';
import {
  analyzeInspection,
  createInspection,
  getInspection,
  overrideInspection,
  uploadInspectionImages,
} from '../services/api';
import {
  CAPTURE_VIEWS,
  PERCEPTION_FAILURE_SCENARIO,
  SCENARIOS,
  agentDecision,
  decisionMeta,
  effectiveDecision,
  isAnalyzed,
  poSignature,
  shortHash,
  viewLabel,
} from '../constants';
import PoEditor, { toPoPayload } from './PoEditor';
import { Card, ChecksTable, DecisionPill, Gallery, HeroStats, Icon, OverrideTimeline, VerifyIntegrity } from './Shared';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHASE_TEXT = {
  creating: 'Creating inspection…',
  uploading: 'Uploading photos…',
  analyzing: 'Agent evaluating…',
  overriding: 'Applying override…',
};

const latestRecord = (...records) =>
  records.filter(Boolean).sort((a, b) => (b.version || 0) - (a.version || 0))[0] || null;

export default function ScannerView({
  poForm, setPoForm, inspection, setInspection, analysis, setAnalysis,
  demoMode, setDemoMode, onChanged, onError, onBusyChange, onOpenBenchmark,
}) {
  const [queue, setQueue] = useState([]);
  const [phase, setPhase] = useState('');
  const [specOpen, setSpecOpen] = useState(false);
  const [activeScenario, setActiveScenario] = useState('correct_shipment');
  const [failOpen, setFailOpen] = useState(false);
  const [dragView, setDragView] = useState('');
  const [overrideDecision, setOverrideDecision] = useState('EXCEPTION');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [status, setStatus] = useState('Ready for inspection creation.');
  const [agentLog, setAgentLog] = useState([{ id: 'boot', text: 'Agent ready. Waiting for receiving intake.', complete: false }]);

  // Revoke queued thumbnail URLs on unmount.
  const queueRef = useRef(queue);
  queueRef.current = queue;
  useEffect(() => () => queueRef.current.forEach((item) => URL.revokeObjectURL(item.url)), []);

  const busy = Boolean(phase);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const analyzed = isAnalyzed(inspection);
  const poDirty = Boolean(inspection) && poSignature(toPoPayload(poForm)) !== poSignature(inspection.po);
  const uploadedCount = inspection?.images?.length ?? 0;

  const appendLog = (text, complete = true) => {
    setAgentLog((current) => [...current.slice(-5), { id: `${Date.now()}-${Math.random()}`, text, complete }]);
  };

  const fail = (label, error) => {
    onError(error.message || `${label} failed.`);
    setStatus(`${label} failed.`);
    appendLog(`${label} failed: ${error.message}`, false);
  };

  const removeQueued = (ids) => {
    setQueue((current) => {
      current.filter((item) => ids.includes(item.id)).forEach((item) => URL.revokeObjectURL(item.url));
      return current.filter((item) => !ids.includes(item.id));
    });
  };

  const addFiles = (viewKey, files) => {
    const accepted = files.filter((file) => ACCEPTED_TYPES.includes(file.type));
    if (accepted.length < files.length) onError('Only JPEG, PNG or WebP photos can be uploaded; other files were skipped.');
    if (!accepted.length) return;
    setQueue((current) => [
      ...current,
      ...accepted.map((file) => ({ id: `${Date.now()}-${Math.random()}`, file, view: viewKey, url: URL.createObjectURL(file) })),
    ]);
    appendLog(`${accepted.length} photo(s) queued for ${viewLabel(viewKey).toLowerCase()}.`);
  };

  const handleFiles = (viewKey, event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = ''; // allow picking the same file again
    addFiles(viewKey, files);
  };

  const handleDrop = (viewKey, event) => {
    event.preventDefault();
    setDragView('');
    if (busy) return;
    addFiles(viewKey, Array.from(event.dataTransfer?.files || []));
  };

  const resetInspection = (message = 'New inspection started. The next run creates a fresh inspection.') => {
    setInspection(null);
    setAnalysis(null);
    setOverrideReason('');
    setOverrideNote('');
    setStatus(message);
    appendLog(message);
  };

  const ensureInspection = async () => {
    if (inspection && !poDirty) return inspection;
    setPhase('creating');
    if (poDirty) appendLog('PO changed since the last inspection; starting a fresh one.');
    const created = await createInspection(toPoPayload(poForm));
    setInspection(created);
    setAnalysis(null);
    appendLog(`Inspection ${created.inspection_id} created for ${created.po?.po_id}.`);
    return created;
  };

  const uploadQueue = async (target) => {
    const views = [...new Set(queue.map((item) => item.view))];
    for (const view of views) {
      const items = queue.filter((item) => item.view === view);
      setPhase('uploading');
      setStatus(`Uploading ${items.length} ${viewLabel(view).toLowerCase()} photo(s)…`);
      const result = await uploadInspectionImages(target.inspection_id, items.map((item) => item.file), view);
      removeQueued(items.map((item) => item.id));
      appendLog(`Uploaded ${result.images?.length ?? items.length} ${viewLabel(view).toLowerCase()} photo(s).`);
    }
    const refreshed = await getInspection(target.inspection_id);
    setInspection(refreshed);
    return refreshed;
  };

  const handleUploadOnly = async () => {
    if (!queue.length) return;
    onError('');
    try {
      const target = await ensureInspection();
      const refreshed = await uploadQueue(target);
      setStatus(`${refreshed.images?.length ?? 0} photo(s) on inspection. Ready for analysis.`);
      onChanged();
    } catch (error) {
      fail('Upload', error);
    } finally {
      setPhase('');
    }
  };

  const handleRun = async () => {
    onError('');
    const scenario = failOpen ? PERCEPTION_FAILURE_SCENARIO : activeScenario;
    try {
      let target = await ensureInspection();
      if (queue.length) target = await uploadQueue(target);
      setPhase('analyzing');
      setStatus(`Running agent analysis (${scenario.replace(/_/g, ' ')})…`);
      appendLog(`Agent evaluating ${target.po?.po_id} with scenario ${scenario.replace(/_/g, ' ')}.`);
      const result = await analyzeInspection(target.inspection_id, scenario);
      setAnalysis(result);
      if (typeof result.demo_mode === 'boolean') setDemoMode(result.demo_mode);
      const refreshed = await getInspection(target.inspection_id);
      setInspection({
        ...refreshed,
        final_decision: result.decision || refreshed.final_decision,
        checks: result.checks || refreshed.checks,
        agent_summary: result.agent_summary || refreshed.agent_summary,
      });
      setStatus(result.failure_reason
        ? `Held for review: perception unavailable (${result.failure_reason}).`
        : `Analysis complete. Decision: ${result.decision}.`);
      appendLog(`Final verdict: ${result.decision}.`);
      onChanged();
    } catch (error) {
      fail('Analysis', error);
    } finally {
      setPhase('');
    }
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
      const refreshed = await getInspection(inspection.inspection_id);
      setInspection({
        ...refreshed,
        override_decision: result.override_decision || refreshed.override_decision,
        agent_summary: result.agent_summary || refreshed.agent_summary,
      });
      setOverrideReason('');
      setStatus(`Operator override applied. Decision: ${result.override_decision}.`);
      appendLog(`Operator override applied: ${result.override_decision}.`);
      onChanged();
    } catch (error) {
      fail('Override', error);
    } finally {
      setPhase('');
    }
  };

  const decision = effectiveDecision(inspection);
  const record = latestRecord(inspection?.record, analysis?.record);
  const failureReason = analysis?.failure_reason || record?.outcome?.failure_reason;
  const modelVersion = record?.checks?.find((check) => check.model_version)?.model_version;
  const overrides = inspection?.overrides?.length ? inspection.overrides : record?.overrides || [];
  const agentVerdict = agentDecision({ overrides });
  const agentSteps = [
    { label: 'Create inspection', complete: Boolean(inspection) && !poDirty },
    { label: `Capture evidence${queue.length ? ` (${queue.length} queued)` : ''}`, complete: uploadedCount > 0 && !poDirty },
    { label: 'Agent decision', complete: analyzed && !poDirty },
  ];
  const modeLabel = demoMode === null ? 'Mode unknown' : demoMode ? 'Demo' : 'Live';
  // The backend refuses to analyze an inspection with zero evidence, even in demo mode.
  const hasEvidence = queue.length > 0 || (uploadedCount > 0 && !poDirty);
  const runLabel = phase ? PHASE_TEXT[phase] : 'Run receiving inspection';

  return (
    <>
      <div className="workspace">
        <div className="workspace-main">
          <PoEditor form={poForm} setForm={setPoForm} open={specOpen} onToggle={() => setSpecOpen((value) => !value)} disabled={busy} />
          {poDirty && (
            <div className="alert alert-warning" role="status">
              <Icon name="alert" size={16} />
              <span className="alert-text">
                PO changed since inspection {inspection.inspection_id} was created — the next run starts a fresh inspection
                {uploadedCount ? ' (photos already uploaded stay with the old one)' : ''}.
              </span>
            </div>
          )}

          <Card
            title="Delivery photos"
            sub="Capture each view at the point of receipt — drop files on a zone or click to add"
            actions={<span className="page-badge">{uploadedCount} uploaded · {queue.length} queued</span>}
          >
            <div className="upload-grid compact">
              {CAPTURE_VIEWS.map((view) => {
                const inputId = `capture-${view.key}`;
                const queuedHere = queue.filter((item) => item.view === view.key).length;
                const uploadedHere = (inspection?.images || []).filter((image) => image.image_type === view.key).length;
                const classes = [
                  'upload-zone',
                  uploadedHere + queuedHere > 0 ? 'has-file' : '',
                  dragView === view.key ? 'is-drag' : '',
                  busy ? 'is-disabled' : '',
                ].join(' ');
                return (
                  <div
                    key={view.key}
                    className={classes}
                    onDragOver={(event) => { event.preventDefault(); if (!busy) setDragView(view.key); }}
                    onDragLeave={() => setDragView((current) => (current === view.key ? '' : current))}
                    onDrop={(event) => handleDrop(view.key, event)}
                  >
                    <label htmlFor={inputId}>
                      <span className="upload-icon"><Icon name={view.icon} size={26} /></span>
                      <span className="upload-label">{view.label}</span>
                      <span className="upload-hint">{view.hint}</span>
                      <span className="upload-count">{uploadedHere} uploaded · {queuedHere} queued</span>
                    </label>
                    <input
                      id={inputId}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                      capture="environment"
                      disabled={busy}
                      onChange={(event) => handleFiles(view.key, event)}
                    />
                  </div>
                );
              })}
            </div>

            {queue.length > 0 && (
              <>
                <div className="gallery">
                  {queue.map((item) => (
                    <figure key={item.id} className="thumb">
                      <img src={item.url} alt={`Queued ${viewLabel(item.view)} photo ${item.file.name}`} />
                      <figcaption>
                        <span className="thumb-view">{viewLabel(item.view)}</span>
                        <span className="thumb-name">{item.file.name}</span>
                      </figcaption>
                      <button type="button" className="detail-btn" disabled={busy} onClick={() => removeQueued([item.id])}>
                        Remove
                      </button>
                    </figure>
                  ))}
                </div>
                <div>
                  <button type="button" className="btn-theme" disabled={busy} onClick={handleUploadOnly}>
                    <Icon name="upload" size={15} />
                    {phase === 'uploading' ? 'Uploading…' : `Upload ${queue.length} queued photo(s) now`}
                  </button>
                </div>
              </>
            )}
          </Card>
        </div>

        <aside className="workspace-side">
          <Card title="Run inspection" actions={<span className="page-badge">{modeLabel}</span>}>
            <ol className="steps">
              {agentSteps.map((step, index) => (
                <li key={step.label} className={step.complete ? 'done' : ''}>
                  <span className="step-num">{step.complete ? <Icon name="check" size={12} /> : index + 1}</span>
                  <span>{step.label}</span>
                </li>
              ))}
            </ol>
            <button type="button" className="btn-primary btn-block" onClick={handleRun} disabled={busy || !hasEvidence} aria-busy={busy} aria-describedby="run-hint">
              {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={16} />}
              {runLabel}
            </button>
            <button type="button" className="btn-theme btn-block" onClick={() => resetInspection()} disabled={busy || (!inspection && !queue.length)}>
              <Icon name="plus" size={15} /> New inspection
            </button>
            <p id="run-hint" className="hint">
              {hasEvidence
                ? (failOpen ? 'Fail-open drill is on: this run uses scenario perception_failure.' : 'Queued photos are uploaded first, then the agent analyzes the inspection.')
                : 'Add at least one photo (any capture view) to enable the analysis — a decision with zero evidence is not allowed.'}
            </p>
            <div className="status-line" role="status" aria-live="polite">{status}</div>
          </Card>

          <Card title="Demo scenarios" sub={demoMode === false
            ? 'Live mode: the backend ignores the scenario; the decision comes from your uploaded photos.'
            : 'In demo mode (DEMO_MODE=true) the selected scenario drives the simulated perception result.'}
          >
            <div className="chip-group" role="group" aria-label="Demo scenario">
              {SCENARIOS.map((scenario) => (
                <button
                  key={scenario.key}
                  type="button"
                  aria-pressed={activeScenario === scenario.key}
                  className={`chip ${activeScenario === scenario.key ? 'active' : ''}`}
                  disabled={busy}
                  onClick={() => { setActiveScenario(scenario.key); appendLog(`Scenario set to ${scenario.label}.`); }}
                >
                  {scenario.label}
                  <span className={`chip-outcome o-${scenario.expected}`}>{decisionMeta(scenario.expected).label}</span>
                </button>
              ))}
            </div>
            <div className="switch-row">
              <label htmlFor="fail-open-toggle">
                <strong>Fail-open drill (Rule 3)</strong>
                <span>Force a perception failure in demo mode — expect Pending · Hold</span>
              </label>
              <button
                id="fail-open-toggle"
                type="button"
                className={`switch ${failOpen ? 'on' : ''}`}
                aria-pressed={failOpen}
                disabled={busy}
                onClick={() => setFailOpen((value) => !value)}
              >
                <span className="sr-only">Force perception failure</span>
              </button>
            </div>
          </Card>

          <Card title="Agent activity">
            <div className="timeline-list flush compact" aria-live="polite">
              {agentLog.map((entry) => (
                <div key={entry.id} className={`timeline-item ${entry.complete ? 'item-good' : ''}`}>
                  <div className="timeline-content">{entry.text}</div>
                </div>
              ))}
            </div>
          </Card>
        </aside>
      </div>

      {!inspection && (
        <section className="card empty-card results">
          <div className="empty-state">
            <Icon name="truck" size={30} />
            <h3>No active receiving inspection</h3>
            <p>Choose a PO line, capture the delivery photos, and run the inspection.</p>
            <button type="button" className="btn-theme" onClick={onOpenBenchmark}>
              <Icon name="gauge" size={15} /> Run the 8-scenario benchmark instead
            </button>
          </div>
        </section>
      )}

      {inspection && (
        <section className="results">
          <div className="result-grid">
            <Card title="Receiving status" sub={`Inspection ${inspection.inspection_id}`} actions={<DecisionPill decision={decision} />}>
              <HeroStats
                flush
                items={[
                  { label: 'Decision', value: decisionMeta(decision).label, className: `d-${decision}` },
                  { label: 'Photos', value: uploadedCount },
                  { label: 'Record', value: record ? `v${record.version}` : '—' },
                ]}
              />
              {inspection.override_decision && (
                <p className="hint">
                  {agentVerdict ? `Agent decision ${decisionMeta(agentVerdict).label} · overridden` : 'Overridden'} to {decisionMeta(inspection.override_decision).label} ({inspection.override_decision})
                </p>
              )}
              {failureReason && (
                <div className="alert alert-hold">
                  <Icon name="clock" size={16} />
                  <span className="alert-text">Perception failure: {failureReason}. Held for human review (fail-open).</span>
                </div>
              )}
              {record?.outcome?.prep_hold && (
                <div className="hold-row">
                  <span className="hold-label">Prep hold</span>
                  {(record.outcome.hold_reasons || ['yes']).map((reason) => <span key={reason} className="cat-flag mono">{reason}</span>)}
                </div>
              )}
              <dl className="modal-kv flush">
                <dt className="modal-key">Purchase order</dt><dd className="modal-val">{inspection.po?.po_id} · {inspection.po?.product_name}</dd>
                <dt className="modal-key">Status</dt><dd className="modal-val capitalize">{inspection.status}{analysis?.analysis_status ? ` · analysis ${analysis.analysis_status}` : ''}</dd>
                <dt className="modal-key">Perception</dt>
                <dd className="modal-val">
                  {analysis ? (analysis.demo_mode ? 'DEMO (simulated)' : 'LIVE model') : 'unknown for this session'}
                  {modelVersion ? ` · ${modelVersion}` : ''}
                </dd>
                <dt className="modal-key">Evidence record</dt><dd className="modal-val mono">{record ? `v${record.version} · ${shortHash(record.content_hash)}` : 'not sealed yet'}</dd>
              </dl>
            </Card>

            <Card title="Agent summary" sub="Plain-language reasoning behind the decision">
              <div className="claim-reasoning flush">
                {inspection.agent_summary || 'The receiving agent is awaiting a completed evidence review.'}
              </div>
              <VerifyIntegrity inspectionId={inspection.inspection_id} />
            </Card>
          </div>

          <Card title="Inspection checks" sub="Each check compares what the photos show against the PO line">
            {(inspection.checks || []).length === 0
              ? <p className="hint">No checks yet — run the inspection.</p>
              : <ChecksTable checks={inspection.checks} />}
          </Card>

          <Card title="Operator override" sub="Overrides are append-only and need a reason; Passed requires an approver key">
            {!analyzed ? (
              <p className="hint">Overrides are available after the inspection has been analyzed.</p>
            ) : (
              <>
                <div className="override-row">
                  <div className="field">
                    <label htmlFor="override-decision" className="field-label">Override decision</label>
                    <select id="override-decision" className="filter-select full" value={overrideDecision} disabled={busy} onChange={(event) => setOverrideDecision(event.target.value)}>
                      <option value="PASS">Passed — PASS (approver only)</option>
                      <option value="EXCEPTION">Exception — EXCEPTION</option>
                      <option value="UNCERTAIN">Uncertain — UNCERTAIN</option>
                    </select>
                  </div>
                  <button type="button" className="btn-primary" onClick={handleOverride} disabled={busy}>
                    {phase === 'overriding' ? 'Applying…' : 'Apply override'}
                  </button>
                </div>
                <div className="field">
                  <label htmlFor="override-reason" className="field-label">Reason (required)</label>
                  <textarea
                    id="override-reason"
                    className="filter-input full"
                    value={overrideReason}
                    onChange={(event) => setOverrideReason(event.target.value)}
                    rows={3}
                    required
                    disabled={busy}
                    placeholder="Why does the operator disagree with the agent?"
                  />
                </div>
                {overrideNote && <div className="verify-result bad">{overrideNote}</div>}
              </>
            )}
            {(overrides.length > 0 || inspection.override_decision) && (
              <div className="field">
                <span className="field-label">Override history</span>
                <OverrideTimeline
                  overrides={overrides}
                  fallback={inspection.override_decision ? { decision: inspection.override_decision, reason: inspection.override_reason } : null}
                />
              </div>
            )}
          </Card>

          {(inspection.images || []).length > 0 && (
            <Card title="Evidence images" actions={<span className="page-badge">{inspection.images.length}</span>}>
              <Gallery inspectionId={inspection.inspection_id} images={inspection.images} />
            </Card>
          )}
        </section>
      )}

      <div className={`loading-overlay ${busy ? 'active' : ''}`} aria-hidden={!busy}>
        <div className="loading-spinner" />
        <div className="loading-text">{PHASE_TEXT[phase] || ''}</div>
      </div>
    </>
  );
}
