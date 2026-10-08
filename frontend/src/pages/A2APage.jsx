/*
 * A2APage — the A2A Integration console.
 *   ?tab=console     composer: any operation, sender presets, editable ids/payload, images → base64, curl
 *   ?tab=demo        guided demo: discover → agent.ping → receiving.inspect → receiving.verify_record
 *   ?tab=card        live agent card (authenticated + public discovery) with operation schemas
 *   ?tab=regression  scenario regression (demo mode only; GET /health demo_mode gate)
 * Every request is real (POST /api/agent/receive etc.); nothing on this page is simulated client-side.
 */
import { getHealth } from '../services/api';
import { useAsync } from '../hooks/useAsync';
import { useApp } from '../context/AppContext';
import { setQuery } from '../lib/router';
import { Card, ConnectPrompt, Icon, Link, PageHeader, StatusBadge, Tabs } from '../components/ui';
import { AgentCardPanel, cardOf, loadAgentCards } from './ops/a2aCard';
import { A2AComposer } from './ops/a2aConsole';
import { GuidedDemo } from './ops/a2aDemo';
import { ScenarioRegression } from './ops/a2aRegression';
import '../styles/ops.css';

const TABS = ['console', 'demo', 'card', 'regression'];

export default function A2APage({ route }) {
  const tab = TABS.includes(route.query.tab) ? route.query.tab : 'console';
  const { hasKey, connectionVersion } = useApp();
  // useAsync, not useApi: the public discovery card loads even without a key (the authenticated one then shows 401).
  const cards = useAsync(loadAgentCards, [connectionVersion]);
  const health = useAsync(() => getHealth(), []);
  const card = cardOf(cards.data);
  const demoMode = health.data?.demo_mode === true;

  if (!hasKey && tab !== 'card') {
    return (
      <div className="stack">
        <PageHeader title="A2A integration" subtitle="Talk to the Receiving Manager exactly as another CUBE agent does (cube.a2a.v1)." icon="link" />
        <Card><ConnectPrompt /></Card>
        <p className="hint">Discovery is public: <Link to="a2a" query={{ tab: 'card' }}>view the agent card without a key</Link>.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHeader
        title="A2A integration"
        subtitle="Talk to the Receiving Manager exactly as another CUBE agent does: cube.a2a.v1 envelopes to POST /api/agent/receive with an API key."
        icon="link"
        actions={(
          <>
            {card && <StatusBadge status={card.status?.ready ? 'healthy' : 'unavailable'} label={`${card.agent_id} v${card.version} · ${card.status?.vision_provider || 'vision ?'}`} />}
            {health.data && <StatusBadge status={demoMode ? 'demo' : 'live'} tone={demoMode ? 'hold' : 'success'} label={demoMode ? 'DEMO_MODE on' : 'Live mode'} />}
            <Link to="agent-activity" className="btn-theme"><Icon name="activity" size={14} /> Agent activity</Link>
          </>
        )}
      />
      <Tabs
        idPrefix="a2a"
        active={tab}
        onChange={(key) => setQuery({ tab: key, from: null })}
        tabs={[
          { key: 'console', label: 'Message console' },
          { key: 'demo', label: 'Guided demo' },
          { key: 'card', label: 'Agent card', count: card?.operations?.length },
          { key: 'regression', label: 'Scenario regression (demo mode only)' },
        ]}
      />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`a2a-${tab}`}>
        {tab === 'console' && <A2AComposer card={card} demoMode={demoMode} fromRequestId={route.query.from} />}
        {tab === 'demo' && <GuidedDemo demoMode={demoMode} />}
        {tab === 'card' && <AgentCardPanel cards={cards.data} loading={cards.loading} error={cards.error} reload={cards.reload} />}
        {tab === 'regression' && <ScenarioRegression health={health.data} healthError={health.error} onHealth={(h) => health.setData(h)} />}
      </div>
    </div>
  );
}
