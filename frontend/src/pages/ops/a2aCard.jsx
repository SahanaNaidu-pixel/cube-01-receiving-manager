/*
 * Live agent card: GET /api/agent/capabilities (with key) and the public GET /.well-known/agent.json, fetched
 * together by A2APage (loadAgentCards) and rendered here with operations and their input/output schemas.
 */
import { useState } from 'react';
import { getApiBaseUrl } from '../../services/api';
import { formatDateTime, formatLatency } from '../../lib/format';
import { AsyncButton, Card, EmptyState, ErrorState, Icon, JsonViewer, KeyValueGrid, LoadingState, StatusBadge } from '../../components/ui';
import { getJsonTimed } from './opsApi';

export async function loadAgentCards() {
  const [auth, pub] = await Promise.all([
    getJsonTimed('/api/agent/capabilities'),
    getJsonTimed('/.well-known/agent.json', { auth: false }),
  ]);
  if (!auth.ok && !pub.ok) throw pub.error || auth.error;
  return { auth, pub, fetchedAt: new Date().toISOString() };
}

/** The best card body available (authenticated first). */
export const cardOf = (cards) => (cards?.auth?.ok ? cards.auth.body : cards?.pub?.ok ? cards.pub.body : null);

function SourceLine({ label, path, res, auth }) {
  if (!res) return null;
  return (
    <div className="ops-source-line">
      <StatusBadge status={res.ok ? 'ok' : 'failed'} label={res.ok ? `HTTP ${res.httpStatus}` : res.httpStatus ? `HTTP ${res.httpStatus}` : 'Unreachable'} />
      <span className="mono">GET {path}</span>
      <span className="hint">{auth ? 'X-API-Key' : 'public, no key'} · {formatLatency(res.latencyMs)}{res.requestId ? ` · ${res.requestId}` : ''}</span>
      {!res.ok && res.error && <span className="ops-error-text">{res.error.message}</span>}
      <span className="sr-only">{label}</span>
    </div>
  );
}

function Operation({ op }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="ops-op">
      <button type="button" className="ops-op-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
        <span className="mono ops-op-name">{op.operation}</span>
        <span className="hint">{op.description}</span>
      </button>
      {open && (
        <div className="ops-envelopes">
          <JsonViewer data={op.input_schema || {}} title="input_schema (payload)" defaultDepth={3} maxHeight={360} />
          <JsonViewer data={op.output_schema || {}} title="output_schema (result)" defaultDepth={3} maxHeight={360} />
        </div>
      )}
    </li>
  );
}

export function AgentCardPanel({ cards, loading, error, reload }) {
  if (!cards && loading) return <Card><LoadingState label="Fetching the agent card…" /></Card>;
  if (!cards && error) return <Card><ErrorState error={error} onRetry={reload} title="Could not fetch the agent card" /></Card>;
  const card = cardOf(cards);
  const same = cards?.auth?.ok && cards?.pub?.ok
    && JSON.stringify(cards.auth.body.operations) === JSON.stringify(cards.pub.body.operations);

  return (
    <div className="stack">
      <Card
        title="Agent card (live)"
        sub={cards ? `Fetched ${formatDateTime(cards.fetchedAt)} from ${getApiBaseUrl()}` : undefined}
        actions={<AsyncButton icon="refresh" label="Refresh" loadingLabel="Fetching…" onClick={() => reload({ throwOnError: true })} errorToast="Could not refresh the agent card" />}
      >
        <SourceLine label="Authenticated" path="/api/agent/capabilities" res={cards?.auth} auth />
        <SourceLine label="Public discovery" path="/.well-known/agent.json" res={cards?.pub} />
        {cards?.auth?.ok && cards?.pub?.ok && (
          <p className="hint">{same ? 'Both discovery endpoints advertise the same operations.' : 'The public and authenticated cards differ — check the deployment.'}</p>
        )}
        {card ? (
          <KeyValueGrid columns={4} items={[
            { label: 'Agent', value: `${card.name} (${card.agent_id})` },
            { label: 'Version', value: card.version },
            { label: 'Protocol', value: card.a2a_version, mono: true },
            { label: 'Record schema', value: card.record_schema, mono: true },
            { label: 'Endpoint', value: `POST ${card.endpoint}`, mono: true },
            { label: 'Auth', value: card.auth ? `${card.auth.type} · header ${card.auth.header}` : null },
            { label: 'Ready', value: card.status ? <StatusBadge status={card.status.ready ? 'healthy' : 'unavailable'} label={card.status.ready ? 'Ready' : 'Not ready'} /> : null },
            { label: 'Vision provider', value: card.status?.vision_provider },
            { label: 'Degraded reasons', value: card.status?.degraded_reasons?.length ? card.status.degraded_reasons : 'None', span: 4 },
            { label: 'Description', value: card.description, span: 4 },
          ]} />
        ) : <EmptyState compact icon="alert" title="No agent card available" message="Neither discovery endpoint answered. Check the backend URL and CORS." />}
      </Card>
      {card && (
        <Card title={`Operations (${card.operations?.length || 0})`} sub="Expand an operation for its JSON Schemas. Full contracts: contracts/a2a_request.v1.schema.json, a2a_response.v1.schema.json.">
          <ul className="ops-op-list">{(card.operations || []).map((op) => <Operation key={op.operation} op={op} />)}</ul>
        </Card>
      )}
      {card && <Card title="Raw card"><JsonViewer data={card} defaultDepth={1} /></Card>}
    </div>
  );
}
