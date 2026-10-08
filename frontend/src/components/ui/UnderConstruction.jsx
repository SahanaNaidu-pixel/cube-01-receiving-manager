/*
 * UnderConstruction — TEMPORARY body for pages that the next build step replaces.
 * Delete its usage when you implement the page. It deliberately shows no data.
 *   <UnderConstruction endpoints={['GET /api/issues', 'GET /api/issues/{id}']} />
 */
import { Icon } from '../Shared';

export default function UnderConstruction({ endpoints = [], note }) {
  return (
    <section className="card empty-card">
      <div className="empty-state">
        <Icon name="clock" size={26} />
        <h3>Page under construction by the next build step</h3>
        <p>{note || 'This screen is being implemented on top of the shared shell, API client and component kit.'}</p>
        {endpoints.length > 0 && (
          <p className="hint">Backed by: <span className="mono">{endpoints.join(' · ')}</span></p>
        )}
      </div>
    </section>
  );
}
