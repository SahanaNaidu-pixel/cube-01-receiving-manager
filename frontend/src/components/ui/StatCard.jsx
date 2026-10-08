/*
 * StatCard — a metric tile. Clickable when `to` (route) or `onClick` is given, rendered as a link.
 *   <StatCard label="Failed" value={12} note="Discrepancy or damage" tone="exception" icon="alert"
 *             to="inspections" query={{ verdict: 'FAIL', range: '7d' }} />
 * tone: dup (blue) | contradicted (green) | exception (red) | uncertain (amber) | hold (purple) | silent (grey)
 * value null/undefined renders '—'; loading renders a skeleton.
 */
import { buildHref } from '../../lib/router';
import { formatNumber } from '../../lib/format';
import { Icon } from '../Shared';

export default function StatCard({ label, value, note, tone = 'silent', icon = 'activity', to, query, onClick, loading = false, title }) {
  const content = (
    <>
      <div className="metric-icon"><Icon name={icon} size={18} /></div>
      <div className="metric-value">{loading ? <span className="ui-skeleton ui-skeleton-value" /> : (typeof value === 'number' ? formatNumber(value) : (value ?? '—'))}</div>
      <div className="metric-label">{label}</div>
      {note && <div className="metric-note">{note}</div>}
    </>
  );
  if (to) {
    return <a className={`metric-card ui-stat-link ${tone}`} href={buildHref(to, query)} title={title || `Open ${label}`}>{content}</a>;
  }
  if (onClick) {
    return <button type="button" className={`metric-card ui-stat-link ${tone}`} onClick={onClick} title={title}>{content}</button>;
  }
  return <div className={`metric-card ${tone}`} title={title}>{content}</div>;
}
