/*
 * AgentActivityDetailPage — GET /api/agent/activity/{request_id}: metadata, request/response envelopes, the linked
 * inspection, and the other messages of the same conversation (GET /api/agent/activity?correlation_id=…).
 */
import { getAgentActivity, listAgentActivity } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor } from '../lib/router';
import { formatDateTime, formatLatency, formatRelative } from '../lib/format';
import {
  Card, ConnectPrompt, DataTable, EmptyState, ErrorState, Icon, JsonViewer, KeyValueGrid, Link, LoadingState, PageHeader, StatusBadge,
} from '../components/ui';
import { errorText } from './ops/shared';
import '../styles/ops.css';

export default function AgentActivityDetailPage({ route }) {
  const requestId = route.params[0];
  const { data, error, reload, notConnected } = useApi(() => getAgentActivity(requestId), [requestId]);
  const correlationId = data?.correlation_id;
  const related = useApi(() => listAgentActivity({ correlation_id: correlationId, page_size: 100 }), [correlationId], { enabled: Boolean(correlationId) });

  if (notConnected) return <Card><ConnectPrompt /></Card>;
  const crumbs = [{ label: 'Agent activity', to: 'agent-activity' }, { label: requestId }];
  if (error && !data) {
    return (
      <div className="stack">
        <PageHeader title="Agent message" breadcrumbs={crumbs} icon="activity" />
        <Card>
          {error.status === 404
            ? <EmptyState icon="search" title="Message not found" message={`No activity entry with request ID ${requestId} in your organisation.`} action={<Link to="agent-activity" className="btn-theme">Back to agent activity</Link>} />
            : <ErrorState error={error} onRetry={reload} title="Could not load the message" />}
        </Card>
      </div>
    );
  }
  if (!data) return <Card><LoadingState label="Loading message…" /></Card>;

  const others = (related.data?.items || []).filter((item) => item.request_id !== data.request_id);
  const replayable = data.direction === 'inbound';

  return (
    <div className="stack">
      <PageHeader
        title={`${data.operation || 'Unknown operation'} · ${data.direction}`}
        subtitle={`${data.direction === 'inbound' ? 'From' : 'To'} ${data.agent || 'unknown agent'} · ${formatDateTime(data.created_at)} (${formatRelative(data.created_at)})`}
        breadcrumbs={crumbs}
        icon="activity"
        actions={replayable && data.request ? (
          <Link to="a2a" query={{ tab: 'console', from: data.request_id }} className="btn-theme" title="Load this request envelope into the A2A console with a new message_id">
            <Icon name="send" size={14} /> Open in console
          </Link>
        ) : null}
      />
      {data.error && (
        <div className={`alert ${data.status === 'not_configured' ? 'alert-warning' : 'alert-danger'}`} role="status"><Icon name="alert" size={16} /><span className="alert-text">{errorText(data.error)}</span></div>
      )}
      <Card>
        <KeyValueGrid columns={4} items={[
          { label: 'Status', value: <StatusBadge status={data.status} /> },
          { label: 'Direction', value: <StatusBadge status={data.direction} /> },
          { label: 'Agent', value: data.agent ? <Link to="agent-activity" query={{ agent: data.agent }}>{data.agent}</Link> : null },
          { label: 'Operation', value: data.operation, mono: true },
          { label: 'Request ID', value: data.request_id, mono: true },
          { label: 'Correlation ID', value: data.correlation_id ? <Link to="agent-activity" query={{ correlation_id: data.correlation_id }} className="link mono">{data.correlation_id}</Link> : null },
          { label: 'Message ID', value: data.message_id, mono: true },
          { label: 'HTTP status', value: data.http_status },
          { label: 'Latency', value: formatLatency(data.latency_ms) },
          { label: 'Inspection', value: data.inspection_id ? <Link to={pathFor('inspections', data.inspection_id)} className="link mono">{data.inspection_id}</Link> : null },
          { label: 'Activity ID', value: data.activity_id, mono: true, hideEmpty: true },
          { label: 'Recorded', value: formatDateTime(data.created_at) },
        ]} />
      </Card>
      <div className="ops-envelopes">
        <Card title={data.direction === 'inbound' ? 'Request envelope (received)' : 'Request envelope (sent)'} sub="Image bytes are stripped before storage (size + sha256 prefix kept).">
          {data.request ? <JsonViewer data={data.request} defaultDepth={2} maxHeight={520} /> : <EmptyState compact title="No request body stored" />}
        </Card>
        <Card title={data.direction === 'inbound' ? 'Response envelope (returned)' : 'Peer response'} sub={data.status === 'not_configured' ? 'Target agent is not in A2A_PEERS — nothing was sent.' : undefined}>
          {data.response ? <JsonViewer data={data.response} defaultDepth={2} maxHeight={520} /> : <EmptyState compact title="No response stored" message={data.status === 'not_configured' ? 'Configure A2A_PEERS to deliver hand-offs for real.' : undefined} />}
        </Card>
      </div>
      <Card flush title="Same conversation" sub={correlationId ? `Other messages with correlation ID ${correlationId}` : 'This message has no correlation ID'}>
        {correlationId ? (
          <DataTable
            rows={related.data ? others : undefined}
            rowKey={(r) => r.activity_id || r.request_id}
            loading={related.loading}
            error={related.error}
            onRetry={related.reload}
            onRowClick={(r) => navigate(pathFor('agent-activity', r.request_id))}
            empty={{ title: 'No other messages in this conversation', icon: 'activity' }}
            skeletonRows={2}
            columns={[
              { key: 'created_at', header: 'Time', render: (r) => formatDateTime(r.created_at) },
              { key: 'direction', header: 'Direction', render: (r) => <StatusBadge status={r.direction} /> },
              { key: 'agent', header: 'Agent' },
              { key: 'operation', header: 'Operation', mono: true },
              { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              { key: 'request_id', header: 'Request ID', render: (r) => <Link to={pathFor('agent-activity', r.request_id)} className="link mono">{r.request_id}</Link> },
              { key: 'inspection_id', header: 'Inspection', render: (r) => (r.inspection_id ? <Link to={pathFor('inspections', r.inspection_id)} className="link mono">{r.inspection_id}</Link> : '—') },
            ]}
          />
        ) : <EmptyState compact title="No correlation ID" />}
      </Card>
    </div>
  );
}
