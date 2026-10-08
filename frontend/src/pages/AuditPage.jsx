/*
 * AuditPage — the append-only audit trail (GET /api/audit, newest first).
 * Hash query: entity_type, action, actor, inspection_id, entity_id, range/date_from/date_to, page, page_size,
 * layout=table|timeline. Rows expand to show the event's `details` JSON.
 * A2A events link their request id to #/app/agent-activity/<request_id>.
 */
import { Fragment, useState } from 'react';
import { listAudit } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { formatDateTime, formatRelative, listParamsFromQuery } from '../lib/format';
import {
  Card, ConnectPrompt, EmptyState, ErrorState, FilterBar, Icon, JsonViewer, Link, PageHeader, Pagination, Skeleton,
  Timeline, auditEventToItem,
} from '../components/ui';
import { IdChip, TextFilter } from './review/components';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from './review/constants';
import { ENTITY_LABELS, entityPath } from './review/helpers';
import '../styles/review.css';

const ACTION_OPTIONS = AUDIT_ACTIONS.map((value) => ({ value, label: value }));

/** Events that came through (or went out over) A2A have an agent-activity entry keyed by request id. */
const isA2A = (event) => event.channel === 'a2a' || String(event.action || '').startsWith('a2a.') || event.entity_type === 'agent_activity';

function RequestRef({ event }) {
  if (!event.request_id) return <span className="hint">—</span>;
  if (isA2A(event)) {
    return <Link to={pathFor('agent-activity', event.request_id)} className="link mono" title="Open agent message">{event.request_id}</Link>;
  }
  return <IdChip value={event.request_id} />;
}

function EntityRef({ event }) {
  const to = entityPath(event.entity_type, event.entity_id, event);
  const label = ENTITY_LABELS[event.entity_type] || event.entity_type || '—';
  return (
    <div className="rv-cell-stack">
      <span className="hint">{label}</span>
      {event.entity_id && (to ? <Link to={to} className="link mono">{event.entity_id}</Link> : <span className="mono">{event.entity_id}</span>)}
    </div>
  );
}

export default function AuditPage({ route }) {
  const query = route.query;
  const layout = query.layout === 'timeline' ? 'timeline' : 'table';
  const params = listParamsFromQuery(query, ['entity_type', 'entity_id', 'action', 'actor', 'inspection_id']);
  const { data, error, loading, reload, notConnected } = useApi(() => listAudit(params), [JSON.stringify(params)]);
  const [open, setOpen] = useState(() => new Set());

  if (notConnected) return <Card><ConnectPrompt /></Card>;
  const items = data?.items || [];
  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="stack">
      <PageHeader
        title="Audit trail"
        icon="history"
        subtitle="Every mutation writes one append-only event in the same request — who did what, to which record, through which channel. Newest first."
        actions={(
          <button type="button" className="btn-theme" onClick={() => reload()} disabled={loading}>
            {loading ? <span className="spinner ui-spinner-accent" aria-hidden="true" /> : null} Refresh
          </button>
        )}
      />

      <FilterBar
        selects={[
          { key: 'entity_type', label: 'Entity', allLabel: 'All entities', value: query.entity_type, options: AUDIT_ENTITY_TYPES,
            onChange: (v) => setQuery({ entity_type: v, page: 1 }) },
          { key: 'action', label: 'Action', allLabel: 'All actions',
            value: query.action,
            options: query.action && !AUDIT_ACTIONS.includes(query.action) ? [...ACTION_OPTIONS, { value: query.action, label: query.action }] : ACTION_OPTIONS,
            onChange: (v) => setQuery({ action: v, page: 1 }) },
        ]}
        dateRange={{ value: query, onChange: (patch) => setQuery({ ...patch, page: 1 }) }}
        onReset={() => navigate('audit', layout === 'timeline' ? { layout } : undefined)}
        resultCount={data?.total}
      >
        <TextFilter label="Actor" value={query.actor} width={130} onChange={(v) => setQuery({ actor: v, page: 1 })} />
        <TextFilter label="Inspection id" value={query.inspection_id} width={150} onChange={(v) => setQuery({ inspection_id: v, page: 1 })} />
        <TextFilter label="Entity id" value={query.entity_id} width={150} onChange={(v) => setQuery({ entity_id: v, page: 1 })} />
        <div className="segmented-control rv-view-toggle" role="group" aria-label="Layout">
          <button type="button" className={layout === 'table' ? 'active' : ''} aria-pressed={layout === 'table'}
            onClick={() => setQuery({ layout: '' })}><Icon name="list" size={13} /> Table</button>
          <button type="button" className={layout === 'timeline' ? 'active' : ''} aria-pressed={layout === 'timeline'}
            onClick={() => setQuery({ layout: 'timeline' })}><Icon name="clock" size={13} /> Timeline</button>
        </div>
      </FilterBar>

      <Card flush className="rv-table-card">
        {error && !items.length && <div className="card-body"><ErrorState error={error} onRetry={reload} title="Could not load the audit trail" /></div>}
        {error && items.length > 0 && <div className="card-body"><ErrorState compact error={error} onRetry={reload} title="Refresh failed — showing the previous results" /></div>}
        {loading && !items.length && !error && <div className="card-body"><Skeleton lines={8} height={16} /></div>}
        {!loading && !error && !items.length && (
          <EmptyState icon="history" title="No audit events match" message="Try clearing a filter or widening the date range." />
        )}

        {items.length > 0 && layout === 'table' && (
          <div className={`table-wrapper ui-table-wrapper ${loading ? 'is-refreshing' : ''}`} aria-busy={loading}>
            <table className="rv-audit-table">
              <thead>
                <tr>
                  <th scope="col"><span className="sr-only">Details</span></th>
                  <th scope="col">Time</th>
                  <th scope="col">Action</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Inspection</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Request</th>
                </tr>
              </thead>
              <tbody>
                {items.map((event) => {
                  const expanded = open.has(event.event_id);
                  return (
                    <Fragment key={event.event_id}>
                      <tr className={expanded ? 'rv-audit-row-open' : undefined}>
                        <td>
                          <button type="button" className="rv-expand-btn" aria-expanded={expanded}
                            aria-label={`${expanded ? 'Hide' : 'Show'} details of ${event.event_id}`} onClick={() => toggle(event.event_id)}>
                            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
                          </button>
                        </td>
                        <td><span title={formatDateTime(event.created_at)}>{formatRelative(event.created_at)}</span></td>
                        <td>
                          <button type="button" className="link" title="Filter by this action"
                            onClick={() => setQuery({ action: event.action, page: 1 })}>{event.action}</button>
                        </td>
                        <td><EntityRef event={event} /></td>
                        <td>{event.inspection_id ? <Link to={pathFor('inspections', event.inspection_id)} className="link mono">{event.inspection_id}</Link> : <span className="hint">—</span>}</td>
                        <td>
                          <div className="rv-cell-stack">
                            <span>{event.actor || '—'}</span>
                            <span className="hint">{[event.role, event.channel].filter(Boolean).join(' · ')}</span>
                          </div>
                        </td>
                        <td className="rv-audit-summary">{event.summary || '—'}</td>
                        <td><RequestRef event={event} /></td>
                      </tr>
                      {expanded && (
                        <tr className="rv-audit-detail-row">
                          <td colSpan={8}>
                            <AuditDetails event={event} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {items.length > 0 && layout === 'timeline' && (
          <div className={`rv-timeline-wrap ${loading ? 'is-refreshing' : ''}`}>
            <Timeline items={items.map((event) => ({
              ...auditEventToItem(event),
              to: entityPath(event.entity_type, event.entity_id, event) || undefined,
              meta: null,
              extra: (
                <div className="rv-timeline-extra">
                  <span className="timeline-meta">
                    {event.actor}{event.role ? ` (${event.role})` : ''}{event.channel ? ` · ${event.channel}` : ''}
                    {event.inspection_id && <> · <Link to={pathFor('inspections', event.inspection_id)} className="link mono">{event.inspection_id}</Link></>}
                    {event.request_id && <> · <RequestRef event={event} /></>}
                  </span>
                  <button type="button" className="detail-btn" style={{ width: 'fit-content' }} aria-expanded={open.has(event.event_id)}
                    onClick={() => toggle(event.event_id)}>
                    {open.has(event.event_id) ? 'Hide details' : 'Show details'}
                  </button>
                  {open.has(event.event_id) && <AuditDetails event={event} />}
                </div>
              ),
            }))} />
          </div>
        )}

        <Pagination
          page={data?.page} pageSize={data?.page_size} total={data?.total}
          onPageChange={(page) => setQuery({ page })}
          onPageSizeChange={(page_size) => setQuery({ page_size, page: 1 })}
        />
      </Card>
    </div>
  );
}

function AuditDetails({ event }) {
  return (
    <div className="rv-form" style={{ paddingTop: 8 }}>
      <div className="rv-actions hint">
        <span>Event <span className="mono">{event.event_id}</span></span>
        <span>· {formatDateTime(event.created_at)}</span>
        {event.correlation_id && event.correlation_id !== event.request_id && (
          <span>· correlation <span className="mono">{event.correlation_id}</span></span>
        )}
        {event.inspection_id && (
          <Link to="audit" query={{ inspection_id: event.inspection_id }}>· all events for {event.inspection_id}</Link>
        )}
      </div>
      <JsonViewer data={event.details || {}} title="details" defaultDepth={2} maxHeight={320} />
    </div>
  );
}
