/*
 * ReviewQueuePage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Inspections waiting for a human decision.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function ReviewQueuePage() {
  return (
    <div className="stack">
      <PageHeader
        title="Review queue"
        subtitle="Inspections waiting for a human decision."
      />
      <UnderConstruction endpoints={['GET /api/reviews']} />
    </div>
  );
}
