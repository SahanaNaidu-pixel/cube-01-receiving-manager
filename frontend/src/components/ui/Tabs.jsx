/*
 * Tabs — accessible tablist (arrow keys move between tabs). The caller renders the active panel.
 *   const tab = route.query.tab || 'overview';
 *   <Tabs
 *     tabs={[{ key: 'overview', label: 'Overview' }, { key: 'issues', label: 'Issues', count: issues.length }]}
 *     active={tab}
 *     onChange={(key) => setQuery({ tab: key })}       // keep the tab in the URL so it is linkable
 *   />
 *   <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>…</div>
 */
import { useRef } from 'react';

export default function Tabs({ tabs = [], active, onChange, idPrefix = 'tab' }) {
  const refs = useRef({});
  const onKeyDown = (event, index) => {
    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    onChange(tab.key);
    refs.current[tab.key]?.focus();
  };
  return (
    <div className="ui-tabs" role="tablist">
      {tabs.map((tab, index) => (
        <button
          key={tab.key}
          ref={(el) => { refs.current[tab.key] = el; }}
          id={`${idPrefix}-${tab.key}`}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          aria-controls={`panel-${tab.key}`}
          tabIndex={active === tab.key ? 0 : -1}
          className={`ui-tab ${active === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
          onKeyDown={(event) => onKeyDown(event, index)}
          disabled={tab.disabled}
        >
          {tab.label}
          {tab.count !== undefined && tab.count !== null && <span className="nav-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
