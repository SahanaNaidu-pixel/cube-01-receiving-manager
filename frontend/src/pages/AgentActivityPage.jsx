/*
 * AgentActivityPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Inbound and outbound A2A messages.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function AgentActivityPage() {
  return (
    <div className="stack">
      <PageHeader
        title="Agent activity"
        subtitle="Inbound and outbound A2A messages."
      />
      <UnderConstruction endpoints={['GET /api/agent/activity']} />
    </div>
  );
}
