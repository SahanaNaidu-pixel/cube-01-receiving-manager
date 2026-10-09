import { useMemo, useState } from 'react';
import { VERDICT_GROUPS, effectiveDecision, fmtValue, timeAgo, verdictGroup } from '../constants';
import { DataGate, DecisionPill, EmptyState, Icon, Panel } from './Shared';

// The backend has no catalogue or purchase-order service: each inspection carries its own PO line. These pages are
// read-only indexes built from those PO lines, so every row traces back to real inspections. Nothing is created,
// edited or stored here.
function IntegrationNotice({ subject }) {
  return (
    <div className="alert alert--info">
      <Icon name="info" size={16} />
      <span className="alert__text">
        <strong>Derived view · {subject} service integration pending</strong>
        This backend has no {subject.toLowerCase()} endpoint. The list below is built from the PO lines recorded on your inspections and is read-only.
        Creating or editing {subject.toLowerCase()} records requires a master-data service that is not part of the Receiving Manager.
      </span>
    </div>
  );
}

function groupCounts(items) {
  const counts = Object.fromEntries(VERDICT_GROUPS.map((g) => [g.key, 0]));
  items.forEach((item) => { counts[verdictGroup(item)] += 1; });
  return counts;
}

function VerdictMini({ counts }) {
  return (
    <div className="mini-counts">
      {VERDICT_GROUPS.filter((g) => counts[g.key]).map((g) => (
        <span key={g.key} className={`mini-count mini-count--${g.tone}`} title={`${g.label}: ${counts[g.key]}`}>{g.key === 'DRAFT' ? 'Draft' : g.label} {counts[g.key]}</span>
      ))}
    </div>
  );
}

function useSearch(rows, fields) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = rows.filter((row) => !q || fields(row).some((v) => String(v || '').toLowerCase().includes(q)));
  return [query, setQuery, filtered];
}

export function CatalogueView({ inspections, connected, loading, error, onRefresh, onConnect, onUsePo, onOpenInspection }) {
  const products = useMemo(() => {
    const map = new Map();
    inspections.forEach((item) => {
      const po = item.po || {};
      const key = `${po.sku}|${po.variant}`;
      if (!map.has(key)) map.set(key, { key, sku: po.sku, asin: new Set(), product_name: po.product_name, variant: po.variant, components: new Set(), packs: new Set(), items: [], latestPo: po, latestAt: '' });
      const row = map.get(key);
      if (po.asin) row.asin.add(po.asin);
      (po.expected_components || []).forEach((c) => row.components.add(c));
      if (po.units_per_carton) row.packs.add(po.units_per_carton);
      row.items.push(item);
      if (String(item.created_at) > row.latestAt) { row.latestAt = String(item.created_at); row.latestPo = po; }
    });
    return [...map.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  }, [inspections]);
  const [query, setQuery, rows] = useSearch(products, (r) => [r.sku, r.product_name, r.variant, ...r.asin]);
  const [open, setOpen] = useState('');

  return (
    <div className="stack">
      <IntegrationNotice subject="Catalogue" />
      <Panel title="Products seen in inspections" icon="package" actions={<button type="button" className="btn btn--sm" onClick={onRefresh} disabled={loading || !connected}><Icon name="refresh" size={14} /> Refresh</button>}>
        <DataGate connected={connected} loading={loading} error={error} hasData={inspections.length > 0} onRetry={onRefresh} onConnect={onConnect}>
          <div className="filters">
            <div className="search"><Icon name="search" size={15} /><input className="input" type="search" placeholder="Search SKU, ASIN, product, variant…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search products" /></div>
            <span className="muted" style={{ fontSize: 13 }}>{products.length} SKU / variant combination{products.length === 1 ? '' : 's'}</span>
          </div>
          {rows.length === 0 ? (
            <EmptyState icon="package" title={products.length ? 'No matching products' : 'No products yet'}>
              {products.length ? 'Try another search.' : 'Products appear once an inspection is created with a PO line.'}
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table table--hover">
                <thead><tr><th>SKU</th><th>Product</th><th>Variant</th><th>Units / carton</th><th>Components</th><th>Inspections</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {rows.map((row) => (
                    <FragmentRow key={row.key} open={open === row.key} cols={7}
                      detail={(
                        <div className="sub-list">
                          {row.items.map((item) => (
                            <button key={item.inspection_id} type="button" className="sub-list__item" onClick={() => onOpenInspection(item.inspection_id)}>
                              <span className="mono">{item.inspection_id}</span><span>{item.po?.po_id}</span><DecisionPill decision={effectiveDecision(item)} /><span className="muted">{timeAgo(item.created_at)}</span>
                            </button>
                          ))}
                        </div>
                      )}>
                      <td className="mono table__strong">{row.sku}{row.asin.size > 0 && <div className="table__sub">ASIN {[...row.asin].join(', ')}</div>}</td>
                      <td>{row.product_name}</td>
                      <td>{row.variant}</td>
                      <td className="mono">{[...row.packs].join(', ') || '—'}</td>
                      <td>{fmtValue([...row.components])}</td>
                      <td><VerdictMini counts={groupCounts(row.items)} /></td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="btn btn--ghost btn--sm" aria-expanded={open === row.key} onClick={() => setOpen(open === row.key ? '' : row.key)}>{row.items.length} inspection{row.items.length === 1 ? '' : 's'}</button>
                          <button type="button" className="btn btn--sm" onClick={() => onUsePo(row.latestPo)} title="Prefill a new inspection with this product's most recent PO line"><Icon name="scan" size={14} /> Inspect</button>
                        </div>
                      </td>
                    </FragmentRow>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataGate>
      </Panel>
    </div>
  );
}

export function PurchaseOrdersView({ inspections, connected, loading, error, onRefresh, onConnect, onUsePo, onOpenInspection }) {
  const lines = useMemo(() => {
    const map = new Map();
    inspections.forEach((item) => {
      const po = item.po || {};
      const key = `${po.po_id}|${po.po_line || ''}|${po.sku}`;
      if (!map.has(key)) map.set(key, { key, po, items: [], latestAt: '' });
      const row = map.get(key);
      row.items.push(item);
      if (String(item.created_at) > row.latestAt) { row.latestAt = String(item.created_at); row.po = po; }
    });
    return [...map.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  }, [inspections]);
  const [query, setQuery, rows] = useSearch(lines, (r) => [r.po.po_id, r.po.po_line, r.po.sku, r.po.product_name, r.po.unit_id]);
  const [open, setOpen] = useState('');

  return (
    <div className="stack">
      <IntegrationNotice subject="Purchase-order" />
      <Panel title="PO lines received" icon="clipboard" actions={<button type="button" className="btn btn--sm" onClick={onRefresh} disabled={loading || !connected}><Icon name="refresh" size={14} /> Refresh</button>}>
        <DataGate connected={connected} loading={loading} error={error} hasData={inspections.length > 0} onRetry={onRefresh} onConnect={onConnect}>
          <div className="filters">
            <div className="search"><Icon name="search" size={15} /><input className="input" type="search" placeholder="Search PO, line, SKU, unit…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search purchase orders" /></div>
            <span className="muted" style={{ fontSize: 13 }}>{lines.length} PO line{lines.length === 1 ? '' : 's'}</span>
          </div>
          {rows.length === 0 ? (
            <EmptyState icon="clipboard" title={lines.length ? 'No matching PO lines' : 'No PO lines yet'}>
              {lines.length ? 'Try another search.' : 'PO lines appear once an inspection is created.'}
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table table--hover">
                <thead><tr><th>PO</th><th>Line</th><th>SKU / product</th><th>Expected</th><th>Latest verdict</th><th>Inspections</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {rows.map((row) => {
                    const latest = [...row.items].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
                    return (
                      <FragmentRow key={row.key} open={open === row.key} cols={7}
                        detail={(
                          <div className="sub-list">
                            {row.items.map((item) => (
                              <button key={item.inspection_id} type="button" className="sub-list__item" onClick={() => onOpenInspection(item.inspection_id)}>
                                <span className="mono">{item.inspection_id}</span><span>{item.images?.length || 0} photos</span><DecisionPill decision={effectiveDecision(item)} /><span className="muted">{timeAgo(item.created_at)}</span>
                              </button>
                            ))}
                          </div>
                        )}>
                        <td className="mono table__strong">{row.po.po_id}</td>
                        <td className="mono">{row.po.po_line || '—'}</td>
                        <td><div className="mono">{row.po.sku}</div><div className="table__sub">{row.po.product_name} · {row.po.variant}</div></td>
                        <td className="nowrap">{row.po.expected_quantity} units<div className="table__sub">{row.po.expected_cartons} × {row.po.units_per_carton}</div></td>
                        <td><DecisionPill decision={effectiveDecision(latest)} /></td>
                        <td><VerdictMini counts={groupCounts(row.items)} /></td>
                        <td>
                          <div className="row-actions">
                            <button type="button" className="btn btn--ghost btn--sm" aria-expanded={open === row.key} onClick={() => setOpen(open === row.key ? '' : row.key)}>{row.items.length} inspection{row.items.length === 1 ? '' : 's'}</button>
                            <button type="button" className="btn btn--sm" onClick={() => onUsePo(row.po)} title="Prefill a new inspection with this PO line"><Icon name="scan" size={14} /> Inspect</button>
                          </div>
                        </td>
                      </FragmentRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </DataGate>
      </Panel>
    </div>
  );
}

function FragmentRow({ children, open, detail, cols }) {
  return (
    <>
      <tr className={open ? 'is-open' : ''}>{children}</tr>
      {open && <tr className="row-detail"><td colSpan={cols}>{detail}</td></tr>}
    </>
  );
}
