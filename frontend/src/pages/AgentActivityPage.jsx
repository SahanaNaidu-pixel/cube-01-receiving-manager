/*
 * AgentActivityPage — every inbound and outbound A2A message (GET /api/agent/activity; filters direction, operation,
 * status, agent, correlation_id, date range; paginated, newest first). Filters live in the hash query.
 */
import { listAgentActivity } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { formatDateTime, formatLatency, formatRelative, listParamsFromQuery, truncate } from '../lib/format';
import { Card, ConnectPrompt, DataTable, FilterBar, Icon, Link, PageHeader, Pagination, StatusBadge } from '../components/ui';
import { TextFilter, errorText } from './ops/shared';
import '../styles/ops.css';

const OPERATIONS = ['receiving.inspect', 'receiving.get_record', 'receiving.verify_record', 'agent.ping', 'receiving.record_available'];
const STATUSES = ['completed', 'failed', 'delivered', 'not_configured'];

export default function AgentActivityPage({ route }) {
  const params = listParamsFromQuery(route.query, ['direction', 'operation', 'status', 'agent', 'correlation_id']);
  const { data, error, loading, reload, notConnected } = useApi(() => listAgentActivity(params), [JSON.stringify(params)]);
  if (notConnected) return <Card><ConnectPrompt /></Card>;
  const q = route.query;
  const hasFilters = Boolean(q.direction || q.operation || q.status || q.agent || q.correlation_id || q.range || q.date_from || q.date_to);

  return (
    <div className="stack">
      <PageHeader
        title="Agent activity"
        subtitle="Persisted cube.a2a.v1 traffic: inbound requests from other CUBE agents and outbound hand-offs, with envelopes (image bytes stripped)."
        icon="activity"
        actions={(
          <>
            <button type="button" className="btn-theme" onClick={() => reload()} disabled={loading}><Icon name="refresh" size={14} /> Refresh</button>
            <Link to="a2a" className="btn-primary"><Icon name="send" size={14} /> Send a test message</Link>
          </>
        )}
      />
      <FilterBar
        selects={[
          { key: 'direction', label: 'Direction', value: q.direction, options: [{ value: 'inbound', label: 'Inbound' }, { value: 'outbound', label: 'Outbound' }], onChange: (direction) => setQuery({ direction, page: 1 }) },
          { key: 'operation', label: 'Operation', value: q.operation, options: OPERATIONS.map((o) => ({ value: o, label: o })), onChange: (operation) => setQuery({ operation, page: 1 }) },
          { key: 'status', label: 'Status', value: q.status, options: STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') })), onChange: (status) => setQuery({ status, page: 1 }) },
        ]}
        dateRange={{ value: q, onChange: (patch) => setQuery({ ...patch, page: 1 }) }}
        onReset={hasFilters ? () => navigate('agent-activity') : undefined}
        resultCount={data?.total}
      >
        <TextFilter label="Agent" placeholder="Agent (e.g. prep_manager)" value={q.agent} onChange={(agent) => setQuery({ agent, page: 1 })} />
        <TextFilter label="Correlation ID" value={q.correlation_id} onChange={(v) => setQuery({ correlation_id: v, page: 1 })} />
      </FilterBar>
      <Card flush>
        <DataTable
          rows={data?.items}
          rowKey={(r) => r.activity_id || r.request_id}
          loading={loading}
          error={error}
          onRetry={reload}
          onRowClick={(r) => navigate(pathFor('agent-activity', r.request_id))}
          empty={hasFilters
            ? { title: 'No messages match', message: 'Clear the filters to see all agent traffic.', icon: 'search' }
            : { title: 'No agent messages yet', message: 'Send an envelope from the A2A console or hand an inspection off to another agent.', icon: 'activity', action: <Link to="a2a" className="btn-primary">Open the A2A console</Link> }}
          columns={[
            { key: 'agent', header: 'Agent', render: (r) => (r.agent ? <button type="button" className="link" onClick={(e) => { e.stopPropagation(); setQuery({ agent: r.agent, page: 1 }); }} title="Filter by this agent">{r.agent}</button> : '—') },
            { key: 'direction', header: 'Direction', render: (r) => <StatusBadge status={r.direction} label={r.direction === 'inbound' ? '← inbound' : '→ outbound'} /> },
            { key: 'request_id', header: 'Request ID', render: (r) => <Link to={pathFor('agent-activity', r.request_id)} className="link mono">{r.request_id}</Link> },
            { key: 'correlation_id', header: 'Correlation ID', render: (r) => (r.correlation_id
              ? <button type="button" className="link" onClick={(e) => { e.stopPropagation(); setQuery({ correlation_id: r.correlation_id, page: 1 }); }} title="Show this conversation">{r.correlation_id}</button>
              : '—') },
            { key: 'operation', header: 'Operation', mono: true },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'created_at', header: 'Time', render: (r) => <span title={formatDateTime(r.created_at)}>{formatRelative(r.created_at)}</span> },
            { key: 'latency_ms', header: 'Latency', align: 'right', render: (r) => formatLatency(r.latency_ms) },
            { key: 'inspection_id', header: 'Inspection', render: (r) => (r.inspection_id ? <Link to={pathFor('inspections', r.inspection_id)} className="link mono">{r.inspection_id}</Link> : '—') },
            { key: 'error', header: 'Error', render: (r) => (r.error ? <span className="ops-error-text" title={errorText(r.error)}>{truncate(errorText(r.error), 60)}</span> : '—') },
          ]}
        />
        <Pagination
          page={data?.page}
          pageSize={data?.page_size}
          total={data?.total}
          onPageChange={(page) => setQuery({ page })}
          onPageSizeChange={(page_size) => setQuery({ page_size, page: 1 })}
        />
      </Card>
    </div>
  );
}
