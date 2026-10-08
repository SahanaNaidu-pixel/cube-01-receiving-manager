/*
 * ReviewDetailPage — one human review task (GET /api/reviews/{id} → task + inspection detail view).
 * Left: the automated (machine) result exactly as sealed. Right: the human decision and its controls.
 * Mutations: POST decision | request-evidence | notes | assign — each reloads the task afterwards.
 */
import { useState } from 'react';
import {
  addReviewNote, assignReview, decideReview, getReview, requestReviewEvidence,
} from '../services/api';
import { useApi } from '../hooks/useAsync';
import { useApp } from '../context/AppContext';
import { pathFor } from '../lib/router';
import { formatDateTime, formatRelative, humanize } from '../lib/format';
import {
  AsyncButton, Card, ConnectPrompt, ErrorState, Icon, KeyValueGrid, Link, LoadingState, PageHeader,
  SeverityBadge, StatusBadge, VerdictBadge,
} from '../components/ui';
import {
  AssignForm, ChecksList, EvidenceThumb, IdChip, ImagePreviewModal, InlineError, NoteComposer, NotesList, TraceChain,
} from './review/components';
import { REVIEW_TRIGGERS } from './review/constants';
import { isForbidden } from './review/helpers';
import '../styles/review.css';

const ACTIVE = ['open', 'evidence_requested'];

const DECISIONS = [
  { value: 'PASS', label: 'Pass', hint: 'Accept the receipt — requires approver role' },
  { value: 'FAIL', label: 'Fail', hint: 'Record an exception (stored as EXCEPTION)' },
  { value: 'UNCERTAIN', label: 'Uncertain', hint: 'Keep on hold; cannot be decided' },
];

export default function ReviewDetailPage({ route }) {
  const taskId = route.params[0];
  const { principal, refreshCounts } = useApp();
  const { data: task, error, loading, reload, notConnected } = useApi(() => getReview(taskId), [taskId]);
  const [preview, setPreview] = useState(null);

  if (notConnected) return <Card><ConnectPrompt /></Card>;
  if (!task && loading) return <LoadingState label={`Loading review ${taskId}…`} />;
  if (!task && error) {
    return (
      <div className="stack">
        <PageHeader title={taskId} breadcrumbs={[{ label: 'Review queue', to: 'reviews' }, { label: taskId }]} />
        <ErrorState error={error} onRetry={reload} title={error.status === 404 ? 'Review task not found' : 'Could not load review task'} />
      </div>
    );
  }
  if (!task) return null;

  const inspection = task.inspection;
  const record = inspection?.record || null;
  const active = ACTIVE.includes(task.status);
  const overrides = record?.overrides || [];
  const override = task.override_id ? overrides.find((o) => o.override_id === task.override_id) : null;
  const evidenceFiles = inspection?.evidence_files || [];
  const issues = inspection?.issues || [];
  const afterMutation = () => { reload(); refreshCounts?.(); };

  return (
    <div className="stack">
      <PageHeader
        title={`Review ${task.task_id}`}
        icon="users"
        breadcrumbs={[{ label: 'Review queue', to: 'reviews' }, { label: task.task_id }]}
        subtitle={task.reason}
        actions={(
          <>
            <Link to={pathFor('inspections', task.inspection_id)} className="btn-theme">
              <Icon name="external" size={14} /> Open inspection
            </Link>
            <button type="button" className="btn-theme" onClick={() => reload()} disabled={loading}>
              {loading ? <span className="spinner ui-spinner-accent" aria-hidden="true" /> : <Icon name="refresh" size={14} />} Refresh
            </button>
          </>
        )}
      />

      {error && <InlineError error={error} title="Refresh failed — showing the last loaded data" />}

      <Card>
        <div className="rv-split-head">
          <TraceChain steps={[
            { label: 'Inspection', value: task.inspection_id, to: pathFor('inspections', task.inspection_id) },
            { label: 'Machine record', value: task.machine_record_id || 'not analysed' },
            { label: 'Review task', value: task.task_id, badge: <StatusBadge status={task.status} /> },
            override && { label: 'Override', value: override.override_id, badge: <VerdictBadge verdict={override.to_verdict} /> },
          ]} />
          <KeyValueGrid columns={4} dense items={[
            { label: 'PO', value: task.po_id ? <Link to={pathFor('purchase-orders', task.po_id)} className="link mono">{task.po_id}</Link> : null },
            { label: 'SKU', value: task.sku ? <Link to={pathFor('products', task.sku)} className="link mono">{task.sku}</Link> : null },
            { label: 'Supplier', value: task.supplier },
            { label: 'Opened', value: <span title={formatDateTime(task.created_at)}>{formatRelative(task.created_at)} · {task.created_by || '—'}</span> },
          ]} />
        </div>
      </Card>

      <div className="rv-callout tone-info">
        <Icon name="shield" size={16} />
        <span>
          The machine result is preserved. A human decision is appended to the sealed record as a new version
          with an override entry — the original checks and the machine verdict (<strong>{task.machine_verdict || 'not analysed'}</strong>)
          are never modified.
        </span>
      </div>

      <div className="rv-grid-2">
        {/* ── automated result ── */}
        <Card
          title="Automated result"
          sub={record ? `Record ${task.machine_record_id || record.record_id} · ${humanize(record.perception?.vision_provider || 'vision')} · vision ${record.perception?.vision_status || 'unknown'}` : 'No sealed record yet'}
          actions={<VerdictBadge verdict={task.machine_verdict} />}
        >
          <KeyValueGrid columns={2} dense items={[
            { label: 'Machine verdict', value: <VerdictBadge verdict={task.machine_verdict} /> },
            { label: 'Trigger', value: REVIEW_TRIGGERS[task.trigger] || humanize(task.trigger) },
            { label: 'Machine record', value: task.machine_record_id ? <IdChip value={task.machine_record_id} /> : null },
            { label: 'Hold reasons', value: (record?.outcome?.hold_reasons || []).filter((r) => !String(r).startsWith('override:')), span: 2 },
            { label: 'Vision failure', value: record?.perception?.vision_failure_reason, span: 2, hideEmpty: true },
          ]} />

          <div>
            <h3 className="rv-section-title">Evidence ({evidenceFiles.length})</h3>
            {evidenceFiles.length === 0
              ? <p className="hint">No photos were uploaded for this inspection.</p>
              : (
                <div className="rv-thumbs">
                  {evidenceFiles.map((file) => (
                    <EvidenceThumb key={file.evidence_id} inspectionId={file.inspection_id} imageId={file.evidence_id}
                      alt={file.filename} size="md" onOpen={() => setPreview(file)}
                      caption={<span className="rv-thumb-cap">{humanize(file.view)} · <span className="mono">{file.evidence_id}</span></span>} />
                  ))}
                </div>
              )}
          </div>

          <div>
            <h3 className="rv-section-title">Checks (failures and uncertain first)</h3>
            <ChecksList checks={record?.checks || []} />
          </div>
        </Card>

        {/* ── human decision ── */}
        <div className="stack">
          <Card title="Human decision" sub={active ? 'Record the reviewer’s decision with a reason.' : `Task ${humanize(task.status).toLowerCase()}`}
            actions={<StatusBadge status={task.status} />}>
            {active
              ? <DecisionPanel task={task} principal={principal} onDone={afterMutation} />
              : <ClosedSummary task={task} override={override} record={record} />}
          </Card>

          {active && (
            <Card title="Request more evidence" sub="Sets the task to “evidence requested”; the next inspection run returns it to open.">
              <RequestEvidenceForm taskId={task.task_id} onDone={afterMutation} />
            </Card>
          )}

          <Card title="Assignment" sub={task.assigned_to ? `Assigned to ${task.assigned_to}` : 'Unassigned'}>
            {active
              ? <AssignForm key={task.assigned_to || ''} current={task.assigned_to} principal={principal}
                onAssign={(who) => assignReview(task.task_id, who)} onDone={afterMutation} />
              : <p className="hint">Assignment is closed — this task is {task.status}.</p>}
          </Card>
        </div>
      </div>

      <div className="rv-grid-2">
        <Card title={`Notes (${task.notes?.length || 0})`} sub="Decision notes, evidence requests and comments, newest first.">
          <NotesList notes={task.notes || []} />
          <NoteComposer onAdd={(text) => addReviewNote(task.task_id, text)} onDone={reload} />
        </Card>

        <Card title={`Issues on this inspection (${issues.length})`} sub="Exceptions opened by the runs; they stay open after a human decision until resolved.">
          {issues.length === 0 ? <p className="hint">No issues recorded.</p> : (
            <ul className="rv-checks">
              {issues.map((issue) => (
                <li key={issue.issue_id} className="rv-check">
                  <div className="rv-check-head">
                    <Link to={pathFor('issues', issue.issue_id)} className="link mono">{issue.issue_id}</Link>
                    <SeverityBadge severity={issue.severity} />
                    <StatusBadge status={issue.status} />
                    <span className="mono rv-code">{issue.issue_type}</span>
                  </div>
                  <p className="rv-check-reason">{issue.title}{issue.reason ? ` — ${issue.reason}` : ''}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {preview && <ImagePreviewModal file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function DecisionPanel({ task, principal, onDone }) {
  const [decision, setDecision] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const trimmed = note.trim();
  const isApprover = principal?.role === 'approver';

  return (
    <div className="rv-form">
      <div className="rv-decision-options" role="radiogroup" aria-label="Decision">
        {DECISIONS.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={decision === option.value}
            className={`rv-decision-opt d-${option.value} ${decision === option.value ? 'is-selected' : ''}`}
            onClick={() => { setDecision(option.value); setError(null); }}>
            <strong>{option.label}</strong>
            <span>{option.hint}</span>
          </button>
        ))}
      </div>
      {decision === 'PASS' && !isApprover && (
        <div className="rv-callout tone-warning">
          <Icon name="key" size={16} />
          <span>PASS requires the approver role. You are signed in as <strong>{principal?.operator_id || 'unknown'}</strong> ({principal?.role || 'unknown role'}); the server will refuse this decision.</span>
        </div>
      )}
      <label className="field">
        <span className="field-label">Decision note (required)</span>
        <textarea className="filter-input full" value={note} maxLength={2000}
          placeholder="Why — what you checked and what you saw…" onChange={(event) => setNote(event.target.value)} />
      </label>
      {error && <InlineError error={error} title={isForbidden(error) ? 'Not permitted' : 'Decision not recorded'} />}
      <div className="rv-actions">
        <AsyncButton
          variant="primary" icon="check"
          label={decision ? `Record ${decision}` : 'Choose a decision'}
          loadingLabel="Recording…" successLabel="Recorded"
          disabled={!decision || !trimmed}
          onClick={() => { setError(null); return decideReview(task.task_id, decision, trimmed); }}
          successToast={(result) => `Decision ${decision} recorded · record v${result?.record?.version ?? '?'}`}
          errorToast={false}
          onError={setError}
          onSuccess={() => { setNote(''); setDecision(''); onDone(); }}
        />
        <span className="hint">{trimmed.length}/2000</span>
      </div>
    </div>
  );
}

function ClosedSummary({ task, override, record }) {
  if (task.status === 'cancelled') {
    return (
      <div className="rv-form">
        <div className="rv-callout">
          <Icon name="info" size={16} />
          <span>
            {task.resolution === 'superseded_by_run'
              ? `Cancelled automatically: a later run produced a decisive machine verdict (${task.machine_verdict || '—'}), so no human decision was needed.`
              : 'This task was cancelled without a human decision.'}
          </span>
        </div>
        <KeyValueGrid columns={2} dense items={[
          { label: 'Resolution', value: humanize(task.resolution) },
          { label: 'Latest machine verdict', value: <VerdictBadge verdict={task.machine_verdict} /> },
          { label: 'Updated', value: formatDateTime(task.updated_at) },
        ]} />
      </div>
    );
  }
  return (
    <div className="rv-form">
      <KeyValueGrid columns={2} dense items={[
        { label: 'Human decision', value: task.human_decision ? <VerdictBadge verdict={task.human_decision} /> : null },
        { label: 'Machine verdict', value: <VerdictBadge verdict={task.machine_verdict} /> },
        { label: 'Decided by', value: task.decided_by },
        { label: 'Decided at', value: formatDateTime(task.decided_at) },
        { label: 'Resolution', value: task.resolution === 'overridden' ? 'Closed by an inspection override' : humanize(task.resolution) },
        { label: 'Current record', value: record ? `${record.record_id} · v${record.version}` : null, mono: true },
      ]} />
      {override ? (
        <div>
          <h3 className="rv-section-title">Resulting override</h3>
          <KeyValueGrid columns={2} dense items={[
            { label: 'Override', value: <IdChip value={override.override_id} /> },
            { label: 'Change', value: <span><VerdictBadge verdict={override.from_verdict} /> → <VerdictBadge verdict={override.to_verdict} /></span> },
            { label: 'By', value: `${override.operator_id} (${override.role})` },
            { label: 'At', value: formatDateTime(override.created_at) },
            { label: 'Reason', value: override.reason, span: 2 },
            { label: 'Previous record hash', value: override.before_hash, mono: true, span: 2 },
          ]} />
        </div>
      ) : (
        task.override_id && <p className="hint">Override {task.override_id} is not in the current record view.</p>
      )}
    </div>
  );
}

function RequestEvidenceForm({ taskId, onDone }) {
  const [note, setNote] = useState('');
  const trimmed = note.trim();
  return (
    <div className="rv-form">
      <label className="field">
        <span className="field-label">What is needed (required)</span>
        <textarea className="filter-input full" value={note} maxLength={2000}
          placeholder="e.g. Close-up of the carton label and the crushed corner" onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="rv-actions">
        <AsyncButton icon="image" label="Request evidence" loadingLabel="Sending…" successLabel="Requested"
          disabled={!trimmed} onClick={() => requestReviewEvidence(taskId, trimmed)}
          successToast="More evidence requested" errorToast="Could not request evidence"
          onSuccess={() => { setNote(''); onDone(); }} />
      </div>
    </div>
  );
}
