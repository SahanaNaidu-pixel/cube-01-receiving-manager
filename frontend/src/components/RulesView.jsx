import { Panel } from './Shared';

const RULES = [
  { title: 'The model only reads', body: 'One batched vision call per run reads every photo blind: it is never told the PO SKU, counts or variant (only the component names, as a checklist). It returns per-photo readings with a confidence; it never decides.' },
  { title: 'Python rules decide', body: 'Any FAIL makes the delivery an EXCEPTION. Otherwise any UNCERTAIN makes it UNCERTAIN. Only when every required check passes is it PASS. The same readings always give the same verdict.' },
  { title: 'Unseen is never a pass', body: 'Readings under 0.6 confidence count as not seen. A value no photo showed is UNCERTAIN, never the PO value. Uncertain is a real verdict, shown in the interface, not a weak pass.' },
  { title: 'Doubt is not failure', body: 'FAIL needs a clear contradiction. Look-alike characters (O/0, I/1), a barcode read instead of the SKU, a partly matching variant or a count no second reading backs up give UNCERTAIN, so a misread photo cannot reject a good delivery.' },
  { title: 'Photos vote', body: 'Each photo votes with confidence × photo quality × how well its view shows that check. A value needs 70% of the weight, and one clear dissenting photo can only push a check to UNCERTAIN. Disputed checks get one focused second look.' },
  { title: 'Fail open', body: 'If the model is down, times out or returns unusable output, the photos and the record are still saved, marked On hold for a person. Nothing blocks the dock and nothing is auto-accepted.' },
  { title: 'Overrides are data', body: 'An operator can override with a mandatory reason; PASS needs an approver key. The original verdict, the new one and the reason are appended as a new sealed record version.' },
  { title: 'Sealed record', body: 'Each run and override writes a record version with image SHA-256 digests, chained to the previous version and HMAC-sealed with a server key. "Verify" recomputes hashes, seals and the chain. It is tamper-evident against edits without the key, not an external anchor.' },
];

const TRUTH = [
  ['SKU', 'exact match after dropping label text and separators', 'a clearly different SKU', 'not read · photos disagree · look-alike characters only · barcode digits'],
  ['Cartons', 'counted on a whole-delivery photo = PO', 'different count', 'only close-ups · photos disagree'],
  ['Units / carton', 'printed or counted = PO', 'different', 'not read · photos disagree'],
  ['Total units', 'direct count, or cartons × units/carton, = PO', 'corroborated different total', 'not counted · direct and derived disagree · uncorroborated count · PO inconsistent'],
  ['Variant', 'all PO words present', 'no shared word', 'extra colour word · partial overlap · not read'],
  ['Condition', 'a reliable photo saw no damage, none saw damage', 'any reliable photo shows damage', 'never judged · cosmetic marks · unclear or unrecognised reading'],
  ['Components', 'every PO part seen', 'a photo shows a part missing', 'a part not seen · photos disagree'],
];

export default function RulesView({ perception }) {
  return (
    <div className="stack">
      <div className="rules">
        {RULES.map((rule, index) => (
          <article key={rule.title} className="panel rule">
            <span className="rule__n">R{String(index + 1).padStart(2, '0')}</span>
            <h3>{rule.title}</h3>
            <p>{rule.body}</p>
          </article>
        ))}
      </div>
      <Panel title="Per-check rules" icon="ruler">
        <div className="table-wrap">
          <table className="truth">
            <thead><tr><th>Check</th><th>Pass</th><th>Fail</th><th>Uncertain</th></tr></thead>
            <tbody>{TRUTH.map((row) => <tr key={row[0]}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </Panel>
      {perception && (
        <Panel title="This server" icon="cpu" sub="Live configuration reported by the backend.">
          <dl className="meta">
            <div><dt>Vision</dt><dd>{perception.mode === 'live' ? perception.model : 'not configured'}</dd></div>
            <div><dt>API</dt><dd>{perception.api_style}{perception.custom_endpoint ? ' (custom endpoint)' : ''}</dd></div>
            <div><dt>Streaming</dt><dd>{perception.stream ? 'on' : 'off'}</dd></div>
            <div><dt>Image detail</dt><dd>{perception.image_detail}</dd></div>
            <div><dt>Second look</dt><dd>{perception.second_look ? 'on' : 'off'}</dd></div>
            <div><dt>Timeout</dt><dd>{perception.timeout_s}s</dd></div>
            <div><dt>Scripted demos</dt><dd>{perception.demo_scenarios ? 'allowed' : 'off'}</dd></div>
            <div><dt>Provider check</dt><dd>{perception.probe || '—'}</dd></div>
          </dl>
        </Panel>
      )}
    </div>
  );
}
