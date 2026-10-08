/*
 * CartonsPage — cartons derived from inspections' carton intake (GET /api/cartons; filters shipment_id, po, sku,
 * inspection_id, condition; paginated). Seal / visible condition are coloured by severity.
 */
import { listCartons } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { formatNumber, listParamsFromQuery } from '../lib/format';
import { Card, ConnectPrompt, DataTable, FilterBar, Link, PageHeader, Pagination, VerdictBadge } from '../components/ui';
import { ConditionBadge, TextFilter } from './ops/shared';
import '../styles/ops.css';

const CONDITION_OPTIONS = [
  { value: 'broken', label: 'Seal: broken' },
  { value: 'resealed', label: 'Seal: resealed' },
  { value: 'intact', label: 'Seal: intact' },
  { value: 'crushed', label: 'Crushed' },
  { value: 'torn', label: 'Torn' },
  { value: 'punctured', label: 'Punctured' },
  { value: 'wet', label: 'Wet' },
  { value: 'open', label: 'Open' },
  { value: 'label_damaged', label: 'Label damaged' },
  { value: 'good', label: 'Good' },
  { value: 'unknown', label: 'Unknown' },
];

export default function CartonsPage({ route }) {
  const params = listParamsFromQuery(route.query, ['shipment_id', 'po', 'sku', 'inspection_id', 'condition']);
  const { data, error, loading, reload, notConnected } = useApi(() => listCartons(params), [JSON.stringify(params)]);
  if (notConnected) return <Card><ConnectPrompt /></Card>;
  const q = route.query;
  const hasFilters = Boolean(q.shipment_id || q.po || q.sku || q.inspection_id || q.condition);

  return (
    <div className="stack">
      <PageHeader
        title="Cartons"
        subtitle="Cartons declared on inspection intake, with the observed units per carton (operator count first, else vision) and evidence photos tagged “carton”."
        icon="box"
      />
      <FilterBar
        selects={[{ key: 'condition', label: 'Condition', value: q.condition, options: CONDITION_OPTIONS, onChange: (condition) => setQuery({ condition, page: 1 }) }]}
        onReset={hasFilters ? () => navigate('cartons') : undefined}
        resultCount={data?.total}
      >
        <TextFilter label="Shipment ID" value={q.shipment_id} onChange={(v) => setQuery({ shipment_id: v, page: 1 })} />
        <TextFilter label="PO" value={q.po} onChange={(v) => setQuery({ po: v, page: 1 })} />
        <TextFilter label="SKU" value={q.sku} onChange={(v) => setQuery({ sku: v, page: 1 })} />
        <TextFilter label="Inspection ID" value={q.inspection_id} onChange={(v) => setQuery({ inspection_id: v, page: 1 })} />
      </FilterBar>
      <Card flush>
        <DataTable
          rows={data?.items}
          rowKey={(c) => `${c.inspection_id}/${c.carton_id}`}
          loading={loading}
          error={error}
          onRetry={reload}
          onRowClick={(c) => navigate(pathFor('cartons', c.inspection_id, c.carton_id))}
          empty={hasFilters
            ? { title: 'No cartons match', message: 'Filters match exactly (case-insensitive). Clear them to see every carton.', icon: 'search' }
            : { title: 'No cartons recorded yet', message: 'Add cartons on New Inspection (shipment & cartons step) or in a receiving.inspect A2A payload.', icon: 'box', action: <Link to="new-inspection" className="btn-primary">New inspection</Link> }}
          columns={[
            { key: 'carton_id', header: 'Carton', render: (c) => <Link to={pathFor('cartons', c.inspection_id, c.carton_id)} className="link mono">{c.carton_id}</Link> },
            { key: 'shipment_id', header: 'Shipment', render: (c) => (c.shipment_id ? <Link to={pathFor('shipments', c.shipment_id)} className="link mono">{c.shipment_id}</Link> : '—') },
            { key: 'po_id', header: 'PO', render: (c) => <Link to={pathFor('purchase-orders', c.po_id)} className="link mono">{c.po_id}</Link> },
            { key: 'sku', header: 'SKU', render: (c) => <Link to={pathFor('products', c.sku)} className="link mono">{c.sku}</Link> },
            { key: 'expected_units', header: 'Expected units', align: 'right', render: (c) => formatNumber(c.expected_units) },
            { key: 'observed_units', header: 'Observed units', align: 'right', render: (c) => (c.observed_units === null || c.observed_units === undefined
              ? <span className="hint">not observed</span>
              : <span className={c.expected_units !== null && c.expected_units !== undefined && c.observed_units !== c.expected_units ? 'ops-neg' : ''}>{formatNumber(c.observed_units)}</span>) },
            { key: 'seal_condition', header: 'Seal', render: (c) => <ConditionBadge kind="seal" value={c.seal_condition} /> },
            { key: 'visible_condition', header: 'Visible condition', render: (c) => <ConditionBadge kind="visible" value={c.visible_condition} /> },
            { key: 'evidence_image_ids', header: 'Evidence', align: 'right', render: (c) => formatNumber(c.evidence_image_ids?.length ?? 0) },
            { key: 'inspection_verdict', header: 'Verdict', render: (c) => <VerdictBadge verdict={c.inspection_verdict} /> },
            { key: 'inspection_id', header: 'Inspection', render: (c) => <Link to={pathFor('inspections', c.inspection_id)} className="link mono">{c.inspection_id}</Link> },
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
