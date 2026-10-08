/*
 * App root: providers → router → landing page (#/) or workspace shell (#/app/…).
 * Pages are registered in routes.js; see src/README.md.
 */
import { Suspense, useEffect } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { ToastProvider } from './components/ui/Toast';
import { LoadingState } from './components/ui/States';
import AppShell, { readinessSummary } from './components/AppShell';
import LandingPage from './components/LandingPage';
import { canonicalizeHash, navigate, useRoute } from './lib/router';
import { resolveRoute } from './routes';
import { useShortcuts } from './hooks/useShortcuts';

function Root() {
  const route = useRoute();
  const { ready, readyError, theme, toggleTheme } = useApp();
  const resolved = route.area === 'app' ? resolveRoute(route) : null;

  // Old hashes (#/app/scanner, #/app/ledger, #/app/benchmark, #/app/rules, …) are rewritten to their new pages.
  useEffect(() => { if (route.aliased) canonicalizeHash(); }, [route]);

  useEffect(() => {
    document.title = resolved ? `${resolved.title} · Receiving Manager` : 'Receiving Manager';
  }, [resolved?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  useShortcuts(route.area === 'app');

  if (route.area === 'landing') {
    const readiness = readinessSummary(ready, readyError);
    const health = { ok: readiness.tone === '' ? null : readiness.tone !== 'error', text: readiness.text };
    return (
      <div id="publicPagesContainer" className="page-view active">
        <LandingPage theme={theme} onToggleTheme={toggleTheme} onOpenApp={(key) => navigate(key)} health={health} />
      </div>
    );
  }

  const Page = resolved.component;
  return (
    <AppShell route={route} navKey={resolved.navKey} title={resolved.title}>
      <Suspense fallback={<LoadingState label="Loading page…" />}>
        <Page key={route.path} route={route} />
      </Suspense>
    </AppShell>
  );
}

export default function App() {
  return (
    <AppProvider>
      <ToastProvider>
        <Root />
      </ToastProvider>
    </AppProvider>
  );
}
