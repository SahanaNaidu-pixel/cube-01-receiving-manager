/*
 * CartonsPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Cartons recorded at intake, with condition and observed units.
 * Props: { route } from useRoute() — route.query holds the hash filters.
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function CartonsPage() {
  return (
    <div className="stack">
      <PageHeader
        title="Cartons"
        subtitle="Cartons recorded at intake, with condition and observed units."
      />
      <UnderConstruction endpoints={['GET /api/cartons']} />
    </div>
  );
}
