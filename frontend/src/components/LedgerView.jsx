import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  VERDICT_GROUPS, effectiveDecision, failedCategories, formatTime, inspectedAt, shortHash, timeAgo, verdictGroup, viewLabel,
} from '../constants';
import { ChecksTable, DataGate, DecisionPill, EmptyState, EvidenceImage, Icon, Modal, Panel, VerifyIntegrity } from './Shared';

const PAGE_SIZE = 10;
const FILTERS = [{ key: 'all', label: 'All' }, ...VERDICT_GROUPS.map((group) => ({ key: group.key, label: group.label }))];

export function InspectionDetails({ item, onClose, onOpenInspection }) {
  const close = useCallback(() => onClose(), [onClose]);
  return (
    <Modal title={`Inspection ${item.inspection_id}`}
      subtitle={`${item.po?.po_id || '—'} · ${item.po?.product_name || '—'} · created ${formatTime(item.created_at)}`}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn" onClick={close}>Close</button>
          <button type="button" className="btn btn--primary" onClick={() => { close(); onOpenInspection(item.inspection_id); }}>
            <Icon name="scan" size={15} /> Open in workspace
          </button>
        </>
      )}>
      <div className="cell-badges">
        <DecisionPill decision={effectiveDecision(item)} />
        {item.override_decision && <span className="tag tag--accent">Overridden · agent said {item.record?.overrides?.[0]?.from_verdict || item.final_decision}</span>}
        {failedCategories(item).map((category) => <span key={category} className="tag tag--fail">{category}</span>)}
      </div>
      {item.agent_summary && <p>{item.agent_summary}</p>}
      <dl className="meta">
        <div><dt>PO / line</dt><dd>{item.po?.po_id || '—'}{item.po?.po_line ? ` / ${item.po.po_line}` : ''}</dd></div>
        <div><dt>SKU</dt><dd>{item.po?.sku || '—'}</dd></div>
        {item.po?.asin && <div><dt>ASIN</dt><dd>{item.po.asin}</dd></div>}
        <div><dt>Variant</dt><dd>{item.po?.variant || '—'}</dd></div>
        <div><dt>Expected</dt><dd>{item.po?.expected_quantity ?? '—'} units / {item.po?.expected_cartons ?? '—'} cartons</dd></div>
        <div><dt>Verdict recorded</dt><dd>{item.record ? formatTime(inspectedAt(item)) : 'not yet'}</dd></div>
        <div><dt>Record</dt><dd>{item.record ? `v${item.record.version} · ${shortHash(item.record.content_hash)}` : '—'}</dd></div>
      </dl>
      <VerifyIntegrity inspectionId={item.inspection_id} />
      {(item.checks || []).length > 0 && <ChecksTable checks={item.checks} />}
      {(item.images || []).length > 0 && (
        <div className="gallery">
          {item.images.map((image, index) => (
            <figure key={image.image_id} className="shot">
              <EvidenceImage inspectionId={item.inspection_id} imageId={image.image_id} alt={image.filename} />
              <figcaption><b>#{index + 1} {viewLabel(image.image_type)}</b><span>{image.filename}</span></figcaption>
            </figure>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function LedgerView({
  inspections, loading, error, connected, lastSync, onRefresh, onOpenInspection, onConnect, onNewInspection, initialFilter,
}) {
  const [detailId, setDetailId] = useState('');
  const [filter, setFilter] = useState(initialFilter || 'all');
  const [query, setQuery] = useState('');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);
  const known = useRef(null);
  const [fresh, setFresh] = useState(new Set());

  useEffect(() => { if (initialFilter) setFilter(initialFilter); }, [initialFilter]);
  useEffect(() => setPage(1), [filter, query, sortDir]);

  // Rows that appeared since the previous sync flash once (real new records, not decoration).
  useEffect(() => {
    if (!lastSync) return undefined;
    const ids = new Set(inspections.map((item) => item.inspection_id));
    if (known.current) setFresh(new Set([...ids].filter((id) => !known.current.has(id))));
    known.current = ids;
    const timer = setTimeout(() => setFresh(new Set()), 1800);
    return () => clearTimeout(timer);
  }, [inspections, lastSync]);

  // The list endpoint has no query parameters, so search/filter/sort/paging run client-side on the fetched records.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...inspections].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) * (sortDir === 'asc' ? 1 : -1));
    return sorted.filter((item) => (filter === 'all' || verdictGroup(item) === filter)
      && (!q || [item.inspection_id, item.po?.po_id, item.po?.sku, item.po?.asin, item.po?.unit_id, item.po?.product_name]
        .some((v) => String(v || '').toLowerCase().includes(q))));
  }, [inspections, filter, query, sortDir]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const detail = inspections.find((item) => item.inspection_id === detailId);
  const closeDetail = useCallback(() => setDetailId(''), []);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, f.key === 'all' ? inspections.length : inspections.filter((i) => verdictGroup(i) === f.key).length])), [inspections]);

  return (
    <div className="stack">
      <Panel title="Inspections" icon="list"
        actions={(
          <>
            {lastSync && <span className="muted" style={{ fontSize: 12.5 }}>Synced {timeAgo(lastSync)}</span>}
            <button type="button" className="btn btn--sm" onClick={onRefresh} disabled={loading || !connected}>
              {loading ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={14} />} Refresh
            </button>
          </>
        )}>
        <DataGate connected={connected} loading={loading} error={error} hasData={inspections.length > 0} onRetry={onRefresh} onConnect={onConnect}>
          <div className="filters">
            <div className="search">
              <Icon name="search" size={15} />
              <input className="input" type="search" placeholder="Search inspection ID, PO, SKU, ASIN, unit…" value={query}
                onChange={(event) => setQuery(event.target.value)} aria-label="Search inspections" />
            </div>
            <div className="segmented" role="group" aria-label="Filter by verdict">
              {FILTERS.map((item) => (
                <button key={item.key} type="button" className={filter === item.key ? 'is-on' : ''} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
                  {item.label}<span className="segmented__n">{counts[item.key]}</span>
                </button>
              ))}
            </div>
          </div>

          {rows.length === 0 ? (
            inspections.length
              ? <EmptyState icon="search" title="No matching inspections" action={<button type="button" className="btn btn--sm" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button>}>No inspection matches this search or verdict filter.</EmptyState>
              : <EmptyState icon="truck" title="No inspections yet" action={<button type="button" className="btn btn--primary btn--sm" onClick={onNewInspection}><Icon name="plus" size={14} /> New inspection</button>}>Inspections you run appear here with their verdict and sealed evidence record.</EmptyState>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table table--hover">
                  <thead>
                    <tr>
                      <th>Inspection</th><th>Purchase order</th><th>SKU</th><th>Verdict</th><th>Photos</th><th>Record</th>
                      <th aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'}>
                        <button type="button" className="th-sort" onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}>
                          Created <Icon name={sortDir === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} />
                        </button>
                      </th>
                      <th><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((item) => (
                      <tr key={item.inspection_id} className={fresh.has(item.inspection_id) ? 'is-new' : ''}>
                        <td><button type="button" className="link mono" onClick={() => onOpenInspection(item.inspection_id)}>{item.inspection_id}</button></td>
                        <td><div className="table__strong">{item.po?.po_id}</div><div className="table__sub">{item.po?.product_name}</div></td>
                        <td className="mono">{item.po?.sku}</td>
                        <td>
                          <div className="cell-badges">
                            <DecisionPill decision={effectiveDecision(item)} />
                            {item.override_decision && <span className="tag tag--accent">override</span>}
                            {failedCategories(item).map((category) => <span key={category} className="tag tag--fail">{category}</span>)}
                          </div>
                        </td>
                        <td className="mono">{item.images?.length ?? 0}</td>
                        <td className="mono nowrap">{item.record ? `v${item.record.version} · ${shortHash(item.record.content_hash)}` : '—'}</td>
                        <td className="nowrap" title={formatTime(item.created_at)}>{timeAgo(item.created_at)}</td>
                        <td>
                          <div className="row-actions">
                            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDetailId(item.inspection_id)}><Icon name="eye" size={14} /> Details</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pager">
                <span className="muted">Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, rows.length)} of {rows.length}</span>
                <div className="pager__btns">
                  <button type="button" className="btn btn--sm" onClick={() => setPage((p) => p - 1)} disabled={page <= 1} aria-label="Previous page"><Icon name="chevronLeft" size={14} /></button>
                  <span className="mono">{page} / {pages}</span>
                  <button type="button" className="btn btn--sm" onClick={() => setPage((p) => p + 1)} disabled={page >= pages} aria-label="Next page"><Icon name="chevronRight" size={14} /></button>
                </div>
              </div>
            </>
          )}
        </DataGate>
      </Panel>
      {detail && <InspectionDetails item={detail} onClose={closeDetail} onOpenInspection={onOpenInspection} />}
    </div>
  );
}
