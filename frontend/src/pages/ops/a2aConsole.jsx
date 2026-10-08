/*
 * A2A message composer: operation + sender + ids + payload (receiving.inspect via form or JSON, images as base64)
 * → POST /api/agent/receive, with delivery state, response envelope, timing, ids, links and copy-as-curl.
 * Everything sent is a real request; the session history below lists what this browser sent.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildA2AEnvelope, getAgentActivity, listInspections } from '../../services/api';
import { useApi } from '../../hooks/useAsync';
import { useApp } from '../../context/AppContext';
import { formatLatency } from '../../lib/format';
import { Card, Icon, Tabs, useToast } from '../../components/ui';
import { newA2AId, postEnvelopeTimed } from './opsApi';
import { FieldError } from './shared';
import {
  FALLBACK_OPERATIONS, SENDER_PRESETS, envelopeProblems, examplePayload, formFromInspectPayload, imagesFromItems,
  inspectFormErrors, inspectPayloadFromForm, referenceForm,
} from './a2aModel';
import { CurlBox, DeliveryPill, ExchangeView, IdField, ImageAttach, InspectForm, NoResponseYet, deliveryOf } from './a2aParts';

const CUSTOM_OP = '__custom';
const pretty = (value) => JSON.stringify(value, null, 2);

export function A2AComposer({ card, demoMode, fromRequestId }) {
  const toast = useToast();
  const { systemInfo } = useApp();
  const env = systemInfo?.environment || {};
  const latest = useApi(() => listInspections({ page_size: 1 }), []);
  const latestInspectionId = latest.data?.items?.[0]?.inspection_id;

  const operations = (card?.operations || []).map((o) => o.operation);
  const opList = operations.length ? operations : FALLBACK_OPERATIONS;

  const [opChoice, setOpChoice] = useState('agent.ping');
  const [customOp, setCustomOp] = useState('receiving.unknown_operation');
  const operation = opChoice === CUSTOM_OP ? customOp.trim() : opChoice;
  const [senderPreset, setSenderPreset] = useState('prep_manager');
  const [customSender, setCustomSender] = useState('');
  const senderId = senderPreset === 'custom' ? customSender.trim() : senderPreset;
  const [messageId, setMessageId] = useState(() => newA2AId('msg'));
  const [correlationId, setCorrelationId] = useState(() => newA2AId('corr'));
  const [mode, setMode] = useState('form');
  const [form, setForm] = useState(referenceForm);
  const [jsonByOp, setJsonByOp] = useState({});
  const [images, setImages] = useState([]);
  const [encoded, setEncoded] = useState({ items: [], error: null, busy: false });
  const [exchange, setExchange] = useState(null);
  const [history, setHistory] = useState([]);
  const lastSent = useRef(null);

  const isInspect = operation === 'receiving.inspect';
  const useForm = isInspect && mode === 'form';
  const jsonText = jsonByOp[operation] ?? pretty(examplePayload(operation, { latestInspectionId }));
  const setJsonText = (text) => setJsonByOp((m) => ({ ...m, [operation]: text }));

  // Prefill from an activity entry ("Open in console" on the activity detail page).
  useEffect(() => {
    if (!fromRequestId) return;
    let cancelled = false;
    getAgentActivity(fromRequestId).then((entry) => {
      if (cancelled || !entry?.request) return;
      const req = entry.request;
      const op = req.operation || 'agent.ping';
      const payload = { ...(req.payload || {}) };
      const hadImages = Array.isArray(payload.images) && payload.images.length > 0;
      delete payload.images;
      setOpChoice(opList.includes(op) ? op : CUSTOM_OP);
      if (!opList.includes(op)) setCustomOp(op);
      const sender = req.sender?.agent_id || '';
      if (SENDER_PRESETS.some((p) => p.value === sender)) setSenderPreset(sender);
      else { setSenderPreset('custom'); setCustomSender(sender); }
      if (req.correlation_id) setCorrelationId(req.correlation_id);
      setMessageId(newA2AId('msg'));
      if (op === 'receiving.inspect') { setForm(formFromInspectPayload(payload)); setMode('form'); }
      setJsonByOp((m) => ({ ...m, [op]: pretty(payload) }));
      toast.info(`Loaded ${op} from ${fromRequestId} with a new message_id${hadImages ? ' — re-attach the images (bytes are never stored in the activity log)' : ''}.`);
    }).catch((err) => { if (!cancelled) toast.error(err, 'Could not load the activity entry'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromRequestId]);

  // Encode attached images once per change so the curl preview and the send use the same bytes.
  useEffect(() => {
    let cancelled = false;
    const ready = images.filter((i) => i.status !== 'rejected');
    if (!ready.length) { setEncoded({ items: [], error: null, busy: false }); return undefined; }
    setEncoded((e) => ({ ...e, busy: true }));
    imagesFromItems(images)
      .then((items) => { if (!cancelled) setEncoded({ items, error: null, busy: false }); })
      .catch((error) => { if (!cancelled) setEncoded({ items: [], error, busy: false }); });
    return () => { cancelled = true; };
  }, [images]);

  const { payload, payloadError } = useMemo(() => {
    if (useForm) return { payload: inspectPayloadFromForm(form), payloadError: null };
    try {
      const parsed = JSON.parse(jsonText || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { payload: null, payloadError: 'payload must be a JSON object' };
      return { payload: parsed, payloadError: null };
    } catch (err) {
      return { payload: null, payloadError: `Invalid JSON: ${err.message}` };
    }
  }, [useForm, form, jsonText]);

  const fullPayload = useMemo(() => {
    if (!payload) return null;
    if (!isInspect) return payload;
    const existing = Array.isArray(payload.images) ? payload.images : [];
    const merged = [...existing, ...encoded.items];
    return merged.length ? { ...payload, images: merged } : payload;
  }, [payload, isInspect, encoded.items]);

  const envelope = useMemo(() => {
    if (!fullPayload || !operation) return null;
    const built = buildA2AEnvelope(operation, fullPayload, {
      sender: { agent_id: senderId, version: '1.0.0' },
      messageId,
      correlationId: correlationId || undefined,
    });
    if (!correlationId) delete built.correlation_id; // let the server generate one
    return built;
  }, [fullPayload, operation, senderId, messageId, correlationId]);

  const formErrors = useForm ? inspectFormErrors(form) : {};
  const warnings = [
    ...envelopeProblems({ senderId, messageId, correlationId, operation }),
    ...Object.entries(formErrors).map(([k, v]) => `${k}: ${v}`),
    ...(isInspect && fullPayload && !(fullPayload.images || []).length ? ['receiving.inspect needs at least one image — attach a photo'] : []),
    ...(opChoice === CUSTOM_OP ? ['custom operation: expect UNSUPPORTED_OPERATION unless the agent card lists it'] : []),
  ];
  const sending = exchange?.state === 'sending';

  const send = async (env0 = envelope, { replay = false } = {}) => {
    if (!env0 || sending) return;
    const toSend = replay ? env0 : { ...env0, timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    setExchange({ state: 'sending', envelope: toSend });
    const result = await postEnvelopeTimed(toSend);
    const done = { state: 'done', envelope: toSend, result, at: new Date().toISOString() };
    setExchange(done);
    lastSent.current = toSend;
    setHistory((h) => [done, ...h].slice(0, 15));
    const d = deliveryOf(done);
    if (d.tone === 'danger') toast.error(result.error || new Error(d.label), 'A2A message failed');
    else if (d.tone === 'warning') toast.warning(`${toSend.operation}: ${d.label}`);
    else toast.success(`${toSend.operation}: ${d.label} in ${formatLatency(result.latencyMs)}`);
    if (!replay && result.httpStatus !== 0) setMessageId(newA2AId('msg'));
    if (toSend.payload?.inspection_id === undefined && result.body?.result?.inspection_id) latest.reload();
  };

  const switchMode = (next) => {
    if (next === mode) return;
    if (next === 'json') setJsonByOp((m) => ({ ...m, 'receiving.inspect': pretty(inspectPayloadFromForm(form)) }));
    else {
      try { setForm(formFromInspectPayload(JSON.parse(jsonByOp['receiving.inspect'] || '{}'))); } catch { toast.warning('The JSON is invalid, so the form keeps its previous values.'); }
    }
    setMode(next);
  };

  return (
    <div className="ops-console">
      <Card title="Compose" sub="A real cube.a2a.v1 request to POST /api/agent/receive, sent with your API key.">
        <div className="ops-stack-sm">
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Operation</span>
              <select className="filter-select full" value={opChoice} onChange={(e) => setOpChoice(e.target.value)}>
                {opList.map((op) => <option key={op} value={op}>{op}</option>)}
                <option value={CUSTOM_OP}>Custom operation…</option>
              </select>
              {!operations.length && <span className="hint">Agent card not loaded — showing the documented operations.</span>}
            </label>
            {opChoice === CUSTOM_OP && (
              <label className="field">
                <span className="field-label">Custom operation</span>
                <input className="filter-input full mono" value={customOp} onChange={(e) => setCustomOp(e.target.value)} />
              </label>
            )}
            <label className="field">
              <span className="field-label">Sender agent (sender.agent_id)</span>
              <select className="filter-select full" value={senderPreset} onChange={(e) => setSenderPreset(e.target.value)}>
                {SENDER_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
            {senderPreset === 'custom' && (
              <label className="field">
                <span className="field-label">Custom agent id</span>
                <input className="filter-input full mono" value={customSender} onChange={(e) => setCustomSender(e.target.value)} placeholder="my_agent" />
              </label>
            )}
          </div>
          <div className="form-grid ops-grid-2">
            <IdField label="message_id" prefix="msg" value={messageId} onChange={setMessageId} hint="Idempotency key per sender — regenerated after each send." />
            <IdField label="correlation_id" prefix="corr" value={correlationId} onChange={setCorrelationId} optional hint="Keep it to chain several messages into one conversation." />
          </div>

          {isInspect && (
            <Tabs idPrefix="a2a-payload" tabs={[{ key: 'form', label: 'PO form' }, { key: 'json', label: 'JSON payload' }]} active={mode} onChange={switchMode} />
          )}
          {useForm ? (
            <InspectForm form={form} onChange={setForm} errors={formErrors} demoMode={demoMode} />
          ) : (
            <label className="field">
              <span className="field-label">payload (JSON){isInspect && ' — attached images are appended to images[] at send time'}</span>
              <textarea className={`filter-input full mono ops-json-input ${payloadError ? 'ops-invalid' : ''}`} rows={isInspect ? 18 : 6} spellCheck={false}
                value={jsonText} onChange={(e) => setJsonText(e.target.value)} aria-invalid={Boolean(payloadError)} />
              <FieldError>{payloadError}</FieldError>
              <span className="row-actions">
                <button type="button" className="detail-btn" onClick={() => setJsonText(pretty(examplePayload(operation, { latestInspectionId })))}>
                  <Icon name="refresh" size={13} /> Reset to example
                </button>
                {(operation === 'receiving.get_record' || operation === 'receiving.verify_record') && (
                  <span className="hint">{latestInspectionId ? `Example uses your latest inspection ${latestInspectionId}.` : latest.loading ? 'Looking up your latest inspection…' : 'No inspections yet — run receiving.inspect first.'}</span>
                )}
              </span>
            </label>
          )}

          {isInspect && (
            <>
              <ImageAttach items={images} onChange={setImages} maxSizeMb={env.max_image_size_mb} maxFiles={env.upload_max_images} />
              {encoded.busy && <span className="hint">Encoding images…</span>}
              {encoded.error && <FieldError>Could not read an image: {encoded.error.message}</FieldError>}
            </>
          )}

          {warnings.length > 0 && (
            <div className="alert alert-warning" role="status">
              <Icon name="alert" size={16} />
              <span className="alert-text">
                The server will likely reject this envelope (you can still send it to see the protocol error):
                <ul className="ops-warn-list">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              </span>
            </div>
          )}

          <div className="row-actions ops-send-row">
            <button type="button" className="btn-primary" onClick={() => send()} disabled={!envelope || sending || encoded.busy} aria-busy={sending}>
              {sending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={14} />}
              {sending ? 'Sending…' : `Send ${operation || 'message'}`}
            </button>
            {exchange && <DeliveryPill exchange={exchange} />}
          </div>
        </div>
      </Card>

      <Card title="Response" sub="Exactly what the Receiving Manager returned.">
        {exchange ? (
          <div className="ops-stack-sm">
            <ExchangeView exchange={exchange} />
            {exchange.state === 'done' && lastSent.current && exchange.result.httpStatus !== 0 && (
              <div className="row-actions">
                <button type="button" className="detail-btn" onClick={() => send(lastSent.current, { replay: true })} disabled={sending}
                  title="Re-POST the identical envelope (same sender + message_id): the server must answer with the stored response and X-Idempotent-Replay: true">
                  <Icon name="refresh" size={13} /> Resend same message_id (idempotency test)
                </button>
              </div>
            )}
          </div>
        ) : <NoResponseYet />}
      </Card>

      <Card title="Copy as curl" sub="The envelope as it would be sent now (fresh timestamp at send time).">
        <CurlBox envelope={envelope} disabledReason={payloadError || 'Choose an operation.'} />
      </Card>

      {history.length > 0 && (
        <Card flush title="Sent from this browser" sub="This session only — the persisted log is Agent Activity.">
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Operation</th><th>Sender</th><th>message_id</th><th>Result</th><th>Latency</th><th /></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={`${h.envelope.message_id}-${h.at}`}>
                    <td className="mono">{h.envelope.operation}</td>
                    <td>{h.envelope.sender?.agent_id}</td>
                    <td className="mono">{h.envelope.message_id}</td>
                    <td><DeliveryPill exchange={h} /></td>
                    <td>{formatLatency(h.result.latencyMs)}</td>
                    <td><button type="button" className="detail-btn" onClick={() => setExchange(h)}>Show</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
