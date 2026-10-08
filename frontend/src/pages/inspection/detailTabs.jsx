/*
 * Tab panels for the inspection detail page. Everything shown comes from GET /api/inspections/{id}
 * (view + issues + review_tasks + evidence_files), /audit and /verify.
 */
import { useState } from 'react';
import { getInspectionAudit, verifyInspection } from '../../services/api';
import { useApi } from '../../hooks/useAsync';
import { formatBytes, formatDateTime, humanize } from '../../lib/format';
import { navigate, pathFor } from '../../lib/router';
import {
  AsyncButton, Card, DataTable, EmptyState, ErrorState, Icon, JsonViewer, KeyValueGrid, Link, SeverityBadge,
  StatusBadge, Timeline, VerdictBadge, auditEventToItem,
} from '../../components/ui';
import { CheckStatusBadge, ChecksTable, ConfidenceMeter, EvidenceLightbox, EvidenceThumb, EvidenceUploader, SourceTag } from './components';
import { countByStatus, displayValue, recommendedAction, viewLabel } from './helpers';

const findCheck = (checks, name) => checks.find((c) => c.check_name === name) || null;

function variance(check) {
  if (!check) return null;
  const e = Number(check.expected_value);
  const o = Number(check.observed_value);
  if (check.observed_value === null || check.observed_value === undefined || Number.isNaN(e) || Number.isNaN(o)) return null;
  return o - e;
}

function CheckRow({ label, check, showVariance }) {
  const v = showVariance ? variance(check) : null;
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="mono">{displayValue(check?.expected_value)}</td>
      <td className="mono">{check ? displayValue(check.observed_value) : '—'}</td>
      {showVariance !== undefined && (
        <td className={`mono insp-var ${v > 0 ? 'over' : v < 0 ? 'short' : ''}`}>{v === null ? '—' : v > 0 ? `+${v}` : String(v)}</td>
      )}
      <td>{check ? <CheckStatusBadge status={check.status} /> : <span className="hint">Not run</span>}</td>
      <td className="insp-reason">{check ? <>{check.reason} <SourceTag modelVersion={check.model_version} /></> : '—'}</td>
    </tr>
  );
}

function CompareTable({ rows, withVariance }) {
  return (
    <div className="table-wrapper ui-table-wrapper">
      <table className="data-table ui-data-table insp-compare">
        <thead>
          <tr>
            <th scope="col">Check</th><th scope="col">Expected</th><th scope="col">Observed</th>
            {withVariance && <th scope="col">Variance</th>}
            <th scope="col">Status</th><th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>{rows.map((r) => <CheckRow key={r.label} label={r.label} check={r.check} showVariance={withVariance ? r.variance : undefined} />)}</tbody>
      </table>
    </div>
  );
}

// ── overview ──

export function OverviewTab({ inspection, checks, onAddNote }) {
  const ran = Boolean(inspection.record);
  const manual = inspection.manual_observations;
  const manualItems = manual ? [
    { label: 'Observed SKU', value: manual.observed_sku },
    { label: 'Observed variant', value: manual.observed_variant },
    { label: 'Counted units', value: manual.observed_quantity },
    { label: 'Counted cartons', value: manual.observed_cartons },
    { label: 'Units per carton', value: manual.observed_units_per_carton },
    { label: 'Damage', value: manual.damage },
    { label: 'Components present', value: manual.components_present },
    { label: 'Components missing', value: manual.components_missing },
    { label: 'Note', value: manual.note, span: 3 },
  ] : [];
  const cartonCheck = findCheck(checks, 'carton_condition_check');
  return (
    <div className="dashboard-grid insp-overview">
      <Card title="Quantity" sub={ran ? 'Expected (PO) vs observed — variance = observed − expected' : 'Not run yet'} className="card-span">
        <CompareTable withVariance rows={[
          { label: 'Total quantity', check: findCheck(checks, 'quantity_check'), variance: true },
          { label: 'Cartons', check: findCheck(checks, 'carton_check'), variance: true },
          { label: 'Units per carton', check: findCheck(checks, 'units_per_carton_check'), variance: true },
        ]} />
      </Card>
      <Card title="Product identity & variant">
        <CompareTable rows={[
          { label: 'SKU', check: findCheck(checks, 'sku_check') },
          { label: 'Variant', check: findCheck(checks, 'variant_check') },
        ]} />
      </Card>
      <Card title="Product condition">
        <CompareTable rows={[
          { label: 'Damage', check: findCheck(checks, 'damage_check') },
          { label: 'Components', check: findCheck(checks, 'component_check') },
        ]} />
      </Card>
      <Card title="Carton condition" sub={`${inspection.cartons?.length || 0} carton(s) recorded at intake`} className="card-span">
        {cartonCheck && (
          <p className="insp-inline-check"><CheckStatusBadge status={cartonCheck.status} /> {cartonCheck.reason}
            {cartonCheck.status !== 'PASS' && cartonCheck.status !== 'NOT_REQUIRED' && <span className="hint"> — {recommendedAction(cartonCheck)}</span>}</p>
        )}
        {inspection.cartons?.length ? (
          <DataTable rowKey="carton_id" rows={inspection.cartons}
            onRowClick={(row) => navigate(pathFor('cartons', inspection.inspection_id, row.carton_id))}
            columns={[
              { key: 'carton_id', header: 'Carton', mono: true, render: (r) => <Link to={pathFor('cartons', inspection.inspection_id, r.carton_id)} className="link mono">{r.carton_id}</Link> },
              { key: 'expected_units', header: 'Expected units', align: 'right' },
              { key: 'seal_condition', header: 'Seal', render: (r) => <StatusBadge status={r.seal_condition || 'unknown'} /> },
              { key: 'visible_condition', header: 'Condition', render: (r) => <StatusBadge status={r.visible_condition || 'unknown'} /> },
              { key: 'carton_type', header: 'Type' },
              { key: 'weight_kg', header: 'Weight kg', align: 'right' },
              { key: 'dimensions_cm', header: 'Dimensions cm' },
              { key: 'notes', header: 'Notes' },
            ]} />
        ) : <p className="hint">No cartons were recorded for this inspection.</p>}
      </Card>
      <Card title="Operator counts" sub="Recorded by the operator as their own evidence, not AI">
        {manual ? <KeyValueGrid columns={3} items={manualItems} /> : <p className="hint">No operator counts recorded.</p>}
      </Card>
      <Card title="Notes" sub={`${inspection.notes?.length || 0} note(s)`} actions={<button type="button" className="detail-btn" onClick={onAddNote}><Icon name="plus" size={13} /> Add note</button>}>
        {inspection.notes?.length ? (
          <Timeline compact items={[...inspection.notes].reverse().map((n) => ({
            id: n.note_id, title: n.text, time: n.created_at, meta: [n.author && `by ${n.author}`, n.role].filter(Boolean).join(' · '),
          }))} />
        ) : <p className="hint">No notes yet.</p>}
      </Card>
    </div>
  );
}

// ── checks ──

export function ChecksTab({ checks }) {
  const counts = countByStatus(checks);
  return (
    <Card title="Checks" sub={checks.length ? `${counts.FAIL} fail · ${counts.UNCERTAIN} uncertain · ${counts.PASS} pass · ${counts.NOT_REQUIRED} not required` : 'Not run yet'} flush>
      <div className="insp-pad"><ChecksTable checks={checks} /></div>
      <p className="hint insp-pad">Row colour = severity (red: failed — exception raised; amber: uncertain — needs review). Recommended actions are guidance derived from each result.</p>
    </Card>
  );
}

// ── evidence ──

export function EvidenceTab({ inspection, uploadOpen, setUploadOpen, onUploaded }) {
  const files = inspection.evidence_files || [];
  const [open, setOpen] = useState(-1);
  return (
    <div className="stack">
      <Card title="Evidence" sub={`${files.length} photo(s) · fetched with your API key`}
        actions={<button type="button" className="btn-theme" onClick={() => setUploadOpen(!uploadOpen)}><Icon name="upload" size={14} /> {uploadOpen ? 'Hide upload' : 'Upload more evidence'}</button>}>
        {uploadOpen && (
          <div className="insp-upload-panel">
            <EvidenceUploader inspectionId={inspection.inspection_id} existingCount={inspection.images?.length || 0} onUploaded={onUploaded} />
            <p className="hint">New photos are not analysed until you re-run the inspection.</p>
          </div>
        )}
        {!files.length ? <EmptyState icon="image" title="No photos" message="This inspection has no photo evidence." compact /> : (
          <ul className="insp-evidence-grid">
            {files.map((f, index) => (
              <li key={f.image_id} className="insp-evidence-card">
                <EvidenceThumb inspectionId={inspection.inspection_id} imageId={f.image_id} alt={f.filename} onClick={() => setOpen(index)} />
                <div className="insp-evidence-meta">
                  <div className="insp-evidence-top">
                    <span className="ui-badge tone-neutral">{viewLabel(f.view)}</span>
                    <StatusBadge status={f.analysis_status} />
                  </div>
                  <Link to={pathFor('evidence', f.image_id)} className="link mono">{f.image_id}</Link>
                  <span className="hint insp-break">{f.filename} · {formatBytes(f.file_size)}</span>
                  <span className="hint">{f.readings?.length || 0} reading(s){f.linked_issue_ids?.length ? ` · ${f.linked_issue_ids.length} issue(s)` : ''}</span>
                  {f.readings?.length > 0 && (
                    <ul className="insp-reading-mini">
                      {f.readings.slice(0, 4).map((r) => (
                        <li key={r.evidence_id}><span className="mono">{r.check_type}</span>: {r.observation} <ConfidenceMeter value={r.confidence} /></li>
                      ))}
                      {f.readings.length > 4 && <li className="hint">+{f.readings.length - 4} more</li>}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {open >= 0 && files[open] && (
        <EvidenceLightbox inspectionId={inspection.inspection_id} file={files[open]} onClose={() => setOpen(-1)}
          onPrev={open > 0 ? () => setOpen(open - 1) : null} onNext={open < files.length - 1 ? () => setOpen(open + 1) : null} />
      )}
    </div>
  );
}

// ── issues / reviews ──

export function IssuesTab({ inspection }) {
  const issues = [...(inspection.issues || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return (
    <Card title="Exceptions" sub="One per failed or uncertain check; superseded when a later run replaces them" flush>
      <DataTable rowKey="issue_id" rows={issues}
        onRowClick={(row) => navigate(pathFor('issues', row.issue_id))}
        empty={{ icon: 'checkCircle', title: 'No exceptions', message: inspection.record ? 'Every check passed or was not required.' : 'The inspection has not been run.' }}
        columns={[
          { key: 'issue_id', header: 'Issue', render: (r) => <Link to={pathFor('issues', r.issue_id)} className="link mono">{r.issue_id}</Link> },
          { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 'title', header: 'Title' },
          { key: 'issue_type', header: 'Reason code', mono: true },
          { key: 'expected', header: 'Expected', render: (r) => displayValue(r.expected) },
          { key: 'observed', header: 'Observed', render: (r) => displayValue(r.observed) },
          { key: 'created_at', header: 'Raised', render: (r) => formatDateTime(r.created_at) },
        ]} />
    </Card>
  );
}

export function ReviewsTab({ inspection }) {
  const tasks = [...(inspection.review_tasks || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return (
    <Card title="Review tasks" sub="Human review queue entries for this inspection" flush>
      <DataTable rowKey="task_id" rows={tasks}
        onRowClick={(row) => navigate(pathFor('reviews', row.task_id))}
        empty={{ icon: 'inbox', title: 'No review tasks', message: 'None was opened automatically or manually.' }}
        columns={[
          { key: 'task_id', header: 'Task', render: (r) => <Link to={pathFor('reviews', r.task_id)} className="link mono">{r.task_id}</Link> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 'trigger', header: 'Trigger', render: (r) => humanize(r.trigger) },
          { key: 'machine_verdict', header: 'Machine verdict', render: (r) => <VerdictBadge verdict={r.machine_verdict} /> },
          { key: 'human_decision', header: 'Human decision', render: (r) => (r.human_decision ? <VerdictBadge verdict={r.human_decision} /> : '—') },
          { key: 'resolution', header: 'Resolution', render: (r) => humanize(r.resolution) },
          { key: 'assigned_to', header: 'Assigned' },
          { key: 'created_at', header: 'Opened', render: (r) => formatDateTime(r.created_at) },
          { key: 'decided_by', header: 'Decided by', render: (r) => (r.decided_by ? `${r.decided_by} · ${formatDateTime(r.decided_at)}` : '—') },
        ]} />
    </Card>
  );
}

// ── audit ──

export function AuditTab({ inspectionId, version }) {
  const audit = useApi(() => getInspectionAudit(inspectionId, { page_size: 200 }), [inspectionId, version]);
  const items = audit.data?.items || [];
  return (
    <Card title="Audit trail" sub={audit.data ? `${audit.data.total ?? items.length} event(s), oldest first · append-only` : 'Loading…'}
      actions={<button type="button" className="detail-btn" onClick={() => audit.reload()} disabled={audit.loading}><Icon name="refresh" size={13} /> Refresh</button>}>
      {audit.error ? <ErrorState error={audit.error} onRetry={audit.reload} title="Could not load the audit trail" compact />
        : <Timeline items={items.map(auditEventToItem)} empty={audit.loading ? 'Loading…' : 'No audit events.'} />}
      {audit.data && audit.data.total > items.length && (
        <p className="hint">Showing the first {items.length} of {audit.data.total}. <Link to="audit" query={{ inspection_id: inspectionId }}>Open the full audit log</Link>.</p>
      )}
    </Card>
  );
}

// ── record ──

export function RecordTab({ inspection }) {
  const [verify, setVerify] = useState(null);
  const record = inspection.record;
  return (
    <div className="stack">
      <Card title="Integrity" sub="Re-computes every sealed record version and override hash chain on the backend"
        actions={<AsyncButton icon="shield" label="Verify integrity" loadingLabel="Verifying…" onClick={() => verifyInspection(inspection.inspection_id)}
          errorToast="Verification request failed" onSuccess={setVerify} />}>
        {verify ? (
          <div className={`alert ${verify.integrity_verified ? 'insp-alert-ok' : 'alert-danger'}`} role="status">
            <Icon name={verify.integrity_verified ? 'checkCircle' : 'alert'} size={16} />
            <span className="alert-text">
              {verify.integrity_verified ? 'Integrity verified' : 'Integrity check FAILED'} — {verify.records} record version(s)
              {verify.ephemeral_key_records ? `, ${verify.ephemeral_key_records} sealed with an ephemeral key` : ''}.
              {verify.latest_content_hash && <> Latest hash <span className="mono insp-break">{verify.latest_content_hash}</span>.</>}
              {verify.problems?.length > 0 && <ul>{verify.problems.map((p) => <li key={String(p)}>{typeof p === 'string' ? p : JSON.stringify(p)}</li>)}</ul>}
            </span>
          </div>
        ) : <p className="hint">Not verified in this session.</p>}
      </Card>
      {record ? (
        <>
          <Card title="Record" sub={`${record.record_id} · v${record.version} · ${record.schema_version || ''}`}>
            <KeyValueGrid columns={3} items={[
              { label: 'Status / stage', value: `${humanize(record.status)} / ${humanize(record.stage)}` },
              { label: 'Analysed by', value: record.analyzed_by },
              { label: 'Sealed at', value: formatDateTime(record.created_at) },
              { label: 'Supersedes', value: record.supersedes && typeof record.supersedes === 'object' ? (record.supersedes.record_id || displayValue(record.supersedes)) : record.supersedes, mono: true },
              { label: 'Content hash', value: record.content_hash, mono: true, span: 2 },
              { label: 'Overrides', value: (record.overrides || []).length },
              { label: 'Vision provider', value: record.perception?.vision_provider, mono: true },
              { label: 'Vision status', value: record.perception?.vision_status },
            ]} />
          </Card>
          <JsonViewer data={record} title="Sealed record (latest version)" defaultDepth={1} />
        </>
      ) : <Card><EmptyState icon="file" title="No record yet" message="A sealed record is written on the first run." compact /></Card>}
    </div>
  );
}
