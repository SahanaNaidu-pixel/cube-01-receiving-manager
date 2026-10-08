/*
 * PageHeader — title block at the top of every page.
 *   <PageHeader
 *     title="Inspections" subtitle="Every receiving inspection in your organisation"
 *     breadcrumbs={[{ label: 'Inspections', to: 'inspections' }, { label: id }]}
 *     actions={<AsyncButton …/>}
 *   />
 * The topbar already shows the section name; PageHeader carries the page-specific title, context and actions.
 */
import Link from './Link';
import { Icon } from '../Shared';

export default function PageHeader({ title, subtitle, actions, breadcrumbs, icon }) {
  return (
    <div className="ui-page-header">
      <div className="ui-page-header-main">
        {breadcrumbs?.length > 0 && (
          <nav className="ui-breadcrumbs" aria-label="Breadcrumb">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} className="ui-breadcrumb">
                {index > 0 && <Icon name="chevronRight" size={12} />}
                {crumb.to ? <Link to={crumb.to} query={crumb.query}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <h2 className="ui-page-title">
          {icon && <Icon name={icon} size={20} />}
          <span>{title}</span>
        </h2>
        {subtitle && <p className="ui-page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="ui-page-actions">{actions}</div>}
    </div>
  );
}
