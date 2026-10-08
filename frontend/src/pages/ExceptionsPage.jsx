/*
 * ExceptionsPage — issues opened by inspection runs (GET /api/issues).
 * Hash query: status, severity, issue_type (comma lists), q, po, sku, inspection_id, range/date_from/date_to, page, page_size.
 * Dashboard deep links: #/app/exceptions?status=open, #/app/exceptions?issue_type=COUNT_MISMATCH,SKU_MISMATCH
 * Row quick actions call POST /api/issues/{id}/actions (resolve / reopen ask for confirmation first).
 */
import { useState } from 'react';
import { issueAction, listIssues } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { useApp } from '../context/AppContext';
import { navigate, pathFor, setQuery } from '../lib/router';
import { formatDateTime, formatRelative, listParamsFromQuery } from '../lib/format';
import {
  AsyncButton, Card, ConnectPrompt, DataTable, FilterBar, Link, PageHeader, Pagination,
  SeverityBadge, StatusBadge,
} from '../components/ui';
import { IssueActionDialog, MultiFilter, TextFilter } from './review/components';
import { ISSUE_SEVERITIES, ISSUE_STATUSES, ISSUE_TRANSITIONS, ISSUE_TYPES } from './review/constants';
import { joinList, parseList } from './review/helpers';
import '../styles/review.css';

const TYPE_OPTIONS = ISSUE_TYPES.map((value) => ({ value, label: value }));

export default function ExceptionsPage({ route }) {
  const query = route.query;
  const { refreshCounts } = useApp();
  const params = listParamsFromQuery(query, ['q', 'status', 'severity', 'issue_type', 'po', 'sku', 'inspection_id']);
  const { data, error, loading, reload, notConnected } = useApi(() => listIssues(params), [JSON.stringify(params)]);
  const [confirm, setConfirm] = useState(null); // {issue, action}

  if (notConnected) return <Card><ConnectPrompt /></Card>;

  const afterMutation = () => { reload(); refreshCounts?.(); };
  const can = (issue, action) => ISSUE_TRANSITIONS[action]?.includes(issue.status);

  return (
    <div className="stack">
      <PageHeader
        title="Exceptions"
        icon="alert"
        subtitle="One issue per FAIL or UNCERTAIN check. Issues stay open after a human review decision until someone resolves them; a new run supersedes the previous run’s issues."
        actions={(
          <button type="button" className="btn-theme" onClick={() => reload()} disabled={loading}>
            {loading ? <span className="spinner ui-spinner-accent" aria-hidden="true" /> : null} Refresh
          </button>
        )}
      />

      <FilterBar
        search={{ value: query.q, placeholder: 'Search issue, inspection, title, reason, SKU, PO, supplier…', onChange: (q) => setQuery({ q, page: 1 }) }}
        dateRange={{ value: query, onChange: (patch) => setQuery({ ...patch, page: 1 }) }}
        onReset={() => navigate('exceptions')}
        resultCount={data?.total}
      >
        <div className="rv-filter-extra">
          <MultiFilter label="Status" options={ISSUE_STATUSES} value={parseList(query.status)}
            onChange={(list) => setQuery({ status: joinList(list), page: 1 })} />
          <MultiFilter label="Severity" options={ISSUE_SEVERITIES} value={parseList(query.severity)}
            onChange={(list) => setQuery({ severity: joinList(list), page: 1 })} />
          <MultiFilter label="Type" options={TYPE_OPTIONS} value={parseList(query.issue_type)}
            onChange={(list) => setQuery({ issue_type: joinList(list), page: 1 })} />
          <TextFilter label="PO" value={query.po} width={120} onChange={(po) => setQuery({ po, page: 1 })} />
          <TextFilter label="SKU" value={query.sku} width={140} onChange={(sku) => setQuery({ sku, page: 1 })} />
          <TextFilter label="Inspection id" value={query.inspection_id} width={150} onChange={(v) => setQuery({ inspection_id: v, page: 1 })} />
        </div>
      </FilterBar>

      <Card flush className="rv-table-card">
        <DataTable
          rows={data?.items}
          rowKey="issue_id"
          loading={loading}
          error={error}
          onRetry={reload}
          onRowClick={(row) => navigate(pathFor('issues', row.issue_id))}
          empty={{
            icon: 'checkCircle',
            title: 'No issues match',
            message: 'Issues are created when an inspection run has FAIL or UNCERTAIN checks. Try clearing a filter or widening the date range.',
          }}
          columns={[
            {
              key: 'issue_type', header: 'Type', width: 200, render: (r) => (
                <div className="rv-cell-stack">
                  <Link to={pathFor('issues', r.issue_id)} className="link mono">{r.issue_type}</Link>
                  <span className="hint" title={r.reason}>{r.title}</span>
                </div>
              ),
            },
            { key: 'severity', header: 'Severity', render: (r) => <SeverityBadge severity={r.severity} /> },
            { key: 'inspection_id', header: 'Inspection', render: (r) => <Link to={pathFor('inspections', r.inspection_id)} className="link mono">{r.inspection_id}</Link> },
            { key: 'sku', header: 'SKU', render: (r) => (r.sku ? <Link to={pathFor('products', r.sku)} className="link mono">{r.sku}</Link> : '—') },
            { key: 'po_id', header: 'PO', render: (r) => (r.po_id ? <Link to={pathFor('purchase-orders', r.po_id)} className="link mono">{r.po_id}</Link> : '—') },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'created_at', header: 'Created', render: (r) => <span title={formatDateTime(r.created_at)}>{formatRelative(r.created_at)}</span> },
            { key: 'evidence', header: 'Evidence', align: 'right', render: (r) => (r.evidence_image_ids?.length ?? 0) },
            { key: 'assigned_to', header: 'Assignee', render: (r) => r.assigned_to || <span className="hint">—</span> },
            {
              key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', render: (r) => (
                // Stop row navigation when using the quick actions.
                // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
                <div className="rv-row-actions" onClick={(event) => event.stopPropagation()}>
                  {can(r, 'start_review') && (
                    <AsyncButton variant="small" label="Start review" loadingLabel="Starting…" successLabel="Started"
                      onClick={() => issueAction(r.issue_id, 'start_review')}
                      successToast={`${r.issue_id} in review`} errorToast="Could not start review" onSuccess={afterMutation} />
                  )}
                  {can(r, 'resolve') && (
                    <button type="button" className="detail-btn" onClick={() => setConfirm({ issue: r, action: 'resolve' })}>Resolve</button>
                  )}
                  {can(r, 'reopen') && (
                    <button type="button" className="detail-btn" onClick={() => setConfirm({ issue: r, action: 'reopen' })}>Reopen</button>
                  )}
                  {r.status === 'superseded' && <span className="hint">Superseded</span>}
                </div>
              ),
            },
          ]}
        />
        <Pagination
          page={data?.page} pageSize={data?.page_size} total={data?.total}
          onPageChange={(page) => setQuery({ page })}
          onPageSizeChange={(page_size) => setQuery({ page_size, page: 1 })}
        />
      </Card>

      {confirm && (
        <IssueActionDialog issue={confirm.issue} action={confirm.action} onCancel={() => setConfirm(null)} onDone={afterMutation} />
      )}
    </div>
  );
}
