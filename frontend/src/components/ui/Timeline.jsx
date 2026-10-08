/*
 * Timeline — vertical event list (audit trail, notes, activity).
 *   <Timeline items={events.map(auditEventToItem)} empty="No audit events yet." />
 * Item: { id, title, description, meta, time (ISO), tone: 'good'|'bad'|'warn'|'info', to?, query? (makes the title a link),
 *         extra? (ReactNode rendered under the description) }
 * auditEventToItem(event) maps a GET /api/audit event onto an item (action → tone, actor/role/request id → meta).
 */
import { formatDateTime, humanize } from '../../lib/format';
import Link from './Link';

const TONE_CLASS = { good: 'item-good', bad: 'item-bad', warn: 'item-charge', info: '' };

export function auditEventToItem(event) {
  const action = String(event.action || '');
  let tone = 'info';
  if (/resolved|decided|verified|delivered|imported/.test(action)) tone = 'good';
  if (/fail|error|rejected/.test(action)) tone = 'bad';
  if (/overridden|evidence_requested|review\.created|handoff/.test(action)) tone = 'warn';
  const who = [event.actor, event.role ? `(${event.role})` : ''].filter(Boolean).join(' ');
  return {
    id: event.event_id,
    title: event.summary || humanize(action),
    description: event.summary ? `${action}${event.entity_type ? ` · ${event.entity_type} ${event.entity_id || ''}` : ''}` : undefined,
    meta: [who && `by ${who}`, event.request_id && `request ${event.request_id}`].filter(Boolean).join(' · '),
    time: event.created_at,
    tone,
  };
}

export default function Timeline({ items = [], empty = 'Nothing recorded yet.', compact = false }) {
  if (!items.length) return <p className="hint">{empty}</p>;
  return (
    <ol className={`timeline-list ui-timeline ${compact ? 'compact' : ''}`}>
      {items.map((item, index) => (
        <li key={item.id || index} className={`timeline-item ${TONE_CLASS[item.tone] || ''}`}>
          <div className="timeline-content">
            <div className="ui-timeline-head">
              <strong>{item.to ? <Link to={item.to} query={item.query}>{item.title}</Link> : item.title}</strong>
              {item.time && <time dateTime={item.time} className="timeline-meta">{formatDateTime(item.time)}</time>}
            </div>
            {item.description && <p>{item.description}</p>}
            {item.extra}
            {item.meta && <div className="timeline-meta">{item.meta}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
