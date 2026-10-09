import { useEffect, useMemo, useState } from 'react';
import { getRequestLog, subscribeRequestLog } from '../services/api';
import { decisionMeta, formatTime, timeAgo } from '../constants';
import { lifecycleEvents } from './OverviewView';
import { EmptyState, Icon, Panel } from './Shared';

// Other CUBE agents. This backend has no integration endpoints or health checks for them, so they are listed as
// not connected; nothing here claims a handoff happened.
const CUBE_AGENTS = [
  { name: 'Preparation Manager', relation: 'Downstream: consumes the prep_hold flag and unit_id from each sealed receiving record.' },
  { name: 'Pack Manager', relation: 'Downstream stage of the same unit_id chain.' },
  { name: 'Returns Manager', relation: 'Separate stage; shares the unit_id join key.' },
  { name: 'Recovery Manager', relation: 'Separate stage; uses its own verdict vocabulary.' },
];

const EVENT_ICON = { created: 'plus', analyzed: 'shield', override: 'pen' };
const PROBE_LABEL = {
  ok: ['ok', 'Ready', 'The provider confirmed the key can use the model.'],
  reachable: ['ok', 'Reachable', 'The provider endpoint answered.'],
  not_configured: ['bad', 'Not configured', 'No AI key on the server: photos are not read and runs are held for review.'],
  key_rejected: ['bad', 'Key rejected', 'The provider rejected the server key.'],
  model_not_found: ['bad', 'Model not found', 'The configured model is not available.'],
  no_access: ['bad', 'No model access', 'The key cannot use the configured model.'],
  unreachable: ['bad', 'Unreachable', 'The server cannot reach the AI endpoint.'],
  rate_limited: ['warn', 'Rate-limited', 'The key is rate-limited or out of quota.'],
  error: ['warn', 'Check failed', 'The provider check failed.'],
};

function useRequestLog() {
  const [log, setLog] = useState(getRequestLog);
  useEffect(() => subscribeRequestLog(() => setLog(getRequestLog())), []);
  return log;
}

function StatusTile({ title, icon, tone, status, detail, meta }) {
  return (
    <div className={`status-tile status-tile--${tone}`}>
      <div className="status-tile__head">
        <span className="status-tile__icon"><Icon name={icon} size={16} /></span>
        <b>{title}</b>
        <span className={`chip chip--${tone}`}><span className="chip__dot" />{status}</span>
      </div>
      <p>{detail}</p>
      {meta && <small>{meta}</small>}
    </div>
  );
}

export default function ActivityView({ health, connection, inspections, connected, onRecheck }) {
  const log = useRequestLog();
  const [hidePolls, setHidePolls] = useState(true);
  const [eventLimit, setEventLimit] = useState(25);
  const events = useMemo(() => lifecycleEvents(inspections), [inspections]);
  const requests = hidePolls ? log.filter((entry) => entry.path !== '/api/health') : log;
  const failures = log.filter((entry) => entry.status === 0 || entry.status >= 400).length;
  const p = health.perception;
  const [probeTone, probeStatus, probeDetail] = health.ok === false ? ['bad', 'Unknown', 'Backend offline.']
    : !p ? ['neutral', 'Checking…', 'Waiting for the health check.']
      : PROBE_LABEL[p.probe] || (p.mode === 'live' ? ['warn', 'Unverified', 'A key is configured but has not been verified.'] : PROBE_LABEL.not_configured);

  return (
    <div className="stack">
      <Panel title="Receiving Manager status" icon="server" sub="Live results of the backend health check and this browser's operator session."
        actions={<button type="button" className="btn btn--sm" onClick={onRecheck}><Icon name="refresh" size={14} /> Re-check now</button>}>
        <div className="status-grid">
          <StatusTile title="Backend API" icon="server"
            tone={health.ok ? 'ok' : health.ok === false ? 'bad' : 'neutral'}
            status={health.ok ? 'Online' : health.ok === false ? 'Offline' : 'Checking…'}
            detail={health.ok ? 'GET /api/health answered.' : health.ok === false ? 'The health endpoint did not answer. The app retries every few seconds.' : 'Waiting for the first health check.'}
            meta={health.checkedAt ? `Last checked ${formatTime(health.checkedAt)}` : ''} />
          <StatusTile title="Vision perception" icon="eye" tone={probeTone} status={probeStatus}
            detail={p?.probe_detail || probeDetail}
            meta={p ? `Model ${p.model} · ${p.api_style}${p.stream ? ' · streaming' : ''}${p.second_look ? ' · second look on' : ''}` : ''} />
          <StatusTile title="Operator session" icon="user"
            tone={connected ? 'ok' : connection.state === 'error' ? 'bad' : 'neutral'}
            status={connected ? 'Authenticated' : connection.state === 'checking' ? 'Connecting…' : 'Signed out'}
            detail={connected ? 'The operator API key was accepted by the inspections API.' : connection.message}
            meta={connected ? `${inspections.length} inspection${inspections.length === 1 ? '' : 's'} in this organization` : ''} />
          <StatusTile title="Scripted demo mode" icon="flask"
            tone={p?.demo_scenarios ? 'warn' : 'neutral'} status={p ? (p.demo_scenarios ? 'Enabled' : 'Off') : '—'}
            detail={p?.demo_scenarios ? 'DEMO_MODE=true: the Rules Benchmark may run scripted readings. Real inspections still read real photos.' : 'Only real photo analysis is possible.'} />
        </div>
      </Panel>

      <Panel title="CUBE agent integrations" icon="link"
        sub="The Receiving Manager publishes a sealed record per inspection. No other agent endpoint is configured or health-checked by this backend.">
        <div className="agent-list">
          {CUBE_AGENTS.map((agent) => (
            <div key={agent.name} className="agent-row">
              <span className="agent-row__icon"><Icon name="cpu" size={16} /></span>
              <div><b>{agent.name}</b><small>{agent.relation}</small></div>
              <span className="chip chip--neutral"><span className="chip__dot" />Not connected</span>
            </div>
          ))}
        </div>
        <p className="field__help" style={{ marginTop: 10 }}>
          Integration contract available today: <code>GET /api/inspections/{'{id}'}</code> returns the latest sealed record with <code>outcome.verdict</code>, <code>outcome.prep_hold</code>,
          <code>outcome.hold_reasons</code> and <code>subject.unit_id</code>; <code>GET /api/inspections/{'{id}'}/verify</code> re-checks its integrity.
        </p>
      </Panel>

      <div className="grid-2">
        <Panel title="Inspection lifecycle" icon="clock" sub="Created, analyzed and override events read from the inspection records.">
          {!connected ? <EmptyState icon="key" title="Not connected">Connect an operator key to load inspection events.</EmptyState>
            : events.length === 0 ? <EmptyState icon="clock" title="No events yet">Events appear when inspections are created and analyzed.</EmptyState>
              : (
                <>
                  <ol className="feed">
                    {events.slice(0, eventLimit).map((event, index) => (
                      <li key={`${event.id}-${event.kind}-${index}`} className={`feed__item feed__item--${event.decision ? decisionMeta(event.decision).tone : 'neutral'}`}>
                        <span className="feed__icon"><Icon name={EVENT_ICON[event.kind]} size={13} /></span>
                        <div><p>{event.text}</p><small><span className="mono">{event.id}</span> · {formatTime(event.at)}</small></div>
                      </li>
                    ))}
                  </ol>
                  {events.length > eventLimit && <button type="button" className="btn btn--sm" style={{ marginTop: 10 }} onClick={() => setEventLimit((n) => n + 25)}>Show more</button>}
                </>
              )}
        </Panel>

        <Panel title="API requests (this session)" icon="activity"
          sub={`Real calls made by this browser since the page loaded. ${failures} failed.`}
          actions={(
            <label className="toggle">
              <input type="checkbox" checked={hidePolls} onChange={(e) => setHidePolls(e.target.checked)} />
              <span>Hide health polls</span>
            </label>
          )}>
          {requests.length === 0 ? <EmptyState icon="activity" title="No requests yet">Requests appear here as you use the app.</EmptyState> : (
            <ol className="req-log">
              {requests.slice(0, 60).map((entry) => {
                const ok = entry.status >= 200 && entry.status < 400;
                return (
                  <li key={entry.id} className={ok ? '' : 'is-error'} title={entry.error || ''}>
                    <span className={`req-log__status ${ok ? 'is-ok' : 'is-bad'}`}>{entry.status || 'ERR'}</span>
                    <span className="req-log__method">{entry.method}</span>
                    <span className="req-log__path mono">{entry.path}</span>
                    <span className="req-log__ms mono">{entry.ms} ms</span>
                    <span className="req-log__at">{timeAgo(entry.at)}</span>
                    {!ok && entry.error && <span className="req-log__err">{entry.error}</span>}
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}
