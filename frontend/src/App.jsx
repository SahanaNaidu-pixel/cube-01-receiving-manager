import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApiKey, getHealth, getInspection, listInspections, setApiKey } from './services/api';
import { PO_PRESETS, effectiveDecision, failedCategories, isAnalyzed } from './constants';
import { poToForm } from './components/PoEditor';
import { ErrorBanner, Icon } from './components/Shared';
import ScannerView from './components/ScannerView';
import BenchmarkView from './components/BenchmarkView';
import LedgerView from './components/LedgerView';
import RulesView from './components/RulesView';

const VIEWS = [
  { key: 'scanner', group: 'Receiving', label: 'Receiving Inspection', icon: 'scan', subtitle: 'Inspect a supplier delivery against its purchase order line' },
  { key: 'ledger', group: 'Receiving', label: 'Inspections', icon: 'list', subtitle: 'Inspection history, decisions and sealed evidence records' },
  { key: 'benchmark', group: 'Quality', label: 'Scenario Benchmark', icon: 'gauge', subtitle: 'Run every demo scenario and score the agent against expected outcomes' },
  { key: 'rules', group: 'Quality', label: 'Receiving Rules', icon: 'book', subtitle: 'How the agent decides, holds and records' },
];
const GROUPS = [...new Set(VIEWS.map((item) => item.group))];
const THEME_KEY = 'receivingTheme';
const AUTO_REFRESH_MS = 20000;

function initialTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* storage blocked */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const [view, setView] = useState('scanner');
  const [error, setError] = useState('');
  const [keyInput, setKeyInput] = useState(getApiKey);
  const [connection, setConnection] = useState({ state: 'idle', message: 'Not connected' });
  const [health, setHealth] = useState({ ok: null, text: 'Backend: checking…', info: null });
  const [inspections, setInspections] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [demoMode, setDemoMode] = useState(null);
  const [theme, setTheme] = useState(initialTheme);
  const [navOpen, setNavOpen] = useState(false);

  const [poForm, setPoForm] = useState(() => poToForm(PO_PRESETS[0]));
  const [inspection, setInspection] = useState(null);
  const [analysis, setAnalysis] = useState(null);

  const connected = connection.state === 'connected';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage blocked */ }
  }, [theme]);

  const checkHealth = useCallback(async () => {
    try {
      const result = await getHealth();
      setHealth({ ok: true, text: `Backend: ${result.status || 'ok'}`, info: result });
      // Older backends omit mode; analyze responses still update it later.
      if (result.mode === 'demo' || result.mode === 'live') setDemoMode(result.mode === 'demo');
    } catch (err) {
      setHealth({ ok: false, text: `Backend: ${err.status ? `error ${err.status}` : 'unreachable'}`, info: null });
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

  // Auto-refresh the inspections list while connected and the tab is visible; skip while a run is busy.
  const busyRef = useRef({});
  const setBusy = useCallback((key, value) => { busyRef.current[key] = value; }, []);
  const scannerBusy = useCallback((value) => setBusy('scanner', value), [setBusy]);
  const benchmarkBusy = useCallback((value) => setBusy('benchmark', value), [setBusy]);
  useEffect(() => {
    if (!connected) return undefined;
    let last = Date.now();
    const tick = (force) => {
      if (document.visibilityState !== 'visible' || Object.values(busyRef.current).some(Boolean)) return;
      if (!force && Date.now() - last < AUTO_REFRESH_MS - 500) return;
      last = Date.now();
      listInspections().then((result) => setInspections(result.items || [])).catch(() => { /* next tick retries */ });
    };
    const timer = setInterval(() => tick(false), AUTO_REFRESH_MS);
    const onVisible = () => { if (Date.now() - last >= AUTO_REFRESH_MS) tick(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [connected]);

  const goTo = (key) => { setView(key); setNavOpen(false); };

  const openInspection = async (id) => {
    setError('');
    try {
      const loaded = await getInspection(id);
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

  const kpi = (value) => (connected ? value : '—');
  const kpis = [
    { label: 'Inspections', value: kpi(stats.total), note: `${kpi(stats.counts.NOT_ANALYZED)} not inspected yet`, icon: 'truck', tone: 'primary' },
    { label: 'Passed', value: kpi(stats.counts.PASS), note: 'Accepted to stock', icon: 'check', tone: 'success' },
    { label: 'Exceptions', value: kpi(stats.counts.EXCEPTION), note: 'Discrepancy or damage found', icon: 'alert', tone: 'danger' },
    { label: 'Uncertain', value: kpi(stats.counts.UNCERTAIN), note: 'Evidence insufficient', icon: 'eye', tone: 'warning' },
    { label: 'Pending · Hold', value: kpi(stats.counts.PENDING_REVIEW), note: 'Fail-open hold for review', icon: 'clock', tone: 'hold' },
    { label: 'Over/Short', value: kpi(stats.categories['Over/Short'] || 0), note: 'Count failed vs PO', icon: 'ruler', tone: 'danger' },
    { label: 'Damaged', value: kpi(stats.categories.Damaged || 0), note: 'Visible damage found', icon: 'box', tone: 'danger' },
    { label: 'Photos captured', value: kpi(stats.images), note: 'Across all inspections', icon: 'image', tone: 'primary' },
  ];

  const current = VIEWS.find((item) => item.key === view) || VIEWS[0];
  const healthTone = health.ok === null ? 'idle' : health.ok ? 'connected' : 'error';
  const info = health.info;
  const modeText = demoMode === null ? 'Mode unknown' : demoMode ? 'Demo' : `Live${info?.model ? ` · ${info.model}` : ''}`;
  const modeTone = demoMode === null ? 'idle' : demoMode ? 'checking' : 'connected';
  const noAiKey = info?.mode === 'live' && info.ai_configured === false;

  return (
    <div className={`app ${navOpen ? 'app--nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar__brand">
          <span className="sidebar__logo"><Icon name="box" size={18} /></span>
          <div>
            <div className="sidebar__name">Receiving Manager</div>
            <div className="sidebar__tag">Pod 01 · Supplier delivery</div>
          </div>
          <button type="button" className="btn btn--ghost btn--icon sidebar__close" onClick={() => setNavOpen(false)} aria-label="Close navigation">
            <Icon name="x" />
          </button>
        </div>

        <nav className="sidebar__nav">
          {GROUPS.map((group) => (
            <div key={group} className="sidebar__group">
              <div className="sidebar__group-label">{group}</div>
              {VIEWS.filter((item) => item.group === group).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  id={`tab-${item.key}`}
                  aria-controls={`panel-${item.key}`}
                  aria-current={view === item.key ? 'page' : undefined}
                  className={`nav-item ${view === item.key ? 'nav-item--active' : ''}`}
                  onClick={() => goTo(item.key)}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {item.key === 'ledger' && connected && <span className="nav-item__count">{stats.total}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar__footer" aria-live="polite">
          <div className="status-row"><span className={`status-dot status-dot--${connection.state}`} />{connection.message}</div>
          <div className="status-row"><span className={`status-dot status-dot--${healthTone}`} />{health.text}</div>
          <div className="status-row">
            <span className={`status-dot status-dot--${demoMode === null ? 'idle' : demoMode ? 'checking' : 'connected'}`} />
            Perception: {modeText}
          </div>
          {typeof info?.barcode_reader === 'boolean' && (
            <div className="status-row">
              <span className={`status-dot status-dot--${info.barcode_reader ? 'connected' : 'idle'}`} />
              Barcode reader: {info.barcode_reader ? 'available' : 'not installed'}
            </div>
          )}
          {typeof info?.image_quality === 'boolean' && (
            <div className="status-row">
              <span className={`status-dot status-dot--${info.image_quality ? 'connected' : 'idle'}`} />
              Photo quality check: {info.image_quality ? 'on' : 'off'}
            </div>
          )}
        </div>
      </aside>
      <div className="sidebar-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <div className="main">
        <header className="topbar">
          <button type="button" className="btn btn--ghost btn--icon topbar__menu" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Icon name="menu" />
          </button>
          <div className="topbar__title">
            <div className="topbar__crumb">Receiving <span aria-hidden="true">/</span> {current.label}</div>
            <h1>{current.label}</h1>
          </div>

          <form className="key-form" onSubmit={(event) => { event.preventDefault(); connect(keyInput); }}>
            <label htmlFor="api-key" className="sr-only">Operator API key</label>
            <div className="input-icon">
              <Icon name="key" size={15} />
              <input
                id="api-key"
                className="input"
                type="password"
                autoComplete="off"
                value={keyInput}
                placeholder="Operator API key"
                onChange={(event) => setKeyInput(event.target.value)}
              />
            </div>
            <button type="submit" className="btn btn--primary" disabled={connection.state === 'checking'}>
              {connection.state === 'checking' ? 'Connecting…' : 'Connect'}
            </button>
            <span className={`conn-chip mode-chip mode-chip--${modeTone}`} title={`Perception mode: ${modeText}`}>
              <span className={`status-dot status-dot--${modeTone}`} />
              <span className="conn-chip__text">{modeText}</span>
            </span>
            <span className={`conn-chip conn-chip--${connection.state}`} title={connection.message}>
              <span className={`status-dot status-dot--${connection.state}`} />
              <span className="conn-chip__text">{connection.message}</span>
            </span>
          </form>

          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </header>

        <main className="content">
          <p className="content__subtitle">{current.subtitle}</p>
          <ErrorBanner message={error} onDismiss={() => setError('')} />
          {noAiKey && (
            <div className="alert alert--warning" role="status">
              <Icon name="alert" />
              <span className="alert__text">Live mode but no OpenAI key is configured on the server — analyses will be held as Pending · Hold.</span>
            </div>
          )}

          <section className="metrics" aria-label="Inspection statistics">
            {kpis.map((item) => (
              <div key={item.label} className={`metric metric--${item.tone}`}>
                <div className="metric__top">
                  <span className="metric__label">{item.label}</span>
                  <span className="metric__icon"><Icon name={item.icon} size={16} /></span>
                </div>
                <strong className="metric__value">{item.value}</strong>
                <span className="metric__note">{connected ? item.note : 'Connect to load'}</span>
              </div>
            ))}
          </section>

          {/* Views stay mounted (hidden) so queued photos and benchmark results survive navigation. */}
          <div role="region" id="panel-scanner" aria-labelledby="tab-scanner" hidden={view !== 'scanner'}>
            <ScannerView
              poForm={poForm}
              setPoForm={setPoForm}
              inspection={inspection}
              setInspection={setInspection}
              analysis={analysis}
              setAnalysis={setAnalysis}
              demoMode={demoMode}
              setDemoMode={setDemoMode}
              serverInfo={info}
              onChanged={refreshInspections}
              onError={setError}
              onOpenBenchmark={() => goTo('benchmark')}
              onBusyChange={scannerBusy}
            />
          </div>
          <div role="region" id="panel-ledger" aria-labelledby="tab-ledger" hidden={view !== 'ledger'}>
            <LedgerView
              inspections={inspections}
              loading={loadingList}
              connected={connected}
              onRefresh={refreshInspections}
              onOpenInspection={openInspection}
            />
          </div>
          <div role="region" id="panel-benchmark" aria-labelledby="tab-benchmark" hidden={view !== 'benchmark'}>
            <BenchmarkView
              poForm={poForm}
              demoMode={demoMode}
              setDemoMode={setDemoMode}
              onChanged={refreshInspections}
              onOpenInspection={openInspection}
              onBusyChange={benchmarkBusy}
            />
          </div>
          <div role="region" id="panel-rules" aria-labelledby="tab-rules" hidden={view !== 'rules'}>
            <RulesView />
          </div>
        </main>
      </div>
    </div>
  );
}
