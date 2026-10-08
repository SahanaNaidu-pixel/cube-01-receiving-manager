/*
 * PurchaseOrdersPage — stored and inspection-derived purchase orders (GET /api/purchase-orders),
 * with create (POST /api/purchase-orders) and catalogue import (POST /api/catalogue/import).
 * Filters (q, status) and pagination live in the hash query.
 */
import { useState } from 'react';
import { listPurchaseOrders } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { formatDate, formatNumber, listParamsFromQuery } from '../lib/format';
import { Card, ConnectPrompt, DataTable, FilterBar, Icon, Link, PageHeader, Pagination, StatusBadge } from '../components/ui';
import { ImportCatalogueModal, PurchaseOrderFormModal } from './ops/forms';
import { DISCREPANCY_HELP } from './ops/shared';
import '../styles/ops.css';

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open (not inspected)' },
  { value: 'partially_received', label: 'Partially received' },
  { value: 'received', label: 'Received' },
  { value: 'discrepancy', label: 'Discrepancy' },
];

function DiscrepancySummary({ lines = [] }) {
  const counts = lines.reduce((acc, line) => {
    const key = line.discrepancy || 'unverified';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const order = ['short', 'over', 'unverified', 'none'];
  const parts = order.filter((key) => counts[key]);
  if (!parts.length) return <span className="hint">No lines</span>;
  return (
    <span className="ops-chip-row">
      {parts.map((key) => (
        <span key={key} title={DISCREPANCY_HELP[key]}>
          <StatusBadge status={key} label={`${counts[key]} ${key === 'none' ? 'matched' : key}`} />
        </span>
      ))}
    </span>
  );
}

export default function PurchaseOrdersPage({ route }) {
  const params = listParamsFromQuery(route.query, ['q', 'status', 'supplier']);
  const { data, error, loading, reload, notConnected } = useApi(() => listPurchaseOrders(params), [JSON.stringify(params)]);
  const [modal, setModal] = useState(null);

  if (notConnected) return <Card><ConnectPrompt /></Card>;

  const hasFilters = Boolean(route.query.q || route.query.status || route.query.supplier);

  return (
    <div className="stack">
      <PageHeader
        title="Purchase orders"
        subtitle="Expected deliveries from the catalogue, plus POs seen only on inspections. Received quantities come from analysed inspections."
        icon="file"
        actions={(
          <>
            <button type="button" className="btn-theme" onClick={() => setModal('import')}><Icon name="upload" size={14} /> Import catalogue</button>
            <button type="button" className="btn-primary" onClick={() => setModal('create')}><Icon name="plus" size={14} /> New purchase order</button>
          </>
        )}
      />
      <FilterBar
        search={{ value: route.query.q, placeholder: 'Search PO number, supplier, SKU…', onChange: (q) => setQuery({ q, page: 1 }) }}
        selects={[{
          key: 'status', label: 'Status', value: route.query.status, options: STATUS_OPTIONS,
          onChange: (status) => setQuery({ status, page: 1 }),
        }]}
        onReset={hasFilters ? () => navigate('purchase-orders') : undefined}
        resultCount={data?.total}
      />
      <Card flush>
        <DataTable
          rows={data?.items}
          rowKey="po_number"
          loading={loading}
          error={error}
          onRetry={reload}
          onRowClick={(row) => navigate(pathFor('purchase-orders', row.po_number))}
          empty={hasFilters
            ? { title: 'No purchase orders match', message: 'Clear the filters to see every PO.', icon: 'search' }
            : {
              title: 'No purchase orders yet',
              message: 'Create one, or import the catalogue CSV to load products and POs.',
              icon: 'file',
              action: (
                <span className="row-actions">
                  <button type="button" className="btn-theme" onClick={() => setModal('import')}><Icon name="upload" size={14} /> Import catalogue</button>
                  <button type="button" className="btn-primary" onClick={() => setModal('create')}><Icon name="plus" size={14} /> New purchase order</button>
                </span>
              ),
            }}
          columns={[
            {
              key: 'po_number', header: 'PO number',
              render: (r) => (
                <span className="ops-cell-stack">
                  <Link to={pathFor('purchase-orders', r.po_number)} className="link mono">{r.po_number}</Link>
                  {r.source === 'inspections' && <span className="hint" title="No catalogue PO exists; derived from inspections that reference this PO.">derived from inspections</span>}
                </span>
              ),
            },
            { key: 'supplier', header: 'Supplier' },
            { key: 'expected_delivery_date', header: 'Expected delivery', render: (r) => formatDate(r.expected_delivery_date) },
            { key: 'warehouse', header: 'Warehouse' },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'lines', header: 'Lines', align: 'right', render: (r) => formatNumber(r.lines?.length ?? 0) },
            { key: 'inspection_count', header: 'Inspections', align: 'right', render: (r) => formatNumber(r.inspection_count ?? 0) },
            { key: 'discrepancy', header: 'Discrepancies', render: (r) => <DiscrepancySummary lines={r.lines} /> },
          ]}
        />
        <Pagination
          page={data?.page}
          pageSize={data?.page_size}
          total={data?.total}
          onPageChange={(page) => setQuery({ page })}
          onPageSizeChange={(page_size) => setQuery({ page_size, page: 1 })}
        />
      </Card>

      {modal === 'create' && (
        <PurchaseOrderFormModal
          onClose={() => setModal(null)}
          onSaved={(po) => { setModal(null); navigate(pathFor('purchase-orders', po.po_number)); }}
        />
      )}
      {modal === 'import' && <ImportCatalogueModal onClose={() => setModal(null)} onImported={() => reload()} />}
    </div>
  );
}
