/*
 * ReviewDetailPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Decide PASS / FAIL / UNCERTAIN, request evidence, assign, notes.
 * Props: { route } from useRoute() — route.params holds the decoded id segment(s).
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function ReviewDetailPage({ route }) {
  const id = route.params.join(' / ');
  return (
    <div className="stack">
      <PageHeader
        title={`Review task ${id}`}
        subtitle="Decide PASS / FAIL / UNCERTAIN, request evidence, assign, notes."
        breadcrumbs={[{ label: 'Review queue', to: 'reviews' }, { label: id }]}
      />
      <UnderConstruction endpoints={['GET /api/reviews/{id}', 'POST /decision', 'POST /request-evidence']} />
    </div>
  );
}
