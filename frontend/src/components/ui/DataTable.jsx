/*
 * DataTable — config-driven table with server-side sorting via callbacks.
 *
 *   <DataTable
 *     columns={[
 *       { key: 'inspection_id', header: 'Inspection', sortable: true, render: (row) => <Link…/> },
 *       { key: 'verdict', header: 'Verdict', render: (row) => <VerdictBadge verdict={row.verdict} /> },
 *       { key: 'created_at', header: 'Created', sortable: true, align: 'right', render: (r) => formatDateTime(r.created_at) },
 *     ]}
 *     rows={data?.items} rowKey="inspection_id"            // string field name or (row) => key
 *     onRowClick={(row) => navigate(pathFor('inspections', row.inspection_id))}
 *     sort={{ key: query.sort, order: query.order }}      // current sort (optional)
 *     onSortChange={(key, order) => setQuery({ sort: key, order })}
 *     loading={loading} error={error} onRetry={reload}
 *     empty={{ title: 'No inspections', message: 'Try widening the date range.', action: <…/> }}
 *   />
 *
 * Column fields: key, header, render(row, index), sortable, sortKey (API sort name, defaults to key),
 * align ('left'|'right'|'center'), width, className, mono (monospace cell).
 * Without render the cell shows row[key] ('—' when empty). Rows are keyboard-activatable when clickable.
 * While loading with no rows, skeleton rows are shown; with rows, they stay visible under a dimmed overlay.
 */
import { Icon } from '../Shared';
import { EmptyState, ErrorState } from './States';

const cellValue = (row, column) => {
  const value = row?.[column.key];
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export default function DataTable({
  columns,
  rows,
  rowKey = 'id',
  onRowClick,
  sort,
  onSortChange,
  loading = false,
  error = null,
  onRetry,
  empty = {},
  skeletonRows = 6,
  caption,
  bordered = false,
}) {
  const list = Array.isArray(rows) ? rows : [];
  const keyOf = (row, index) => (typeof rowKey === 'function' ? rowKey(row, index) : row?.[rowKey]) ?? index;

  const toggleSort = (column) => {
    if (!onSortChange) return;
    const sortKey = column.sortKey || column.key;
    const order = sort?.key === sortKey && sort?.order !== 'asc' ? 'asc' : 'desc';
    onSortChange(sortKey, order);
  };

  if (error && list.length === 0) return <ErrorState error={error} onRetry={onRetry} title="Could not load data" />;

  return (
    <div className={`table-wrapper ui-table-wrapper ${bordered ? 'bordered' : ''} ${loading && list.length ? 'is-refreshing' : ''}`} aria-busy={loading}>
      {error && list.length > 0 && (
        <div className="ui-table-error"><ErrorState error={error} onRetry={onRetry} title="Refresh failed — showing the previous results" compact /></div>
      )}
      <table className="data-table ui-data-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => {
              const sortKey = column.sortKey || column.key;
              const active = sort?.key === sortKey;
              const ariaSort = active ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined;
              return (
                <th key={column.key} style={{ width: column.width, textAlign: column.align }} aria-sort={ariaSort} scope="col">
                  {column.sortable && onSortChange ? (
                    <button type="button" className={`ui-sort-btn ${active ? 'active' : ''}`} onClick={() => toggleSort(column)}>
                      {column.header}
                      <Icon name={active && sort.order === 'asc' ? 'chevronUp' : 'chevronDown'} size={12} />
                    </button>
                  ) : column.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && list.length === 0 && Array.from({ length: skeletonRows }, (_, index) => (
            <tr key={`sk-${index}`} className="ui-skeleton-row">
              {columns.map((column) => <td key={column.key}><span className="ui-skeleton" /></td>)}
            </tr>
          ))}
          {!loading && list.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="ui-empty-cell">
                <EmptyState icon={empty.icon || 'inbox'} title={empty.title || 'Nothing to show'} message={empty.message} action={empty.action} compact />
              </td>
            </tr>
          )}
          {list.map((row, index) => (
            <tr
              key={keyOf(row, index)}
              className={onRowClick ? 'ui-row-clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (event) => {
                if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                  event.preventDefault();
                  onRowClick(row);
                }
              } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((column) => (
                <td key={column.key} className={`${column.mono ? 'mono' : ''} ${column.className || ''}`} style={{ textAlign: column.align }}>
                  {column.render ? column.render(row, index) : cellValue(row, column)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
