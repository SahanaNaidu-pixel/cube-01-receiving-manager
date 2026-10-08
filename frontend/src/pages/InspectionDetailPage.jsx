/*
 * Inspection detail (#/app/inspections/<id>): verdict header, facts, tabs (overview, checks, evidence, issues,
 * reviews, audit, record) and real actions (exports, hand-off, review, override, re-run, notes, uploads).
 * The tab is kept in ?tab= so it is linkable.
 */
import { useState } from 'react';
import { downloadInspectionExport, getInspection } from '../services/api';
import { useApp } from '../context/AppContext';
import { useApi } from '../hooks/useAsync';
import { formatDateTime, formatPercent, humanize } from '../lib/format';
import { pathFor, setQuery } from '../lib/router';
import {
  AsyncButton, Card, ConnectPrompt, ErrorState, Icon, KeyValueGrid, Link, LoadingState, PageHeader, StatusBadge, Tabs, VerdictBadge,
} from '../components/ui';
import { RunOutcomeNotice, VerdictBanner, useInspectionEnv } from './inspection/components';
import { ACTIVE_REVIEW, confidenceSummary, mergedChecks, overallRecommendation, runOutcome, uiVerdictOf } from './inspection/helpers';
import { HandoffDialog, NoteDialog, OverrideDialog, RerunDialog, ReviewDialog } from './inspection/detailActions';
import { AuditTab, ChecksTab, EvidenceTab, IssuesTab, OverviewTab, RecordTab, ReviewsTab } from './inspection/detailTabs';
import '../styles/inspection.css';

const TAB_KEYS = ['overview', 'checks', 'evidence', 'issues', 'reviews', 'audit', 'record'];

export default function InspectionDetailPage({ route }) {
  const id = route.params[0] || '';
  const tab = TAB_KEYS.includes(route.query.tab) ? route.query.tab : 'overview';
  const env = useInspectionEnv();
  const { refreshCounts } = useApp();
  const { data: inspection, error, loading, reload, notConnected } = useApi(() => getInspection(id), [id]);
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);

  const refresh = async () => {
    await reload();
    setVersion((v) => v + 1);
    refreshCounts();
  };

  const crumbs = [{ label: 'Inspections', to: 'inspections' }, { label: id }];
  if (notConnected) return <div className="stack"><PageHeader title={`Inspection ${id}`} breadcrumbs={crumbs} /><Card><ConnectPrompt /></Card></div>;
  if (error && !inspection) {
    return (
      <div className="stack">
        <PageHeader title={`Inspection ${id}`} breadcrumbs={crumbs} />
        <Card><ErrorState error={error} onRetry={reload} title={error.status === 404 ? 'Inspection not found' : 'Could not load the inspection'} /></Card>
      </div>
    );
  }
  if (!inspection) return <div className="stack"><PageHeader title={`Inspection ${id}`} breadcrumbs={crumbs} /><Card><LoadingState label="Loading inspection…" /></Card></div>;

  const checks = mergedChecks(inspection);
  const verdict = uiVerdictOf(inspection);
  const outcome = runOutcome(inspection);
  const conf = confidenceSummary(checks);
  const po = inspection.po || {};
  const ship = inspection.shipment || {};
  const record = inspection.record;
  const task = inspection.review_task;
  const activeReview = task && ACTIVE_REVIEW.has(task.status);
  const openIssues = (inspection.issues || []).filter((i) => i.status === 'open' || i.status === 'in_review').length;

  const exportBtn = (fmt, label, icon) => (
    <AsyncButton icon={icon} label={label} loadingLabel="Preparing…" successLabel="Downloaded"
      onClick={() => downloadInspectionExport(id, fmt)} successToast={(r) => `Saved ${r?.filename || label}`} errorToast={`${label} failed`} />
  );

  return (
    <div className="stack">
      <PageHeader
        title={<span className="insp-title">Inspection <span className="mono">{inspection.inspection_id}</span> <VerdictBadge verdict={record ? inspection.verdict : null} /></span>}
        subtitle={`${po.product_name || '—'} · ${po.sku || ''}${po.variant ? ` · ${po.variant}` : ''}`}
        breadcrumbs={crumbs}
        actions={(
          <>
            {exportBtn('html', 'Download report', 'download')}
            {exportBtn('json', 'Export JSON', 'file')}
            {exportBtn('csv', 'Export CSV', 'file')}
          </>
        )}
      />

      <Card flush>
        <div className="insp-detail-head">
          <VerdictBanner verdict={verdict} checks={checks}>
            <div className="insp-verdict-rec"><Icon name="arrowRight" size={14} /> {overallRecommendation(verdict)}</div>
            {inspection.override_decision && (
              <div className="insp-verdict-note"><Icon name="shield" size={14} /> Overridden to {humanize(inspection.override_decision)}{inspection.override_reason ? ` — ${inspection.override_reason}` : ''}</div>
            )}
          </VerdictBanner>
          <div className="insp-detail-facts">
            <KeyValueGrid columns={4} items={[
              { label: 'Inspection ID', value: inspection.inspection_id, mono: true },
              { label: 'PO', value: po.po_id ? <Link to={pathFor('purchase-orders', po.po_id)} className="link mono">{po.po_id}</Link> : null },
              { label: 'SKU', value: po.sku ? <Link to={pathFor('products', po.sku)} className="link mono">{po.sku}</Link> : null },
              { label: 'Shipment', value: ship.shipment_id ? <Link to={pathFor('shipments', ship.shipment_id)} className="link mono">{ship.shipment_id}</Link> : null },
              { label: 'Supplier', value: ship.supplier },
              { label: 'Warehouse / ASN', value: [ship.warehouse, ship.asn].filter(Boolean).join(' · ') || null },
              { label: 'Status', value: <StatusBadge status={inspection.status} /> },
              { label: 'Confidence', value: conf ? `min ${formatPercent(conf.min)} · avg ${formatPercent(conf.avg)} (${conf.count} checks)` : null },
              { label: 'Created', value: `${formatDateTime(inspection.created_at)}${inspection.created_by ? ` by ${inspection.created_by}` : ''}` },
              { label: 'Updated', value: formatDateTime(inspection.updated_at) },
              { label: 'Analysed by', value: record ? `${record.analyzed_by || '—'} · ${formatDateTime(record.created_at)}` : 'Not run' },
              { label: 'Open issues / review', value: (
                <span>{openIssues} open · {task ? <Link to={pathFor('reviews', task.task_id)} className="link mono">{task.task_id}</Link> : 'no review'}{task ? ` (${humanize(task.status).toLowerCase()})` : ''}</span>
              ) },
            ]} />
          </div>
          <div className="insp-pad"><RunOutcomeNotice outcome={outcome} /></div>
          <div className="insp-detail-actions ui-button-row">
            <button type="button" className="btn-primary" onClick={() => setDialog('rerun')}><Icon name="play" size={14} /> {record ? 'Re-run' : 'Run'}</button>
            <button type="button" className="btn-theme" onClick={() => setDialog('override')} disabled={!record} title={record ? '' : 'Run the inspection before overriding'}><Icon name="shield" size={14} /> Override</button>
            {activeReview
              ? <Link to={pathFor('reviews', task.task_id)} className="btn-theme"><Icon name="inbox" size={14} /> Open review {task.task_id}</Link>
              : <button type="button" className="btn-theme" onClick={() => setDialog('review')}><Icon name="inbox" size={14} /> Create review task</button>}
            <button type="button" className="btn-theme" onClick={() => setDialog('handoff')} disabled={!record} title={record ? '' : 'Nothing to hand off until the inspection has a record'}><Icon name="send" size={14} /> Send to agent</button>
            <button type="button" className="btn-theme" onClick={() => setDialog('note')}><Icon name="plus" size={14} /> Add note</button>
            <button type="button" className="btn-theme" onClick={() => setQuery({ tab: 'evidence', upload: '1' })}><Icon name="upload" size={14} /> Upload evidence</button>
            <button type="button" className="detail-btn" onClick={() => reload()} disabled={loading}><Icon name="refresh" size={13} /> Refresh</button>
            {!record && <Link to="new-inspection" query={{ id: inspection.inspection_id, step: 4 }} className="detail-btn">Continue in wizard</Link>}
          </div>
        </div>
      </Card>

      <Tabs
        active={tab}
        onChange={(key) => setQuery({ tab: key === 'overview' ? '' : key })}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'checks', label: 'Checks', count: checks.length },
          { key: 'evidence', label: 'Evidence', count: inspection.evidence_files?.length || 0 },
          { key: 'issues', label: 'Issues', count: inspection.issues?.length || 0 },
          { key: 'reviews', label: 'Reviews', count: inspection.review_tasks?.length || 0 },
          { key: 'audit', label: 'Audit' },
          { key: 'record', label: 'Record' },
        ]}
      />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' && <OverviewTab inspection={inspection} checks={checks} onAddNote={() => setDialog('note')} />}
        {tab === 'checks' && <ChecksTab checks={checks} />}
        {tab === 'evidence' && (
          <EvidenceTab inspection={inspection} uploadOpen={route.query.upload === '1'}
            setUploadOpen={(open) => setQuery({ upload: open ? '1' : '' })} onUploaded={refresh} />
        )}
        {tab === 'issues' && <IssuesTab inspection={inspection} />}
        {tab === 'reviews' && <ReviewsTab inspection={inspection} />}
        {tab === 'audit' && <AuditTab inspectionId={inspection.inspection_id} version={version} />}
        {tab === 'record' && <RecordTab inspection={inspection} />}
      </div>

      {dialog === 'handoff' && <HandoffDialog inspection={inspection} env={env} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'review' && <ReviewDialog inspection={inspection} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'override' && <OverrideDialog inspection={inspection} env={env} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'note' && <NoteDialog inspection={inspection} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'rerun' && <RerunDialog inspection={inspection} env={env} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}
