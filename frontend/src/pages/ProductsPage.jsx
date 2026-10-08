/*
 * ProductsPage — catalogue products (GET /api/products, q + supplier filters, paginated) with create (POST) and
 * inline edit (PUT) modals. Filters and pagination live in the hash query.
 */
import { useState } from 'react';
import { listProducts } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { formatDateTime, formatNumber, listParamsFromQuery } from '../lib/format';
import { Card, ConnectPrompt, DataTable, FilterBar, Icon, Link, PageHeader, Pagination } from '../components/ui';
import { ImportCatalogueModal, ProductFormModal } from './ops/forms';
import { StartInspectionLink, TextFilter } from './ops/shared';
import '../styles/ops.css';

export default function ProductsPage({ route }) {
  const params = listParamsFromQuery(route.query, ['q', 'supplier']);
  const { data, error, loading, reload, notConnected } = useApi(() => listProducts(params), [JSON.stringify(params)]);
  const [modal, setModal] = useState(null);

  if (notConnected) return <Card><ConnectPrompt /></Card>;
  const hasFilters = Boolean(route.query.q || route.query.supplier);

  return (
    <div className="stack">
      <PageHeader
        title="Products"
        subtitle="The SKU catalogue inspections are checked against (name, variant, units per carton, expected components)."
        icon="tag"
        actions={(
          <>
            <button type="button" className="btn-theme" onClick={() => setModal({ kind: 'import' })}><Icon name="upload" size={14} /> Import catalogue</button>
            <button type="button" className="btn-primary" onClick={() => setModal({ kind: 'create' })}><Icon name="plus" size={14} /> New product</button>
          </>
        )}
      />
      <FilterBar
        search={{ value: route.query.q, placeholder: 'Search SKU, ASIN, name, variant, supplier…', onChange: (q) => setQuery({ q, page: 1 }) }}
        onReset={hasFilters ? () => navigate('products') : undefined}
        resultCount={data?.total}
      >
        <TextFilter label="Supplier (exact)" value={route.query.supplier} onChange={(supplier) => setQuery({ supplier, page: 1 })} />
      </FilterBar>
      <Card flush>
        <DataTable
          rows={data?.items}
          rowKey="sku"
          loading={loading}
          error={error}
          onRetry={reload}
          onRowClick={(row) => navigate(pathFor('products', row.sku))}
          empty={hasFilters
            ? { title: 'No products match', message: 'Clear the filters to see the whole catalogue.', icon: 'search' }
            : {
              title: 'No products yet',
              message: 'Create a product or import the catalogue CSV.',
              icon: 'tag',
              action: (
                <span className="row-actions">
                  <button type="button" className="btn-theme" onClick={() => setModal({ kind: 'import' })}><Icon name="upload" size={14} /> Import catalogue</button>
                  <button type="button" className="btn-primary" onClick={() => setModal({ kind: 'create' })}><Icon name="plus" size={14} /> New product</button>
                </span>
              ),
            }}
          columns={[
            { key: 'sku', header: 'SKU', render: (r) => <Link to={pathFor('products', r.sku)} className="link mono">{r.sku}</Link> },
            { key: 'product_name', header: 'Product', render: (r) => (
              <span className="ops-cell-stack"><span>{r.product_name}</span>{r.asin && <span className="hint mono">ASIN {r.asin}</span>}</span>
            ) },
            { key: 'variant', header: 'Variant', render: (r) => [r.variant, r.colour].filter(Boolean).join(' · ') || '—' },
            { key: 'units_per_carton', header: 'Units / carton', align: 'right', render: (r) => formatNumber(r.units_per_carton) },
            { key: 'expected_components', header: 'Components' },
            { key: 'supplier', header: 'Supplier' },
            { key: 'updated_at', header: 'Updated', render: (r) => formatDateTime(r.updated_at) },
            { key: 'actions', header: '', render: (r) => (
              <span className="row-actions ops-nowrap">
                <button type="button" className="detail-btn" onClick={(e) => { e.stopPropagation(); setModal({ kind: 'edit', product: r }); }}>
                  <Icon name="settings" size={13} /> Edit
                </button>
                <StartInspectionLink sku={r.sku} label="Inspect" />
              </span>
            ) },
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

      {modal?.kind === 'create' && (
        <ProductFormModal mode="create" onClose={() => setModal(null)} onSaved={(p) => { setModal(null); navigate(pathFor('products', p.sku)); }} />
      )}
      {modal?.kind === 'edit' && (
        <ProductFormModal mode="edit" product={modal.product} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />
      )}
      {modal?.kind === 'import' && <ImportCatalogueModal onClose={() => setModal(null)} onImported={() => reload()} />}
    </div>
  );
}
