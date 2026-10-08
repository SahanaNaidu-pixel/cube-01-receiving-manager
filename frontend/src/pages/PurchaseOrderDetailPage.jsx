/*
 * PurchaseOrderDetailPage — GET /api/purchase-orders/{po_number}: lines expected vs received (derived from analysed
 * inspections), discrepancy per line, and the inspections linked to this PO (GET /api/inspections?po=…).
 */
import { getPurchaseOrder, listInspections } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { pathFor, setQuery } from '../lib/router';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';
import {
  Card, ConnectPrompt, DataTable, EmptyState, ErrorState, KeyValueGrid, Link, LoadingState, PageHeader, Pagination, StatusBadge,
} from '../components/ui';
import { DiscrepancyBadge, InspectionSummaryTable, StartInspectionLink } from './ops/shared';
import '../styles/ops.css';

function delta(line) {
  if (line.received_quantity === null || line.received_quantity === undefined || line.expected_quantity === null || line.expected_quantity === undefined) return null;
  return line.received_quantity - line.expected_quantity;
}

export default function PurchaseOrderDetailPage({ route }) {
  const poNumber = route.params[0];
  const po = useApi(() => getPurchaseOrder(poNumber), [poNumber]);
  const page = Math.max(1, Number(route.query.page) || 1);
  const inspections = useApi(() => listInspections({ po: poNumber, page, page_size: 25 }), [poNumber, page]);

  if (po.notConnected) return <Card><ConnectPrompt /></Card>;

  const crumbs = [{ label: 'Purchase orders', to: 'purchase-orders' }, { label: poNumber }];
  if (po.error && !po.data) {
    return (
      <div className="stack">
        <PageHeader title={`PO ${poNumber}`} breadcrumbs={crumbs} icon="file" />
        <Card>
          {po.error.status === 404
            ? <EmptyState icon="search" title="Purchase order not found" message={`No catalogue PO or inspection references ${poNumber} in your organisation.`} action={<Link to="purchase-orders" className="btn-theme">Back to purchase orders</Link>} />
            : <ErrorState error={po.error} onRetry={po.reload} title="Could not load the purchase order" />}
        </Card>
      </div>
    );
  }
  if (!po.data) return <Card><LoadingState label={`Loading ${poNumber}…`} /></Card>;

  const data = po.data;
  const lines = data.lines || [];
  const expectedTotal = lines.reduce((sum, l) => sum + (Number(l.expected_quantity) || 0), 0);
  const verified = lines.filter((l) => l.received_quantity !== null && l.received_quantity !== undefined);
  const receivedTotal = verified.reduce((sum, l) => sum + l.received_quantity, 0);

  return (
    <div className="stack">
      <PageHeader
        title={`PO ${data.po_number}`}
        subtitle={data.source === 'inspections'
          ? 'Derived from inspections — no catalogue PO exists for this number. Lines come from the inspections’ PO data.'
          : 'Catalogue purchase order. Received quantities are summed from observed totals of analysed inspections.'}
        breadcrumbs={crumbs}
        icon="file"
        actions={<StartInspectionLink po={data.po_number} small={false} label="Start inspection for this PO" />}
      />

      <Card>
        <KeyValueGrid columns={4} items={[
          { label: 'Status', value: <StatusBadge status={data.status} /> },
          { label: 'Supplier', value: data.supplier },
          { label: 'Expected delivery', value: data.expected_delivery_date ? formatDate(data.expected_delivery_date) : null },
          { label: 'Warehouse', value: data.warehouse },
          { label: 'Lines', value: formatNumber(lines.length) },
          { label: 'Expected units', value: formatNumber(expectedTotal) },
          { label: 'Received units (verified lines)', value: verified.length ? `${formatNumber(receivedTotal)} on ${verified.length}/${lines.length} line(s)` : 'Not observed yet' },
          { label: 'Inspections', value: formatNumber(data.inspection_count ?? 0) },
          { label: 'Source', value: data.source === 'inspections' ? 'Derived from inspections' : 'Catalogue' },
          { label: 'Created', value: formatDateTime(data.created_at) },
        ]} />
      </Card>

      <Card flush title="Lines" sub="Expected vs received. “Unverified” = no analysed inspection of the line has an observed total quantity yet.">
        <DataTable
          rows={lines}
          rowKey={(l) => `${l.line}-${l.sku}`}
          empty={{ title: 'No lines on this PO', icon: 'list' }}
          columns={[
            { key: 'line', header: 'Line', mono: true },
            { key: 'sku', header: 'SKU', render: (l) => <Link to={pathFor('products', l.sku)} className="link mono">{l.sku}</Link> },
            { key: 'product_name', header: 'Product', render: (l) => (
              <span className="ops-cell-stack"><span>{l.product_name || '—'}</span>{l.variant && <span className="hint">{l.variant}</span>}</span>
            ) },
            { key: 'expected_quantity', header: 'Expected', align: 'right', render: (l) => formatNumber(l.expected_quantity) },
            { key: 'expected_cartons', header: 'Cartons', align: 'right', render: (l) => (
              l.expected_cartons !== null && l.expected_cartons !== undefined
                ? `${formatNumber(l.expected_cartons)}${l.units_per_carton ? ` × ${formatNumber(l.units_per_carton)}` : ''}`
                : '—'
            ) },
            { key: 'received_quantity', header: 'Received', align: 'right', render: (l) => (
              l.received_quantity === null || l.received_quantity === undefined ? <span className="hint">not observed</span> : formatNumber(l.received_quantity)
            ) },
            { key: 'delta', header: 'Δ', align: 'right', render: (l) => {
              const d = delta(l);
              if (d === null) return '—';
              return <span className={d < 0 ? 'ops-neg' : d > 0 ? 'ops-pos' : ''}>{d > 0 ? `+${d}` : d}</span>;
            } },
            { key: 'discrepancy', header: 'Discrepancy', render: (l) => <DiscrepancyBadge value={l.discrepancy} /> },
            { key: 'inspection_ids', header: 'Inspections', render: (l) => (
              l.inspection_ids?.length
                ? <span className="ops-chip-row">{l.inspection_ids.map((id) => <Link key={id} to={pathFor('inspections', id)} className="link mono">{id}</Link>)}</span>
                : <span className="hint">none</span>
            ) },
            { key: 'actions', header: '', render: (l) => <StartInspectionLink po={data.po_number} sku={l.sku} /> },
          ]}
        />
      </Card>

      <Card flush title="Linked inspections" sub={`GET /api/inspections?po=${data.po_number}`}>
        <InspectionSummaryTable
          rows={inspections.data?.items}
          loading={inspections.loading}
          error={inspections.error}
          onRetry={inspections.reload}
          showPo={false}
          empty={{ title: 'No inspections for this PO yet', message: 'Start an inspection from a line above.', icon: 'scan' }}
        />
        <Pagination
          page={inspections.data?.page}
          pageSize={inspections.data?.page_size}
          total={inspections.data?.total}
          onPageChange={(p) => setQuery({ page: p })}
        />
      </Card>
    </div>
  );
}
