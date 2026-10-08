/*
 * EvidenceDetailPage — one uploaded photo (GET /api/evidence/{image_id}) with its bytes
 * (GET /api/inspections/{id}/images/{image_id}, fetched with the API key).
 * Readings are shown exactly as stored; no detection is implied when there are none.
 */
import { useState } from 'react';
import { fetchInspectionImageBlob, getEvidence, saveBlob } from '../services/api';
import { useApi } from '../hooks/useAsync';
import { pathFor } from '../lib/router';
import { formatBytes, formatDateTime, humanize } from '../lib/format';
import {
  AsyncButton, Card, ConnectPrompt, DataTable, ErrorState, Icon, KeyValueGrid, Link, LoadingState, PageHeader, StatusBadge,
} from '../components/ui';
import { ConfidenceBar, IdChip, InlineError, TraceChain, useImageUrl } from './review/components';
import { ANALYSIS_STATUSES, VISION_UNAVAILABLE_MESSAGE } from './review/constants';
import '../styles/review.css';

const STATUS_LABEL = Object.fromEntries(ANALYSIS_STATUSES.map((s) => [s.value, s.label]));

async function sha256Hex(blob) {
  if (!globalThis.crypto?.subtle) throw new Error('Digest verification needs a secure (HTTPS or localhost) context.');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default function EvidenceDetailPage({ route }) {
  const imageId = route.params[0];
  const { data: file, error, loading, reload, notConnected } = useApi(() => getEvidence(imageId), [imageId]);
  const image = useImageUrl(file?.inspection_id, file?.evidence_id, { enabled: Boolean(file) });
  const [digestCheck, setDigestCheck] = useState(null); // {match, computed}

  if (notConnected) return <Card><ConnectPrompt /></Card>;
  if (!file && loading) return <LoadingState label={`Loading evidence ${imageId}…`} />;
  if (!file && error) {
    return (
      <div className="stack">
        <PageHeader title={imageId} breadcrumbs={[{ label: 'Evidence', to: 'evidence' }, { label: imageId }]} />
        <ErrorState error={error} onRetry={reload} title={error.status === 404 ? 'Evidence not found' : 'Could not load evidence'} />
      </div>
    );
  }
  if (!file) return null;

  const readings = file.readings || [];
  const download = async () => {
    const blob = await fetchInspectionImageBlob(file.inspection_id, file.evidence_id);
    saveBlob(blob, file.filename || `${file.evidence_id}`);
    return blob;
  };
  const verify = async () => {
    const blob = await fetchInspectionImageBlob(file.inspection_id, file.evidence_id);
    const computed = await sha256Hex(blob);
    const result = { computed, match: computed === String(file.sha256_digest || '').toLowerCase() };
    setDigestCheck(result);
    if (!result.match) throw new Error('The downloaded bytes do not match the stored SHA-256 digest.');
    return result;
  };

  return (
    <div className="stack">
      <PageHeader
        title={file.filename || file.evidence_id}
        icon="image"
        breadcrumbs={[{ label: 'Evidence', to: 'evidence' }, { label: file.evidence_id }]}
        subtitle={`${humanize(file.view)} view · uploaded ${formatDateTime(file.uploaded_at)} by ${file.uploaded_by || 'unknown'}`}
        actions={(
          <>
            <Link to={pathFor('inspections', file.inspection_id)} className="btn-theme"><Icon name="external" size={14} /> Inspection</Link>
            <AsyncButton icon="download" label="Download original" loadingLabel="Downloading…" successLabel="Downloaded"
              onClick={download} successToast={`${file.filename} downloaded`} errorToast="Download failed" />
          </>
        )}
      />

      {error && <InlineError error={error} title="Refresh failed — showing the last loaded data" />}

      <Card>
        <TraceChain steps={[
          { label: 'Inspection', value: file.inspection_id, to: pathFor('inspections', file.inspection_id) },
          { label: 'Evidence', value: file.evidence_id, badge: <StatusBadge status={file.analysis_status} label={STATUS_LABEL[file.analysis_status]} /> },
          { label: 'Checks', value: file.linked_checks?.length ? file.linked_checks.map(humanize).join(', ') : 'none' },
          { label: 'Issues', value: file.linked_issue_ids?.length ? `${file.linked_issue_ids.length} linked` : 'none' },
        ]} />
      </Card>

      <div className="rv-grid-main">
        <Card title="Preview" flush>
          <div className="card-body">
            <div className="rv-ev-preview">
              {image.loading && <LoadingState compact label="Loading image…" />}
              {image.error && <InlineError error={image.error} title="Image could not be loaded" />}
              {image.url && <img src={image.url} alt={file.filename || file.evidence_id} />}
            </div>
          </div>
        </Card>

        <div className="stack">
          <Card title="Metadata">
            <KeyValueGrid columns={2} dense items={[
              { label: 'Evidence id', value: <IdChip value={file.evidence_id} /> },
              { label: 'Filename', value: file.filename },
              { label: 'Type', value: file.file_type, mono: true },
              { label: 'Size', value: formatBytes(file.file_size) },
              { label: 'View', value: humanize(file.view) },
              { label: 'Source', value: file.source === 'a2a' ? 'A2A message' : 'Web/API upload' },
              { label: 'Uploaded at', value: formatDateTime(file.uploaded_at) },
              { label: 'Uploaded by', value: file.uploaded_by },
              { label: 'PO', value: file.po_id ? <Link to={pathFor('purchase-orders', file.po_id)} className="link mono">{file.po_id}</Link> : null },
              { label: 'SKU', value: file.sku ? <Link to={pathFor('products', file.sku)} className="link mono">{file.sku}</Link> : null },
              { label: 'SHA-256', value: <span className="mono" style={{ wordBreak: 'break-all' }}>{file.sha256_digest}</span>, span: 2 },
            ]} />
            <div className="rv-actions">
              <AsyncButton variant="small" icon="shield" label="Verify digest" loadingLabel="Hashing…" successLabel="Digest matches"
                failedLabel="Mismatch" onClick={verify} successToast="SHA-256 of the stored bytes matches the recorded digest" errorToast="Digest check failed" />
              {digestCheck && !digestCheck.match && (
                <span className="hint">Computed <span className="mono">{digestCheck.computed.slice(0, 16)}…</span></span>
              )}
            </div>
          </Card>

          <Card title="Provenance">
            <KeyValueGrid columns={2} dense items={[
              { label: 'Channel', value: file.provenance?.channel === 'a2a' ? 'A2A' : 'API' },
              {
                label: 'Request id', value: file.provenance?.request_id
                  ? (file.provenance.channel === 'a2a'
                    ? <Link to={pathFor('agent-activity', file.provenance.request_id)} className="link mono">{file.provenance.request_id}</Link>
                    : <IdChip value={file.provenance.request_id} />)
                  : null,
              },
            ]} />
            <p className="hint">
              The request id ties this upload to the audit trail: <Link to="audit" query={{ inspection_id: file.inspection_id, action: 'evidence.uploaded' }}>view upload events</Link>.
            </p>
          </Card>
        </div>
      </div>

      <Card title="Analysis" sub="Readings recorded for this photo by the vision provider." actions={<StatusBadge status={file.analysis_status} label={STATUS_LABEL[file.analysis_status]} />}>
        {file.analysis_status === 'perception_unavailable' && (
          <div className="rv-callout tone-warning"><Icon name="alert" size={16} /><span>{VISION_UNAVAILABLE_MESSAGE}</span></div>
        )}
        {file.analysis_status === 'not_analyzed' && (
          <div className="rv-callout"><Icon name="info" size={16} /><span>This photo has not been analysed yet — run the inspection to analyse it. No readings exist.</span></div>
        )}
        {file.analysis_status === 'analyzed' && readings.length === 0 && (
          <div className="rv-callout"><Icon name="info" size={16} /><span>The photo was part of an analysed run, but no readings were recorded for it. Nothing was detected from this image.</span></div>
        )}
        {readings.length > 0 && (
          <DataTable
            bordered
            rows={readings}
            rowKey="evidence_id"
            columns={[
              { key: 'evidence_id', header: 'Reading', mono: true },
              { key: 'check_type', header: 'Check', render: (r) => humanize(r.check_type) },
              { key: 'observation', header: 'Observation', render: (r) => <span className="mono">{String(r.observation ?? '—')}</span> },
              { key: 'confidence', header: 'Confidence', render: (r) => <ConfidenceBar value={r.confidence} /> },
              { key: 'description', header: 'Note', render: (r) => r.description || '—' },
            ]}
          />
        )}
        <p className="hint">Operator counts entered during a run are stored as separate “operator” readings on the inspection, not on a photo.</p>
      </Card>

      <div className="rv-grid-2">
        <Card title={`Linked issues (${file.linked_issue_ids?.length || 0})`}>
          {file.linked_issue_ids?.length
            ? <div className="rv-actions">{file.linked_issue_ids.map((id) => <Link key={id} to={pathFor('issues', id)} className="link mono">{id}</Link>)}</div>
            : <p className="hint">No issue references this photo.</p>}
        </Card>
        <Card title={`Linked checks (${file.linked_checks?.length || 0})`} sub="Checks of the latest record that used this photo.">
          {file.linked_checks?.length
            ? <div className="rv-actions">{file.linked_checks.map((key) => <span key={key} className="ui-badge tone-neutral">{humanize(key)}</span>)}</div>
            : <p className="hint">No check of the latest record used this photo.</p>}
          <Link to={pathFor('inspections', file.inspection_id)} className="link">Open inspection {file.inspection_id}</Link>
        </Card>
      </div>
    </div>
  );
}
