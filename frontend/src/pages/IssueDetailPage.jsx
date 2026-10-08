/*
 * IssueDetailPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Start review, resolve, reopen, assign, notes and linked evidence.
 * Props: { route } from useRoute() — route.params holds the decoded id segment(s).
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function IssueDetailPage({ route }) {
  const id = route.params.join(' / ');
  return (
    <div className="stack">
      <PageHeader
        title={`Issue ${id}`}
        subtitle="Start review, resolve, reopen, assign, notes and linked evidence."
        breadcrumbs={[{ label: 'Exceptions', to: 'exceptions' }, { label: id }]}
      />
      <UnderConstruction endpoints={['GET /api/issues/{id}', 'POST /actions', 'POST /notes', 'POST /evidence']} />
    </div>
  );
}
