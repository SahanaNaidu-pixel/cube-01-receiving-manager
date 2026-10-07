import { useCallback, useState } from 'react';
import { effectiveDecision, failedCategories, formatTime, shortHash, viewLabel } from '../constants';
import { Card, ChecksTable, DecisionPill, EvidenceImage, Icon, Modal, VerifyIntegrity } from './Shared';

function InspectionDetails({ item, onClose, onOpenInspection }) {
  const close = useCallback(() => onClose(), [onClose]);
  return (
    <Modal
      title={`Inspection ${item.inspection_id}`}
      subtitle={`${item.po?.po_id || '—'} · ${item.po?.product_name || '—'} · created ${formatTime(item.created_at)}`}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn btn--secondary" onClick={close}>Close</button>
          <button type="button" className="btn btn--primary" onClick={() => { close(); onOpenInspection(item.inspection_id); }}>
            <Icon name="scan" size={15} /> Open in workspace
          </button>
        </>
      )}
    >
      <div className="detail-head">
        <DecisionPill decision={effectiveDecision(item)} />
        {item.override_decision && <span className="hint">Agent decision {item.final_decision} · overridden</span>}
        {failedCategories(item).map((category) => <span key={category} className="tag tag--danger">{category}</span>)}
      </div>
      <dl className="meta-list meta-list--grid">
        <div><dt>SKU</dt><dd className="mono">{item.po?.sku || '—'}</dd></div>
        <div><dt>Variant</dt><dd>{item.po?.variant || '—'}</dd></div>
        <div><dt>Expected</dt><dd>{item.po?.expected_quantity ?? '—'} units / {item.po?.expected_cartons ?? '—'} cartons</dd></div>
        <div><dt>Evidence record</dt><dd className="mono">{item.record ? `v${item.record.version} · ${shortHash(item.record.content_hash)}` : '—'}</dd></div>
      </dl>
      {item.agent_summary && <p className="summary-text">{item.agent_summary}</p>}
      <VerifyIntegrity inspectionId={item.inspection_id} />
      {(item.checks || []).length > 0 && <ChecksTable checks={item.checks} />}
      {(item.images || []).length > 0 && (
        <div className="gallery gallery--compact">
          {item.images.map((image) => (
            <figure key={image.image_id} className="thumb">
              <EvidenceImage inspectionId={item.inspection_id} imageId={image.image_id} alt={image.filename} />
              <figcaption>
                <span className="thumb__view">{viewLabel(image.image_type)}</span>
                <span className="thumb__name">{image.filename}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function LedgerView({ inspections, loading, connected, onRefresh, onOpenInspection }) {
  const [detailId, setDetailId] = useState('');
  const sorted = [...inspections].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const detail = sorted.find((item) => item.inspection_id === detailId);
  const closeDetail = useCallback(() => setDetailId(''), []);

  return (
    <Card
      title="Inspections"
      icon="list"
      subtitle="Every inspection for your organization. Open one in the workspace, view its details, or verify its sealed record chain."
      actions={(
        <button type="button" className="btn btn--secondary btn--sm" onClick={onRefresh} disabled={loading || !connected}>
          <Icon name="refresh" size={14} /> {loading ? 'Loading…' : 'Refresh'}
        </button>
      )}
    >
      {!connected && (
        <div className="alert alert--warning"><Icon name="key" /><span className="alert__text">Connect with an API key to load the ledger.</span></div>
      )}
      {connected && sorted.length === 0 && !loading && (
        <div className="empty-inline"><Icon name="truck" size={22} /><span>No inspections yet.</span></div>
      )}

      {sorted.length > 0 && (
        <div className="table-wrap">
          <table className="table table--hover">
            <thead>
              <tr><th>Inspection</th><th>Purchase order</th><th>Receiving status</th><th>Created</th><th>Record</th><th>Photos</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {sorted.map((item) => (
                <tr key={item.inspection_id}>
                  <td>
                    <button type="button" className="link mono" onClick={() => onOpenInspection(item.inspection_id)}>
                      {item.inspection_id}
                    </button>
                  </td>
                  <td>
                    <div className="table__strong">{item.po?.po_id}</div>
                    <div className="table__sub">{item.po?.product_name}</div>
                  </td>
                  <td>
                    <div className="cell-badges">
                      <DecisionPill decision={effectiveDecision(item)} />
                      {item.override_decision && <span className="tag">overridden</span>}
                      {failedCategories(item).map((category) => <span key={category} className="tag tag--danger">{category}</span>)}
                    </div>
                  </td>
                  <td className="nowrap">{formatTime(item.created_at)}</td>
                  <td className="mono">{item.record ? `v${item.record.version} · ${shortHash(item.record.content_hash)}` : '—'}</td>
                  <td>{item.images?.length ?? 0}</td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDetailId(item.inspection_id)}>
                        <Icon name="eye" size={14} /> Details
                      </button>
                      <VerifyIntegrity inspectionId={item.inspection_id} compact />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && <InspectionDetails item={detail} onClose={closeDetail} onOpenInspection={onOpenInspection} />}
    </Card>
  );
}
