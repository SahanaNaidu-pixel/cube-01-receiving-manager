/*
 * SystemHealthPage — live readiness of the platform, measured from this browser:
 *   - frontend ↔ backend connectivity (timed GET /api/ready, HTTP status, request-id header visible → CORS ok)
 *   - GET /api/ready components (database, storage, vision provider, seal key, authentication, a2a)
 *   - GET /api/health liveness (service, version, demo mode)
 *   - API key / principal check (GET /api/system/info via AppContext)
 * Overall: HEALTHY | DEGRADED | UNAVAILABLE (UNAVAILABLE when the backend cannot be reached).
 */
import { useCallback, useEffect, useState } from 'react';
import { getApiBaseUrl, getHealth, probeBackend } from '../services/api';
import { useApp } from '../context/AppContext';
import { formatDateTime, formatLatency, formatRelative } from '../lib/format';
import {
  AsyncButton, Card, DataTable, ErrorState, Icon, KeyValueGrid, Link, LoadingState, PageHeader, StatusBadge,
} from '../components/ui';

const OVERALL_COPY = {
  HEALTHY: 'All components report healthy. Receiving decisions can be automated.',
  DEGRADED: 'The backend is up but at least one component is degraded — affected checks fall back to manual review.',
  UNAVAILABLE: 'The backend is not ready or cannot be reached. Inspections cannot be processed.',
};

function latencyTone(ms) {
  if (ms === null || ms === undefined) return 'neutral';
  if (ms < 300) return 'success';
  if (ms < 1000) return 'warning';
  return 'danger';
}

export default function SystemHealthPage() {
  const { connection, principal, hasKey, refreshReady, connect, apiKey } = useApp();
  const [probe, setProbe] = useState(null);
  const [health, setHealth] = useState({ data: null, error: null });
  const [running, setRunning] = useState(true);

  const runChecks = useCallback(async () => {
    setRunning(true);
    const [probeResult, healthResult] = await Promise.all([
      probeBackend(),
      getHealth().then((data) => ({ data, error: null }), (error) => ({ data: null, error })),
    ]);
    setProbe(probeResult);
    setHealth(healthResult);
    setRunning(false);
    refreshReady(); // keep the topbar pill in sync with what this page just measured
    return probeResult;
  }, [refreshReady]);

  useEffect(() => { runChecks(); }, [runChecks]);

  const refresh = async () => {
    const result = await runChecks();
    if (hasKey) await connect(apiKey);
    if (!result.reachable) throw result.error || new Error('Backend unreachable');
    return result;
  };

  const ready = probe?.ready;
  const overall = !probe ? null : !probe.reachable ? 'UNAVAILABLE' : (ready?.status || (probe.httpStatus === 503 ? 'UNAVAILABLE' : 'DEGRADED'));
  const components = ready?.components || [];

  return (
    <div className="stack">
      <PageHeader
        title="System health"
        subtitle="Measured live from this browser against the configured backend"
        actions={(
          <AsyncButton
            icon="refresh"
            label="Run checks"
            loadingLabel="Checking…"
            successLabel="All checks run"
            failedLabel="Backend unreachable"
            onClick={refresh}
            errorToast="Health check failed"
          />
        )}
      />

      {!probe && running && <Card><LoadingState label="Checking the backend…" /></Card>}

      {probe && (
        <>
          <section className={`card ui-overall tone-${overall === 'HEALTHY' ? 'success' : overall === 'DEGRADED' ? 'warning' : 'danger'}`}>
            <div className="ui-overall-icon"><Icon name={overall === 'HEALTHY' ? 'checkCircle' : 'alert'} size={28} /></div>
            <div>
              <div className="ui-overall-label">Overall status</div>
              <div className="ui-overall-status">{overall}</div>
              <p className="hint">{OVERALL_COPY[overall]}</p>
            </div>
            <div className="ui-overall-meta hint">
              {ready?.checked_at ? <>Backend checked {formatRelative(ready.checked_at)}</> : <>Probed {formatRelative(probe.checkedAt)}</>}
            </div>
          </section>

          <div className="dashboard-grid">
            <Card title="Frontend ↔ backend connectivity" sub="Timed request from this browser to GET /api/ready">
              <KeyValueGrid
                columns={2}
                items={[
                  { label: 'API base URL', value: getApiBaseUrl(), mono: true, span: 2 },
                  { label: 'Reachable', value: <StatusBadge status={probe.reachable ? 'ok' : 'unavailable'} label={probe.reachable ? 'Yes' : 'No'} /> },
                  { label: 'Round-trip latency', value: <StatusBadge tone={latencyTone(probe.reachable ? probe.latencyMs : null)} label={probe.reachable ? formatLatency(probe.latencyMs) : '—'} /> },
                  { label: 'HTTP status', value: probe.httpStatus || 'no response' },
                  { label: 'Request ID header', value: probe.requestId || (probe.reachable ? 'not exposed (check CORS expose_headers)' : '—'), mono: Boolean(probe.requestId) },
                  { label: 'Checked at', value: formatDateTime(probe.checkedAt), span: 2 },
                ]}
              />
              {!probe.reachable && probe.error && <ErrorState error={probe.error} title="Backend unreachable" compact />}
            </Card>

            <Card title="Liveness" sub="GET /api/health">
              {health.error && <ErrorState error={health.error} title="Liveness check failed" compact />}
              {health.data && (
                <KeyValueGrid
                  columns={2}
                  items={[
                    { label: 'Status', value: <StatusBadge status={health.data.status} /> },
                    { label: 'Service', value: health.data.service, mono: true },
                    { label: 'Version', value: health.data.version, mono: true },
                    { label: 'Demo mode', value: health.data.demo_mode === undefined ? '—' : (health.data.demo_mode ? 'On — simulated perception' : 'Off') },
                  ]}
                />
              )}
            </Card>
          </div>

          <Card flush title="Readiness components" sub="GET /api/ready — each dependency the receiving pipeline needs">
            <DataTable
              rowKey="name"
              rows={components}
              loading={running && !components.length}
              skeletonRows={6}
              empty={{ icon: 'server', title: probe.reachable ? 'No components reported' : 'Backend unreachable', message: probe.reachable ? 'The readiness response had no components list.' : 'Start the backend or fix VITE_API_BASE_URL, then run the checks again.' }}
              columns={[
                { key: 'name', header: 'Component', render: (row) => <span className="mono">{row.name}</span> },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                { key: 'message', header: 'Detail', render: (row) => row.message || '—' },
              ]}
            />
          </Card>

          <Card title="API key" sub="GET /api/system/info with the operator key">
            <KeyValueGrid
              columns={3}
              items={[
                { label: 'Connection', value: <StatusBadge status={connection.state === 'connected' ? 'ok' : connection.state === 'error' ? 'failed' : 'unknown'} label={connection.message} /> },
                { label: 'Operator', value: principal?.operator_id, mono: true },
                { label: 'Role', value: principal?.role },
                { label: 'Organisation', value: principal?.organization_id, mono: true },
              ]}
            />
            {!hasKey && <p className="hint">No API key set. <Link to="settings">Add one in Settings</Link> to check authenticated access.</p>}
            {connection.error && <ErrorState error={connection.error} title="Authenticated check failed" compact />}
          </Card>
        </>
      )}
    </div>
  );
}
