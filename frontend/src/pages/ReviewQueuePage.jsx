/*
 * ReviewQueuePage — human review tasks (GET /api/reviews).
 * Hash query: status (comma list | 'all'; default open,evidence_requested), q, range/date_from/date_to, page, page_size.
 * Deep link used by the dashboard: #/app/reviews?status=open,evidence_requested
 */
import { listReviews } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { formatDateTime, formatRelative, listParamsFromQuery, humanize } from '../lib/format';
import {
  Card, ConnectPrompt, DataTable, FilterBar, Link, PageHeader, Pagination, StatusBadge, Tabs, VerdictBadge,
} from '../components/ui';
import { REVIEW_TABS, REVIEW_TRIGGERS } from './review/constants';
import { parseList } from './review/helpers';
import '../styles/review.css';

const DEFAULT_STATUS = 'open,evidence_requested';
const sameSet = (a, b) => {
  const x = parseList(a).sort().join(',');
  const y = parseList(b).sort().join(',');
  return x === y;
};

export default function ReviewQueuePage({ route }) {
  const query = route.query;
  const status = query.status || DEFAULT_STATUS;
  const apiStatus = status === 'all' ? undefined : status;
  const params = { ...listParamsFromQuery(query, ['q']), status: apiStatus };
  const activeTab = REVIEW_TABS.find((tab) => sameSet(tab.status, status))?.key;

  const { data, error, loading, reload, notConnected } = useApi(() => listReviews(params), [JSON.stringify(params)]);

  // Per-tab totals under the same search/date filters (page_size=1: only `total` is used).
  const countParams = { ...listParamsFromQuery(query, ['q']), page: 1, page_size: 1 };
  const counts = useApi(async () => {
    const entries = await Promise.all(REVIEW_TABS.map(async (tab) => {
      const res = await listReviews({ ...countParams, status: tab.status === 'all' ? undefined : tab.status });
      return [tab.key, res.total];
    }));
    return Object.fromEntries(entries);
  }, [JSON.stringify(countParams)]);

  if (notConnected) return <Card><ConnectPrompt /></Card>;

  const tabs = REVIEW_TABS.map((tab) => ({ key: tab.key, label: tab.label, count: counts.data?.[tab.key] }));

  return (
    <div className="stack">
      <PageHeader
        title="Review queue"
        subtitle="Inspections the machine could not decide on its own. A reviewer records the human decision; the original machine result is always preserved in the sealed record."
        icon="users"
        actions={(
          <button type="button" className="btn-theme" onClick={() => { reload(); counts.reload(); }} disabled={loading}>
            {loading ? <span className="spinner ui-spinner-accent" aria-hidden="true" /> : null} Refresh
          </button>
        )}
      />

      <Tabs
        idPrefix="review-tab"
        tabs={tabs}
        active={activeTab}
        onChange={(key) => {
          const tab = REVIEW_TABS.find((t) => t.key === key);
          setQuery({ status: tab.status === DEFAULT_STATUS ? '' : tab.status, page: 1 });
        }}
      />
      {!activeTab && (
        <p className="hint">Custom status filter: <span className="mono">{status}</span> · <Link to="reviews">clear</Link></p>
      )}

      <FilterBar
        search={{ value: query.q, placeholder: 'Search task, inspection, PO, SKU, supplier, assignee…', onChange: (q) => setQuery({ q, page: 1 }) }}
        dateRange={{ value: query, onChange: (patch) => setQuery({ ...patch, page: 1 }) }}
        onReset={() => navigate('reviews')}
        resultCount={data?.total}
      />

      <Card flush className="rv-table-card">
        <DataTable
          rows={data?.items}
          rowKey="task_id"
          loading={loading}
          error={error}
          onRetry={reload}
          onRowClick={(row) => navigate(pathFor('reviews', row.task_id))}
          empty={{
            icon: 'checkCircle',
            title: activeTab === 'active' ? 'No reviews need action' : 'No review tasks match',
            message: activeTab === 'active'
              ? 'Tasks open automatically when a run ends UNCERTAIN or vision is unavailable, or when someone requests a review.'
              : 'Try another status tab or widen the date range.',
          }}
          columns={[
            { key: 'task_id', header: 'Task', render: (r) => <Link to={pathFor('reviews', r.task_id)} className="link mono">{r.task_id}</Link> },
            { key: 'inspection_id', header: 'Inspection', render: (r) => <Link to={pathFor('inspections', r.inspection_id)} className="link mono">{r.inspection_id}</Link> },
            {
              key: 'po', header: 'PO / SKU / Supplier', render: (r) => (
                <div className="rv-cell-stack">
                  <span className="mono">{r.po_id || '—'}</span>
                  <span className="hint mono">{r.sku || '—'}</span>
                  {r.supplier && <span className="hint">{r.supplier}</span>}
                </div>
              ),
            },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'trigger', header: 'Trigger', render: (r) => <span title={r.reason}>{REVIEW_TRIGGERS[r.trigger] || humanize(r.trigger)}</span> },
            { key: 'machine_verdict', header: 'Machine', render: (r) => <VerdictBadge verdict={r.machine_verdict} /> },
            {
              key: 'human_decision', header: 'Human decision', render: (r) => (r.human_decision
                ? (
                  <div className="rv-cell-stack">
                    <VerdictBadge verdict={r.human_decision} />
                    {r.resolution === 'overridden' && <span className="hint">via inspection override</span>}
                  </div>
                )
                : <span className="hint">{r.status === 'cancelled' ? (r.resolution === 'superseded_by_run' ? 'Superseded by run' : 'Not needed') : 'Pending'}</span>),
            },
            { key: 'assigned_to', header: 'Assigned', render: (r) => r.assigned_to || <span className="hint">Unassigned</span> },
            { key: 'created_at', header: 'Age', align: 'right', render: (r) => <span title={formatDateTime(r.created_at)}>{formatRelative(r.created_at)}</span> },
          ]}
        />
        <Pagination
          page={data?.page} pageSize={data?.page_size} total={data?.total}
          onPageChange={(page) => setQuery({ page })}
          onPageSizeChange={(page_size) => setQuery({ page_size, page: 1 })}
        />
      </Card>
    </div>
  );
}
