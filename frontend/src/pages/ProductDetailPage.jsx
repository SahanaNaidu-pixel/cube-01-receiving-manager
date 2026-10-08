/*
 * ProductDetailPage — GET /api/products/{sku}: every field, edit (PUT) modal, inspection history (from the product
 * response's `inspections` summaries) with verdict badges, and Start inspection.
 */
import { useMemo, useState } from 'react';
import { getProduct } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { setQuery } from '../lib/router';
import { formatDateTime, formatNumber, toUiVerdict } from '../lib/format';
import {
  Card, ConnectPrompt, EmptyState, ErrorState, Icon, KeyValueGrid, Link, LoadingState, PageHeader,
} from '../components/ui';
import { ProductFormModal } from './ops/forms';
import { InspectionSummaryTable, StartInspectionLink, VerdictCounts } from './ops/shared';
import '../styles/ops.css';

const VERDICT_FILTERS = [
  { value: '', label: 'All' }, { value: 'PASS', label: 'Pass' }, { value: 'FAIL', label: 'Fail' },
  { value: 'UNCERTAIN', label: 'Uncertain' }, { value: 'NOT_ANALYZED', label: 'Not analyzed' },
];

export default function ProductDetailPage({ route }) {
  const sku = route.params[0];
  const { data, error, loading, reload, setData, notConnected } = useApi(() => getProduct(sku), [sku]);
  const [editing, setEditing] = useState(false);
  const verdictFilter = route.query.verdict || '';

  const counts = useMemo(() => (data?.inspections || []).reduce((acc, i) => {
    const v = toUiVerdict(i.verdict);
    acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {}), [data]);
  const rows = useMemo(() => (data?.inspections || []).filter((i) => !verdictFilter || toUiVerdict(i.verdict) === verdictFilter), [data, verdictFilter]);

  if (notConnected) return <Card><ConnectPrompt /></Card>;
  const crumbs = [{ label: 'Products', to: 'products' }, { label: sku }];

  if (error && !data) {
    return (
      <div className="stack">
        <PageHeader title={sku} breadcrumbs={crumbs} icon="tag" />
        <Card>
          {error.status === 404
            ? <EmptyState icon="search" title="Product not found" message={`SKU ${sku} is not in your catalogue.`} action={<Link to="products" className="btn-theme">Back to products</Link>} />
            : <ErrorState error={error} onRetry={reload} title="Could not load the product" />}
        </Card>
      </div>
    );
  }
  if (!data) return <Card><LoadingState label={`Loading ${sku}…`} /></Card>;

  return (
    <div className="stack">
      <PageHeader
        title={data.product_name || data.sku}
        subtitle={<span className="mono">{data.sku}</span>}
        breadcrumbs={crumbs}
        icon="tag"
        actions={(
          <>
            <button type="button" className="btn-theme" onClick={() => setEditing(true)}><Icon name="settings" size={14} /> Edit product</button>
            <StartInspectionLink sku={data.sku} small={false} />
          </>
        )}
      />
      <Card title="Product" sub={loading ? 'Refreshing…' : `Updated ${formatDateTime(data.updated_at)}`}>
        <KeyValueGrid columns={4} items={[
          { label: 'SKU', value: data.sku, mono: true },
          { label: 'ASIN', value: data.asin, mono: true },
          { label: 'Product name', value: data.product_name },
          { label: 'Variant', value: data.variant },
          { label: 'Colour', value: data.colour },
          { label: 'Units per carton', value: formatNumber(data.units_per_carton) },
          { label: 'Supplier', value: data.supplier },
          { label: 'Expected components', value: data.expected_components?.length ? data.expected_components : null },
          { label: 'Created', value: formatDateTime(data.created_at) },
          { label: 'Updated', value: formatDateTime(data.updated_at) },
        ]} />
      </Card>

      <Card
        flush
        title="Inspection history"
        sub={`${formatNumber(data.inspections?.length ?? 0)} inspection(s) of this SKU`}
        actions={<VerdictCounts counts={counts} />}
      >
        <div className="ops-toolbar">
          <div className="segmented-control" role="group" aria-label="Filter by verdict">
            {VERDICT_FILTERS.map((option) => (
              <button key={option.value || 'all'} type="button" className={verdictFilter === option.value ? 'active' : ''}
                aria-pressed={verdictFilter === option.value} onClick={() => setQuery({ verdict: option.value })}>
                {option.label}{option.value ? ` (${counts[option.value] || 0})` : ''}
              </button>
            ))}
          </div>
        </div>
        <InspectionSummaryTable
          rows={rows}
          showSku={false}
          empty={verdictFilter
            ? { title: 'No inspections with this verdict', icon: 'filter' }
            : { title: 'Never inspected', message: 'Start an inspection to check a delivery of this SKU.', icon: 'scan', action: <StartInspectionLink sku={data.sku} small={false} /> }}
        />
      </Card>

      {editing && (
        <ProductFormModal
          mode="edit"
          product={data}
          onClose={() => setEditing(false)}
          onSaved={(saved) => { setEditing(false); setData((prev) => ({ ...prev, ...saved, inspections: prev?.inspections })); reload(); }}
        />
      )}
    </div>
  );
}
