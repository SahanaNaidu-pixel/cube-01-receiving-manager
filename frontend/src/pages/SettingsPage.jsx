/*
 * SettingsPage — API key management, appearance, connection target and the backend's
 * non-secret configuration (GET /api/system/info). The key itself is never displayed in full.
 */
import { useEffect, useState } from 'react';
import { API_BASE_URL, getApiBaseUrl } from '../services/api';
import { useApp } from '../context/AppContext';
import {
  AsyncButton, Card, ConfirmDialog, ErrorState, Icon, JsonViewer, KeyValueGrid, Link, PageHeader, StatusBadge,
} from '../components/ui';

const maskKey = (key) => (key ? `${'•'.repeat(Math.max(4, Math.min(12, key.length - 4)))}${key.slice(-4)}` : '');

export default function SettingsPage() {
  const { apiKey, connect, disconnect, connection, principal, systemInfo, theme, setTheme } = useApp();
  const [draft, setDraft] = useState('');
  const [show, setShow] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  useEffect(() => { setDraft(''); }, [apiKey]);

  const save = async () => {
    const ok = await connect(draft);
    if (!ok) throw new Error('The backend rejected this key or could not be reached — see the connection status below.');
  };
  const recheck = async () => {
    const ok = await connect(apiKey);
    if (!ok) throw new Error('Connection check failed — see the connection status below.');
  };

  const env = systemInfo?.environment || {};
  const agent = systemInfo?.agent || {};

  return (
    <div className="stack">
      <PageHeader title="Settings" subtitle="Operator access, appearance and the backend this workspace talks to" />

      <div className="dashboard-grid">
        <Card title="Operator API key" sub="Maps server-side to one organisation, operator and role. Stored only in this browser (localStorage).">
          <KeyValueGrid
            columns={2}
            items={[
              { label: 'Current key', value: apiKey ? <span className="mono">{maskKey(apiKey)}</span> : 'Not set' },
              { label: 'Status', value: <StatusBadge status={connection.state === 'connected' ? 'ok' : connection.state === 'error' ? 'failed' : 'unknown'} label={connection.message} /> },
              { label: 'Operator', value: principal?.operator_id, mono: true },
              { label: 'Role', value: principal?.role },
              { label: 'Organisation', value: principal?.organization_id, mono: true, span: 2 },
            ]}
          />
          {connection.error && <ErrorState error={connection.error} title="Key check failed" compact />}

          <form className="ui-form-row" onSubmit={(event) => event.preventDefault()}>
            <label className="field" htmlFor="settings-key">
              <span className="field-label">{apiKey ? 'Replace key' : 'API key'}</span>
              <span className="ui-input-group">
                <input
                  id="settings-key"
                  className="filter-input full"
                  type={show ? 'text' : 'password'}
                  autoComplete="off"
                  value={draft}
                  placeholder="Paste an operator or approver key"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="button" className="btn-theme" onClick={() => setShow((v) => !v)} aria-pressed={show}>
                  <Icon name="eye" size={14} /> {show ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>
            <div className="ui-button-row">
              <AsyncButton
                type="submit"
                variant="primary"
                icon="key"
                label="Save & connect"
                loadingLabel="Checking key…"
                successLabel="Connected"
                disabled={!draft.trim()}
                onClick={save}
                successToast="API key saved and verified"
                errorToast="Key not accepted"
              />
              {apiKey && (
                <AsyncButton icon="refresh" label="Re-check" loadingLabel="Checking…" successLabel="Verified" onClick={recheck} errorToast="Connection check failed" />
              )}
              {apiKey && (
                <button type="button" className="btn-theme ui-btn-danger" onClick={() => setConfirmForget(true)}>
                  <Icon name="logout" size={14} /> Forget key
                </button>
              )}
            </div>
          </form>
          <p className="hint">Only an <strong>approver</strong> key can finalise a PASS (override or review decision). Operators can escalate to FAIL or UNCERTAIN.</p>
        </Card>

        <div className="stack">
          <Card title="Appearance">
            <div className="ui-setting-row">
              <div>
                <strong>Theme</strong>
                <p className="hint">Saved in this browser. Defaults to your system preference.</p>
              </div>
              <div className="segmented-control" role="group" aria-label="Theme">
                {['light', 'dark'].map((value) => (
                  <button key={value} type="button" className={theme === value ? 'active' : ''} aria-pressed={theme === value} onClick={() => setTheme(value)}>
                    <Icon name={value === 'dark' ? 'moon' : 'sun'} size={13} /> {value === 'dark' ? 'Dark' : 'Light'}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          <Card title="Backend connection" sub="Set at build time with VITE_API_BASE_URL">
            <KeyValueGrid
              columns={2}
              items={[
                { label: 'API base URL', value: getApiBaseUrl(), mono: true, span: 2 },
                { label: 'Source', value: import.meta.env.VITE_API_BASE_URL ? 'VITE_API_BASE_URL' : (API_BASE_URL ? 'Dev default' : 'Same origin as this page') },
                { label: 'Build', value: import.meta.env.DEV ? 'Development server' : 'Production build' },
              ]}
            />
            <p className="hint"><Link to="system-health">Run a live connectivity check →</Link></p>
          </Card>
        </div>
      </div>

      <Card
        title="Backend configuration"
        sub="GET /api/system/info — non-secret settings reported by the backend"
        actions={apiKey && <AsyncButton variant="small" icon="refresh" label="Reload" loadingLabel="Loading…" onClick={recheck} errorToast="Could not reload system info" />}
      >
        {!systemInfo && <p className="hint">{apiKey ? 'Connect successfully to load the backend configuration.' : 'Set an API key to load the backend configuration.'}</p>}
        {systemInfo && (
          <>
            <KeyValueGrid
              columns={3}
              items={[
                { label: 'Agent', value: agent.name },
                { label: 'Agent ID', value: agent.agent_id, mono: true },
                { label: 'Agent version', value: agent.version, mono: true },
                { label: 'API version', value: systemInfo.api_version, mono: true },
                { label: 'A2A protocol', value: systemInfo.a2a_version, mono: true },
                { label: 'Record schema', value: systemInfo.record_schema, mono: true },
                { label: 'Vision provider', value: env.vision_provider },
                { label: 'Vision model', value: env.vision_model, mono: true },
                { label: 'Demo mode', value: env.demo_mode },
                { label: 'Damage policy', value: env.damage_policy },
                { label: 'Max image size', value: env.max_image_size_mb !== undefined ? `${env.max_image_size_mb} MB` : null },
                { label: 'Max images per upload', value: env.upload_max_images },
                { label: 'Allowed extensions', value: env.allowed_extensions },
                { label: 'Seal key configured', value: env.seal_key_configured },
                { label: 'A2A peers', value: (env.a2a_peers || []).length ? env.a2a_peers : 'None configured' },
                { label: 'Storage configured', value: systemInfo.storage?.root_configured },
                { label: 'Storage writable', value: systemInfo.storage?.writable },
              ]}
            />
            <JsonViewer data={systemInfo} title="Raw response" defaultDepth={0} maxHeight={320} />
          </>
        )}
      </Card>

      {confirmForget && (
        <ConfirmDialog
          title="Forget this API key?"
          message="The key is removed from this browser. You will need to paste it again to load data."
          confirmLabel="Forget key"
          tone="danger"
          onConfirm={async () => { disconnect(); }}
          onCancel={() => setConfirmForget(false)}
          successToast="API key removed from this browser"
        />
      )}
    </div>
  );
}
