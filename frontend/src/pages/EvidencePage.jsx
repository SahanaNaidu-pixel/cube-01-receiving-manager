/*
 * EvidencePage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Uploaded photos with provenance, digest and analysis status.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function EvidencePage() {
  return (
    <div className="stack">
      <PageHeader
        title="Evidence"
        subtitle="Uploaded photos with provenance, digest and analysis status."
      />
      <UnderConstruction endpoints={['GET /api/evidence']} />
    </div>
  );
}
