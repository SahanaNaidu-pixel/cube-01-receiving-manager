/*
 * Inspections — every receiving inspection, filtered server-side (GET /api/inspections).
 * All filters live in the hash query so views are shareable and the dashboard deep links work:
 *   q, verdict (comma list: PASS,FAIL,UNCERTAIN,NOT_ANALYZED), status, supplier, sku, po,
 *   range (today|7d|30d|custom) / date_from / date_to, has_open_issues (true|false), sort, order, page, page_size.
 */
import { listInspections } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { formatDateTime, formatRelative, listParamsFromQuery } from '../lib/format';
import { navigate, pathFor, setQuery } from '../lib/router';
import {
  Card, ConnectPrompt, DataTable, FilterBar, Icon, Link, PageHeader, Pagination, StatusBadge, VerdictBadge,
} from '../components/ui';
import { DebouncedInput } from './inspection/components';
import '../styles/inspection.css';

const VERDICTS = [
  { value: 'PASS', label: 'Pass' },
  { value: 'FAIL', label: 'Fail' },
  { value: 'UNCERTAIN', label: 'Uncertain' },
  { value: 'NOT_ANALYZED', label: 'Not analyzed' },
];

const FILTER_KEYS = ['q', 'verdict', 'status', 'supplier', 'sku', 'po', 'has_open_issues', 'sort', 'order'];
const SORT_KEYS = ['created_at', 'updated_at', 'po_id', 'sku', 'verdict'];

export default function InspectionsPage({ route }) {
  const query = route.query;
  const params = listParamsFromQuery(query, FILTER_KEYS);
  if (params.sort && !SORT_KEYS.includes(params.sort)) delete params.sort;
  const { data, error, loading, reload, notConnected } = useApi(() => listInspections(params), [JSON.stringify(params)]);

  const selectedVerdicts = String(query.verdict || '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
  const toggleVerdict = (value) => {
    const next = selectedVerdicts.includes(value) ? selectedVerdicts.filter((v) => v !== value) : [...selectedVerdicts, value];
    setQuery({ verdict: next.join(','), page: 1 });
  };
  const hasFilters = FILTER_KEYS.some((k) => k !== 'sort' && k !== 'order' && query[k]) || query.range || query.date_from || query.date_to;

  const newButton = <Link to="new-inspection" className="btn-primary"><Icon name="plus" size={14} /> New inspection</Link>;

  if (notConnected) {
    return (
      <div className="stack">
        <PageHeader title="Inspections" subtitle="Every receiving inspection in your organisation." actions={newButton} />
        <Card><ConnectPrompt /></Card>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHeader title="Inspections" subtitle="Every receiving inspection — search and filter by verdict, supplier, SKU, PO and date." actions={newButton} />
      <Card flush>
        <div className="insp-filters">
          <FilterBar
            search={{ value: query.q, placeholder: 'Search ID, PO, SKU, product, supplier, shipment…', onChange: (q) => setQuery({ q, page: 1 }) }}
            selects={[
              { key: 'status', label: 'Status', value: query.status,
                options: [{ value: 'draft', label: 'Draft' }, { value: 'pending', label: 'Pending review' }, { value: 'completed', label: 'Completed' }],
                onChange: (status) => setQuery({ status, page: 1 }) },
              { key: 'has_open_issues', label: 'Open issues', value: query.has_open_issues, allLabel: 'Any issues',
                options: [{ value: 'true', label: 'Has open issues' }, { value: 'false', label: 'No open issues' }],
                onChange: (v) => setQuery({ has_open_issues: v, page: 1 }) },
            ]}
            dateRange={{ value: query, onChange: (patch) => setQuery({ ...patch, page: 1 }) }}
            onReset={hasFilters ? () => navigate('inspections', query.sort ? { sort: query.sort, order: query.order } : undefined) : undefined}
            resultCount={data?.total}
          />
          <div className="insp-filter-row">
            <div className="chip-group" role="group" aria-label="Verdict filter">
              {VERDICTS.map((v) => (
                <button key={v.value} type="button" aria-pressed={selectedVerdicts.includes(v.value)}
                  className={`chip insp-vchip vc-${v.value} ${selectedVerdicts.includes(v.value) ? 'active' : ''}`} onClick={() => toggleVerdict(v.value)}>
                  {v.label}
                </button>
              ))}
            </div>
            <DebouncedInput value={query.supplier} placeholder="Supplier (exact)" onCommit={(supplier) => setQuery({ supplier, page: 1 })} />
            <DebouncedInput value={query.sku} placeholder="SKU (exact)" onCommit={(sku) => setQuery({ sku, page: 1 })} />
            <DebouncedInput value={query.po} placeholder="PO number (exact)" onCommit={(po) => setQuery({ po, page: 1 })} />
          </div>
        </div>
        <DataTable
          rows={data?.items}
          rowKey="inspection_id"
          loading={loading}
          error={error}
          onRetry={reload}
          onRowClick={(row) => navigate(pathFor('inspections', row.inspection_id))}
          sort={{ key: params.sort || 'created_at', order: params.order || 'desc' }}
          onSortChange={(sort, order) => setQuery({ sort, order, page: 1 })}
          empty={hasFilters
            ? { icon: 'filter', title: 'No inspections match these filters', message: 'Widen the date range or clear filters.',
              action: <button type="button" className="btn-theme" onClick={() => navigate('inspections')}>Reset filters</button> }
            : { icon: 'scan', title: 'No inspections yet', message: 'Start the first receiving inspection.', action: newButton }}
          columns={[
            { key: 'inspection_id', header: 'Inspection', render: (r) => <Link to={pathFor('inspections', r.inspection_id)} className="link mono">{r.inspection_id}</Link> },
            { key: 'created_at', header: 'Created', sortable: true, render: (r) => <span title={formatDateTime(r.created_at)}>{formatRelative(r.created_at)}</span> },
            { key: 'po_id', header: 'PO', sortable: true, mono: true, render: (r) => r.po?.po_id || '—' },
            { key: 'sku', header: 'SKU / product', sortable: true, render: (r) => (
              <div><div className="mono">{r.po?.sku || '—'}</div><div className="insp-cell-sub">{r.po?.product_name}</div></div>
            ) },
            { key: 'supplier', header: 'Supplier', render: (r) => r.shipment?.supplier || '—' },
            { key: 'verdict', header: 'Verdict', sortable: true, render: (r) => <VerdictBadge verdict={r.record ? r.verdict : null} /> },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'open_issue_count', header: 'Open issues', align: 'right', render: (r) => (r.open_issue_count ? <strong className="insp-count-bad">{r.open_issue_count}</strong> : '0') },
            { key: 'images', header: 'Photos', align: 'right', render: (r) => r.images?.length ?? 0 },
            { key: 'review', header: 'Review', render: (r) => (r.review_task ? <StatusBadge status={r.review_task.status} /> : '—') },
            { key: 'updated_at', header: 'Updated', sortable: true, render: (r) => formatDateTime(r.updated_at) },
          ]}
        />
        <Pagination page={data?.page} pageSize={data?.page_size} total={data?.total}
          onPageChange={(page) => setQuery({ page })} onPageSizeChange={(page_size) => setQuery({ page_size, page: 1 })} />
      </Card>
    </div>
  );
}
