/*
 * InspectionsPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Every receiving inspection — search, filter by verdict, supplier, PO, date.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function InspectionsPage() {
  return (
    <div className="stack">
      <PageHeader
        title="Inspections"
        subtitle="Every receiving inspection — search, filter by verdict, supplier, PO, date."
      />
      <UnderConstruction endpoints={['GET /api/inspections']} />
    </div>
  );
}
