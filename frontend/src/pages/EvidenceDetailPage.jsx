/*
 * EvidenceDetailPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Image, readings, linked issues and checks, provenance.
 * Props: { route } from useRoute() — route.params holds the decoded id segment(s).
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function EvidenceDetailPage({ route }) {
  const id = route.params.join(' / ');
  return (
    <div className="stack">
      <PageHeader
        title={`Evidence file ${id}`}
        subtitle="Image, readings, linked issues and checks, provenance."
        breadcrumbs={[{ label: 'Evidence', to: 'evidence' }, { label: id }]}
      />
      <UnderConstruction endpoints={['GET /api/evidence/{image_id}']} />
    </div>
  );
}
