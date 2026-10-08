/*
 * DashboardPage — every number comes from GET /api/dashboard (range filter in the hash: ?range=today|7d|30d|all|custom).
 * Each metric deep-links to the filtered list it summarises; the daily chart links to that day's inspections.
 */
import { getDashboard } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { formatDate, formatDateTime, formatLatency, formatRelative } from '../lib/format';
import {
  AsyncButton, Card, ConnectPrompt, DataTable, DateRangePicker, EmptyState, ErrorState, Icon, Link, PageHeader,
  Skeleton, StatCard, StatusBadge, VerdictBadge, VerdictChart,
} from '../components/ui';

const DEFAULT_RANGE = '7d';

/**
 * Metric → list deep link. Issue-type metrics use the engine's reason codes (backend/app/core/decision_engine.py):
 * COUNT_MISMATCH (quantity/cartons/units), SKU_MISMATCH (identity), VARIANT_MISMATCH, DAMAGE_VISIBLE, COMPONENT_MISSING.
 */
const METRICS = [
  { key: 'inspections', label: 'Inspections', icon: 'truck', tone: 'dup', note: 'Created in range', to: 'inspections', query: {} },
  { key: 'pass', label: 'Passed', icon: 'check', tone: 'contradicted', note: 'Accepted to stock', to: 'inspections', query: { verdict: 'PASS' } },
  { key: 'fail', label: 'Failed', icon: 'alert', tone: 'exception', note: 'Discrepancy or damage', to: 'inspections', query: { verdict: 'FAIL' } },
  { key: 'uncertain', label: 'Uncertain', icon: 'eye', tone: 'uncertain', note: 'Needs a human decision', to: 'inspections', query: { verdict: 'UNCERTAIN' } },
  { key: 'not_analyzed', label: 'Not analyzed', icon: 'clock', tone: 'silent', note: 'Created, not yet run', to: 'inspections', query: { verdict: 'NOT_ANALYZED' } },
  { key: 'open_reviews', label: 'Open reviews', icon: 'users', tone: 'hold', note: 'In the review queue', to: 'reviews', query: { status: 'open,evidence_requested' } },
  { key: 'open_issues', label: 'Open issues', icon: 'inbox', tone: 'exception', note: 'Exceptions to resolve', to: 'exceptions', query: { status: 'open' } },
];

const DISCREPANCIES = [
  { key: 'quantity_discrepancies', label: 'Quantity discrepancies', icon: 'ruler', query: { issue_type: 'COUNT_MISMATCH' } },
  { key: 'product_mismatches', label: 'Wrong product (SKU)', icon: 'tag', query: { issue_type: 'SKU_MISMATCH' } },
  { key: 'variant_mismatches', label: 'Wrong variant', icon: 'layers', query: { issue_type: 'VARIANT_MISMATCH' } },
  { key: 'damaged_cartons', label: 'Damaged cartons', icon: 'box', query: { issue_type: 'DAMAGE_VISIBLE' } },
  { key: 'damaged_products', label: 'Damaged products', icon: 'package', query: { issue_type: 'DAMAGE_VISIBLE' } },
  { key: 'missing_components', label: 'Missing components', icon: 'minus', query: { issue_type: 'COMPONENT_MISSING' } },
];

const poOf = (item) => item?.po || {};

export default function DashboardPage({ route }) {
  const range = route.query.range || DEFAULT_RANGE;
  const isCustom = range === 'custom';
  const params = { range, date_from: isCustom ? route.query.date_from : undefined, date_to: isCustom ? route.query.date_to : undefined };
  const customIncomplete = isCustom && (!params.date_from || !params.date_to);

  const { data, error, loading, reload, notConnected } = useApi(
    () => getDashboard(params),
    [range, params.date_from, params.date_to],
    { enabled: !customIncomplete },
  );

  // Query carried to every deep link so the list shows the same window as the dashboard.
  const windowQuery = range === 'all' ? {} : isCustom ? { date_from: params.date_from, date_to: params.date_to } : { range };
  const totals = data?.totals || {};
  const rangeLabel = data?.range?.from || data?.range?.to
    ? `${formatDate(data.range.from)} – ${formatDate(data.range.to)}`
    : range === 'all' ? 'All time' : '';

  const header = (
    <PageHeader
      title="Receiving overview"
      subtitle={rangeLabel ? `Window: ${rangeLabel}` : 'Live totals from the receiving ledger'}
      actions={(
        <>
          <DateRangePicker
            value={{ range, date_from: route.query.date_from, date_to: route.query.date_to }}
            onChange={(patch) => setQuery({ ...patch, range: patch.range || 'all' })}
          />
          <AsyncButton
            icon="refresh"
            label="Refresh"
            loadingLabel="Refreshing…"
            successLabel="Updated"
            disabled={notConnected || customIncomplete}
            onClick={() => reload({ throwOnError: true })}
            errorToast="Dashboard refresh failed"
          />
        </>
      )}
    />
  );

  if (notConnected) return <div className="stack">{header}<Card><ConnectPrompt /></Card></div>;
  if (customIncomplete) {
    return (
      <div className="stack">
        {header}
        <Card><EmptyState icon="calendar" title="Pick a start and end date" message="The custom range needs both dates." /></Card>
      </div>
    );
  }
  if (error && !data) return <div className="stack">{header}<ErrorState error={error} onRetry={reload} title="Could not load the dashboard" /></div>;

  const firstLoad = loading && !data;
  const issueTypes = data?.issues_by_type || [];
  const issueMax = Math.max(1, ...issueTypes.map((row) => row.count || 0));

  return (
    <div className="stack">
      {header}
      {error && data && <ErrorState error={error} onRetry={reload} title="Refresh failed — showing the last loaded figures" compact />}

      <div className="metrics-grid ui-metrics-7">
        {METRICS.map((metric) => (
          <StatCard
            key={metric.key}
            label={metric.label}
            value={metric.key === 'inspections' ? totals.inspections : totals[metric.key]}
            note={metric.note}
            tone={metric.tone}
            icon={metric.icon}
            loading={firstLoad}
            to={metric.to}
            query={{ ...metric.query, ...windowQuery }}
          />
        ))}
      </div>

      <div className="dashboard-grid">
        <Card flush title="Daily verdicts" sub="Inspections per day by verdict — click a bar to open that day">
          <div className="ui-card-pad">
            {firstLoad && <Skeleton lines={5} height={18} />}
            {!firstLoad && (data?.daily || []).length === 0 && (
              <EmptyState compact icon="activity" title="No inspections in this window" message="Create an inspection or widen the date range." />
            )}
            {!firstLoad && (data?.daily || []).length > 0 && (
              <VerdictChart
                days={data.daily}
                onSelect={(date, verdict) => navigate('inspections', { date_from: date, date_to: date, verdict })}
              />
            )}
          </div>
        </Card>

        <Card flush title="Discrepancies found" sub="Failed checks by type (latest record per inspection)">
          <ul className="ui-metric-list">
            {DISCREPANCIES.map((item) => (
              <li key={item.key}>
                <Link to="exceptions" query={{ ...item.query, ...windowQuery }} className="ui-metric-row">
                  <Icon name={item.icon} size={16} />
                  <span>{item.label}</span>
                  <strong className={totals[item.key] ? 'd-EXCEPTION' : ''}>{firstLoad ? '…' : (totals[item.key] ?? '—')}</strong>
                  <Icon name="chevronRight" size={14} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="dashboard-grid">
        <Card flush title="Issues by type" sub="All issues raised in the window, grouped by reason code">
          <div className="ui-card-pad">
            {firstLoad && <Skeleton lines={4} height={18} />}
            {!firstLoad && issueTypes.length === 0 && <EmptyState compact icon="check" title="No issues raised in this window" />}
            {!firstLoad && issueTypes.length > 0 && (
              <div className="chart-bars">
                {issueTypes.map((row) => (
                  <Link key={row.issue_type} to="exceptions" query={{ issue_type: row.issue_type, ...windowQuery }} className="chart-bar-row ui-bar-link">
                    <span className="chart-bar-label mono">{row.issue_type}</span>
                    <span className="chart-bar-track">
                      <span className="chart-bar-fill bar-pending" style={{ width: `${(row.count / issueMax) * 100}%` }} />
                    </span>
                    <span className="chart-bar-count">{row.count}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card
          flush
          title="System health"
          sub={data?.system?.checked_at ? `Checked ${formatRelative(data.system.checked_at)}` : 'Backend readiness'}
          actions={<Link to="system-health" className="detail-btn">Details</Link>}
        >
          <div className="ui-card-pad">
            {firstLoad && <Skeleton lines={4} />}
            {!firstLoad && !data?.system && <EmptyState compact icon="server" title="No readiness data in the response" />}
            {!firstLoad && data?.system && (
              <>
                <div className="ui-health-head">
                  <StatusBadge status={data.system.status} />
                  <span className="hint">{(data.system.components || []).length} component(s) checked</span>
                </div>
                <ul className="ui-component-list">
                  {(data.system.components || []).map((component) => (
                    <li key={component.name}>
                      <span className="mono">{component.name}</span>
                      <StatusBadge status={component.status} />
                      <span className="hint">{component.message}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Card>
      </div>

      <Card
        flush
        title="Recent inspections"
        sub="Latest 8 in the window"
        actions={<Link to="inspections" query={windowQuery} className="detail-btn">View all</Link>}
      >
        <DataTable
          rowKey="inspection_id"
          rows={data?.recent_inspections}
          loading={firstLoad}
          skeletonRows={4}
          onRowClick={(row) => navigate(pathFor('inspections', row.inspection_id))}
          empty={{
            icon: 'truck',
            title: 'No inspections yet',
            message: 'Start one from New Inspection.',
            action: <Link to="new-inspection" className="btn-primary"><Icon name="scan" size={14} /> New inspection</Link>,
          }}
          columns={[
            { key: 'inspection_id', header: 'Inspection', render: (row) => <Link to={pathFor('inspections', row.inspection_id)} className="link mono">{row.inspection_id}</Link> },
            { key: 'po', header: 'PO', render: (row) => poOf(row).po_id || '—' },
            {
              key: 'product',
              header: 'Product',
              render: (row) => (
                <span className="ui-cell-stack">
                  <span className="cell-strong">{poOf(row).product_name || '—'}</span>
                  <span className="cell-sub mono">{poOf(row).sku || ''}</span>
                </span>
              ),
            },
            { key: 'supplier', header: 'Supplier', render: (row) => row.shipment?.supplier || row.supplier || '—' },
            { key: 'verdict', header: 'Verdict', render: (row) => <VerdictBadge verdict={row.verdict} /> },
            { key: 'open_issue_count', header: 'Open issues', align: 'right', render: (row) => row.open_issue_count ?? '—' },
            { key: 'created_at', header: 'Created', render: (row) => <span title={formatDateTime(row.created_at)}>{formatRelative(row.created_at)}</span> },
          ]}
        />
      </Card>

      <Card
        flush
        title="Recent agent activity"
        sub="Latest A2A messages in and out"
        actions={<Link to="agent-activity" className="detail-btn">View all</Link>}
      >
        <DataTable
          rowKey={(row, index) => row.request_id || index}
          rows={data?.recent_agent_activity}
          loading={firstLoad}
          skeletonRows={3}
          onRowClick={(row) => row.request_id && navigate(pathFor('agent-activity', row.request_id))}
          empty={{ icon: 'link', title: 'No agent messages yet', message: 'Inbound requests and outbound hand-offs appear here.' }}
          columns={[
            { key: 'created_at', header: 'When', render: (row) => <span title={formatDateTime(row.created_at)}>{formatRelative(row.created_at)}</span> },
            { key: 'direction', header: 'Direction', render: (row) => <StatusBadge status={row.direction} /> },
            { key: 'agent', header: 'Agent', render: (row) => <span className="mono">{row.agent || '—'}</span> },
            { key: 'operation', header: 'Operation', render: (row) => <span className="mono">{row.operation || '—'}</span> },
            { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
            { key: 'latency_ms', header: 'Latency', align: 'right', render: (row) => formatLatency(row.latency_ms) },
            { key: 'inspection_id', header: 'Inspection', render: (row) => (row.inspection_id ? <Link to={pathFor('inspections', row.inspection_id)} className="link mono">{row.inspection_id}</Link> : '—') },
          ]}
        />
      </Card>

      {data && <p className="hint">Counts derive from the latest sealed record per inspection.</p>}
    </div>
  );
}
