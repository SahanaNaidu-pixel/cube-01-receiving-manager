import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApiKey, getInspection, healthCheck, listInspections, setApiKey } from './services/api';
import { PO_PRESETS, effectiveDecision, failedCategories, isAnalyzed } from './constants';
import { poToForm } from './components/PoEditor';
import { ErrorBanner, Icon } from './components/Shared';
import LandingPage from './components/LandingPage';
import DashboardView, { PIPELINE } from './components/DashboardView';
import ScannerView from './components/ScannerView';
import BenchmarkView from './components/BenchmarkView';
import LedgerView from './components/LedgerView';
import RulesView from './components/RulesView';

const VIEWS = [
  { key: 'dashboard', section: 'Overview', label: 'Dashboard', icon: 'grid' },
  { key: 'scanner', section: 'Receiving', label: 'Receiving Inspection', icon: 'scan' },
  { key: 'ledger', section: 'Receiving', label: 'Inspections', icon: 'list' },
  { key: 'benchmark', section: 'Quality', label: 'Scenario Benchmark', icon: 'gauge' },
  { key: 'rules', section: 'Quality', label: 'Receiving Rules', icon: 'book' },
];
const SECTIONS = [...new Set(VIEWS.map((item) => item.section))];
const THEME_KEY = 'receivingTheme';

function initialTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* storage blocked */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Hash routes: "#/" is the public landing page, "#/app/<view>" is the workspace.
function readRoute() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] !== 'app') return { page: 'landing', view: 'dashboard' };
  return { page: 'app', view: VIEWS.some((item) => item.key === parts[1]) ? parts[1] : 'dashboard' };
}

export default function App() {
  const [route, setRoute] = useState(readRoute);
  const [error, setError] = useState('');
  const [keyInput, setKeyInput] = useState(getApiKey);
  const [connection, setConnection] = useState({ state: 'idle', message: 'Not connected' });
  const [health, setHealth] = useState({ ok: null, text: 'Backend: checking…' });
  const [inspections, setInspections] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [demoMode, setDemoMode] = useState(null);
  const [theme, setTheme] = useState(initialTheme);
  const [navOpen, setNavOpen] = useState(false);

  const [poForm, setPoForm] = useState(() => poToForm(PO_PRESETS[0]));
  const [inspection, setInspection] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  // True while ScannerView has a create/upload/analyze/override in flight. Its handlers write the
  // result into `inspection` when they finish, so opening another inspection meanwhile would be clobbered.
  const scannerBusyRef = useRef(false);
  const handleScannerBusy = useCallback((value) => { scannerBusyRef.current = value; }, []);

  const connected = connection.state === 'connected';
  const view = route.view;

  useEffect(() => {
    const onHash = () => { setRoute(readRoute()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage blocked */ }
  }, [theme]);

  const toggleTheme = () => setTheme((value) => (value === 'dark' ? 'light' : 'dark'));

  const checkHealth = useCallback(async () => {
    try {
      const result = await healthCheck();
      setHealth({ ok: true, text: `Backend: ${result.status || 'ok'}` });
    } catch (err) {
      setHealth({ ok: false, text: `Backend: ${err.status ? `error ${err.status}` : 'unreachable'}` });
    }
  }, []);

  const refreshInspections = useCallback(async () => {
    setLoadingList(true);
    try {
      const result = await listInspections();
      const items = result.items || [];
      setInspections(items);
      setConnection((current) => (current.state === 'connected'
        ? { ...current, message: `Connected · ${result.count ?? items.length} inspection(s)` }
        : current));
      return true;
    } catch (err) {
      setError(err.message);
      if (err.status === 401 || err.status === 503) setConnection({ state: 'error', message: err.message });
      return false;
    } finally {
      setLoadingList(false);
    }
  }, []);

  const connect = useCallback(async (key) => {
    setApiKey(key.trim());
    setError('');
    setConnection({ state: 'checking', message: 'Connecting…' });
    checkHealth();
    try {
      const result = await listInspections();
      setInspections(result.items || []);
      setConnection({ state: 'connected', message: `Connected · ${result.count ?? (result.items || []).length} inspection(s)` });
    } catch (err) {
      const message = err.status === 401
        ? 'Invalid or missing API key (401). Check the key and try again.'
        : err.status === 503
          ? `Backend not ready (503): ${err.message}`
          : err.message;
      setConnection({ state: 'error', message });
      setError(message);
    }
  }, [checkHealth]);

  useEffect(() => {
    if (getApiKey()) connect(getApiKey());
    else checkHealth();
  }, [connect, checkHealth]);

  const goTo = (key) => {
    setNavOpen(false);
    window.location.hash = `#/app/${key}`;
  };
  const goHome = () => {
    setNavOpen(false);
    window.location.hash = '#/';
  };

  const SCANNER_BUSY = 'The receiving workspace is still uploading or analyzing. Wait for it to finish before opening another inspection.';
  const openInspection = async (id) => {
    if (scannerBusyRef.current) { setError(SCANNER_BUSY); return; }
    setError('');
    try {
      const loaded = await getInspection(id);
      if (scannerBusyRef.current) { setError(SCANNER_BUSY); return; } // a run started while loading
      setInspection(loaded);
      setAnalysis(null);
      if (loaded.po) setPoForm(poToForm(loaded.po));
      goTo('scanner');
    } catch (err) {
      setError(err.message);
    }
  };

  const stats = useMemo(() => {
    const counts = { PASS: 0, EXCEPTION: 0, UNCERTAIN: 0, PENDING_REVIEW: 0, NOT_ANALYZED: 0 };
    const categories = {};
    let images = 0;
    inspections.forEach((item) => {
      const decision = isAnalyzed(item) ? effectiveDecision(item) : 'NOT_ANALYZED';
      counts[decision] = (counts[decision] || 0) + 1;
      failedCategories(item).forEach((category) => { categories[category] = (categories[category] || 0) + 1; });
      images += item.images?.length ?? 0;
    });
    return { total: inspections.length, counts, categories, images };
  }, [inspections]);

  // Pipeline position of the inspection open in the workspace (index of the first unfinished stage).
  const pipelineDone = [
    true,
    (inspection?.images?.length ?? 0) > 0,
    isAnalyzed(inspection),
    Boolean(inspection?.record),
  ];
  const pipelineIndex = pipelineDone.indexOf(false) === -1 ? PIPELINE.length : pipelineDone.indexOf(false);

  const current = VIEWS.find((item) => item.key === view) || VIEWS[0];
  const healthTone = health.ok === null ? 'checking' : health.ok ? 'connected' : 'error';
  const badgeClass = connected ? 'badge-connected' : connection.state === 'error' ? 'badge-error' : '';

  return (
    <>
      <div id="publicPagesContainer" className={`page-view ${route.page === 'landing' ? 'active' : ''}`}>
        {route.page === 'landing' && <LandingPage theme={theme} onToggleTheme={toggleTheme} onOpenApp={goTo} health={health} />}
      </div>

      {/* The workspace stays mounted while on the landing page so queued photos and results survive. */}
      <div id="appWorkspaceContainer" className={`page-view ${route.page === 'app' ? 'active' : ''} ${navOpen ? 'nav-open' : ''}`}>
        <aside className="sidebar" aria-label="Main navigation">
          <button type="button" className="sidebar-logo" onClick={goHome} title="Back to the home page">
            <span className="logo-icon"><Icon name="box" size={18} /></span>
            <span>
              <span className="logo-title" style={{ display: 'block' }}>Receiving</span>
              <span className="logo-sub">Manager · Pod 01</span>
            </span>
          </button>

          <nav className="sidebar-nav">
            {SECTIONS.map((section) => (
              <div key={section}>
                <div className="nav-section">{section}</div>
                {VIEWS.filter((item) => item.section === section).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    aria-current={view === item.key ? 'page' : undefined}
                    className={`nav-item ${view === item.key ? 'active' : ''}`}
                    onClick={() => goTo(item.key)}
                  >
                    <span className="nav-icon"><Icon name={item.icon} size={17} /></span>
                    <span>{item.label}</span>
                    {item.key === 'ledger' && connected && <span className="nav-count">{stats.total}</span>}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="sidebar-footer">
            <div className="pipeline-title">Current inspection</div>
            <div className="pipeline-badge">
              {PIPELINE.map((step, index) => (
                <div key={step.label} className={`pipeline-step ${index < pipelineIndex ? 'done' : index === pipelineIndex ? 'active' : ''}`}>
                  {index < pipelineIndex ? '✓' : `${index + 1}`} · {step.label}
                </div>
              ))}
            </div>
            <div className="status-list" aria-live="polite">
              <div className="status-row"><span className={`status-dot ${connection.state}`} /><span>{connection.message}</span></div>
              <div className="status-row"><span className={`status-dot ${healthTone}`} /><span>{health.text}</span></div>
              <div className="status-row">
                <span className={`status-dot ${demoMode === null ? '' : demoMode ? 'checking' : 'connected'}`} />
                <span>Perception: {demoMode === null ? 'unknown' : demoMode ? 'demo' : 'live'}</span>
              </div>
            </div>
          </div>
        </aside>
        <div className="sidebar-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

        <div className="main-content">
          {demoMode && (
            <div className="demo-banner" role="status">
              <span>DEMO MODE — perception is simulated from the selected scenario</span>
              <span>Not for real receiving decisions</span>
            </div>
          )}

          <header className="topbar">
            <div className="topbar-left">
              <button type="button" className="btn-theme menu-btn" onClick={() => setNavOpen(true)} aria-label="Open navigation">
                <Icon name="menu" size={16} />
              </button>
              <h1 className="page-title">{current.label}</h1>
              <span className={`page-badge ${badgeClass}`} title={connection.message}>{connection.message}</span>
            </div>

            <div className="topbar-right">
              <form className="key-form" onSubmit={(event) => { event.preventDefault(); connect(keyInput); }}>
                <label htmlFor="api-key" className="sr-only">Operator API key</label>
                <input
                  id="api-key"
                  className="org-selector"
                  type="password"
                  autoComplete="off"
                  value={keyInput}
                  placeholder="Operator API key"
                  onChange={(event) => setKeyInput(event.target.value)}
                />
                <button type="submit" className="btn-primary" disabled={connection.state === 'checking'}>
                  <Icon name="key" size={15} /> {connection.state === 'checking' ? 'Connecting…' : 'Connect'}
                </button>
              </form>
              <button
                type="button"
                className="btn-theme"
                onClick={toggleTheme}
                aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} /> {theme === 'dark' ? 'Light' : 'Dark'}
              </button>
            </div>
          </header>

          <main>
            {error && (
              <div className="view-banner">
                <ErrorBanner message={error} onDismiss={() => setError('')} />
              </div>
            )}

            {/* Views stay mounted (hidden) so queued photos and benchmark results survive navigation. */}
            <section className={`view ${view === 'dashboard' ? 'active' : ''}`} aria-label="Dashboard">
              <DashboardView
                inspections={inspections}
                stats={stats}
                connected={connected}
                pipelineIndex={pipelineIndex}
                onOpenInspection={openInspection}
                onNavigate={goTo}
              />
            </section>
            <section className={`view ${view === 'scanner' ? 'active' : ''}`} aria-label="Receiving inspection">
              <ScannerView
                poForm={poForm}
                setPoForm={setPoForm}
                inspection={inspection}
                setInspection={setInspection}
                analysis={analysis}
                setAnalysis={setAnalysis}
                demoMode={demoMode}
                setDemoMode={setDemoMode}
                onChanged={refreshInspections}
                onError={setError}
                onBusyChange={handleScannerBusy}
                onOpenBenchmark={() => goTo('benchmark')}
              />
            </section>
            <section className={`view ${view === 'ledger' ? 'active' : ''}`} aria-label="Inspections">
              <LedgerView
                inspections={inspections}
                loading={loadingList}
                connected={connected}
                onRefresh={refreshInspections}
                onOpenInspection={openInspection}
              />
            </section>
            <section className={`view ${view === 'benchmark' ? 'active' : ''}`} aria-label="Scenario benchmark">
              <BenchmarkView
                poForm={poForm}
                demoMode={demoMode}
                setDemoMode={setDemoMode}
                onChanged={refreshInspections}
                onOpenInspection={openInspection}
              />
            </section>
            <section className={`view ${view === 'rules' ? 'active' : ''}`} aria-label="Receiving rules">
              <RulesView />
            </section>
          </main>
        </div>
      </div>
    </>
  );
}
