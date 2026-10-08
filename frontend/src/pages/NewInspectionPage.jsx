/*
 * NewInspectionPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * PO line, shipment, cartons, photos, manual observations, run.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function NewInspectionPage() {
  return (
    <div className="stack">
      <PageHeader
        title="New inspection"
        subtitle="PO line, shipment, cartons, photos, manual observations, run."
      />
      <UnderConstruction endpoints={['POST /api/inspections', 'POST /images', 'POST /run']} />
    </div>
  );
}
