/*
 * Action dialogs for the inspection detail page. Each one calls the real endpoint and shows the backend's answer
 * (including 403 / 409) — nothing is reported as done unless the API said so.
 */
import { useState } from 'react';
import {
  addInspectionNote, handoffInspection, overrideInspection, requestInspectionReview, runInspection,
} from '../../services/api';
import { formatLatency, humanize } from '../../lib/format';
import { pathFor } from '../../lib/router';
import { AsyncButton, ErrorState, Icon, Link, Modal, StatusBadge } from '../../components/ui';
import { Field, ManualObservationsForm, RunOutcomeNotice, ScenarioPicker } from './components';
import { HANDOFF_TARGETS, hasReadings, manualFromForm, manualToForm, runOutcome } from './helpers';

function Footer({ onClose, children, closeLabel = 'Cancel' }) {
  return (
    <>
      <button type="button" className="btn-theme" onClick={onClose}>{closeLabel}</button>
      {children}
    </>
  );
}

const reject = (message) => Promise.reject(new Error(message));

// ── handoff ──

export function HandoffDialog({ inspection, env, onClose, onDone }) {
  const [target, setTarget] = useState(HANDOFF_TARGETS[0].value);
  const [result, setResult] = useState(null);
  const configured = env.peers.includes(target);
  return (
    <Modal title="Send to downstream agent" subtitle={inspection.inspection_id} onClose={onClose}
      footer={(
        <Footer onClose={onClose} closeLabel={result ? 'Close' : 'Cancel'}>
          <AsyncButton variant="primary" icon="send" label={result ? 'Send again' : 'Send'} loadingLabel="Sending…"
            onClick={() => handoffInspection(inspection.inspection_id, target)}
            errorToast="Hand-off request failed"
            onSuccess={(r) => { setResult(r); onDone?.(); }} />
        </Footer>
      )}>
      <div className="stack">
        <Field id="ho-target" label="Target agent">
          <select id="ho-target" className="filter-select full" value={target} onChange={(e) => { setTarget(e.target.value); setResult(null); }}>
            {HANDOFF_TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}{env.peers.includes(t.value) ? ' — configured' : ''}</option>)}
          </select>
        </Field>
        <p className="hint">
          Sends a <span className="mono">receiving.record_available</span> A2A envelope with the latest sealed record.
          {configured
            ? ' This peer is configured (A2A_PEERS), so the backend will attempt delivery.'
            : ' No A2A_PEERS entry is configured for this agent: the envelope will be recorded as not_configured and not sent.'}
        </p>
        {result && (
          <div className={`insp-handoff s-${result.status}`} role="status">
            <div className="insp-handoff-head">
              <StatusBadge status={result.status} />
              <strong>
                {result.status === 'delivered' && `Delivered to ${result.agent}`}
                {result.status === 'not_configured' && `Not sent — ${result.agent} is not configured`}
                {result.status === 'failed' && `Delivery to ${result.agent} failed`}
                {!['delivered', 'not_configured', 'failed'].includes(result.status) && humanize(result.status)}
              </strong>
            </div>
            <dl className="insp-mini-kv">
              <dt>Request</dt><dd><Link to={pathFor('agent-activity', result.request_id)} className="link mono">{result.request_id}</Link></dd>
              <dt>Operation</dt><dd className="mono">{result.operation}</dd>
              {result.http_status !== null && result.http_status !== undefined && (<><dt>HTTP</dt><dd>{result.http_status}</dd></>)}
              <dt>Latency</dt><dd>{formatLatency(result.latency_ms)}</dd>
              {result.error && (<><dt>Detail</dt><dd>{result.error}</dd></>)}
            </dl>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── review ──

export function ReviewDialog({ inspection, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState(null);
  const submit = () => {
    const text = reason.trim();
    if (!text) return reject('Give a reason for the review.');
    if (text.length > 2000) return reject('The reason is limited to 2000 characters.');
    return requestInspectionReview(inspection.inspection_id, text, assignee.trim() || undefined);
  };
  return (
    <Modal title="Create review task" subtitle={inspection.inspection_id} onClose={onClose}
      footer={(
        <Footer onClose={onClose}>
          <AsyncButton variant="primary" icon="inbox" label="Create task" loadingLabel="Creating…" onClick={submit}
            errorToast="Could not create the review task" onError={setError}
            successToast={(t) => `Review task ${t?.task_id || ''} created`}
            onSuccess={() => { onDone?.(); onClose(); }} />
        </Footer>
      )}>
      <div className="stack">
        <Field id="rd-reason" label="Reason" required>
          <textarea id="rd-reason" className="filter-input full" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field id="rd-assign" label="Assign to (optional)">
          <input id="rd-assign" className="filter-input full" maxLength={200} value={assignee} onChange={(e) => setAssignee(e.target.value)} />
        </Field>
        {error && <ErrorState error={error} title="Not created" compact />}
      </div>
    </Modal>
  );
}

// ── override ──

const OVERRIDE_CHOICES = [
  { value: 'PASS', label: 'Pass', note: 'Release for putaway (approver only)' },
  { value: 'EXCEPTION', label: 'Fail', note: 'Exception — quarantine' },
  { value: 'UNCERTAIN', label: 'Uncertain', note: 'Keep on hold' },
];

export function OverrideDialog({ inspection, env, onClose, onDone }) {
  const [decision, setDecision] = useState('EXCEPTION');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const notApprover = env.role && env.role !== 'approver';
  const submit = () => {
    const text = reason.trim();
    if (!text) return reject('A reason is required for an override.');
    if (text.length > 2000) return reject('The reason is limited to 2000 characters.');
    setError(null);
    return overrideInspection(inspection.inspection_id, decision, text);
  };
  return (
    <Modal title="Override verdict" subtitle={`${inspection.inspection_id} · machine checks stay in the record`} onClose={onClose}
      footer={(
        <Footer onClose={onClose}>
          <AsyncButton variant="primary" icon="shield" label="Apply override" loadingLabel="Applying…" onClick={submit}
            errorToast="Override rejected" onError={setError}
            successToast={(r) => `Verdict overridden to ${r?.override_decision || decision}`}
            onSuccess={() => { onDone?.(); onClose(); }} />
        </Footer>
      )}>
      <div className="stack">
        {!inspection.record && <div className="alert alert-warning"><Icon name="alert" size={16} /><span className="alert-text">This inspection has not been run; the backend only accepts overrides on an analysed inspection.</span></div>}
        <div className="chip-group" role="radiogroup" aria-label="Override decision">
          {OVERRIDE_CHOICES.map((c) => (
            <button key={c.value} type="button" role="radio" aria-checked={decision === c.value}
              className={`chip ${decision === c.value ? 'active' : ''}`} onClick={() => setDecision(c.value)} title={c.note}>
              {c.label}
            </button>
          ))}
        </div>
        {decision === 'PASS' && notApprover && (
          <p className="hint">Your key’s role is <strong>{env.role}</strong>. Only an approver may finalise PASS — the backend will refuse it (403).</p>
        )}
        <Field id="ov-reason" label="Reason" required hint="Recorded in the sealed record and the audit trail.">
          <textarea id="ov-reason" className="filter-input full" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {inspection.review_task && ['open', 'evidence_requested'].includes(inspection.review_task.status) && (
          <p className="hint">The open review task {inspection.review_task.task_id} will be closed as overridden.</p>
        )}
        {error && <ErrorState error={error} title="Override not applied" compact />}
      </div>
    </Modal>
  );
}

// ── note ──

export function NoteDialog({ inspection, onClose, onDone }) {
  const [text, setText] = useState('');
  const submit = () => {
    const value = text.trim();
    if (!value) return reject('Write a note first.');
    if (value.length > 2000) return reject('Notes are limited to 2000 characters.');
    return addInspectionNote(inspection.inspection_id, value);
  };
  return (
    <Modal title="Add note" subtitle={inspection.inspection_id} onClose={onClose}
      footer={(
        <Footer onClose={onClose}>
          <AsyncButton variant="primary" icon="plus" label="Add note" loadingLabel="Saving…" onClick={submit}
            errorToast="Could not add the note" successToast="Note added" onSuccess={() => { onDone?.(); onClose(); }} />
        </Footer>
      )}>
      <Field id="nd-text" label="Note" required>
        <textarea id="nd-text" className="filter-input full" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ── re-run ──

export function RerunDialog({ inspection, env, onClose, onDone }) {
  const [form, setForm] = useState(() => manualToForm(inspection.manual_observations));
  const [errors, setErrors] = useState({});
  const [scenario, setScenario] = useState('');
  const [outcome, setOutcome] = useState(null);
  const submit = () => {
    const { errors: errs, payload } = manualFromForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return reject('Fix the highlighted operator counts.');
    if (!inspection.images?.length && !hasReadings(payload)) return reject('No photos on this inspection — enter operator counts to run it.');
    const manual = payload || (inspection.manual_observations ? {} : undefined);
    return runInspection(inspection.inspection_id, { manual_observations: manual, scenario: env.demoMode ? scenario : undefined });
  };
  return (
    <Modal wide title="Re-run inspection" subtitle={`${inspection.inspection_id} · ${inspection.images?.length || 0} photo(s)`} onClose={onClose}
      footer={(
        <Footer onClose={onClose} closeLabel={outcome ? 'Close' : 'Cancel'}>
          <AsyncButton variant="primary" icon="play" label="Run" loadingLabel="Running…" onClick={submit} errorToast="Run failed"
            successToast={(r) => `Run complete: ${r?.verdict || 'not decided'}`}
            onSuccess={(r) => { setOutcome(runOutcome(r)); onDone?.(); }} />
        </Footer>
      )}>
      <div className="stack">
        <p className="hint">A run appends a new sealed record version; earlier versions and overrides stay in the chain.</p>
        <ManualObservationsForm form={form} setForm={setForm} errors={errors} idPrefix="rr" />
        {env.demoMode && <ScenarioPicker value={scenario} onChange={setScenario} />}
        {outcome && <RunOutcomeNotice outcome={outcome} />}
        {outcome && outcome.kind === 'complete' && <p className="hint">Run complete — the page has been refreshed with the new verdict.</p>}
      </div>
    </Modal>
  );
}
