import { useCallback, useMemo, useState } from 'react';
import { CAPTURE_VIEWS, checkLabel, effectiveDecision, formatBytes, formatTime, shortHash, viewLongLabel } from '../constants';
import { DataGate, DecisionPill, EmptyState, EvidenceImage, Icon, Modal, Panel } from './Shared';

const CHECK_BY_TYPE = {
  sku: 'sku_check', carton: 'carton_check', units_per_carton: 'units_per_carton_check', quantity: 'quantity_check',
  variant: 'variant_check', damage: 'damage_check', components: 'component_check',
};
const PAGE = 24;

// Every stored image across the organization's inspections, kept tied to its inspection and to the readings the
// backend recorded for that exact image_id. Nothing is inferred: an image with no readings says so.
function flatten(inspections) {
  const items = [];
  inspections.forEach((inspection) => {
    (inspection.images || []).forEach((image, index) => {
      const reads = (inspection.evidence || []).filter((e) => e.image_id === image.image_id);
      const checks = (inspection.checks || []).filter((c) => reads.some((r) => (c.evidence_ids || []).includes(r.evidence_id)));
      items.push({ inspection, image, index, reads, checks });
    });
  });
  return items.sort((a, b) => String(b.image.uploaded_at).localeCompare(String(a.image.uploaded_at)));
}

function EvidenceDetail({ item, onClose, onOpenInspection }) {
  const close = useCallback(() => onClose(), [onClose]);
  const { inspection, image, reads, checks } = item;
  return (
    <Modal title={`${viewLongLabel(image.image_type)} · ${image.image_id}`} subtitle={`${inspection.inspection_id} · PO ${inspection.po?.po_id || '—'} · ${inspection.po?.sku || '—'}`}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn" onClick={close}>Close</button>
          <button type="button" className="btn btn--primary" onClick={() => { close(); onOpenInspection(inspection.inspection_id); }}><Icon name="scan" size={15} /> Open inspection</button>
        </>
      )}>
      <div className="evidence-detail">
        <div className="evidence-detail__img"><EvidenceImage inspectionId={inspection.inspection_id} imageId={image.image_id} alt={image.filename} /></div>
        <div className="stack" style={{ gap: 14 }}>
          <dl className="meta meta--grid">
            <div><dt>File</dt><dd>{image.filename}</dd></div>
            <div><dt>Category</dt><dd>{viewLongLabel(image.image_type)}</dd></div>
            <div><dt>Size / type</dt><dd>{formatBytes(image.file_size)} · {image.mime_type}</dd></div>
            <div><dt>Uploaded</dt><dd>{formatTime(image.uploaded_at)}</dd></div>
            <div className="meta--full"><dt>SHA-256 (computed by the server at upload)</dt><dd>{image.sha256_digest || '—'}</dd></div>
          </dl>
          <div className="cell-badges"><span className="muted" style={{ fontSize: 13 }}>Inspection verdict</span><DecisionPill decision={effectiveDecision(inspection)} /></div>
          <div>
            <h3 className="subhead">Readings from this image</h3>
            {reads.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>No readings were recorded for this image{inspection.checks?.length ? ' (it may have shown nothing the checks could use, or perception was unavailable)' : ' (the inspection has not been analyzed)'}.</p>
            ) : (
              <ul className="read-list">
                {reads.map((read) => (
                  <li key={read.evidence_id}>
                    <div><b>{checkLabel(CHECK_BY_TYPE[read.check_type] || read.check_type)}</b>: <span className="mono">{read.observation}</span></div>
                    <small>{read.description} · confidence {Math.round(read.confidence * 100)}% (model-reported) · <span className="mono">{read.evidence_id}</span></small>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {checks.length > 0 && (
            <div>
              <h3 className="subhead">Checks this image supported</h3>
              <ul className="read-list">
                {checks.map((check) => (
                  <li key={check.check_name}><b>{checkLabel(check.check_name)}</b> · <span className={`tag tag--${check.status === 'PASS' ? 'pass' : check.status === 'FAIL' ? 'fail' : 'warn'}`}>{check.status}</span><small>{check.reason}</small></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function EvidenceView({ inspections, connected, loading, error, onRefresh, onConnect, onOpenInspection, onNavigate }) {
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState(null);
  const all = useMemo(() => flatten(inspections), [inspections]);
  const q = query.trim().toLowerCase();
  const items = all.filter((item) => (category === 'all' || item.image.image_type === category)
    && (!q || [item.inspection.inspection_id, item.inspection.po?.po_id, item.inspection.po?.sku, item.image.image_id, item.image.filename]
      .some((v) => String(v || '').toLowerCase().includes(q))));
  const closeDetail = useCallback(() => setSelected(null), []);

  return (
    <div className="stack">
      <Panel title="Evidence library" icon="image"
        sub="Photos stored by the backend, grouped by the category chosen at upload. Readings come from the inspection's analysis for that exact image."
        actions={<button type="button" className="btn btn--sm" onClick={onRefresh} disabled={loading || !connected}>{loading ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={14} />} Refresh</button>}>
        <DataGate connected={connected} loading={loading} error={error} hasData={inspections.length > 0} onRetry={onRefresh} onConnect={onConnect}>
          <div className="filters">
            <div className="search">
              <Icon name="search" size={15} />
              <input className="input" type="search" placeholder="Search inspection, PO, SKU, image ID, file…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search evidence" />
            </div>
            <div className="segmented" role="group" aria-label="Filter by evidence category">
              <button type="button" className={category === 'all' ? 'is-on' : ''} aria-pressed={category === 'all'} onClick={() => setCategory('all')}>All<span className="segmented__n">{all.length}</span></button>
              {CAPTURE_VIEWS.map((view) => (
                <button key={view.key} type="button" className={category === view.key ? 'is-on' : ''} aria-pressed={category === view.key} onClick={() => setCategory(view.key)}>
                  {view.short}<span className="segmented__n">{all.filter((i) => i.image.image_type === view.key).length}</span>
                </button>
              ))}
            </div>
          </div>
          {items.length === 0 ? (
            all.length
              ? <EmptyState icon="search" title="No matching evidence">Try another category or search.</EmptyState>
              : <EmptyState icon="image" title="No evidence stored yet" action={<button type="button" className="btn btn--primary btn--sm" onClick={() => onNavigate('inspect')}><Icon name="upload" size={14} /> Upload evidence</button>}>Photos uploaded during an inspection appear here.</EmptyState>
          ) : (
            <>
              <div className="evidence-grid">
                {items.slice(0, limit).map((item) => (
                  <button key={item.image.image_id} type="button" className="evidence-card" onClick={() => setSelected(item)}>
                    <span className="evidence-card__img"><EvidenceImage inspectionId={item.inspection.inspection_id} imageId={item.image.image_id} alt={item.image.filename} /></span>
                    <span className="evidence-card__body">
                      <span className="evidence-card__row"><b>{viewLongLabel(item.image.image_type)}</b><DecisionPill decision={effectiveDecision(item.inspection)} qualifier={false} /></span>
                      <span className="mono evidence-card__id">{item.inspection.inspection_id} · {item.inspection.po?.sku}</span>
                      <span className="evidence-card__meta">{item.reads.length ? `${item.reads.length} reading${item.reads.length === 1 ? '' : 's'}` : 'no readings'} · {shortHash(item.image.sha256_digest)}</span>
                    </span>
                  </button>
                ))}
              </div>
              {items.length > limit && (
                <div style={{ textAlign: 'center', marginTop: 14 }}>
                  <button type="button" className="btn btn--sm" onClick={() => setLimit((n) => n + PAGE)}>Load more ({items.length - limit} remaining)</button>
                </div>
              )}
            </>
          )}
        </DataGate>
      </Panel>
      {selected && <EvidenceDetail item={selected} onClose={closeDetail} onOpenInspection={onOpenInspection} />}
    </div>
  );
}
