/*
 * AuditPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Append-only log of every mutation.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function AuditPage() {
  return (
    <div className="stack">
      <PageHeader
        title="Audit trail"
        subtitle="Append-only log of every mutation."
      />
      <UnderConstruction endpoints={['GET /api/audit']} />
    </div>
  );
}
