/*
 * AgentActivityDetailPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Request and response envelopes for one A2A exchange.
 * Props: { route } from useRoute() — route.params holds the decoded id segment(s).
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function AgentActivityDetailPage({ route }) {
  const id = route.params.join(' / ');
  return (
    <div className="stack">
      <PageHeader
        title={`Agent message ${id}`}
        subtitle="Request and response envelopes for one A2A exchange."
        breadcrumbs={[{ label: 'Agent activity', to: 'agent-activity' }, { label: id }]}
      />
      <UnderConstruction endpoints={['GET /api/agent/activity/{request_id}']} />
    </div>
  );
}
