/*
 * IssueDetailPage — one exception (GET /api/issues/{id} → issue + inspection summary + linked evidence files).
 * The parent inspection (GET /api/inspections/{id}) supplies its photos (for "Link evidence") and review tasks.
 * Mutations: POST /api/issues/{id}/actions (start_review | resolve | reopen | assign), /notes, /evidence.
 */
import { useState } from 'react';
import { addIssueNote, getInspection, getIssue, issueAction, linkIssueEvidence } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { useApp } from '../context/AppContext';
import { pathFor } from '../lib/router';
import { formatDateTime, formatRelative, humanize } from '../lib/format';
import {
  AsyncButton, Card, ConnectPrompt, ErrorState, Icon, KeyValueGrid, Link, LoadingState, Modal, PageHeader,
  SeverityBadge, StatusBadge, VerdictBadge,
} from '../components/ui';
import {
  AssignForm, EvidenceThumb, ImagePreviewModal, InlineError, IssueActionDialog, NoteComposer, NotesList, TraceChain,
} from './review/components';
import { ISSUE_TRANSITIONS } from './review/constants';
import { stateText } from './review/helpers';
import '../styles/review.css';

export default function IssueDetailPage({ route }) {
  const issueId = route.params[0];
  const { principal, refreshCounts } = useApp();
  const { data: issue, error, loading, reload, notConnected } = useApi(() => getIssue(issueId), [issueId]);
  const inspectionId = issue?.inspection_id;
  const parent = useApi(() => getInspection(inspectionId), [inspectionId], { enabled: Boolean(inspectionId) });
  const [confirm, setConfirm] = useState(null);
  const [linking, setLinking] = useState(false);
  const [preview, setPreview] = useState(null);
  const [actionError, setActionError] = useState(null);

  if (notConnected) return <Card><ConnectPrompt /></Card>;
  if (!issue && loading) return <LoadingState label={`Loading issue ${issueId}…`} />;
  if (!issue && error) {
    return (
      <div className="stack">
        <PageHeader title={issueId} breadcrumbs={[{ label: 'Exceptions', to: 'exceptions' }, { label: issueId }]} />
        <ErrorState error={error} onRetry={reload} title={error.status === 404 ? 'Issue not found' : 'Could not load issue'} />
      </div>
    );
  }
  if (!issue) return null;

  const can = (action) => ISSUE_TRANSITIONS[action]?.includes(issue.status);
  const afterMutation = () => { setActionError(null); reload(); parent.reload(); refreshCounts?.(); };
  const evidence = issue.evidence_files || [];
  const reviewTasks = parent.data?.review_tasks || [];
  const latestTask = reviewTasks[reviewTasks.length - 1];
  const inspection = issue.inspection;
  const check = (parent.data?.record?.checks || []).find((c) => c.check_key === issue.check_key);

  return (
    <div className="stack">
      <PageHeader
        title={issue.title || issue.issue_id}
        icon="alert"
        breadcrumbs={[{ label: 'Exceptions', to: 'exceptions' }, { label: issue.issue_id }]}
        subtitle={issue.reason}
        actions={(
          <>
            <Link to={pathFor('inspections', issue.inspection_id)} className="btn-theme"><Icon name="external" size={14} /> Inspection</Link>
            <button type="button" className="btn-theme" onClick={() => { reload(); parent.reload(); }} disabled={loading}>
              {loading ? <span className="spinner ui-spinner-accent" aria-hidden="true" /> : <Icon name="refresh" size={14} />} Refresh
            </button>
          </>
        )}
      />

      {error && <InlineError error={error} title="Refresh failed — showing the last loaded data" />}

      <Card title="Traceability" sub="Inspection → check → issue → evidence → review">
        <TraceChain steps={[
          { label: 'Inspection', value: issue.inspection_id, to: pathFor('inspections', issue.inspection_id),
            badge: inspection ? <VerdictBadge verdict={inspection.verdict} /> : null },
          { label: 'Check', value: humanize(issue.check_key) },
          { label: 'Issue', value: issue.issue_id, badge: <StatusBadge status={issue.status} /> },
          { label: 'Evidence', value: evidence.length ? `${evidence.length} photo${evidence.length === 1 ? '' : 's'}` : 'none linked' },
          latestTask
            ? { label: 'Review task', value: latestTask.task_id, to: pathFor('reviews', latestTask.task_id), badge: <StatusBadge status={latestTask.status} /> }
            : { label: 'Review task', value: parent.loading ? '…' : 'none' },
        ]} />
      </Card>

      <div className="rv-grid-main">
        <div className="stack">
          <Card title="Details" actions={<><SeverityBadge severity={issue.severity} /> <StatusBadge status={issue.status} /></>}>
            <KeyValueGrid columns={3} items={[
              { label: 'Issue type', value: issue.issue_type, mono: true },
              { label: 'Check', value: `${humanize(issue.check_key)} (${issue.check_name || '—'})` },
              { label: 'Record', value: issue.record_id, mono: true },
              { label: 'PO', value: issue.po_id ? <Link to={pathFor('purchase-orders', issue.po_id)} className="link mono">{issue.po_id}</Link> : null },
              { label: 'SKU', value: issue.sku ? <Link to={pathFor('products', issue.sku)} className="link mono">{issue.sku}</Link> : null },
              { label: 'Supplier', value: issue.supplier },
              { label: 'Created', value: <span title={formatDateTime(issue.created_at)}>{formatRelative(issue.created_at)}</span> },
              { label: 'Updated', value: formatDateTime(issue.updated_at) },
              { label: 'Assignee', value: issue.assigned_to },
              { label: 'Resolved', value: issue.resolved_at ? `${formatDateTime(issue.resolved_at)} by ${issue.resolved_by || '—'}` : null, hideEmpty: true, span: 3 },
            ]} />
            <div className="rv-compare">
              <div className="rv-compare-box">
                <h3 className="rv-section-title">Expected</h3>
                <div className="rv-compare-value">{stateText(issue.expected)}</div>
              </div>
              <div className="rv-compare-box is-observed">
                <h3 className="rv-section-title">Observed</h3>
                <div className="rv-compare-value">{stateText(issue.observed)}</div>
              </div>
            </div>
            <div>
              <h3 className="rv-section-title">Reason</h3>
              <p className="rv-check-reason">{issue.reason || '—'}</p>
              {check && (
                <p className="hint">
                  Machine check verdict <strong>{check.verdict}</strong> · reason code <span className="mono">{check.reason_code || '—'}</span>
                  {check.model_version ? ` · decided by ${check.model_version}` : ''}
                </p>
              )}
            </div>
          </Card>

          <Card
            title={`Linked evidence (${evidence.length})`}
            sub="Photos from this inspection that support the issue."
            actions={(
              <button type="button" className="btn-theme" onClick={() => setLinking(true)}>
                <Icon name="link" size={14} /> Link evidence
              </button>
            )}
          >
            {evidence.length === 0
              ? <p className="hint">No photos linked yet. Use “Link evidence” to attach photos of this inspection.</p>
              : (
                <div className="rv-thumbs">
                  {evidence.map((file) => (
                    <div key={file.evidence_id} className="rv-cell-stack">
                      <EvidenceThumb inspectionId={file.inspection_id} imageId={file.evidence_id} alt={file.filename}
                        size="md" onOpen={() => setPreview(file)}
                        caption={<span className="rv-thumb-cap">{humanize(file.view)} · {file.filename}</span>} />
                      <Link to={pathFor('evidence', file.evidence_id)} className="link mono">{file.evidence_id}</Link>
                    </div>
                  ))}
                </div>
              )}
          </Card>

          <Card title={`Notes (${issue.notes?.length || 0})`}>
            <NotesList notes={issue.notes || []} />
            <NoteComposer onAdd={(text) => addIssueNote(issue.issue_id, text)} onDone={reload} />
          </Card>
        </div>

        <div className="stack">
          <Card title="Actions" sub={`Status: ${humanize(issue.status)}`}>
            {issue.status === 'superseded' && (
              <div className="rv-callout">
                <Icon name="info" size={16} />
                <span>A later run of this inspection replaced this issue. It is kept for the audit trail and cannot change state.</span>
              </div>
            )}
            <div className="rv-actions">
              <AsyncButton icon="eye" label="Start review" loadingLabel="Starting…" successLabel="In review"
                disabled={!can('start_review')} title={can('start_review') ? undefined : `Only open issues can start review (now ${issue.status}).`}
                onClick={() => issueAction(issue.issue_id, 'start_review')}
                successToast="Issue moved to in review" errorToast="Could not start review"
                onSuccess={afterMutation} onError={setActionError} />
              <button type="button" className="btn-primary" disabled={!can('resolve')}
                title={can('resolve') ? undefined : `Only open or in-review issues can be resolved (now ${issue.status}).`}
                onClick={() => setConfirm('resolve')}>
                <Icon name="check" size={14} /> Resolve
              </button>
              <button type="button" className="btn-theme" disabled={!can('reopen')}
                title={can('reopen') ? undefined : `Only resolved issues can be reopened (now ${issue.status}).`}
                onClick={() => setConfirm('reopen')}>
                <Icon name="refresh" size={14} /> Reopen
              </button>
            </div>
            {actionError && <InlineError error={actionError} title={actionError.status === 409 ? 'Not allowed in the current state' : 'Action failed'} />}
            <h3 className="rv-section-title">Assignment</h3>
            {can('assign')
              ? <AssignForm key={issue.assigned_to || ''} current={issue.assigned_to} principal={principal}
                onAssign={(who) => issueAction(issue.issue_id, 'assign', { assigned_to: who }).catch((err) => { setActionError(err); throw err; })}
                onDone={afterMutation} />
              : <p className="hint">Superseded issues cannot be assigned.</p>}
          </Card>

          <Card title="Inspection" sub={inspection?.product_name || ''}>
            {inspection ? (
              <KeyValueGrid columns={2} dense items={[
                { label: 'Inspection', value: <Link to={pathFor('inspections', inspection.inspection_id)} className="link mono">{inspection.inspection_id}</Link> },
                { label: 'Verdict', value: <VerdictBadge verdict={inspection.verdict} /> },
                { label: 'Shipment', value: inspection.shipment_id ? <Link to={pathFor('shipments', inspection.shipment_id)} className="link mono">{inspection.shipment_id}</Link> : null },
                { label: 'Open issues', value: inspection.open_issue_count },
                { label: 'Photos', value: inspection.image_count },
                { label: 'Channel', value: inspection.channel },
              ]} />
            ) : <p className="hint">The parent inspection is not available.</p>}
          </Card>

          <Card title={`Review tasks (${reviewTasks.length})`} sub="Human review of the parent inspection.">
            {parent.error && <InlineError error={parent.error} title="Could not load the inspection" />}
            {parent.loading && !parent.data && <LoadingState compact label="Loading…" />}
            {parent.data && reviewTasks.length === 0 && <p className="hint">No review task for this inspection.</p>}
            {reviewTasks.length > 0 && (
              <ul className="rv-checks">
                {[...reviewTasks].reverse().map((task) => (
                  <li key={task.task_id} className="rv-check">
                    <div className="rv-check-head">
                      <Link to={pathFor('reviews', task.task_id)} className="link mono">{task.task_id}</Link>
                      <StatusBadge status={task.status} />
                      {task.human_decision && <VerdictBadge verdict={task.human_decision} />}
                    </div>
                    <p className="hint">{formatDateTime(task.created_at)} · machine {task.machine_verdict || '—'}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {confirm && <IssueActionDialog issue={issue} action={confirm} onCancel={() => setConfirm(null)} onDone={afterMutation} />}
      {linking && (
        <LinkEvidenceModal issue={issue} parent={parent} onClose={() => setLinking(false)} onLinked={afterMutation} />
      )}
      {preview && <ImagePreviewModal file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function LinkEvidenceModal({ issue, parent, onClose, onLinked }) {
  const [selected, setSelected] = useState('');
  const [error, setError] = useState(null);
  const files = parent.data?.evidence_files || [];
  const linked = new Set(issue.evidence_image_ids || []);
  const candidates = files.filter((file) => !linked.has(file.evidence_id));

  return (
    <Modal
      wide
      title="Link evidence"
      subtitle={`Choose a photo of inspection ${issue.inspection_id} to attach to ${issue.issue_id}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-theme" onClick={onClose}>Cancel</button>
          <AsyncButton variant="primary" icon="link" label="Link selected photo" loadingLabel="Linking…" successLabel="Linked"
            disabled={!selected} resetAfter={0}
            onClick={() => { setError(null); return linkIssueEvidence(issue.issue_id, selected); }}
            successToast={`${selected} linked to ${issue.issue_id}`} errorToast={false}
            onError={setError}
            onSuccess={() => { onLinked(); onClose(); }} />
        </>
      )}
    >
      <div className="rv-form">
        {parent.loading && !parent.data && <LoadingState compact label="Loading inspection photos…" />}
        {parent.error && <InlineError error={parent.error} title="Could not load the inspection photos" />}
        {parent.data && files.length === 0 && <p className="hint">This inspection has no photos. Upload them from the inspection page first.</p>}
        {parent.data && files.length > 0 && candidates.length === 0 && <p className="hint">Every photo of this inspection is already linked.</p>}
        {candidates.length > 0 && (
          <div className="rv-pick-grid" role="radiogroup" aria-label="Photos">
            {candidates.map((file) => (
              <EvidenceThumb key={file.evidence_id} inspectionId={file.inspection_id} imageId={file.evidence_id} alt={file.filename}
                size="md" selected={selected === file.evidence_id} onOpen={() => setSelected(file.evidence_id)}
                caption={(
                  <span className="rv-thumb-cap">
                    {humanize(file.view)} · <span className="mono">{file.evidence_id}</span><br />{file.filename}
                  </span>
                )} />
            ))}
          </div>
        )}
        {linked.size > 0 && <p className="hint">Already linked: <span className="mono">{[...linked].join(', ')}</span></p>}
        {error && <InlineError error={error} title="Could not link the photo" />}
      </div>
    </Modal>
  );
}
