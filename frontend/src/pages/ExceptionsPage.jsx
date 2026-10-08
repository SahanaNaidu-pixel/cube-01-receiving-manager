/*
 * ExceptionsPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Open issues raised by failed or uncertain checks.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function ExceptionsPage() {
  return (
    <div className="stack">
      <PageHeader
        title="Exceptions"
        subtitle="Open issues raised by failed or uncertain checks."
      />
      <UnderConstruction endpoints={['GET /api/issues']} />
    </div>
  );
}
