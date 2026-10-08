/*
 * ShipmentsPage — shipments derived from inspections' shipment intake (GET /api/shipments, q + supplier, paginated),
 * with per-shipment verdict counts. Filters and pagination live in the hash query.
 */
import { listShipments } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { formatDate, formatDateTime, formatNumber, formatRelative, listParamsFromQuery } from '../lib/format';
import { Card, ConnectPrompt, DataTable, FilterBar, Link, PageHeader, Pagination } from '../components/ui';
import { TextFilter, VerdictCounts } from './ops/shared';
import '../styles/ops.css';

export default function ShipmentsPage({ route }) {
  const params = listParamsFromQuery(route.query, ['q', 'supplier']);
  const { data, error, loading, reload, notConnected } = useApi(() => listShipments(params), [JSON.stringify(params)]);
  if (notConnected) return <Card><ConnectPrompt /></Card>;
  const hasFilters = Boolean(route.query.q || route.query.supplier);

  return (
    <div className="stack">
      <PageHeader
        title="Shipments"
        subtitle="Grouped from the shipment details captured on inspections (shipment ID, supplier, ASN, warehouse). Newest activity first."
        icon="truck"
        actions={<Link to="new-inspection" className="btn-primary">New inspection with shipment</Link>}
      />
      <FilterBar
        search={{ value: route.query.q, placeholder: 'Search shipment ID, supplier, ASN, warehouse…', onChange: (q) => setQuery({ q, page: 1 }) }}
        onReset={hasFilters ? () => navigate('shipments') : undefined}
        resultCount={data?.total}
      >
        <TextFilter label="Supplier (exact)" value={route.query.supplier} onChange={(supplier) => setQuery({ supplier, page: 1 })} />
      </FilterBar>
      <Card flush>
        <DataTable
          rows={data?.items}
          rowKey="shipment_id"
          loading={loading}
          error={error}
          onRetry={reload}
          onRowClick={(row) => navigate(pathFor('shipments', row.shipment_id))}
          empty={hasFilters
            ? { title: 'No shipments match', message: 'Clear the filters to see every shipment.', icon: 'search' }
            : {
              title: 'No shipments yet',
              message: 'Shipments appear when an inspection is created with a shipment ID (New Inspection → shipment details, or receiving.inspect over A2A).',
              icon: 'truck',
              action: <Link to="new-inspection" className="btn-primary">New inspection</Link>,
            }}
          columns={[
            { key: 'shipment_id', header: 'Shipment', render: (r) => <Link to={pathFor('shipments', r.shipment_id)} className="link mono">{r.shipment_id}</Link> },
            { key: 'supplier', header: 'Supplier' },
            { key: 'asn', header: 'ASN', mono: true },
            { key: 'warehouse', header: 'Warehouse' },
            { key: 'expected_delivery_date', header: 'Expected delivery', render: (r) => formatDate(r.expected_delivery_date) },
            { key: 'inspection_count', header: 'Inspections', align: 'right', render: (r) => formatNumber(r.inspection_count) },
            { key: 'verdict_counts', header: 'Verdicts', render: (r) => <VerdictCounts counts={r.verdict_counts} /> },
            { key: 'last_activity', header: 'Last activity', render: (r) => <span title={formatDateTime(r.last_activity)}>{formatRelative(r.last_activity)}</span> },
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
    </div>
  );
}
