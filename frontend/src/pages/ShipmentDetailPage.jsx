/*
 * ShipmentDetailPage — GET /api/shipments/{shipment_id} (shipment + inspection summaries) and its cartons
 * (GET /api/cartons?shipment_id=…).
 */
import { getShipment, listCartons } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor } from '../lib/router';
import { formatDate, formatDateTime, formatNumber } from '../lib/format';
import {
  Card, ConnectPrompt, DataTable, EmptyState, ErrorState, KeyValueGrid, Link, LoadingState, PageHeader, VerdictBadge,
} from '../components/ui';
import { ConditionBadge, InspectionSummaryTable, VerdictCounts } from './ops/shared';
import '../styles/ops.css';

export default function ShipmentDetailPage({ route }) {
  const shipmentId = route.params[0];
  const { data, error, reload, notConnected } = useApi(() => getShipment(shipmentId), [shipmentId]);
  const cartons = useApi(() => listCartons({ shipment_id: shipmentId, page_size: 200 }), [shipmentId]);

  if (notConnected) return <Card><ConnectPrompt /></Card>;
  const crumbs = [{ label: 'Shipments', to: 'shipments' }, { label: shipmentId }];
  if (error && !data) {
    return (
      <div className="stack">
        <PageHeader title={`Shipment ${shipmentId}`} breadcrumbs={crumbs} icon="truck" />
        <Card>
          {error.status === 404
            ? <EmptyState icon="search" title="Shipment not found" message="No inspection in your organisation carries this shipment ID." action={<Link to="shipments" className="btn-theme">Back to shipments</Link>} />
            : <ErrorState error={error} onRetry={reload} title="Could not load the shipment" />}
        </Card>
      </div>
    );
  }
  if (!data) return <Card><LoadingState label={`Loading ${shipmentId}…`} /></Card>;

  return (
    <div className="stack">
      <PageHeader title={`Shipment ${data.shipment_id}`} subtitle="Derived from the inspections that reference this shipment." breadcrumbs={crumbs} icon="truck" />
      <Card>
        <KeyValueGrid columns={4} items={[
          { label: 'Supplier', value: data.supplier },
          { label: 'ASN', value: data.asn, mono: true },
          { label: 'Warehouse', value: data.warehouse },
          { label: 'Expected delivery', value: data.expected_delivery_date ? formatDate(data.expected_delivery_date) : null },
          { label: 'Inspections', value: formatNumber(data.inspection_count) },
          { label: 'Verdicts', value: <VerdictCounts counts={data.verdict_counts} /> },
          { label: 'Last activity', value: formatDateTime(data.last_activity) },
        ]} />
      </Card>
      <Card flush title="Inspections" sub="Every inspection captured for this shipment">
        <InspectionSummaryTable rows={data.inspections} />
      </Card>
      <Card flush title="Cartons" sub={`GET /api/cartons?shipment_id=${data.shipment_id}`}>
        <DataTable
          rows={cartons.data?.items}
          rowKey={(c) => `${c.inspection_id}/${c.carton_id}`}
          loading={cartons.loading}
          error={cartons.error}
          onRetry={cartons.reload}
          onRowClick={(c) => navigate(pathFor('cartons', c.inspection_id, c.carton_id))}
          empty={{ title: 'No cartons recorded', message: 'Carton details are optional on inspection intake.', icon: 'box' }}
          skeletonRows={2}
          columns={[
            { key: 'carton_id', header: 'Carton', render: (c) => <Link to={pathFor('cartons', c.inspection_id, c.carton_id)} className="link mono">{c.carton_id}</Link> },
            { key: 'inspection_id', header: 'Inspection', render: (c) => <Link to={pathFor('inspections', c.inspection_id)} className="link mono">{c.inspection_id}</Link> },
            { key: 'sku', header: 'SKU', mono: true },
            { key: 'expected_units', header: 'Expected', align: 'right', render: (c) => formatNumber(c.expected_units) },
            { key: 'observed_units', header: 'Observed', align: 'right', render: (c) => (c.observed_units ?? null) === null ? <span className="hint">not observed</span> : formatNumber(c.observed_units) },
            { key: 'seal_condition', header: 'Seal', render: (c) => <ConditionBadge kind="seal" value={c.seal_condition} /> },
            { key: 'visible_condition', header: 'Condition', render: (c) => <ConditionBadge kind="visible" value={c.visible_condition} /> },
            { key: 'inspection_verdict', header: 'Verdict', render: (c) => <VerdictBadge verdict={c.inspection_verdict} /> },
          ]}
        />
      </Card>
    </div>
  );
}
