/*
 * ShipmentsPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Shipments derived from inspection intake, with verdict counts.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function ShipmentsPage() {
  return (
    <div className="stack">
      <PageHeader
        title="Shipments"
        subtitle="Shipments derived from inspection intake, with verdict counts."
      />
      <UnderConstruction endpoints={['GET /api/shipments']} />
    </div>
  );
}
