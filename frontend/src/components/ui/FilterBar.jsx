/*
 * FilterBar — search box, select filters and a date-range preset picker, all controlled.
 * Usually bound to the hash query so filters are shareable/deep-linkable:
 *
 *   const route = useRoute();
 *   <FilterBar
 *     search={{ value: route.query.q, placeholder: 'Search PO, SKU, supplier…', onChange: (q) => setQuery({ q, page: 1 }) }}
 *     selects={[
 *       { key: 'verdict', label: 'Verdict', value: route.query.verdict,
 *         options: [{ value: 'PASS', label: 'Pass' }, { value: 'FAIL', label: 'Fail' }],
 *         onChange: (verdict) => setQuery({ verdict, page: 1 }) },
 *     ]}
 *     dateRange={{ value: route.query, onChange: (patch) => setQuery({ ...patch, page: 1 }) }}
 *     onReset={() => navigate('inspections')}
 *     resultCount={data?.total}
 *   >{extra controls}</FilterBar>
 *
 * search.onChange is debounced (350 ms) and fires on Enter immediately.
 * dateRange.value reads {range, date_from, date_to}; onChange receives a patch with those three keys
 * (presets clear the custom dates; 'custom' shows two date inputs). Each select has an "All" option (value '').
 */
import { useEffect, useRef, useState } from 'react';
import { RANGE_OPTIONS } from '../../lib/format';
import { Icon } from '../Shared';

function SearchInput({ value = '', placeholder = 'Search…', onChange, delay = 350 }) {
  const [text, setText] = useState(value || '');
  const timer = useRef(null);
  const lastSent = useRef(value || '');

  useEffect(() => {
    // External changes (back button, reset) win over the local draft.
    if ((value || '') !== lastSent.current) {
      lastSent.current = value || '';
      setText(value || '');
    }
  }, [value]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const send = (next) => {
    window.clearTimeout(timer.current);
    if (next === lastSent.current) return;
    lastSent.current = next;
    onChange(next);
  };

  return (
    <label className="ui-search">
      <Icon name="search" size={15} />
      <span className="sr-only">{placeholder}</span>
      <input
        type="search"
        className="filter-input"
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => send(next.trim()), delay);
        }}
        onKeyDown={(event) => { if (event.key === 'Enter') send(text.trim()); }}
      />
    </label>
  );
}

export function DateRangePicker({ value = {}, onChange, options = RANGE_OPTIONS, includeAll = true }) {
  const range = value.range || (value.date_from || value.date_to ? 'custom' : (includeAll ? 'all' : '7d'));
  const choices = includeAll ? options : options.filter((option) => option.value !== 'all');
  return (
    <div className="ui-date-range">
      <div className="segmented-control" role="group" aria-label="Date range">
        {choices.map((option) => (
          <button
            key={option.value}
            type="button"
            className={range === option.value ? 'active' : ''}
            aria-pressed={range === option.value}
            onClick={() => onChange(option.value === 'custom'
              ? { range: 'custom', date_from: value.date_from || '', date_to: value.date_to || '' }
              : { range: option.value === 'all' ? '' : option.value, date_from: '', date_to: '' })}
          >
            {option.label}
          </button>
        ))}
      </div>
      {range === 'custom' && (
        <div className="ui-date-inputs">
          <label>
            <span className="sr-only">From date</span>
            <input type="date" className="filter-input" value={value.date_from || ''} max={value.date_to || undefined}
              onChange={(event) => onChange({ range: 'custom', date_from: event.target.value, date_to: value.date_to || '' })} />
          </label>
          <span className="hint">to</span>
          <label>
            <span className="sr-only">To date</span>
            <input type="date" className="filter-input" value={value.date_to || ''} min={value.date_from || undefined}
              onChange={(event) => onChange({ range: 'custom', date_from: value.date_from || '', date_to: event.target.value })} />
          </label>
        </div>
      )}
    </div>
  );
}

export default function FilterBar({ search, selects = [], dateRange, onReset, resultCount, children }) {
  return (
    <div className="filter-bar ui-filter-bar">
      {search && <SearchInput {...search} />}
      {selects.map((select) => (
        <label key={select.key} className="ui-select">
          <span className="sr-only">{select.label}</span>
          <select
            className="filter-select"
            value={select.value || ''}
            onChange={(event) => select.onChange(event.target.value)}
            aria-label={select.label}
          >
            <option value="">{select.allLabel || `All ${select.label.toLowerCase()}`}</option>
            {select.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      ))}
      {dateRange && <DateRangePicker {...dateRange} />}
      {children}
      {(onReset || resultCount !== undefined) && (
        <div className="ui-filter-tail">
          {resultCount !== undefined && resultCount !== null && <span className="filter-count">{Number(resultCount).toLocaleString()} result(s)</span>}
          {onReset && <button type="button" className="detail-btn" onClick={onReset}>Reset filters</button>}
        </div>
      )}
    </div>
  );
}
