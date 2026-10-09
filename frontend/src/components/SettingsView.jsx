import { useState } from 'react';
import { apiBaseUrl } from '../services/api';
import { formatTime } from '../constants';
import { Icon, Panel } from './Shared';

const THEMES = [
  { key: 'light', label: 'Light', icon: 'sun' },
  { key: 'dark', label: 'Dark', icon: 'moon' },
  { key: 'system', label: 'System', icon: 'settings' },
];

export default function SettingsView({ themePref, setThemePref, connection, onConnect, onSignOut, hasKey, health, onRecheck, onNavigate }) {
  const [keyInput, setKeyInput] = useState('');
  const [reveal, setReveal] = useState(false);
  const connected = connection.state === 'connected';
  const p = health.perception;
  const limits = health.limits;

  return (
    <div className="settings">
      <Panel title="Operator API key" icon="key"
        sub="Each key maps on the server to one organization, operator and role (operator or approver) from RECEIVING_API_KEYS. It is stored only in this browser's localStorage and sent as the X-API-Key header.">
        <form className="key-form" onSubmit={(event) => { event.preventDefault(); if (keyInput.trim()) onConnect(keyInput); }}>
          <div className="field">
            <label htmlFor="settings-key" className="field__label">API key</label>
            <div className="input-group">
              <input id="settings-key" className="input mono" type={reveal ? 'text' : 'password'} autoComplete="off" value={keyInput}
                placeholder={hasKey ? 'A key is saved. Paste a new one to switch.' : 'Paste operator API key'} onChange={(event) => setKeyInput(event.target.value)} />
              <button type="button" className="btn btn--ghost btn--icon" onClick={() => setReveal((v) => !v)} aria-label={reveal ? 'Hide key' : 'Show key'}><Icon name="eye" size={16} /></button>
            </div>
          </div>
          <div className="key-form__actions">
            <button type="submit" className="btn btn--primary" disabled={connection.state === 'checking' || !keyInput.trim()}>
              {connection.state === 'checking' ? <span className="spinner" aria-hidden="true" /> : <Icon name="key" size={15} />}{connected ? 'Switch key' : 'Connect'}
            </button>
            {hasKey && <button type="button" className="btn" onClick={onSignOut}><Icon name="logout" size={15} /> Sign out</button>}
          </div>
        </form>
        <div className={`session-state session-state--${connected ? 'ok' : connection.state === 'error' ? 'bad' : 'neutral'}`} role="status">
          <span className="chip__dot" /> {connected ? 'Connected: the inspections API accepted this key.' : connection.message}
        </div>
      </Panel>

      <Panel title="Appearance" icon="sun" sub="Light is the default. System follows your operating-system setting.">
        <div className="segmented segmented--lg" role="radiogroup" aria-label="Theme">
          {THEMES.map((theme) => (
            <button key={theme.key} type="button" role="radio" aria-checked={themePref === theme.key} className={themePref === theme.key ? 'is-on' : ''} onClick={() => setThemePref(theme.key)}>
              <Icon name={theme.icon} size={15} /> {theme.label}
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Backend connection" icon="server" actions={<button type="button" className="btn btn--sm" onClick={onRecheck}><Icon name="refresh" size={14} /> Re-check</button>}>
        <dl className="meta meta--grid">
          <div><dt>API base URL</dt><dd>{apiBaseUrl()}</dd></div>
          <div><dt>Health</dt><dd>{health.ok ? 'online' : health.ok === false ? 'offline' : 'checking…'}</dd></div>
          <div><dt>Last checked</dt><dd>{health.checkedAt ? formatTime(health.checkedAt) : '—'}</dd></div>
          <div><dt>Configured via</dt><dd>VITE_API_BASE_URL (frontend/.env)</dd></div>
        </dl>
      </Panel>

      <Panel title="Upload limits" icon="upload" sub="Reported by the backend; the server validates every upload regardless.">
        {limits ? (
          <dl className="meta meta--grid">
            <div><dt>Max image size</dt><dd>{limits.max_image_size_mb} MB</dd></div>
            <div><dt>Max photos / inspection</dt><dd>{limits.upload_max_images}</dd></div>
            <div><dt>Allowed types</dt><dd>{(limits.allowed_extensions || []).join(' ')}</dd></div>
          </dl>
        ) : <p className="muted">Not reported (backend offline or an older backend version).</p>}
      </Panel>

      <Panel title="Vision configuration" icon="cpu" sub="Server-side settings reported by GET /api/health. Secrets are never sent to the browser.">
        {p ? (
          <dl className="meta meta--grid">
            <div><dt>Vision</dt><dd>{p.mode === 'live' ? p.model : 'not configured'}</dd></div>
            <div><dt>API style</dt><dd>{p.api_style}{p.custom_endpoint ? ' (custom endpoint)' : ''}</dd></div>
            <div><dt>Streaming</dt><dd>{p.stream ? 'on' : 'off'}</dd></div>
            <div><dt>Image detail</dt><dd>{p.image_detail}</dd></div>
            <div><dt>Second look</dt><dd>{p.second_look ? 'on' : 'off'}</dd></div>
            <div><dt>Timeout</dt><dd>{p.timeout_s}s</dd></div>
            <div><dt>Scripted demos</dt><dd>{p.demo_scenarios ? 'allowed' : 'off'}</dd></div>
            <div><dt>Provider check</dt><dd>{p.probe || '—'}</dd></div>
          </dl>
        ) : <p className="muted">Waiting for the backend health check.</p>}
        <div className="row-actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn btn--sm" onClick={() => onNavigate('rules')}><Icon name="book" size={14} /> How the agent decides</button>
          <button type="button" className="btn btn--sm" onClick={() => onNavigate('benchmark')}><Icon name="gauge" size={14} /> Rules benchmark</button>
        </div>
      </Panel>
    </div>
  );
}
