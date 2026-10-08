/*
 * A2APage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Agent card and a console that sends real cube.a2a.v1 envelopes.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function A2APage() {
  return (
    <div className="stack">
      <PageHeader
        title="A2A integration"
        subtitle="Agent card and a console that sends real cube.a2a.v1 envelopes."
      />
      <UnderConstruction endpoints={['GET /api/agent/capabilities', 'POST /api/agent/receive']} />
    </div>
  );
}
