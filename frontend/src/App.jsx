import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiKey, getInspection, healthCheck, listInspections, setApiKey } from './services/api';
import { PO_PRESETS, isAnalyzed } from './constants';
import { poToForm } from './components/PoEditor';
import { ErrorBanner, Icon } from './components/Shared';
import ScannerView from './components/ScannerView';
import BenchmarkView from './components/BenchmarkView';
import LedgerView from './components/LedgerView';
import RulesView from './components/RulesView';
import OverviewView from './components/OverviewView';
import EvidenceView from './components/EvidenceView';
import { CatalogueView, PurchaseOrdersView } from './components/ReferenceViews';
import ActivityView from './components/ActivityView';
import SettingsView from './components/SettingsView';

const NAV = [
  { group: 'Receiving', items: [
    { key: 'overview', label: 'Overview', icon: 'home', title: 'Overview', subtitle: 'Receiving inspection activity across your organization, from the inspection records.' },
    { key: 'inspect', label: 'New Inspection', icon: 'scan', title: 'New inspection', subtitle: 'Check a supplier delivery against its PO line: enter the expected values, upload evidence, run the agent and review the verdict.' },
    { key: 'history', label: 'Inspection History', icon: 'list', title: 'Inspection history', subtitle: 'Every inspection, its verdict and its sealed evidence record.' },
    { key: 'evidence', label: 'Evidence Center', icon: 'image', title: 'Evidence center', subtitle: 'Photos stored with each inspection and the readings recorded for them.' },
  ] },
  { group: 'Reference data', items: [
    { key: 'catalogue', label: 'Product Catalogue', icon: 'package', title: 'Product catalogue', subtitle: 'Products seen on inspection PO lines (derived, read-only).' },
    { key: 'orders', label: 'Purchase Orders', icon: 'clipboard', title: 'Purchase orders', subtitle: 'PO lines received and inspected (derived, read-only).' },
  ] },
  { group: 'System', items: [
    { key: 'activity', label: 'Agent Activity', icon: 'activity', title: 'Agent activity', subtitle: 'Service health, inspection lifecycle events, API outcomes and integration status.' },
    { key: 'rules', label: 'Decision Rules', icon: 'book', title: 'How the agent decides', subtitle: 'What the model does, what the rules do, and when a person has to look.' },
    { key: 'benchmark', label: 'Rules Benchmark', icon: 'gauge', title: 'Rules benchmark', subtitle: 'Scripted readings that exercise every verdict path of the rules engine. It tests the rules, not the vision model.' },
    { key: 'settings', label: 'Settings', icon: 'settings', title: 'Settings', subtitle: 'Operator key, appearance and backend configuration.' },
  ] },
];
const ROUTES = NAV.flatMap((group) => group.items);
const THEME_KEY = 'receivingTheme';
const HEALTH_POLL_MS = 30000;
const OFFLINE_POLL_MS = 4000; // while the backend is down, look for it often so the app recovers on its own
const LIST_POLL_MS = 15000;

const routeFromHash = () => {
  const key = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  return ROUTES.some((route) => route.key === key) ? key : 'overview';
};

function initialThemePref() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (['light', 'dark', 'system'].includes(stored)) return stored;
  } catch { /* storage blocked */ }
  return 'light';
}
const resolveTheme = (pref) => (pref === 'system'
  ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  : pref);

const PROBE_TEXT = {
  ok: ['ok', 'Vision ready'],
  reachable: ['ok', 'Vision reachable'],
  not_configured: ['bad', 'Vision: no key'],
  key_rejected: ['bad', 'Vision: key rejected'],
  model_not_found: ['bad', 'Vision: model not found'],
  no_access: ['bad', 'Vision: no access'],
  unreachable: ['bad', 'Vision unreachable'],
  rate_limited: ['warn', 'Vision rate-limited'],
  error: ['warn', 'Vision check failed'],
};

function StatusChips({ health, onRecheck }) {
  if (health.ok === false) {
    return (
      <button type="button" className="chip chip--bad" onClick={onRecheck} title="GET /api/health is not answering. Retrying automatically; click to retry now.">
        <span className="chip__dot" />Backend offline
      </button>
    );
  }
  if (health.ok === null) return <span className="chip"><span className="chip__dot" />Checking backend…</span>;
  const p = health.perception;
  const [tone, text] = p ? (PROBE_TEXT[p.probe] || (p.mode === 'live' ? ['warn', 'Vision unverified'] : ['bad', 'Vision: no key'])) : ['neutral', 'Vision…'];
  return (
    <>
      <span className="chip chip--ok hide-md" title="GET /api/health answered"><span className="chip__dot" />API online</span>
      <button type="button" className={`chip chip--${tone}`} onClick={onRecheck}
        title={`${p?.probe_detail || ''} ${p ? `Model ${p.model} via ${p.api_style}.` : ''} Click to re-check now.`}>
        <span className="chip__dot" />{text}
      </button>
    </>
  );
}

export default function App() {
  const [view, setView] = useState(routeFromHash);
  const [navOpen, setNavOpen] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState({ state: 'idle', message: 'Not connected. Add an operator API key in Settings.' });
  const [health, setHealth] = useState({ ok: null, perception: null, limits: null, checkedAt: null });
  const [inspections, setInspections] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [themePref, setThemePref] = useState(initialThemePref);
  const [theme, setTheme] = useState(() => resolveTheme(initialThemePref()));
  const [live, setLive] = useState(false);
  const [historyFilter, setHistoryFilter] = useState({ key: 'all', n: 0 });

  const [poForm, setPoForm] = useState(() => poToForm(PO_PRESETS[0]));
  const [inspection, setInspection] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const mainRef = useRef(null);

  const connected = connection.state === 'connected';

  // ---- routing (hash based, so back/forward and deep links work without a router dependency) ----------
  useEffect(() => {
    const onHash = () => { setView(routeFromHash()); setNavOpen(false); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((key) => {
    if (window.location.hash !== `#/${key}`) window.location.hash = `/${key}`;
    else setView(key);
    setNavOpen(false);
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, []);

  // ---- theme -------------------------------------------------------------------------------------------
  useEffect(() => {
    setTheme(resolveTheme(themePref));
    try { localStorage.setItem(THEME_KEY, themePref); } catch { /* storage blocked */ }
    if (themePref !== 'system' || !window.matchMedia) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(resolveTheme('system'));
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, [themePref]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // ---- health ------------------------------------------------------------------------------------------
  // The probe really asks the AI provider whether the key works for the model (cached on the server).
  const checkHealth = useCallback(async (force = false) => {
    try {
      const result = await healthCheck({ probe: true, force });
      setHealth({ ok: true, perception: result.perception || null, limits: result.limits || null, checkedAt: new Date().toISOString() });
    } catch {
      setHealth((current) => ({ ...current, ok: false, perception: null, checkedAt: new Date().toISOString() }));
    }
  }, []);

  useEffect(() => {
    const every = health.ok === false ? OFFLINE_POLL_MS : HEALTH_POLL_MS;
    const timer = setInterval(() => { if (!document.hidden) checkHealth(); }, every);
    return () => clearInterval(timer);
  }, [checkHealth, health.ok]);

  // ---- inspections -------------------------------------------------------------------------------------
  const refreshInspections = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoadingList(true);
    try {
      const result = await listInspections();
      setInspections(result.items || []);
      setLastSync(new Date());
      setListError('');
      return true;
    } catch (err) {
      if (!quiet) setListError(err.message);
      if (err.status === 401 || err.status === 503) setConnection({ state: 'error', message: err.message });
      return false;
    } finally {
      if (!quiet) setLoadingList(false);
    }
  }, []);

  // Data pages stay current while on screen (other operators may be inspecting too).
  useEffect(() => {
    if (!connected || ['inspect', 'settings', 'rules', 'benchmark'].includes(view)) return undefined;
    const timer = setInterval(() => { if (!document.hidden) refreshInspections({ quiet: true }); }, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [connected, view, refreshInspections]);

  const connect = useCallback(async (key) => {
    setApiKey(key.trim());
    setError('');
    setConnection({ state: 'checking', message: 'Connecting…' });
    checkHealth();
    setLoadingList(true);
    try {
      const result = await listInspections();
      setInspections(result.items || []);
      setLastSync(new Date());
      setListError('');
      setConnection({ state: 'connected', message: 'Connected' });
    } catch (err) {
      const message = err.status === 401
        ? 'Invalid or missing operator key (401). Check the key and try again.'
        : err.status === 503 ? `Backend not ready (503): ${err.message}` : err.message;
      setConnection({ state: 'error', message });
      setListError(message);
    } finally {
      setLoadingList(false);
    }
  }, [checkHealth]);

  const signOut = useCallback(() => {
    setApiKey('');
    setInspections([]);
    setLastSync(null);
    setConnection({ state: 'idle', message: 'Signed out. Add an operator API key to continue.' });
  }, []);

  // Backend came back (or was down when the page loaded): reconnect with the saved key.
  useEffect(() => {
    if (health.ok && getApiKey() && ['idle', 'error'].includes(connection.state) && !/401|Invalid|Signed out/.test(connection.message)) {
      connect(getApiKey());
    }
  }, [health.ok]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (getApiKey()) connect(getApiKey());
    else checkHealth();
  }, [connect, checkHealth]);

  const openInspection = async (id) => {
    if (live) {
      setError('An inspection is still running. Open another one when it finishes.');
      return;
    }
    setError('');
    try {
      const loaded = await getInspection(id);
      setInspection(loaded);
      setAnalysis(null);
      if (loaded.po) setPoForm(poToForm(loaded.po));
      navigate('inspect');
    } catch (err) {
      setError(err.message);
    }
  };

  // Prefill a fresh inspection with a PO line taken from a real record (catalogue / purchase-order pages).
  const startWithPo = (po) => {
    if (live) { setError('An inspection is still running. Start another one when it finishes.'); return; }
    setInspection(null);
    setAnalysis(null);
    setPoForm(poToForm(po));
    navigate('inspect');
  };

  const startNewInspection = () => {
    if (!live && inspection && isAnalyzed(inspection)) { setInspection(null); setAnalysis(null); }
    navigate('inspect');
  };

  const filterHistory = (key) => {
    setHistoryFilter((current) => ({ key, n: current.n + 1 }));
    navigate('history');
  };

  const refreshAll = () => { checkHealth(true); if (connected) refreshInspections(); };

  const current = ROUTES.find((item) => item.key === view) || ROUTES[0];
  const group = NAV.find((g) => g.items.includes(current))?.group;
  const dataProps = { inspections, connected, loading: loadingList, error: listError, onRefresh: () => refreshInspections(), onConnect: () => navigate('settings') };

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''} ${live ? 'is-live' : ''}`}>
      <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>Skip to content</a>
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#/overview" onClick={() => setNavOpen(false)}>
          <span className="brand__mark" aria-hidden="true"><Icon name="box" size={18} /></span>
          <span className="brand__text"><b>CUBE Receiving Manager</b><small>Inbound inspection agent</small></span>
        </a>
        <nav className="sidenav">
          {NAV.map((section) => (
            <div key={section.group} className="sidenav__group">
              <div className="sidenav__label">{section.group}</div>
              {section.items.map((item) => (
                <a key={item.key} href={`#/${item.key}`} className={`sidenav__item ${view === item.key ? 'is-active' : ''}`}
                  aria-current={view === item.key ? 'page' : undefined} onClick={() => setNavOpen(false)}>
                  <Icon name={item.icon} size={17} />
                  <span>{item.label}</span>
                  {item.key === 'history' && connected && <span className="sidenav__count">{inspections.length}</span>}
                  {item.key === 'inspect' && live && <span className="live-dot" aria-label="running" />}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar__foot">
          <button type="button" className={`operator ${connected ? 'is-on' : ''}`} onClick={() => navigate('settings')}>
            <span className="operator__avatar"><Icon name="user" size={15} /></span>
            <span className="operator__text"><b>{connected ? 'Operator connected' : 'Not signed in'}</b><small>{connected ? 'API key accepted' : 'Add an API key'}</small></span>
            <span className={`chip__dot ${connected ? 'is-ok' : connection.state === 'error' ? 'is-bad' : ''}`} />
          </button>
        </div>
      </aside>
      <button type="button" className="scrim" aria-label="Close navigation" tabIndex={navOpen ? 0 : -1} onClick={() => setNavOpen(false)} />

      <div className="main-col">
        <header className="topbar">
          <button type="button" className="btn btn--ghost btn--icon topbar__menu" onClick={() => setNavOpen(true)} aria-label="Open navigation" aria-expanded={navOpen}>
            <Icon name="menu" />
          </button>
          <div className="topbar__title">
            <div className="crumbs" aria-label="Breadcrumb"><span>Receiving Manager</span><Icon name="chevronRight" size={12} /><span>{group}</span></div>
            <h1>{current.title}</h1>
          </div>
          <div className="topbar__end">
            <StatusChips health={health} onRecheck={() => checkHealth(true)} />
            <button type="button" className="btn btn--ghost btn--icon" onClick={refreshAll} aria-label="Refresh data and status" title="Refresh data and status" disabled={loadingList}>
              {loadingList ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={17} />}
            </button>
            <button type="button" className="btn btn--ghost btn--icon" onClick={() => setThemePref(theme === 'dark' ? 'light' : 'dark')}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
            </button>
            {view !== 'inspect' && (
              <button type="button" className="btn btn--primary topbar__cta" onClick={startNewInspection}>
                <Icon name="plus" size={16} /><span className="hide-sm">New Inspection</span>
              </button>
            )}
          </div>
        </header>

        <main id="main" className="content" ref={mainRef} tabIndex={-1}>
          <div className="page-head">
            <p>{current.subtitle}</p>
          </div>

          <div className="toasts" aria-live="assertive">
            <ErrorBanner message={error} onDismiss={() => setError('')} />
          </div>
          <div className="banner-stack">
            {health.ok === false && (
              <div className="alert alert--fail">
                <Icon name="server" size={16} />
                <span className="alert__text"><strong>The backend is not responding.</strong>
                  Start it with <code>uvicorn backend.app.main:app --port 8000</code>. This page reconnects automatically as soon as it answers.</span>
                <button type="button" className="btn btn--sm" onClick={() => checkHealth(true)}>Retry now</button>
              </div>
            )}
            {!connected && connection.state !== 'checking' && view !== 'settings' && (
              <div className="alert alert--warn">
                <Icon name="key" size={16} />
                <span className="alert__text">{connection.state === 'error' ? connection.message : 'Connect with an operator API key to inspect, view history and record overrides.'}</span>
                <button type="button" className="btn btn--sm" onClick={() => navigate('settings')}>Open settings</button>
              </div>
            )}
          </div>

          {/* The workspace and benchmark stay mounted (hidden) so queued photos, a running analysis and benchmark results survive navigation. */}
          <div hidden={view !== 'inspect'}>
            <ScannerView poForm={poForm} setPoForm={setPoForm} inspection={inspection} setInspection={setInspection}
              analysis={analysis} setAnalysis={setAnalysis} perception={health.perception} limits={health.limits}
              onChanged={() => refreshInspections({ quiet: true })} onError={setError} onLiveChange={setLive} onNavigate={navigate} />
          </div>
          <div hidden={view !== 'benchmark'}>
            <BenchmarkView poForm={poForm} perception={health.perception} onChanged={() => refreshInspections({ quiet: true })} onOpenInspection={openInspection} />
          </div>
          {view === 'overview' && (
            <OverviewView {...dataProps} onNavigate={navigate} onOpenInspection={openInspection} onFilterHistory={filterHistory} />
          )}
          {view === 'history' && (
            <LedgerView key={historyFilter.n} {...dataProps} lastSync={lastSync} initialFilter={historyFilter.key}
              onOpenInspection={openInspection} onNewInspection={startNewInspection} />
          )}
          {view === 'evidence' && <EvidenceView {...dataProps} onOpenInspection={openInspection} onNavigate={navigate} />}
          {view === 'catalogue' && <CatalogueView {...dataProps} onUsePo={startWithPo} onOpenInspection={openInspection} />}
          {view === 'orders' && <PurchaseOrdersView {...dataProps} onUsePo={startWithPo} onOpenInspection={openInspection} />}
          {view === 'activity' && <ActivityView health={health} connection={connection} inspections={inspections} connected={connected} onRecheck={() => checkHealth(true)} />}
          {view === 'rules' && <RulesView perception={health.perception} />}
          {view === 'settings' && (
            <SettingsView themePref={themePref} setThemePref={setThemePref} connection={connection} onConnect={connect} onSignOut={signOut}
              hasKey={Boolean(getApiKey())} health={health} onRecheck={() => checkHealth(true)} onNavigate={navigate} />
          )}
        </main>
      </div>
    </div>
  );
}
