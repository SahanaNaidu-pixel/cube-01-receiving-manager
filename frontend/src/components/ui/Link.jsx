/*
 * Link — a real <a href="#/…"> for in-app navigation (middle-click / copy link work).
 *   <Link to="inspections" query={{ verdict: 'FAIL' }}>Failed</Link>
 *   <Link to={pathFor('inspections', id)} className="link mono">{id}</Link>
 * `to` accepts the same forms as navigate(): '/app/x', 'x' (shorthand for /app/x) or '/'.
 * Clicks inside a clickable table row do not also trigger the row handler.
 */
import { buildHref } from '../../lib/router';

export default function Link({ to, query, children, className = 'link', onClick, ...rest }) {
  return (
    <a
      href={buildHref(to, query)}
      className={className}
      onClick={(event) => { event.stopPropagation(); onClick?.(event); }}
      {...rest}
    >
      {children}
    </a>
  );
}
