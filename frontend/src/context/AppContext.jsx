/*
 * AppContext — workspace-wide state, read with `useApp()`:
 *
 *   apiKey, hasKey                   current operator key (localStorage) and whether one is set
 *   connection {state, message, error}
 *                                    state: idle | checking | connected | error
 *   connected                        shorthand for state === 'connected'
 *   connectionVersion                increments on every (re)connect / disconnect — useApi() re-fetches on change
 *   principal                        {organization_id, operator_id, role} from /api/system/info
 *   systemInfo                       full /api/system/info body (null until connected)
 *   connect(key) → Promise<boolean>  saves the key, validates it via /api/system/info
 *   disconnect()                     clears the key
 *   ready, readyError, readyCheckedAt, refreshReady()
 *                                    /api/ready body (public, polled every 60 s)
 *   counts {open_reviews, open_issues} | null, refreshCounts()
 *                                    sidebar badges, from GET /api/dashboard?range=all totals
 *                                    — call refreshCounts() after a mutation that changes them
 *   theme, setTheme(t), toggleTheme()
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getApiKey, getDashboard, getReady, getSystemInfo, setApiKey } from '../services/api';

const AppContext = createContext(null);
const THEME_KEY = 'receivingTheme';
const POLL_MS = 60000;

function initialTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* storage blocked */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function connectionMessage(err) {
  if (err.status === 401) return 'Invalid or missing API key (401).';
  if (err.status === 403) return 'This key is not allowed to use the workspace (403).';
  if (err.status === 0) return 'Backend unreachable.';
  return err.message;
}

export function AppProvider({ children }) {
  const [apiKey, setKey] = useState(getApiKey);
  const [connection, setConnection] = useState({ state: 'idle', message: 'Not connected', error: null });
  const [connectionVersion, setConnectionVersion] = useState(0);
  // The key pages fetched with on their last load (on first render: the stored key) and whether it worked.
  const loadedWith = useRef({ key: getApiKey(), ok: true });
  const [systemInfo, setSystemInfo] = useState(null);
  const [ready, setReady] = useState(null);
  const [readyError, setReadyError] = useState(null);
  const [readyCheckedAt, setReadyCheckedAt] = useState(null);
  const [counts, setCounts] = useState(null);
  const [theme, setThemeState] = useState(initialTheme);
  const connectSeq = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage blocked */ }
  }, [theme]);

  const setTheme = useCallback((value) => setThemeState(value === 'dark' ? 'dark' : 'light'), []);
  const toggleTheme = useCallback(() => setThemeState((value) => (value === 'dark' ? 'light' : 'dark')), []);

  const refreshReady = useCallback(async () => {
    try {
      const body = await getReady();
      setReady(body);
      setReadyError(null);
    } catch (err) {
      setReady(null);
      setReadyError(err);
    } finally {
      setReadyCheckedAt(new Date().toISOString());
    }
  }, []);

  const refreshCounts = useCallback(async () => {
    if (!getApiKey()) { setCounts(null); return; }
    try {
      const body = await getDashboard({ range: 'all' });
      setCounts({
        open_reviews: body?.totals?.open_reviews ?? null,
        open_issues: body?.totals?.open_issues ?? null,
      });
    } catch {
      setCounts(null); // badges are hidden rather than showing a stale or invented number
    }
  }, []);

  const connect = useCallback(async (key) => {
    const value = String(key || '').trim();
    const seq = ++connectSeq.current;
    setApiKey(value);
    setKey(value);
    if (!value) {
      setConnection({ state: 'idle', message: 'Not connected', error: null });
      setSystemInfo(null);
      setCounts(null);
      setConnectionVersion((v) => v + 1);
      loadedWith.current = { key: '', ok: false };
      return false;
    }
    setConnection({ state: 'checking', message: 'Connecting…', error: null });
    try {
      const info = await getSystemInfo();
      if (seq !== connectSeq.current) return false;
      setSystemInfo(info);
      const who = info?.principal?.operator_id ? ` · ${info.principal.operator_id}` : '';
      setConnection({ state: 'connected', message: `Connected${who}`, error: null });
      // Pages already loaded with this key; re-fetching anyway would reset forms seeded from their data.
      if (value !== loadedWith.current.key || !loadedWith.current.ok) setConnectionVersion((v) => v + 1);
      loadedWith.current = { key: value, ok: true };
      refreshCounts();
      return true;
    } catch (err) {
      if (seq !== connectSeq.current) return false;
      setSystemInfo(null);
      setCounts(null);
      setConnection({ state: 'error', message: connectionMessage(err), error: err });
      setConnectionVersion((v) => v + 1);
      loadedWith.current = { key: value, ok: false };
      return false;
    }
  }, [refreshCounts]);

  const disconnect = useCallback(() => { connect(''); }, [connect]);

  // Initial readiness check + reconnect with a stored key.
  useEffect(() => {
    refreshReady();
    const stored = getApiKey();
    if (stored) connect(stored);
  }, [refreshReady, connect]);

  // Real polling: readiness and badge counts refresh every minute while the tab is visible.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      refreshReady();
      if (connection.state === 'connected') refreshCounts();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refreshReady, refreshCounts, connection.state]);

  const value = useMemo(() => ({
    apiKey,
    hasKey: Boolean(apiKey),
    connection,
    connected: connection.state === 'connected',
    connectionVersion,
    principal: systemInfo?.principal || null,
    systemInfo,
    connect,
    disconnect,
    ready,
    readyError,
    readyCheckedAt,
    refreshReady,
    counts,
    refreshCounts,
    theme,
    setTheme,
    toggleTheme,
  }), [apiKey, connection, connectionVersion, systemInfo, connect, disconnect, ready, readyError, readyCheckedAt,
    refreshReady, counts, refreshCounts, theme, setTheme, toggleTheme]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp() must be used inside <AppProvider>.');
  return value;
}
