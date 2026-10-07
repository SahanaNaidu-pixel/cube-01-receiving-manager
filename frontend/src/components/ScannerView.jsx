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
  decisionMeta,
  effectiveDecision,
  formatTime,
  isAnalyzed,
  poSignature,
  shortHash,
  viewLabel,
} from '../constants';
import PoEditor, { toPoPayload } from './PoEditor';
import { Badge, Card, ChecksTable, EvidenceImage, Icon, VerifyIntegrity } from './Shared';

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
  demoMode, setDemoMode, onChanged, onError, onOpenBenchmark,
}) {
  const [queue, setQueue] = useState([]);
  const [phase, setPhase] = useState('');
  const [specOpen, setSpecOpen] = useState(false);
  const [activeScenario, setActiveScenario] = useState('correct_shipment');
  const [failOpen, setFailOpen] = useState(false);
  const [selectedView, setSelectedView] = useState(CAPTURE_VIEWS[0].key);
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
    setSelectedView(viewKey);
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
  const decisionInfo = decisionMeta(decision);
  const record = latestRecord(inspection?.record, analysis?.record);
  const failureReason = analysis?.failure_reason || record?.outcome?.failure_reason;
  const modelVersion = record?.checks?.find((check) => check.model_version)?.model_version;
  const overrides = inspection?.overrides?.length ? inspection.overrides : record?.overrides || [];
  const agentSteps = [
    { label: 'Create inspection', complete: Boolean(inspection) && !poDirty },
    { label: `Capture evidence${queue.length ? ` (${queue.length} queued)` : ''}`, complete: uploadedCount > 0 && !poDirty },
    { label: 'Agent decision', complete: analyzed && !poDirty },
  ];
  const modeLabel = demoMode === null ? 'Mode unknown' : demoMode ? 'Demo' : 'Live';
  const modeTone = demoMode === null ? 'neutral' : demoMode ? 'hold' : 'success';
  // The backend refuses to analyze an inspection with zero evidence, even in demo mode.
  const hasEvidence = queue.length > 0 || (uploadedCount > 0 && !poDirty);
  const runLabel = phase ? PHASE_TEXT[phase] : 'Run receiving inspection';

  return (
    <div className="workspace">
      <div className="workspace__top">
        <div className="workspace__main">
          <PoEditor form={poForm} setForm={setPoForm} open={specOpen} onToggle={() => setSpecOpen((value) => !value)} disabled={busy} />
          {poDirty && (
            <div className="alert alert--warning" role="status">
              <Icon name="alert" />
              <span className="alert__text">
                PO changed since inspection {inspection.inspection_id} was created — the next run starts a fresh inspection
                {uploadedCount ? ' (photos already uploaded stay with the old one)' : ''}.
              </span>
            </div>
          )}

          <Card
            title="Delivery photos"
            subtitle="Capture each view at the point of receipt — drop files on a zone or click to add"
            icon="upload"
            className="step-card"
            actions={<Badge tone="neutral" dot={false}>{uploadedCount} uploaded · {queue.length} queued</Badge>}
          >
            <div className="upload-grid">
              {CAPTURE_VIEWS.map((view) => {
                const inputId = `capture-${view.key}`;
                const queuedHere = queue.filter((item) => item.view === view.key).length;
                const uploadedHere = (inspection?.images || []).filter((image) => image.image_type === view.key).length;
                const classes = [
                  'upload-zone',
                  selectedView === view.key ? 'upload-zone--selected' : '',
                  dragView === view.key ? 'upload-zone--drag' : '',
                  uploadedHere + queuedHere > 0 ? 'upload-zone--filled' : '',
                ].join(' ');
                return (
                  <div
                    key={view.key}
                    className={classes}
                    onDragOver={(event) => { event.preventDefault(); if (!busy) setDragView(view.key); }}
                    onDragLeave={() => setDragView((current) => (current === view.key ? '' : current))}
                    onDrop={(event) => handleDrop(view.key, event)}
                  >
                    <span className="upload-zone__icon"><Icon name={view.icon} size={20} /></span>
                    <strong className="upload-zone__title">{view.label}</strong>
                    <small className="upload-zone__hint">{view.hint}</small>
                    <label htmlFor={inputId} className={`btn btn--secondary btn--sm file-label ${busy ? 'is-disabled' : ''}`}>
                      <Icon name="plus" size={14} /> Add photos
                    </label>
                    <input
                      id={inputId}
                      className="file-input"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                      capture="environment"
                      disabled={busy}
                      onChange={(event) => handleFiles(view.key, event)}
                    />
                    <small className="upload-zone__count">{uploadedHere} uploaded · {queuedHere} queued</small>
                  </div>
                );
              })}
            </div>

            {queue.length > 0 && (
              <div className="queue">
                <div className="queue__grid">
                  {queue.map((item) => (
                    <figure key={item.id} className="thumb queue-card">
                      <img src={item.url} alt={`Queued ${viewLabel(item.view)} photo ${item.file.name}`} />
                      <figcaption>
                        <span className="thumb__view">{viewLabel(item.view)}</span>
                        <span className="thumb__name">{item.file.name}</span>
                      </figcaption>
                      <button type="button" className="btn btn--ghost btn--sm thumb__remove" disabled={busy} onClick={() => removeQueued([item.id])}>
                        Remove
                      </button>
                    </figure>
                  ))}
                </div>
                <button type="button" className="btn btn--secondary upload-button" disabled={busy} onClick={handleUploadOnly}>
                  <Icon name="upload" size={15} />
                  {phase === 'uploading' ? 'Uploading…' : `Upload ${queue.length} queued photo(s) now`}
                </button>
              </div>
            )}
          </Card>
        </div>

        <aside className="workspace__side">
          <Card
            title="Run inspection"
            icon="play"
            className="run-card"
            actions={<Badge tone={modeTone}>{modeLabel}</Badge>}
          >
            <ol className="steps">
              {agentSteps.map((step, index) => (
                <li key={step.label} className={`steps__item ${step.complete ? 'steps__item--done' : ''}`}>
                  <span className="steps__marker">{step.complete ? <Icon name="check" size={13} /> : index + 1}</span>
                  <span>{step.label}</span>
                </li>
              ))}
            </ol>
            <button type="button" className="btn btn--primary btn--lg btn--block run-analysis-button" onClick={handleRun} disabled={busy || !hasEvidence} aria-busy={busy} aria-describedby="run-hint">
              {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={16} />}
              {runLabel}
            </button>
            <button type="button" className="btn btn--secondary btn--block" onClick={() => resetInspection()} disabled={busy || (!inspection && !queue.length)}>
              <Icon name="plus" size={15} /> New inspection
            </button>
            <p id="run-hint" className="hint">
              {hasEvidence
                ? (failOpen ? 'Fail-open drill is on: this run uses scenario perception_failure.' : 'Queued photos are uploaded first, then the agent analyzes the inspection.')
                : 'Add at least one photo (any capture view) to enable the analysis — a decision with zero evidence is not allowed.'}
            </p>
            <div className="status-line" role="status" aria-live="polite">{status}</div>
          </Card>

          <Card title="Demo scenarios" icon="flask" subtitle={demoMode === false
            ? 'Live mode: the backend ignores the scenario; the decision comes from your uploaded photos.'
            : 'In demo mode (DEMO_MODE=true) the selected scenario drives the simulated perception result.'}
          >
            <div className="chip-group" role="group" aria-label="Demo scenario">
              {SCENARIOS.map((scenario) => (
                <button
                  key={scenario.key}
                  type="button"
                  aria-pressed={activeScenario === scenario.key}
                  className={`chip scenario-chip chip--${decisionMeta(scenario.expected).tone} ${activeScenario === scenario.key ? 'chip--active' : ''}`}
                  disabled={busy}
                  onClick={() => { setActiveScenario(scenario.key); appendLog(`Scenario set to ${scenario.label}.`); }}
                >
                  <span className="chip__label">{scenario.label}</span>
                  <span className="chip__outcome">{decisionMeta(scenario.expected).label}</span>
                </button>
              ))}
            </div>
            <div className="switch-row">
              <label htmlFor="fail-open-toggle" className="switch-row__label">
                <strong>Fail-open drill (Rule 3)</strong>
                <span>Force a perception failure in demo mode — expect Pending · Hold</span>
              </label>
              <button
                id="fail-open-toggle"
                type="button"
                className={`switch ${failOpen ? 'switch--on' : ''}`}
                aria-pressed={failOpen}
                disabled={busy}
                onClick={() => setFailOpen((value) => !value)}
              >
                <span className="switch__thumb" />
                <span className="sr-only">Force perception failure</span>
              </button>
            </div>
          </Card>

          <Card title="Activity" icon="activity">
            <ul className="feed" aria-live="polite">
              {agentLog.map((entry) => (
                <li key={entry.id} className={`feed__item ${entry.complete ? 'feed__item--done' : ''}`}>
                  <span className="feed__dot" aria-hidden="true" />
                  <span>{entry.text}</span>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>

      <div className="workspace__results">
        {!inspection && (
          <section className="card empty-state">
            <span className="empty-state__icon"><Icon name="truck" size={26} /></span>
            <h2 className="empty-state__title">No active receiving inspection</h2>
            <p className="empty-state__text">Choose a PO line, capture the delivery photos, and run the inspection.</p>
            <button type="button" className="btn btn--secondary" onClick={onOpenBenchmark}>
              <Icon name="gauge" size={15} /> Run the 8-Scenario Benchmark Instead
            </button>
          </section>
        )}

        {inspection && (
          <section className="results-area">
            <div className="result-grid">
              <Card title="Receiving status" icon="shield" className={`decision-card decision-card--${decisionInfo.tone}`}>
                <div className="decision">
                  <span className={`decision__badge decision__badge--${decisionInfo.tone}`}>{decisionInfo.label}</span>
                  <span className="decision__code mono">{decision}</span>
                </div>
                {inspection.override_decision && (
                  <p className="decision__note">
                    Agent decision {decisionMeta(inspection.final_decision).label} · overridden to {decisionMeta(inspection.override_decision).label} ({inspection.override_decision})
                  </p>
                )}
                {failureReason && (
                  <div className="alert alert--hold">
                    <Icon name="clock" />
                    <span className="alert__text">Perception failure: {failureReason}. Held for human review (fail-open).</span>
                  </div>
                )}
                {record?.outcome?.prep_hold && (
                  <div className="hold">
                    <span className="hold__label">Prep hold</span>
                    <div className="hold__tags">
                      {(record.outcome.hold_reasons || ['yes']).map((reason) => <span key={reason} className="tag tag--danger mono">{reason}</span>)}
                    </div>
                  </div>
                )}
                <dl className="meta-list">
                  <div><dt>Inspection ID</dt><dd className="mono">{inspection.inspection_id}</dd></div>
                  <div><dt>Purchase order</dt><dd>{inspection.po?.po_id} · {inspection.po?.product_name}</dd></div>
                  <div><dt>Status</dt><dd className="capitalize">{inspection.status}{analysis?.analysis_status ? ` · analysis ${analysis.analysis_status}` : ''}</dd></div>
                  <div>
                    <dt>Perception</dt>
                    <dd>
                      {analysis ? (analysis.demo_mode ? 'DEMO (simulated)' : 'LIVE model') : 'unknown for this session'}
                      {modelVersion ? ` · ${modelVersion}` : ''}
                    </dd>
                  </div>
                  <div><dt>Evidence record</dt><dd className="mono">{record ? `v${record.version} · ${shortHash(record.content_hash)}` : 'not sealed yet'}</dd></div>
                </dl>
              </Card>

              <Card title="Agent summary" icon="file">
                <p className="summary-text">
                  {inspection.agent_summary || 'The receiving agent is awaiting a completed evidence review.'}
                </p>
                <VerifyIntegrity inspectionId={inspection.inspection_id} />
              </Card>
            </div>

            <Card title="Inspection checks" icon="list" subtitle="Each check compares what the photos show against the PO line">
              {(inspection.checks || []).length === 0
                ? <p className="hint">No checks yet — run the inspection.</p>
                : <ChecksTable checks={inspection.checks} />}
            </Card>

            <Card title="Operator override" icon="key" subtitle="Overrides are append-only and need a reason; Passed requires an approver key">
              {!analyzed ? (
                <p className="hint">Overrides are available after the inspection has been analyzed.</p>
              ) : (
                <div className="override">
                  <div className="override__row">
                    <div className="field">
                      <label htmlFor="override-decision" className="field__label">Override decision</label>
                      <select id="override-decision" className="input select" value={overrideDecision} disabled={busy} onChange={(event) => setOverrideDecision(event.target.value)}>
                        <option value="PASS">Passed — PASS (approver only)</option>
                        <option value="EXCEPTION">Exception — EXCEPTION</option>
                        <option value="UNCERTAIN">Uncertain — UNCERTAIN</option>
                      </select>
                    </div>
                    <button type="button" className="btn btn--primary" onClick={handleOverride} disabled={busy}>
                      {phase === 'overriding' ? 'Applying…' : 'Apply override'}
                    </button>
                  </div>
                  <div className="field">
                    <label htmlFor="override-reason" className="field__label">Reason (required)</label>
                    <textarea
                      id="override-reason"
                      className="input textarea"
                      value={overrideReason}
                      onChange={(event) => setOverrideReason(event.target.value)}
                      rows={3}
                      required
                      disabled={busy}
                      placeholder="Why does the operator disagree with the agent?"
                    />
                  </div>
                  {overrideNote && <div className="verify__result verify__result--bad">{overrideNote}</div>}
                </div>
              )}
              {(overrides.length > 0 || inspection.override_decision) && (
                <div className="history">
                  <div className="field__label">Override history</div>
                  {overrides.length === 0 && (
                    <div className="history__item">{inspection.override_decision}: {inspection.override_reason || 'no reason recorded'}</div>
                  )}
                  {overrides.map((item) => (
                    <div key={item.override_id || item.created_at} className="history__item">
                      <div className="history__head">
                        <strong>{item.from_verdict} → {item.to_verdict}</strong>
                        <span>by {item.operator_id || 'operator'}{item.role ? ` (${item.role})` : ''} · {formatTime(item.created_at)}</span>
                      </div>
                      <div>{item.reason}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {(inspection.images || []).length > 0 && (
              <Card title="Evidence images" icon="image" actions={<Badge tone="neutral" dot={false}>{inspection.images.length}</Badge>}>
                <div className="gallery">
                  {inspection.images.map((image) => (
                    <figure key={image.image_id} className="thumb evidence-card">
                      <EvidenceImage inspectionId={inspection.inspection_id} imageId={image.image_id} alt={image.filename} />
                      <figcaption>
                        <span className="thumb__view">{viewLabel(image.image_type)}</span>
                        <span className="thumb__name">{image.filename}</span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </Card>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
