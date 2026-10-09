import { useMemo } from 'react';
import {
  VERDICT_GROUPS, decisionMeta, effectiveDecision, failedCategories, hasDamageOrMismatch, hasQuantityDiscrepancy,
  inspectedAt, isAnalyzed, timeAgo, verdictGroup,
} from '../constants';
import { DataGate, DecisionPill, EmptyState, Icon, Panel, StatCard } from './Shared';

// Real lifecycle events read from the inspection records: created, analyzed (latest sealed record), overridden.
export function lifecycleEvents(inspections) {
  const events = [];
  inspections.forEach((item) => {
    const po = item.po?.po_id || '—';
    events.push({ at: item.created_at, kind: 'created', id: item.inspection_id, text: `Inspection opened for ${po}` });
    if (item.record) {
      const firstVerdict = item.record.overrides?.[0]?.from_verdict || item.record.outcome?.verdict;
      events.push({
        at: item.record.overrides?.length ? null : item.record.created_at, kind: 'analyzed', id: item.inspection_id,
        decision: firstVerdict, text: `Analyzed: ${decisionMeta(firstVerdict).label} (${po})`,
      });
    }
    (item.overrides || []).forEach((override) => events.push({
      at: override.created_at, kind: 'override', id: item.inspection_id, decision: override.to_verdict,
      text: `Override by ${override.operator_id || 'operator'}: ${decisionMeta(override.from_verdict).label} → ${decisionMeta(override.to_verdict).label}`,
    }));
  });
  return events.filter((event) => event.at).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

const EVENT_ICON = { created: 'plus', analyzed: 'shield', override: 'pen' };

export default function OverviewView({ inspections, connected, loading, error, onRefresh, onConnect, onNavigate, onOpenInspection, onFilterHistory }) {
  const stats = useMemo(() => {
    const groups = Object.fromEntries(VERDICT_GROUPS.map((g) => [g.key, 0]));
    const categories = {};
    let quantity = 0;
    let mismatch = 0;
    let held = 0;
    inspections.forEach((item) => {
      groups[verdictGroup(item)] += 1;
      if (effectiveDecision(item) === 'PENDING_REVIEW') held += 1;
      if (hasQuantityDiscrepancy(item)) quantity += 1;
      if (hasDamageOrMismatch(item)) mismatch += 1;
      failedCategories(item).forEach((category) => { categories[category] = (categories[category] || 0) + 1; });
    });
    const analyzed = inspections.filter(isAnalyzed).length;
    return { total: inspections.length, analyzed, groups, quantity, mismatch, held, categories };
  }, [inspections]);

  const recent = useMemo(() => [...inspections].sort((a, b) => String(inspectedAt(b)).localeCompare(String(inspectedAt(a)))).slice(0, 6), [inspections]);
  const activity = useMemo(() => lifecycleEvents(inspections).slice(0, 8), [inspections]);
  const categories = Object.entries(stats.categories).sort((a, b) => b[1] - a[1]);
  const maxCategory = categories[0]?.[1] || 1;
  const share = (n) => (stats.analyzed ? n / stats.analyzed : 0);

  return (
    <div className="stack">
      <section className="quick-actions" aria-label="Quick actions">
        <button type="button" className="quick" onClick={() => onNavigate('inspect')}>
          <span className="quick__icon quick__icon--primary"><Icon name="scan" size={18} /></span>
          <span><b>Start an inspection</b><small>Check a delivery against its PO line</small></span>
          <Icon name="chevronRight" size={16} />
        </button>
        <button type="button" className="quick" onClick={() => onNavigate('history')}>
          <span className="quick__icon"><Icon name="list" size={18} /></span>
          <span><b>Review inspections</b><small>Search, filter and verify past results</small></span>
          <Icon name="chevronRight" size={16} />
        </button>
        <button type="button" className="quick" onClick={() => onNavigate('evidence')}>
          <span className="quick__icon"><Icon name="image" size={18} /></span>
          <span><b>Browse evidence</b><small>Photos and readings by inspection</small></span>
          <Icon name="chevronRight" size={16} />
        </button>
      </section>

      <DataGate connected={connected} loading={loading} error={error} hasData={inspections.length > 0} onRetry={onRefresh} onConnect={onConnect}>
        {stats.total === 0 ? (
          <Panel>
            <EmptyState icon="truck" title="No inspections yet"
              action={<button type="button" className="btn btn--primary" onClick={() => onNavigate('inspect')}><Icon name="plus" size={15} /> Run your first inspection</button>}>
              This is a new installation: there is no receiving data to summarize. Metrics appear here as soon as inspections are recorded.
            </EmptyState>
          </Panel>
        ) : (
          <>
            <section className="stat-grid" aria-label="Receiving metrics">
              <StatCard label="Total inspections" value={stats.total} icon="clipboard" hint={`${stats.analyzed} analyzed · ${stats.groups.DRAFT} not inspected`} onClick={() => onFilterHistory('all')} />
              <StatCard label="Passed" value={stats.groups.PASS} tone="pass" icon="check" share={share(stats.groups.PASS)} hint="Released to putaway" onClick={() => onFilterHistory('PASS')} />
              <StatCard label="Failed" value={stats.groups.FAIL} tone="fail" icon="x" share={share(stats.groups.FAIL)} hint="Exceptions: quarantine & claim" onClick={() => onFilterHistory('FAIL')} />
              <StatCard label="Requiring review" value={stats.groups.UNCERTAIN} tone="warn" icon="help" share={share(stats.groups.UNCERTAIN)}
                hint={stats.held ? `${stats.held} not analyzed (vision unavailable)` : 'Uncertain verdicts'} onClick={() => onFilterHistory('UNCERTAIN')} />
              <StatCard label="Quantity discrepancies" value={stats.quantity} tone="info" icon="layers" hint="Failed quantity, carton or pack-size check" />
              <StatCard label="Damaged or mismatched" value={stats.mismatch} tone="accent" icon="alert" hint="Failed condition, SKU, variant or component check" />
            </section>

            <div className="grid-2">
              <Panel title="Verdict distribution" icon="activity" sub={`Across ${stats.total} inspection${stats.total === 1 ? '' : 's'}, using the current verdict (overrides included).`}>
                <div className="dist" role="img" aria-label={VERDICT_GROUPS.map((g) => `${g.label} ${stats.groups[g.key]}`).join(', ')}>
                  {VERDICT_GROUPS.map((g) => stats.groups[g.key] > 0 && (
                    <span key={g.key} className={`dist__seg dist__seg--${g.tone}`} style={{ flexGrow: stats.groups[g.key] }} title={`${g.label}: ${stats.groups[g.key]}`} />
                  ))}
                </div>
                <ul className="legend">
                  {VERDICT_GROUPS.map((g) => (
                    <li key={g.key}>
                      <button type="button" className="legend__item" onClick={() => onFilterHistory(g.key)}>
                        <span className={`legend__dot legend__dot--${g.tone}`} />{g.label}
                        <b>{stats.groups[g.key]}</b>
                        <span className="muted">{stats.total ? Math.round((stats.groups[g.key] / stats.total) * 100) : 0}%</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
              <Panel title="Discrepancy categories" icon="alert" sub="Inspections with at least one failed check in each category.">
                {categories.length === 0 ? (
                  <EmptyState icon="check" title="No discrepancies recorded">No inspection has a failed check yet.</EmptyState>
                ) : (
                  <ul className="hbars">
                    {categories.map(([name, count]) => (
                      <li key={name}>
                        <span className="hbars__label">{name}</span>
                        <span className="hbars__track"><i style={{ width: `${(count / maxCategory) * 100}%` }} /></span>
                        <b className="mono">{count}</b>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>

            <div className="grid-2 grid-2--wide-left">
              <Panel title="Recent inspections" icon="list" actions={<button type="button" className="btn btn--ghost btn--sm" onClick={() => onNavigate('history')}>View all <Icon name="chevronRight" size={14} /></button>}>
                <div className="table-wrap">
                  <table className="table table--hover">
                    <thead><tr><th>Inspection</th><th>Purchase order</th><th>Verdict</th><th>Updated</th></tr></thead>
                    <tbody>
                      {recent.map((item) => (
                        <tr key={item.inspection_id}>
                          <td><button type="button" className="link mono" onClick={() => onOpenInspection(item.inspection_id)}>{item.inspection_id}</button></td>
                          <td><div className="table__strong">{item.po?.po_id}</div><div className="table__sub">{item.po?.product_name}</div></td>
                          <td><DecisionPill decision={effectiveDecision(item)} /></td>
                          <td className="nowrap">{timeAgo(inspectedAt(item))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
              <Panel title="Recent receiving activity" icon="clock" actions={<button type="button" className="btn btn--ghost btn--sm" onClick={() => onNavigate('activity')}>Activity <Icon name="chevronRight" size={14} /></button>}>
                <ol className="feed">
                  {activity.map((event, index) => (
                    <li key={`${event.id}-${event.kind}-${index}`} className={`feed__item feed__item--${event.decision ? decisionMeta(event.decision).tone : 'neutral'}`}>
                      <span className="feed__icon"><Icon name={EVENT_ICON[event.kind]} size={13} /></span>
                      <div>
                        <p>{event.text}</p>
                        <small><button type="button" className="link mono" onClick={() => onOpenInspection(event.id)}>{event.id}</button> · {timeAgo(event.at)}</small>
                      </div>
                    </li>
                  ))}
                </ol>
              </Panel>
            </div>
          </>
        )}
      </DataGate>
    </div>
  );
}
