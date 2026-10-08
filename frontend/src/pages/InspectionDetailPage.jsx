/*
 * InspectionDetailPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Checks, evidence, issues, review tasks, notes, audit, export and hand-off.
 * Props: { route } from useRoute() — route.params holds the decoded id segment(s).
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function InspectionDetailPage({ route }) {
  const id = route.params.join(' / ');
  return (
    <div className="stack">
      <PageHeader
        title={`Inspection ${id}`}
        subtitle="Checks, evidence, issues, review tasks, notes, audit, export and hand-off."
        breadcrumbs={[{ label: 'Inspections', to: 'inspections' }, { label: id }]}
      />
      <UnderConstruction endpoints={['GET /api/inspections/{id}', 'POST /run', 'POST /notes', 'POST /handoff', 'GET /export', 'GET /audit']} />
    </div>
  );
}
