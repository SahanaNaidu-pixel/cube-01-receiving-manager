/*
 * Guided demo: Agent A → Receiving Manager → structured inspection → response.
 * Four real requests sharing one correlation_id: discover the public agent card, agent.ping, receiving.inspect with
 * the operator's photo, then receiving.verify_record on the returned inspection. Each step shows its request and
 * response; nothing is simulated (in DEMO_MODE the backend's demo provider replaces vision, and the page says so).
 */
import { useEffect, useRef, useState } from 'react';
import { buildA2AEnvelope, listPurchaseOrders, listProducts } from '../../services/api';
import { useApi } from '../../hooks/useAsync';
import { useApp } from '../../context/AppContext';
import { pathFor } from '../../lib/router';
import { formatLatency } from '../../lib/format';
import { Card, Icon, JsonViewer, Link, StatusBadge, VerdictBadge } from '../../components/ui';
import { getJsonTimed, newA2AId, postEnvelopeTimed } from './opsApi';
import { FieldError } from './shared';
import { SENDER_PRESETS, formFromPoLine, imagesFromItems, inspectFormErrors, inspectPayloadFromForm, referenceForm } from './a2aModel';
import { ExchangeView, ImageAttach, InspectForm } from './a2aParts';

const STEPS = [
  { key: 'discover', title: 'Discover', text: 'Agent A reads the public agent card (GET /.well-known/agent.json) to learn the endpoint, auth and operations.' },
  { key: 'ping', title: 'agent.ping', text: 'Agent A checks the Receiving Manager is alive and ready.' },
  { key: 'inspect', title: 'receiving.inspect', text: 'Agent A sends the PO line and the delivery photo (base64). The Receiving Manager creates an inspection, runs perception + deterministic rules and seals a receiving_record.v1.' },
  { key: 'verify', title: 'receiving.verify_record', text: 'Agent A verifies the sealed record (content hash, HMAC seal, version chain) before acting on it.' },
];

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function GuidedDemo({ demoMode }) {
  const { systemInfo } = useApp();
  const env = systemInfo?.environment || {};
  const [sender, setSender] = useState('prep_manager');
  const [correlationId, setCorrelationId] = useState(() => newA2AId('corr'));
  const [form, setForm] = useState(() => ({ ...referenceForm(), scenario: '' }));
  const [formTouched, setFormTouched] = useState(false);
  const [images, setImages] = useState([]);
  const [results, setResultsState] = useState({});
  const resultsRef = useRef({});
  // Steps run back to back (Run all), so the latest results are read from a ref, not a stale render closure.
  const setResults = (fn) => { resultsRef.current = fn(resultsRef.current); setResultsState(resultsRef.current); };
  const [running, setRunning] = useState('');
  const [error, setError] = useState('');

  // Default the PO to the first real catalogue line (the operator can switch to the demo reference line).
  const pos = useApi(() => listPurchaseOrders({ page_size: 1 }), []);
  const products = useApi(() => listProducts({ page_size: 200 }), []);
  useEffect(() => {
    if (formTouched || demoMode) return;
    const po = pos.data?.items?.[0];
    const line = po?.lines?.[0];
    if (!po || !line) return;
    const product = (products.data?.items || []).find((p) => String(p.sku).toUpperCase() === String(line.sku).toUpperCase());
    setForm((f) => ({ ...formFromPoLine(po, line, product), scenario: f.scenario }));
  }, [pos.data, products.data, formTouched, demoMode]);
  useEffect(() => { if (demoMode && !formTouched) setForm((f) => ({ ...f, scenario: f.scenario || 'correct_shipment' })); }, [demoMode, formTouched]);

  const nextIndex = STEPS.findIndex((s) => !results[s.key] || !stepOk(s.key, results[s.key]));
  const formErrors = inspectFormErrors(form);
  const readyImages = images.filter((i) => i.status !== 'rejected');

  function stepOk(key, exchange) {
    if (!exchange || exchange.state !== 'done') return false;
    if (key === 'discover') return exchange.result.ok;
    return exchange.result.ok && exchange.result.body?.status === 'completed';
  }

  const runStep = async (key) => {
    setError('');
    setRunning(key);
    try {
      if (key === 'discover') {
        setResults((r) => ({ ...r, discover: { state: 'sending' } }));
        const result = await getJsonTimed('/.well-known/agent.json', { auth: false });
        setResults((r) => ({ ...r, discover: { state: 'done', result } }));
        return stepOk('discover', { state: 'done', result });
      }
      let payload;
      if (key === 'ping') payload = {};
      if (key === 'inspect') {
        if (Object.keys(formErrors).length) throw new Error('Fix the PO fields first.');
        if (!readyImages.length) throw new Error('Attach at least one delivery photo for receiving.inspect.');
        payload = { ...inspectPayloadFromForm(form), images: await imagesFromItems(images) };
      }
      if (key === 'verify') {
        const inspectionId = resultsRef.current.inspect?.result?.body?.result?.inspection_id;
        if (!inspectionId) throw new Error('Run receiving.inspect first.');
        payload = { inspection_id: inspectionId };
      }
      const operation = STEPS.find((s) => s.key === key).title;
      const envelope = buildA2AEnvelope(operation, payload, {
        sender: { agent_id: sender, version: '1.0.0' }, correlationId, messageId: newA2AId('msg'),
      });
      envelope.timestamp = stamp();
      setResults((r) => ({ ...r, [key]: { state: 'sending', envelope } }));
      const result = await postEnvelopeTimed(envelope);
      const exchange = { state: 'done', envelope, result };
      setResults((r) => ({ ...r, [key]: exchange }));
      return stepOk(key, exchange);
    } catch (err) {
      setError(err.message);
      setResults((r) => { const next = { ...r }; if (next[key]?.state === 'sending') delete next[key]; return next; });
      return false;
    } finally {
      setRunning('');
    }
  };

  const runAll = async () => {
    const first = STEPS.findIndex((s) => !stepOk(s.key, resultsRef.current[s.key]));
    for (let i = Math.max(0, first); i < STEPS.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await runStep(STEPS[i].key);
      if (!ok) break;
    }
  };

  const reset = () => { setResults(() => ({})); setError(''); setCorrelationId(newA2AId('corr')); };
  const inspectResult = results.inspect?.result?.body?.result;
  const verifyResult = results.verify?.result?.body?.result;
  const allDone = nextIndex === -1;

  return (
    <div className="stack">
      <Card
        title="Guided demo: Agent A → Receiving Manager → structured inspection → response"
        sub="Four real requests in one conversation (same correlation_id). Run them one by one or all at once."
        actions={(
          <>
            <button type="button" className="btn-theme" onClick={reset} disabled={Boolean(running)}><Icon name="refresh" size={14} /> New conversation</button>
            <button type="button" className="btn-primary" onClick={runAll} disabled={Boolean(running) || allDone} aria-busy={Boolean(running)}>
              {running ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={14} />}
              {running ? `Running ${running}…` : allDone ? 'All steps done' : nextIndex > 0 ? 'Run remaining steps' : 'Run all steps'}
            </button>
          </>
        )}
      >
        <div className="form-grid ops-grid-2">
          <label className="field">
            <span className="field-label">Agent A (sender.agent_id)</span>
            <select className="filter-select full" value={sender} onChange={(e) => setSender(e.target.value)} disabled={Boolean(running)}>
              {SENDER_PRESETS.filter((p) => p.value !== 'custom').map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">correlation_id (whole conversation)</span>
            <input className="filter-input full mono" value={correlationId} readOnly />
          </label>
        </div>
        {demoMode && (
          <div className="alert alert-hold" role="note">
            <Icon name="flask" size={16} />
            <span className="alert-text">The backend runs with <span className="mono">DEMO_MODE=true</span>: perception comes from the selected demo scenario, not from the photo. With a vision provider configured and demo mode off, the same flow analyses the photo for real.</span>
          </div>
        )}
        <details className="ops-details" open>
          <summary>Inspection input for step 3 (PO line, photo{demoMode ? ', scenario' : ''})</summary>
          <div className="ops-stack-sm">
            <InspectForm form={form} onChange={(f) => { setFormTouched(true); setForm(f); }} errors={formErrors} demoMode={demoMode} showShipment />
            <ImageAttach items={images} onChange={setImages} maxSizeMb={env.max_image_size_mb} maxFiles={env.upload_max_images} label="Attach the delivery photo Agent A sends" />
          </div>
        </details>
        {error && <FieldError>{error}</FieldError>}
      </Card>

      <ol className="ops-steps">
        {STEPS.map((step, index) => {
          const exchange = results[step.key];
          const ok = stepOk(step.key, exchange);
          const failed = exchange?.state === 'done' && !ok;
          const enabled = !running && (index === 0 || stepOk(STEPS[index - 1].key, results[STEPS[index - 1].key]));
          return (
            <li key={step.key} className={`ops-step ${ok ? 'is-ok' : failed ? 'is-failed' : exchange?.state === 'sending' ? 'is-running' : ''}`}>
              <div className="ops-step-head">
                <span className="ops-step-num" aria-hidden="true">{ok ? <Icon name="check" size={14} /> : index + 1}</span>
                <div className="ops-step-text">
                  <strong className="mono">{step.title}</strong>
                  <span className="hint">{step.text}</span>
                </div>
                <button type="button" className={ok ? 'detail-btn' : 'btn-theme'} onClick={() => runStep(step.key)} disabled={!enabled}
                  title={enabled ? undefined : 'Complete the previous step first'}>
                  {exchange?.state === 'sending' ? <span className="spinner ui-spinner-accent" aria-hidden="true" /> : <Icon name={ok ? 'refresh' : 'play'} size={13} />}
                  {ok || failed ? 'Run again' : 'Run step'}
                </button>
              </div>
              {exchange && step.key === 'discover' && (
                exchange.state === 'sending'
                  ? <div className="ops-waiting"><span className="spinner ui-spinner-accent" aria-hidden="true" /> Fetching…</div>
                  : (
                    <div className="ops-stack-sm">
                      <span className="ops-exchange-meta">
                        <StatusBadge status={exchange.result.ok ? 'ok' : 'failed'} label={exchange.result.ok ? `HTTP ${exchange.result.httpStatus}` : exchange.result.error?.message} />
                        <span>Latency <strong>{formatLatency(exchange.result.latencyMs)}</strong></span>
                        {exchange.result.ok && <span>{exchange.result.body?.name} · {exchange.result.body?.operations?.length} operations · endpoint <span className="mono">{exchange.result.body?.endpoint}</span></span>}
                      </span>
                      {exchange.result.body && <JsonViewer data={exchange.result.body} title="Agent card" defaultDepth={1} maxHeight={260} />}
                    </div>
                  )
              )}
              {exchange && step.key !== 'discover' && <ExchangeView exchange={exchange} compact />}
            </li>
          );
        })}
      </ol>

      {inspectResult && (
        <Card title="Structured result Agent A receives" sub="From the receiving.inspect response — what a downstream agent acts on.">
          <div className="ops-result-hero">
            <VerdictBadge verdict={inspectResult.verdict} />
            <span>Decision <strong>{inspectResult.decision}</strong></span>
            <span>Prep hold <strong>{inspectResult.prep_hold ? 'yes' : 'no'}</strong></span>
            <span>{inspectResult.issues?.length || 0} issue(s)</span>
            {inspectResult.review_task_id && <Link to={pathFor('reviews', inspectResult.review_task_id)} className="link mono">{inspectResult.review_task_id}</Link>}
            {verifyResult && <StatusBadge status={verifyResult.integrity_verified ? 'ok' : 'failed'} label={verifyResult.integrity_verified ? 'Seal verified' : 'Seal NOT verified'} />}
          </div>
          <div className="row-actions">
            <Link to={pathFor('inspections', inspectResult.inspection_id)} className="btn-primary">Open inspection {inspectResult.inspection_id}</Link>
            <Link to="agent-activity" query={{ correlation_id: correlationId }} className="btn-theme">View this conversation in Agent Activity</Link>
          </div>
        </Card>
      )}
    </div>
  );
}
