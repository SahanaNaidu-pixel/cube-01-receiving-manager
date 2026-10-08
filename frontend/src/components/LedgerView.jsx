import { useCallback, useMemo, useState } from 'react';
import { DECISION_META, agentDecision, decisionMeta, effectiveDecision, failedCategories, formatTime, shortHash } from '../constants';
import {
  Card, CheckCards, DecisionPill, Gallery, HeroStats, Icon, Modal, ModalSection, OverrideTimeline, VerifyIntegrity,
} from './Shared';

export function InspectionDetails({ item, onClose, onOpenInspection }) {
  const close = useCallback(() => onClose(), [onClose]);
  const decision = effectiveDecision(item);
  const categories = failedCategories(item);
  const agentVerdict = agentDecision(item);
  return (
    <Modal
      wide
      title={`Inspection ${item.inspection_id}`}
      subtitle={`${item.po?.po_id || '—'} · ${item.po?.product_name || '—'} · created ${formatTime(item.created_at)}`}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn-theme" onClick={close}>Close</button>
          <button type="button" className="btn-primary" onClick={() => { close(); onOpenInspection(item.inspection_id); }}>
            <Icon name="scan" size={15} /> Open in workspace
          </button>
        </>
      )}
    >
      <HeroStats
        items={[
          { label: 'Decision', value: decisionMeta(decision).label, className: `d-${decision}` },
          { label: 'Photos', value: item.images?.length ?? 0 },
          { label: 'Evidence record', value: item.record ? `v${item.record.version}` : '—' },
        ]}
      />

      <ModalSection title="Purchase order">
        <dl className="modal-kv">
          <dt className="modal-key">SKU</dt><dd className="modal-val mono">{item.po?.sku || '—'}</dd>
          <dt className="modal-key">Variant</dt><dd className="modal-val">{item.po?.variant || '—'}</dd>
          <dt className="modal-key">Expected</dt><dd className="modal-val">{item.po?.expected_quantity ?? '—'} units / {item.po?.expected_cartons ?? '—'} cartons</dd>
          <dt className="modal-key">Exception categories</dt>
          <dd className="modal-val">
            <span className="cell-badges">
              {categories.length ? categories.map((category) => <span key={category} className="cat-flag">{category}</span>) : 'none'}
              {item.override_decision && (
                <span className="dup-flag">overridden{agentVerdict ? ` (agent: ${decisionMeta(agentVerdict).label})` : ''}</span>
              )}
            </span>
          </dd>
          <dt className="modal-key">Record hash</dt><dd className="modal-val mono">{item.record ? shortHash(item.record.content_hash) : '—'}</dd>
        </dl>
      </ModalSection>

      {item.agent_summary && (
        <ModalSection title="Agent summary">
          <div className="claim-reasoning flush">{item.agent_summary}</div>
        </ModalSection>
      )}

      {(item.checks || []).length > 0 && (
        <ModalSection title="Checks">
          <CheckCards checks={item.checks} />
        </ModalSection>
      )}

      {(item.overrides?.length > 0 || item.override_decision) && (
        <ModalSection title="Override history">
          <OverrideTimeline
            overrides={item.overrides || []}
            fallback={item.override_decision ? { decision: item.override_decision, reason: item.override_reason } : null}
          />
        </ModalSection>
      )}

      <ModalSection title="Integrity">
        <VerifyIntegrity inspectionId={item.inspection_id} />
      </ModalSection>

      {(item.images || []).length > 0 && (
        <ModalSection title="Photos">
          <Gallery inspectionId={item.inspection_id} images={item.images} />
        </ModalSection>
      )}
    </Modal>
  );
}

export default function LedgerView({ inspections, loading, connected, onRefresh, onOpenInspection }) {
  const [detailId, setDetailId] = useState('');
  const [query, setQuery] = useState('');
  const [decisionFilter, setDecisionFilter] = useState('ALL');
  const closeDetail = useCallback(() => setDetailId(''), []);

  const sorted = useMemo(
    () => [...inspections].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    [inspections],
  );
  const text = query.trim().toLowerCase();
  const filtered = sorted.filter((item) => {
    if (decisionFilter !== 'ALL' && effectiveDecision(item) !== decisionFilter) return false;
    if (!text) return true;
    return [item.inspection_id, item.po?.po_id, item.po?.product_name, item.po?.sku]
      .some((value) => String(value || '').toLowerCase().includes(text));
  });
  const detail = sorted.find((item) => item.inspection_id === detailId);

  return (
    <>
      <div className="filter-bar">
        <label htmlFor="ledger-search" className="sr-only">Search inspections</label>
        <input
          id="ledger-search"
          className="filter-input"
          type="search"
          placeholder="Search by inspection, PO, product or SKU…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label htmlFor="ledger-filter" className="sr-only">Filter by decision</label>
        <select id="ledger-filter" className="filter-select" value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value)}>
          <option value="ALL">All decisions</option>
          {Object.entries(DECISION_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
        </select>
        <button type="button" className="btn-theme" onClick={onRefresh} disabled={loading || !connected}>
          <Icon name="refresh" size={14} /> {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <Card
        flush
        title="Inspection ledger"
        sub="Every inspection for your organization — open one in the workspace, view details, or verify its sealed record chain"
        actions={connected ? <span className="filter-count">{filtered.length} of {sorted.length}</span> : null}
      >
        {!connected && (
          <div className="empty-state">
            <Icon name="key" size={28} />
            <h3>Not connected</h3>
            <p>Connect with an API key in the top bar to load the ledger.</p>
          </div>
        )}
        {connected && (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Inspection</th><th>Purchase order</th><th>Receiving status</th><th>Created</th><th>Record</th><th>Photos</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="empty-cell">{loading ? 'Loading…' : sorted.length ? 'No inspections match the filter.' : 'No inspections yet.'}</td></tr>
                )}
                {filtered.map((item) => (
                  <tr key={item.inspection_id}>
                    <td>
                      <button type="button" className="link" onClick={() => onOpenInspection(item.inspection_id)}>
                        {item.inspection_id}
                      </button>
                    </td>
                    <td>
                      <div className="cell-strong">{item.po?.po_id}</div>
                      <div className="cell-sub">{item.po?.product_name}</div>
                    </td>
                    <td>
                      <div className="cell-badges">
                        <DecisionPill decision={effectiveDecision(item)} />
                        {item.override_decision && <span className="dup-flag">overridden</span>}
                        {failedCategories(item).map((category) => <span key={category} className="cat-flag">{category}</span>)}
                      </div>
                    </td>
                    <td className="nowrap">{formatTime(item.created_at)}</td>
                    <td className="mono">{item.record ? `v${item.record.version} · ${shortHash(item.record.content_hash)}` : '—'}</td>
                    <td>{item.images?.length ?? 0}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="detail-btn" onClick={() => setDetailId(item.inspection_id)}>Details</button>
                        <VerifyIntegrity inspectionId={item.inspection_id} compact />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {detail && <InspectionDetails item={detail} onClose={closeDetail} onOpenInspection={onOpenInspection} />}
    </>
  );
}
