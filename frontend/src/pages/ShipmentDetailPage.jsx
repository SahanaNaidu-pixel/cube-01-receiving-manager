/*
 * ShipmentDetailPage — TEMPORARY placeholder. Replaced by the page build step (see src/README.md → "Adding a page").
 * Shipment details and its inspections.
 * Props: { route } from useRoute() — route.params holds the decoded id segment(s).
 */
import { PageHeader, UnderConstruction } from '../components/ui';

export default function ShipmentDetailPage({ route }) {
  const id = route.params.join(' / ');
  return (
    <div className="stack">
      <PageHeader
        title={`Shipment ${id}`}
        subtitle="Shipment details and its inspections."
        breadcrumbs={[{ label: 'Shipments', to: 'shipments' }, { label: id }]}
      />
      <UnderConstruction endpoints={['GET /api/shipments/{shipment_id}']} />
    </div>
  );
}
