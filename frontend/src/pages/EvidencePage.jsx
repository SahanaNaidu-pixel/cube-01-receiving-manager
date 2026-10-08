/*
 * EvidencePage — every uploaded photo with provenance and analysis status (GET /api/evidence).
 * Hash query: q, inspection_id, view, analysis_status, range/date_from/date_to, page, page_size, layout=grid|table.
 * Thumbnails are fetched with the API key only when scrolled into view.
 */
import { listEvidence } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { navigate, pathFor, setQuery } from '../lib/router';
import { formatBytes, formatDateTime, formatRelative, humanize, listParamsFromQuery } from '../lib/format';
import {
  Card, ConnectPrompt, DataTable, EmptyState, ErrorState, FilterBar, Icon, Link, PageHeader, Pagination, Skeleton,
  StatusBadge,
} from '../components/ui';
import { EvidenceThumb, TextFilter } from './review/components';
import { ANALYSIS_STATUSES, EVIDENCE_VIEWS } from './review/constants';
import '../styles/review.css';

const STATUS_LABEL = Object.fromEntries(ANALYSIS_STATUSES.map((s) => [s.value, s.label]));

export default function EvidencePage({ route }) {
  const query = route.query;
  const layout = query.layout === 'table' ? 'table' : 'grid';
  const params = listParamsFromQuery(query, ['q', 'inspection_id', 'view', 'analysis_status'], { pageSize: layout === 'grid' ? 24 : 25 });
  const { data, error, loading, reload, notConnected } = useApi(() => listEvidence(params), [JSON.stringify(params)]);

  if (notConnected) return <Card><ConnectPrompt /></Card>;
  const items = data?.items || [];

  return (
    <div className="stack">
      <PageHeader
        title="Evidence"
        icon="image"
        subtitle="Every uploaded photo with its SHA-256 digest, source, uploader and analysis status. Readings are only shown where the vision provider or an operator actually produced them."
        actions={(
          <button type="button" className="btn-theme" onClick={() => reload()} disabled={loading}>
            {loading ? <span className="spinner ui-spinner-accent" aria-hidden="true" /> : null} Refresh
          </button>
        )}
      />

      <FilterBar
        search={{ value: query.q, placeholder: 'Search evidence id, inspection, filename, PO, SKU, digest…', onChange: (q) => setQuery({ q, page: 1 }) }}
        selects={[
          { key: 'view', label: 'View', allLabel: 'All views', value: query.view, options: EVIDENCE_VIEWS, onChange: (view) => setQuery({ view, page: 1 }) },
          { key: 'analysis_status', label: 'Analysis', allLabel: 'Any analysis status', value: query.analysis_status, options: ANALYSIS_STATUSES,
            onChange: (analysisStatus) => setQuery({ analysis_status: analysisStatus, page: 1 }) },
        ]}
        dateRange={{ value: query, onChange: (patch) => setQuery({ ...patch, page: 1 }) }}
        onReset={() => navigate('evidence', layout === 'table' ? { layout } : undefined)}
        resultCount={data?.total}
      >
        <TextFilter label="Inspection id" value={query.inspection_id} width={160} onChange={(v) => setQuery({ inspection_id: v, page: 1 })} />
        <div className="segmented-control rv-view-toggle" role="group" aria-label="Layout">
          <button type="button" className={layout === 'grid' ? 'active' : ''} aria-pressed={layout === 'grid'}
            onClick={() => setQuery({ layout: '', page: 1, page_size: '' })}><Icon name="grid" size={13} /> Grid</button>
          <button type="button" className={layout === 'table' ? 'active' : ''} aria-pressed={layout === 'table'}
            onClick={() => setQuery({ layout: 'table', page: 1, page_size: '' })}><Icon name="list" size={13} /> Table</button>
        </div>
      </FilterBar>

      <Card flush className="rv-table-card">
        {layout === 'grid' ? (
          <>
            {error && !items.length && <div className="card-body"><ErrorState error={error} onRetry={reload} title="Could not load evidence" /></div>}
            {error && items.length > 0 && <div className="card-body"><ErrorState compact error={error} onRetry={reload} title="Refresh failed — showing the previous results" /></div>}
            {loading && !items.length && !error && (
              <div className="rv-ev-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="rv-ev-card"><Skeleton lines={4} height={18} /></div>)}</div>
            )}
            {!loading && !error && !items.length && (
              <EmptyState icon="image" title="No evidence matches"
                message="Photos appear here once they are uploaded to an inspection (web upload or A2A). Try clearing a filter." />
            )}
            {items.length > 0 && (
              <div className={`rv-ev-grid ${loading ? 'is-refreshing' : ''}`}>
                {items.map((file) => (
                  <article key={file.evidence_id} className="rv-ev-card">
                    <EvidenceThumb inspectionId={file.inspection_id} imageId={file.evidence_id} alt={file.filename}
                      size="lg" to={pathFor('evidence', file.evidence_id)} caption={null} />
                    <div className="rv-ev-meta">
                      <div className="rv-ev-meta-row">
                        <Link to={pathFor('evidence', file.evidence_id)} className="link mono">{file.evidence_id}</Link>
                        <StatusBadge status={file.analysis_status} label={STATUS_LABEL[file.analysis_status]} />
                      </div>
                      <div className="rv-ev-meta-row">
                        <span title={file.filename}>{file.filename}</span>
                        <span className="hint">{humanize(file.view)}</span>
                      </div>
                      <div className="rv-ev-meta-row">
                        <Link to={pathFor('inspections', file.inspection_id)} className="link mono">{file.inspection_id}</Link>
                        <span className="hint" title={formatDateTime(file.uploaded_at)}>{formatRelative(file.uploaded_at)}</span>
                      </div>
                      <div className="rv-ev-meta-row hint">
                        <span>{file.readings?.length || 0} reading(s) · {file.linked_issue_ids?.length || 0} issue(s)</span>
                        <span>{formatBytes(file.file_size)}</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        ) : (
          <DataTable
            rows={items}
            rowKey="evidence_id"
            loading={loading}
            error={error}
            onRetry={reload}
            onRowClick={(row) => navigate(pathFor('evidence', row.evidence_id))}
            empty={{ icon: 'image', title: 'No evidence matches', message: 'Try clearing a filter or widening the date range.' }}
            columns={[
              { key: 'thumb', header: <span className="sr-only">Preview</span>, render: (r) => <EvidenceThumb inspectionId={r.inspection_id} imageId={r.evidence_id} alt={r.filename} size="sm" caption={null} /> },
              {
                key: 'evidence_id', header: 'Evidence', render: (r) => (
                  <div className="rv-cell-stack">
                    <Link to={pathFor('evidence', r.evidence_id)} className="link mono">{r.evidence_id}</Link>
                    <span className="hint" title={r.filename}>{r.filename}</span>
                  </div>
                ),
              },
              { key: 'inspection_id', header: 'Inspection', render: (r) => <Link to={pathFor('inspections', r.inspection_id)} className="link mono">{r.inspection_id}</Link> },
              { key: 'po', header: 'PO / SKU', render: (r) => <div className="rv-cell-stack"><span className="mono">{r.po_id || '—'}</span><span className="hint mono">{r.sku || '—'}</span></div> },
              { key: 'view', header: 'View', render: (r) => humanize(r.view) },
              { key: 'analysis_status', header: 'Analysis', render: (r) => <StatusBadge status={r.analysis_status} label={STATUS_LABEL[r.analysis_status]} /> },
              { key: 'readings', header: 'Readings', align: 'right', render: (r) => r.readings?.length || 0 },
              { key: 'issues', header: 'Issues', align: 'right', render: (r) => r.linked_issue_ids?.length || 0 },
              { key: 'source', header: 'Source', render: (r) => <span>{r.source === 'a2a' ? 'A2A' : 'Upload'} · {r.uploaded_by || '—'}</span> },
              { key: 'file_size', header: 'Size', align: 'right', render: (r) => formatBytes(r.file_size) },
              { key: 'uploaded_at', header: 'Uploaded', align: 'right', render: (r) => <span title={formatDateTime(r.uploaded_at)}>{formatRelative(r.uploaded_at)}</span> },
            ]}
          />
        )}
        <Pagination
          page={data?.page} pageSize={data?.page_size} total={data?.total}
          pageSizeOptions={layout === 'grid' ? [24, 48, 96, 192] : undefined}
          onPageChange={(page) => setQuery({ page })}
          onPageSizeChange={(page_size) => setQuery({ page_size, page: 1 })}
        />
      </Card>
    </div>
  );
}
