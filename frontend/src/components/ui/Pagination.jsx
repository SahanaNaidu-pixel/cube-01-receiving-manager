/*
 * Pagination — for the API's {items, total, page, page_size} lists.
 *   <Pagination page={data.page} pageSize={data.page_size} total={data.total}
 *               onPageChange={(p) => setQuery({ page: p })}
 *               onPageSizeChange={(s) => setQuery({ page_size: s, page: 1 })} />
 * Renders nothing when total is unknown.
 */
import { Icon } from '../Shared';

export default function Pagination({ page = 1, pageSize = 25, total, onPageChange, onPageSizeChange, pageSizeOptions = [25, 50, 100, 200] }) {
  if (total === undefined || total === null) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="ui-pagination">
      <span className="ui-pagination-info">{from}–{to} of {Number(total).toLocaleString()}</span>
      <div className="ui-pagination-controls">
        {onPageSizeChange && (
          <label className="ui-pagination-size">
            <span className="sr-only">Rows per page</span>
            <select className="filter-select" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
              {pageSizeOptions.map((size) => <option key={size} value={size}>{size} / page</option>)}
            </select>
          </label>
        )}
        <button type="button" className="detail-btn" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className="ui-pagination-page">Page {page} of {pages}</span>
        <button type="button" className="detail-btn" onClick={() => onPageChange(page + 1)} disabled={page >= pages} aria-label="Next page">
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
    </div>
  );
}
