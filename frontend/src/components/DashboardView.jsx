import { decisionMeta, effectiveDecision, failedCategories, formatTime } from '../constants';
import { Card, Icon } from './Shared';
import { ChainDiagram } from './RulesView';

const DECISION_BARS = [
  { key: 'PASS', bar: 'bar-contradicted' },
  { key: 'EXCEPTION', bar: 'bar-pending' },
  { key: 'UNCERTAIN', bar: 'bar-uncertain' },
  { key: 'PENDING_REVIEW', bar: 'bar-hold' },
  { key: 'NOT_ANALYZED', bar: 'bar-silent' },
];
const CATEGORIES = ['Over/Short', 'Damaged', 'Wrong item', 'Missing parts'];
const ATTENTION = ['EXCEPTION', 'PENDING_REVIEW', 'UNCERTAIN'];

export const PIPELINE = [
  { label: 'PO line', desc: 'Expected values loaded', icon: 'file' },
  { label: 'Photos captured', desc: 'Evidence uploaded', icon: 'image' },
  { label: 'Agent decision', desc: 'Checks evaluated', icon: 'gauge' },
  { label: 'Sealed record', desc: 'Hash-chained & HMAC', icon: 'shield' },
];

function BarChart({ rows, total }) {
  return (
    <div className="chart-bars">
      {rows.map((row) => (
        <div key={row.label} className="chart-bar-row">
          <span className="chart-bar-label">{row.label}</span>
          <div className="chart-bar-track">
            <div className={`chart-bar-fill ${row.bar}`} style={{ width: `${total ? (row.count / total) * 100 : 0}%` }}>
              {total ? `${Math.round((row.count / total) * 100)}%` : ''}
            </div>
          </div>
          <span className="chart-bar-count">{row.count}</span>
        </div>
      ))}
    </div>
  );
}

function NotConnected() {
  return <div className="empty-state"><Icon name="key" size={26} /><p>Connect with an API key to load data.</p></div>;
}

export default function DashboardView({ inspections, stats, connected, pipelineIndex, onOpenInspection, onNavigate }) {
  const attention = [...inspections]
    .filter((item) => ATTENTION.includes(effectiveDecision(item)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 5);
  const categoryTotal = CATEGORIES.reduce((sum, key) => sum + (stats.categories[key] || 0), 0);
  const analyzedCount = stats.total - (stats.counts.NOT_ANALYZED || 0);
  const value = (count) => (connected ? count : '—');

  const metrics = [
    { label: 'Inspections', value: value(stats.total), note: `${value(stats.counts.NOT_ANALYZED)} not inspected yet`, tone: 'dup', icon: 'truck' },
    { label: 'Passed', value: value(stats.counts.PASS), note: 'Accepted to stock', tone: 'contradicted', icon: 'check' },
    { label: 'Exceptions', value: value(stats.counts.EXCEPTION), note: 'Discrepancy or damage', tone: 'exception', icon: 'alert' },
    { label: 'Uncertain', value: value(stats.counts.UNCERTAIN), note: 'Evidence insufficient', tone: 'uncertain', icon: 'eye' },
    { label: 'Pending · Hold', value: value(stats.counts.PENDING_REVIEW), note: 'Fail-open hold', tone: 'hold', icon: 'clock' },
    { label: 'Photos', value: value(stats.images), note: 'Evidence captured', tone: 'silent', icon: 'image' },
  ];

  return (
    <>
      <div className="metrics-grid">
        {metrics.map((metric) => (
          <div key={metric.label} className={`metric-card ${metric.tone}`}>
            <div className="metric-icon"><Icon name={metric.icon} size={18} /></div>
            <div className="metric-value">{metric.value}</div>
            <div className="metric-label">{metric.label}</div>
            <div className="metric-note">{connected ? metric.note : 'Connect to load'}</div>
          </div>
        ))}
      </div>

      <div className="dashboard-grid">
        <Card flush title="Decision distribution" sub={connected ? `${stats.total} inspection(s)` : 'Not connected'}>
          <div className="chart-area">
            {connected
              ? <BarChart total={stats.total} rows={DECISION_BARS.map((row) => ({ label: decisionMeta(row.key).label, bar: row.bar, count: stats.counts[row.key] || 0 }))} />
              : <NotConnected />}
          </div>
        </Card>

        <Card
          flush
          title="Needs attention"
          sub="Latest exceptions, holds and uncertain deliveries"
          actions={<button type="button" className="detail-btn" onClick={() => onNavigate('ledger')}>View all</button>}
        >
          {!connected && <NotConnected />}
          {connected && attention.length === 0 && stats.total === 0 && (
            <div className="empty-state"><Icon name="truck" size={26} /><p>No inspections yet. Inspect a delivery to get started.</p></div>
          )}
          {connected && attention.length === 0 && stats.total > 0 && analyzedCount === 0 && (
            <div className="empty-state"><Icon name="clock" size={26} /><p>Nothing analyzed yet: {stats.total} inspection(s) waiting for analysis.</p></div>
          )}
          {connected && attention.length === 0 && analyzedCount > 0 && (
            <div className="empty-state">
              <Icon name="check" size={26} />
              <p>
                Nothing waiting — every analyzed delivery passed.
                {stats.counts.NOT_ANALYZED > 0 && ` ${stats.counts.NOT_ANALYZED} inspection(s) not analyzed yet.`}
              </p>
            </div>
          )}
          {connected && attention.length > 0 && (
            <div className="top-claims-list">
              {attention.map((item, index) => {
                const decision = effectiveDecision(item);
                const categories = failedCategories(item);
                return (
                  <button key={item.inspection_id} type="button" className="top-claim-item" onClick={() => onOpenInspection(item.inspection_id)}>
                    <span className={`top-claim-rank r-${decision}`}>{index + 1}</span>
                    <span className="top-claim-info">
                      <span className="top-claim-id mono">{item.inspection_id}</span>
                      <span className="top-claim-type" style={{ display: 'block' }}>
                        {item.po?.po_id} · {item.po?.product_name}{categories.length ? ` · ${categories.join(', ')}` : ''} · {formatTime(item.created_at)}
                      </span>
                    </span>
                    <span className={`verdict-badge v-${decision}`}>{decisionMeta(decision).label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="dashboard-grid">
        <Card flush title="Exception categories" sub="Failed checks grouped by receiving discrepancy">
          <div className="chart-area">
            {connected
              ? <BarChart total={categoryTotal} rows={CATEGORIES.map((key) => ({ label: key, bar: 'bar-supported', count: stats.categories[key] || 0 }))} />
              : <NotConnected />}
          </div>
        </Card>

        <Card
          flush
          title="Current inspection pipeline"
          sub="Where the inspection open in the workspace stands"
          actions={<button type="button" className="btn-primary" onClick={() => onNavigate('scanner')}><Icon name="scan" size={15} /> Inspect a delivery</button>}
        >
          <ChainDiagram steps={PIPELINE} activeIndex={pipelineIndex} />
        </Card>
      </div>
    </>
  );
}
