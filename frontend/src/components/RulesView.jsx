import { Fragment } from 'react';
import { Card, Icon } from './Shared';

export const RULES = [
  {
    title: 'Decision aggregation',
    icon: 'list',
    body: 'Each check (quantity, SKU, variant, condition, components…) yields PASS, FAIL, UNCERTAIN or NOT REQUIRED. Any FAIL makes the inspection EXCEPTION; otherwise any UNCERTAIN makes it UNCERTAIN; only when every required check passes is it PASS.',
  },
  {
    title: 'Confidence floor',
    icon: 'eye',
    body: 'Perception readings below 0.6 confidence are treated as unseen, so the affected check becomes UNCERTAIN instead of guessing.',
  },
  {
    title: 'Fail-open hold (Rule 3)',
    icon: 'clock',
    body: 'If perception fails (model error, timeout, unusable output) the inspection is not auto-accepted: it becomes PENDING_REVIEW and goes on prep hold for a human.',
  },
  {
    title: 'Authoritative PO (Rule 5)',
    icon: 'file',
    body: 'Expected SKU, variant, quantity, cartons, units per carton and components come only from the PO line, never from what the camera claims.',
  },
  {
    title: 'Overrides',
    icon: 'key',
    body: 'An operator can override the agent with a mandatory reason. Overriding to PASS requires an approver-role API key; operators may only escalate to EXCEPTION or UNCERTAIN. Overrides are append-only.',
  },
  {
    title: 'Tamper-evident record',
    icon: 'shield',
    body: 'Each analysis and override writes a new record version that embeds image SHA-256 digests, is hash-chained to the previous version and HMAC-sealed. "Verify integrity" recomputes the hashes, seals and chain.',
  },
];

export const FLOW = [
  { label: 'PO line', desc: 'Expected values', icon: 'file' },
  { label: 'Photos', desc: 'Per capture view', icon: 'image' },
  { label: 'Perception', desc: 'Live model or demo', icon: 'eye' },
  { label: 'Decision engine', desc: 'Deterministic rules', icon: 'gauge' },
  { label: 'Sealed record', desc: 'Hash-chained', icon: 'shield' },
  { label: 'Override', desc: 'Optional, with reason', icon: 'key' },
];

export function ChainDiagram({ steps, activeIndex = -1 }) {
  return (
    <div className="chain-diagram">
      {steps.map((step, index) => (
        <Fragment key={step.label}>
          {index > 0 && <span className="chain-arrow" aria-hidden="true">→</span>}
          <div className={`chain-step ${index === activeIndex ? 'active-step' : ''} ${index < activeIndex ? 'done-step' : ''}`}>
            <div className="chain-icon"><Icon name={index < activeIndex ? 'check' : step.icon} size={22} /></div>
            <div className="chain-label">{step.label}</div>
            <div className="chain-desc">{step.desc}</div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

export default function RulesView() {
  return (
    <div className="stack">
      <Card flush title="Receiving rules" sub="How the agent decides, holds and records">
        <div className="policy-note">
          The decision engine is deterministic: the model only reports what it sees; these rules turn that into a verdict.
        </div>
        <table className="policy-table">
          <thead><tr><th>Rule</th><th>What the agent does</th></tr></thead>
          <tbody>
            {RULES.map((rule) => (
              <tr key={rule.title}>
                <td><Icon name={rule.icon} size={16} />{rule.title}</td>
                <td>{rule.body}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card flush title="Receiving flow" sub="From purchase order line to verified evidence">
        <ChainDiagram steps={FLOW} />
      </Card>
    </div>
  );
}
