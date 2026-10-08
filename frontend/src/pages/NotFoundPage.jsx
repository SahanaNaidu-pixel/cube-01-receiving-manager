/*
 * NotFoundPage — unknown #/app/<page> or a detail route with the wrong number of segments.
 */
import { EmptyState, Link, PageHeader } from '../components/ui';

export default function NotFoundPage({ route }) {
  return (
    <div className="stack">
      <PageHeader title="Page not found" subtitle={`Nothing is registered at #${route.path}.`} />
      <section className="card">
        <EmptyState
          icon="alert"
          title="This link does not match a page"
          message="It may be mistyped, or point at a record id that is missing a segment."
          action={<Link to="dashboard" className="btn-primary">Go to the dashboard</Link>}
        />
      </section>
    </div>
  );
}
