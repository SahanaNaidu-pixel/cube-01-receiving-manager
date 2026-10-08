/*
 * CartonDetailPage — GET /api/cartons/{inspection_id}/{carton_id}: intake fields, observed units, condition,
 * evidence thumbnails (fetched with the API key, object URLs revoked) and the inspection link.
 */
import { getCarton } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { pathFor } from '../lib/router';
import { formatDateTime, formatNumber } from '../lib/format';
import {
  Card, ConnectPrompt, EmptyState, ErrorState, KeyValueGrid, Link, LoadingState, PageHeader, VerdictBadge,
} from '../components/ui';
import { ConditionBadge, EvidenceThumb, conditionTone } from './ops/shared';
import '../styles/ops.css';

export default function CartonDetailPage({ route }) {
  const [inspectionId, cartonId] = route.params;
  const { data, error, reload, notConnected } = useApi(() => getCarton(inspectionId, cartonId), [inspectionId, cartonId]);

  if (notConnected) return <Card><ConnectPrompt /></Card>;
  const crumbs = [{ label: 'Cartons', to: 'cartons' }, { label: inspectionId, to: pathFor('inspections', inspectionId) }, { label: cartonId }];
  if (error && !data) {
    return (
      <div className="stack">
        <PageHeader title={`Carton ${cartonId}`} breadcrumbs={crumbs} icon="box" />
        <Card>
          {error.status === 404
            ? <EmptyState icon="search" title="Carton not found" message={`Inspection ${inspectionId} has no carton ${cartonId}.`} action={<Link to="cartons" className="btn-theme">Back to cartons</Link>} />
            : <ErrorState error={error} onRetry={reload} title="Could not load the carton" />}
        </Card>
      </div>
    );
  }
  if (!data) return <Card><LoadingState label={`Loading carton ${cartonId}…`} /></Card>;

  const damaged = ['danger', 'warning'].includes(conditionTone('seal', data.seal_condition))
    || ['danger', 'warning'].includes(conditionTone('visible', data.visible_condition));
  const mismatch = data.observed_units !== null && data.observed_units !== undefined
    && data.expected_units !== null && data.expected_units !== undefined && data.observed_units !== data.expected_units;

  return (
    <div className="stack">
      <PageHeader
        title={`Carton ${data.carton_id}`}
        subtitle={<>Inspection <Link to={pathFor('inspections', data.inspection_id)} className="link mono">{data.inspection_id}</Link> · recorded {formatDateTime(data.created_at)}</>}
        breadcrumbs={crumbs}
        icon="box"
        actions={<Link to={pathFor('inspections', data.inspection_id)} className="btn-primary">Open inspection</Link>}
      />
      {(damaged || mismatch) && (
        <div className="alert alert-warning" role="status">
          <span className="alert-text">
            {damaged && 'Condition reported on intake is not intact/good — the carton_condition check fails (or needs review under DAMAGE_POLICY=review). '}
            {mismatch && `Observed ${data.observed_units} units per carton vs ${data.expected_units} expected.`}
          </span>
        </div>
      )}
      <Card title="Carton">
        <KeyValueGrid columns={4} items={[
          { label: 'Carton ID', value: data.carton_id, mono: true },
          { label: 'Inspection verdict', value: <VerdictBadge verdict={data.inspection_verdict} /> },
          { label: 'Shipment', value: data.shipment_id ? <Link to={pathFor('shipments', data.shipment_id)} className="link mono">{data.shipment_id}</Link> : null },
          { label: 'PO', value: <Link to={pathFor('purchase-orders', data.po_id)} className="link mono">{data.po_id}</Link> },
          { label: 'SKU', value: <Link to={pathFor('products', data.sku)} className="link mono">{data.sku}</Link> },
          { label: 'Expected units', value: formatNumber(data.expected_units) },
          { label: 'Observed units / carton', value: data.observed_units === null || data.observed_units === undefined ? 'Not observed' : formatNumber(data.observed_units) },
          { label: 'Seal', value: <ConditionBadge kind="seal" value={data.seal_condition} /> },
          { label: 'Visible condition', value: <ConditionBadge kind="visible" value={data.visible_condition} /> },
          { label: 'Carton type', value: data.carton_type },
          { label: 'Weight', value: data.weight_kg !== null && data.weight_kg !== undefined ? `${data.weight_kg} kg` : null },
          { label: 'Dimensions', value: data.dimensions_cm ? `${data.dimensions_cm} cm` : null },
          { label: 'Notes', value: data.notes, span: 4 },
        ]} />
      </Card>
      <Card title="Evidence" sub="Photos of this inspection uploaded with view “carton” (shared by every carton of the inspection).">
        {data.evidence_image_ids?.length
          ? <div className="ops-thumbs">{data.evidence_image_ids.map((id) => <EvidenceThumb key={id} inspectionId={data.inspection_id} imageId={id} />)}</div>
          : <EmptyState compact icon="image" title="No carton photos" message="Upload images with view “carton” on the inspection to attach evidence here." action={<Link to={pathFor('inspections', data.inspection_id)} className="btn-theme">Open inspection</Link>} />}
      </Card>
    </div>
  );
}
