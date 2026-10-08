/*
 * AppShell — workspace chrome: sidebar (sections, live badges, status), topbar (title, connection,
 * backend readiness, API key panel, theme toggle), mobile drawer, demo banner and a page error boundary.
 * Pages render as children inside <main>.
 */
import { Component, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { buildHref, navigate } from '../lib/router';
import { NAV_SECTIONS } from '../routes';
import { Icon } from './Shared';
import { ErrorState } from './ui/States';

const READY_TONE = { HEALTHY: 'connected', DEGRADED: 'checking', UNAVAILABLE: 'error' };

export function readinessSummary(ready, readyError) {
  if (ready?.status) {
    return { tone: READY_TONE[ready.status] || '', label: ready.status, text: `Backend: ${ready.status.toLowerCase()}` };
  }
  if (readyError) {
    return { tone: 'error', label: readyError.status === 0 ? 'UNREACHABLE' : `HTTP ${readyError.status}`, text: readyError.status === 0 ? 'Backend: unreachable' : `Backend: error ${readyError.status}` };
  }
  return { tone: '', label: 'CHECKING', text: 'Backend: checking…' };
}

/** Catches render errors in a page so the shell (and navigation) keep working. */
class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          title="This page failed to render"
          error={{ message: this.state.error.message || String(this.state.error) }}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

function ApiKeyPanel() {
  const { apiKey, connect, disconnect, connection, principal } = useApp();
  const [draft, setDraft] = useState(apiKey);
  useEffect(() => setDraft(apiKey), [apiKey]);
  const checking = connection.state === 'checking';
  return (
    <form className="key-form" onSubmit={(event) => { event.preventDefault(); connect(draft); }}>
      <label htmlFor="api-key" className="sr-only">Operator API key</label>
      <input
        id="api-key"
        className="org-selector"
        type="password"
        autoComplete="off"
        value={draft}
        placeholder="Operator API key"
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="submit" className="btn-primary" disabled={checking || !draft.trim()}>
        {checking ? <span className="spinner" aria-hidden="true" /> : <Icon name="key" size={15} />}
        {checking ? 'Connecting…' : connection.state === 'connected' && draft === apiKey ? 'Reconnect' : 'Connect'}
      </button>
      {apiKey && (
        <button type="button" className="btn-theme ui-icon-only" onClick={disconnect} title="Forget this API key" aria-label="Forget API key">
          <Icon name="logout" size={15} />
        </button>
      )}
      {principal?.role && <span className="ui-role-pill" title={`Organisation ${principal.organization_id}`}>{principal.role}</span>}
    </form>
  );
}

export default function AppShell({ route, navKey, title, children }) {
  const { connection, connected, counts, ready, readyError, systemInfo, theme, toggleTheme } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  const mainRef = useRef(null);

  // Close the mobile drawer and move focus to the page on navigation (not on filter/query changes).
  useEffect(() => {
    setNavOpen(false);
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [route.path]);

  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const readiness = readinessSummary(ready, readyError);
  const env = systemInfo?.environment;
  const demo = Boolean(env?.demo_mode);
  const vision = env?.vision_provider || ready?.components?.find((c) => c.name === 'vision_provider')?.message;
  const badgeClass = connected ? 'badge-connected' : connection.state === 'error' ? 'badge-error' : '';

  return (
    <div id="appWorkspaceContainer" className={`page-view active ${navOpen ? 'nav-open' : ''}`}>
      <a href="#main-content" className="ui-skip-link" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>
      <aside className="sidebar" aria-label="Main navigation">
        <button type="button" className="sidebar-logo" onClick={() => navigate('/')} title="Back to the home page">
          <span className="logo-icon"><Icon name="box" size={18} /></span>
          <span>
            <span className="logo-title" style={{ display: 'block' }}>Receiving</span>
            <span className="logo-sub">Manager · Pod 01</span>
          </span>
        </button>

        <nav className="sidebar-nav ui-sidebar-nav">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label}>
              <div className="nav-section">{section.label}</div>
              {section.items.map((item) => {
                const count = item.badge && counts ? counts[item.badge] : null;
                const active = navKey === item.key;
                return (
                  <a
                    key={item.key}
                    href={buildHref(item.key)}
                    aria-current={active ? 'page' : undefined}
                    className={`nav-item ${active ? 'active' : ''}`}
                  >
                    <span className="nav-icon"><Icon name={item.icon} size={17} /></span>
                    <span>{item.label}</span>
                    {typeof count === 'number' && count > 0 && (
                      <span className="nav-count ui-nav-alert" title={`${count} ${item.badgeTitle || ''}`.trim()}>{count}</span>
                    )}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="status-list" aria-live="polite">
            <div className="status-row"><span className={`status-dot ${connection.state}`} /><span>{connection.message}</span></div>
            <a className="status-row ui-status-link" href={buildHref('system-health')}>
              <span className={`status-dot ${readiness.tone}`} /><span>{readiness.text}</span>
            </a>
            {vision && (
              <div className="status-row">
                <span className={`status-dot ${vision === 'none' ? 'checking' : demo ? 'checking' : 'connected'}`} />
                <span>Vision: {vision}</span>
              </div>
            )}
          </div>
        </div>
      </aside>
      <div className="sidebar-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <div className="main-content">
        {demo && (
          <div className="demo-banner" role="status">
            <span>DEMO MODE — perception is simulated from demo scenarios</span>
            <span>Not for real receiving decisions</span>
          </div>
        )}

        <header className="topbar">
          <div className="topbar-left">
            <button type="button" className="btn-theme menu-btn" onClick={() => setNavOpen(true)} aria-label="Open navigation" aria-expanded={navOpen}>
              <Icon name="menu" size={16} />
            </button>
            <h1 className="page-title">{title}</h1>
            <span className={`page-badge ${badgeClass}`} title={connection.message}>{connection.message}</span>
            <a className={`ui-health-pill tone-${readiness.tone || 'idle'}`} href={buildHref('system-health')} title="Backend readiness (GET /api/ready)">
              <span className={`status-dot ${readiness.tone}`} />{readiness.label}
            </a>
          </div>

          <div className="topbar-right">
            <ApiKeyPanel />
            <button
              type="button"
              className="btn-theme"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} /> <span className="ui-hide-sm">{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </header>

        <main id="main-content" className="ui-main" ref={mainRef} tabIndex={-1}>
          <PageErrorBoundary resetKey={route.path}>{children}</PageErrorBoundary>
        </main>
      </div>
    </div>
  );
}
