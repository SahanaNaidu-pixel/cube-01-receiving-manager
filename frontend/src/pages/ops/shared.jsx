/*
 * Shared pieces for the Orders & Stock and Integration pages.
 *   <StartInspectionLink po sku />      → #/app/new-inspection?po=<po>&sku=<sku> (wizard prefills from the API)
 *   <DiscrepancyBadge value />          none | short | over | unverified (with explanation tooltip)
 *   <ConditionBadge kind value />       seal/visible carton condition, severity-coloured
 *   <InspectionSummaryTable rows … />   inspection summaries or full inspection views (product/shipment/PO pages)
 *   <EvidenceThumb inspectionId imageId /> authenticated image thumbnail (object URL revoked on unmount)
 *   <VerdictCounts counts />            PASS/FAIL/UNCERTAIN/NOT_ANALYZED counters
 *   <TextFilter value onChange label /> debounced text input bound to a query key
 */
import { useEffect, useRef, useState } from 'react';
import { fetchInspectionImageUrl } from '../../services/api';
import { pathFor } from '../../lib/router';
import { formatDateTime, formatNumber } from '../../lib/format';
import { DataTable, Icon, Link, StatusBadge, VerdictBadge } from '../../components/ui';
import { navigate } from '../../lib/router';

export function StartInspectionLink({ po, sku, label = 'Start inspection', small = true }) {
  const query = {};
  if (po) query.po = po;
  if (sku) query.sku = sku;
  return (
    <Link to="new-inspection" query={query} className={small ? 'detail-btn ops-inline-btn' : 'btn-primary ops-inline-btn'}
      title={`Open the New Inspection wizard prefilled with${po ? ` PO ${po}` : ''}${sku ? ` SKU ${sku}` : ''}`}>
      <Icon name="scan" size={13} /> {label}
    </Link>
  );
}

export const DISCREPANCY_HELP = {
  none: 'Observed quantity equals the expected quantity.',
  short: 'Fewer units were observed than the PO line expects.',
  over: 'More units were observed than the PO line expects.',
  unverified: 'No observed count yet: no analysed inspection of this PO line has an observed total quantity.',
};

export function DiscrepancyBadge({ value }) {
  const key = String(value || 'unverified').toLowerCase();
  return (
    <span title={DISCREPANCY_HELP[key] || ''}>
      <StatusBadge status={key} label={key === 'none' ? 'No discrepancy' : undefined} />
    </span>
  );
}

const SEAL_TONES = { intact: 'success', resealed: 'warning', broken: 'danger', unknown: 'neutral' };
const VISIBLE_TONES = {
  good: 'success', label_damaged: 'warning', crushed: 'danger', torn: 'danger', punctured: 'danger',
  wet: 'danger', open: 'danger', unknown: 'neutral',
};

export function conditionTone(kind, value) {
  const key = String(value || 'unknown').toLowerCase();
  return (kind === 'seal' ? SEAL_TONES : VISIBLE_TONES)[key] || 'neutral';
}

export function ConditionBadge({ kind, value }) {
  return <StatusBadge status={value || 'unknown'} tone={conditionTone(kind, value)} />;
}

export function VerdictCounts({ counts = {} }) {
  const items = [
    ['PASS', 'Pass'], ['FAIL', 'Fail'], ['UNCERTAIN', 'Uncertain'], ['NOT_ANALYZED', 'Not analyzed'],
  ];
  return (
    <span className="ops-verdict-counts">
      {items.map(([key, label]) => (
        <span key={key} className={`ops-vc v-${key} ${counts[key] ? '' : 'is-zero'}`} title={`${label}: ${counts[key] || 0}`}>
          <i />{counts[key] || 0}
        </span>
      ))}
    </span>
  );
}

export function InspectionSummaryTable({ rows, loading, error, onRetry, empty, showPo = true, showSku = true }) {
  const columns = [
    { key: 'inspection_id', header: 'Inspection', render: (r) => <Link to={pathFor('inspections', r.inspection_id)} className="link mono">{r.inspection_id}</Link> },
    showPo && { key: 'po_id', header: 'PO', render: (r) => { const po = r.po_id ?? r.po?.po_id; return po ? <Link to={pathFor('purchase-orders', po)} className="link mono">{po}</Link> : '—'; } },
    showSku && { key: 'sku', header: 'SKU', render: (r) => { const sku = r.sku ?? r.po?.sku; return sku ? <Link to={pathFor('products', sku)} className="link mono">{sku}</Link> : '—'; } },
    { key: 'verdict', header: 'Verdict', render: (r) => <VerdictBadge verdict={r.verdict} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'image_count', header: 'Images', align: 'right', render: (r) => formatNumber(r.image_count ?? r.images?.length) },
    { key: 'open_issue_count', header: 'Open issues', align: 'right', render: (r) => (r.open_issue_count ? <StatusBadge status="open" tone="danger" label={String(r.open_issue_count)} /> : '0') },
    { key: 'channel', header: 'Channel', render: (r) => r.channel || '—' },
    { key: 'created_at', header: 'Created', render: (r) => formatDateTime(r.created_at) },
  ].filter(Boolean);
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey="inspection_id"
      loading={loading}
      error={error}
      onRetry={onRetry}
      onRowClick={(r) => navigate(pathFor('inspections', r.inspection_id))}
      empty={empty || { title: 'No inspections yet', icon: 'scan' }}
      skeletonRows={3}
    />
  );
}

export function EvidenceThumb({ inspectionId, imageId, size = 120 }) {
  const [state, setState] = useState({ url: '', error: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    let created = '';
    setState({ url: '', error: null, loading: true });
    fetchInspectionImageUrl(inspectionId, imageId)
      .then((url) => {
        created = url;
        if (cancelled) URL.revokeObjectURL(url);
        else setState({ url, error: null, loading: false });
      })
      .catch((error) => { if (!cancelled) setState({ url: '', error, loading: false }); });
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created); };
  }, [inspectionId, imageId]);

  return (
    <figure className="ops-thumb" style={{ width: size }}>
      <Link to={pathFor('evidence', imageId)} className="ops-thumb-frame" style={{ height: size }} title={`Open evidence ${imageId}`}>
        {state.loading && <span className="spinner ui-spinner-accent" aria-label="Loading image" />}
        {state.url && <img src={state.url} alt={`Evidence ${imageId}`} />}
        {state.error && <span className="ops-thumb-error" title={state.error.message}><Icon name="alert" size={16} /> Unavailable</span>}
      </Link>
      <figcaption className="mono">{imageId}</figcaption>
    </figure>
  );
}

export function TextFilter({ value = '', onChange, label, placeholder, delay = 400 }) {
  const [text, setText] = useState(value || '');
  const timer = useRef(null);
  useEffect(() => { setText(value || ''); }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <label className="ops-text-filter">
      <span className="sr-only">{label}</span>
      <input
        className="filter-input"
        value={text}
        placeholder={placeholder || label}
        aria-label={label}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => onChange(next.trim()), delay);
        }}
        onKeyDown={(event) => { if (event.key === 'Enter') { window.clearTimeout(timer.current); onChange(text.trim()); } }}
      />
    </label>
  );
}

/** "cap, label" → ['cap', 'label'] */
export const splitList = (text) => String(text || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

/** Number-or-undefined parse for optional integer inputs. */
export function parseIntField(value) {
  if (value === '' || value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

export function FieldError({ children }) {
  if (!children) return null;
  return <span className="ops-field-error" role="alert">{children}</span>;
}

export function NotFoundOr({ error, children }) {
  return error?.status === 404 ? children : null;
}

/** Text for an A2A/activity error object ({code, message}) or string. */
export function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return [error.code, error.message].filter(Boolean).join(': ') || JSON.stringify(error);
}
