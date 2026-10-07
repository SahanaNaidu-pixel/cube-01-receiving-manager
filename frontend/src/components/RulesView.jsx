import { Card, Icon } from './Shared';

const RULES = [
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
    title: 'Tamper-evident evidence record',
    icon: 'shield',
    body: 'Each analysis and override writes a new record version that embeds image SHA-256 digests, is hash-chained to the previous version and HMAC-sealed. "Verify integrity" recomputes the hashes, seals and chain.',
  },
];

export default function RulesView() {
  return (
    <div className="stack">
      <div className="rules-grid">
        {RULES.map((rule) => (
          <article key={rule.title} className="card rule-card">
            <span className="rule-card__icon"><Icon name={rule.icon} size={18} /></span>
            <h3 className="rule-card__title">{rule.title}</h3>
            <p className="rule-card__body">{rule.body}</p>
          </article>
        ))}
      </div>
      <Card title="Receiving flow" icon="truck">
        <ol className="flow">
          {['PO line', 'Create inspection', 'Upload photos per view', 'Perception (live model or demo scenario)', 'Deterministic decision engine', 'Sealed evidence record', 'Optional override', 'Integrity verification'].map((step, index) => (
            <li key={step} className="flow__step"><span className="flow__num">{index + 1}</span>{step}</li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
