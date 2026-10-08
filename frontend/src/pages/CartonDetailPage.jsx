/*
 * CartonDetailPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Carton condition, expected vs observed units, evidence.
 * Props: { route } from useRoute() — route.params holds the decoded id segment(s).
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function CartonDetailPage({ route }) {
  const id = route.params.join(' / ');
  return (
    <div className="stack">
      <PageHeader
        title={`Carton ${id}`}
        subtitle="Carton condition, expected vs observed units, evidence."
        breadcrumbs={[{ label: 'Cartons', to: 'cartons' }, { label: id }]}
      />
      <UnderConstruction endpoints={['GET /api/cartons/{inspection_id}/{carton_id}']} />
    </div>
  );
}
