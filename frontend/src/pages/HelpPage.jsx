/*
 * HelpPage — operator documentation: workflow, verdicts, decision rules (ported from RulesView), review &
 * exception lifecycle, A2A summary, keyboard shortcuts and troubleshooting. Static content, no data calls.
 */
import { ChainDiagram, FLOW, RULES } from '../components/RulesView';
import { SHORTCUTS } from '../hooks/useShortcuts';
import { Card, Icon, Link, PageHeader, StatusBadge, VerdictBadge } from '../components/ui';

const SECTIONS = [
  { id: 'help-workflow', label: 'Receiving workflow' },
  { id: 'help-verdicts', label: 'Verdicts' },
  { id: 'help-rules', label: 'Decision rules' },
  { id: 'help-lifecycle', label: 'Reviews & exceptions' },
  { id: 'help-a2a', label: 'A2A integration' },
  { id: 'help-shortcuts', label: 'Shortcuts & tips' },
  { id: 'help-troubleshooting', label: 'Troubleshooting' },
];

const WORKFLOW = [
  { title: 'Load the catalogue', page: 'purchase-orders', body: 'Import products and purchase orders from CSV (or the bundled sample) on the Purchase Orders page. The PO line is the only source of expected values.' },
  { title: 'Start an inspection', page: 'new-inspection', body: 'Pick the PO line, add the shipment (supplier, ASN, warehouse, expected date) and the cartons you received with their seal and visible condition.' },
  { title: 'Capture evidence', page: 'new-inspection', body: 'Upload photos per view — pallet, carton, label, unit, other. Each file is SHA-256 digested and stored as evidence with provenance.' },
  { title: 'Add manual observations', page: 'new-inspection', body: 'Record what you counted yourself: SKU, quantity, cartons, units per carton, variant, damage, components. Operator counts are evidence (confidence 1.0) and are cross-checked with vision.' },
  { title: 'Run the inspection', page: 'new-inspection', body: 'The deterministic engine evaluates every check and seals a hash-chained, HMAC-signed record. FAIL and UNCERTAIN checks raise issues automatically.' },
  { title: 'Act on the result', page: 'reviews', body: 'PASS goes to stock. FAIL appears in Exceptions. UNCERTAIN or PENDING_REVIEW opens a task in the Review Queue for a human decision.' },
  { title: 'Hand off and export', page: 'inspections', body: 'From the inspection, export JSON/CSV/HTML reports, verify integrity, or hand the sealed record to Prep, Recovery, Returns or Pack over A2A.' },
];

const VERDICTS = [
  { verdict: 'PASS', stored: 'PASS', decision: 'ACCEPT', meaning: 'Every required check passed with sufficient confidence. Accept to stock.' },
  { verdict: 'FAIL', stored: 'EXCEPTION', decision: 'REJECT', meaning: 'At least one check failed — quantity, wrong SKU/variant, visible damage, missing components or reported carton condition.' },
  { verdict: 'UNCERTAIN', stored: 'UNCERTAIN / PENDING_REVIEW', decision: 'PENDING_REVIEW', meaning: 'Evidence was insufficient, readings disagreed, or perception was unavailable. A human must decide; the shipment is held.' },
  { verdict: null, stored: '—', decision: '—', meaning: 'Not analyzed: the inspection exists but has not been run yet.' },
];

const EXTRA_RULES = [
  { title: 'Manual observations', icon: 'clipboard', body: 'Operator counts are fused with vision readings as source "operator". If operator and vision disagree, the check becomes UNCERTAIN (VIEWS_DISAGREE) instead of picking one.' },
  { title: 'Carton condition', icon: 'box', body: 'From the intake cartons: any broken/resealed seal or damaged visible condition fails the carton_condition check; all intact and good passes; all unknown is UNCERTAIN; no cartons means not required.' },
  { title: 'Damage policy', icon: 'alert', body: 'DAMAGE_POLICY=fail (default) fails on visible damage. Under DAMAGE_POLICY=review, damage becomes UNCERTAIN (DAMAGE_REVIEW_REQUIRED) and goes to the review queue.' },
  { title: 'No vision provider', icon: 'eye', body: 'With no provider and no manual observations, every perception check is UNCERTAIN (PERCEPTION_UNAVAILABLE) and the verdict is PENDING_REVIEW. The agent never answers PASS without evidence.' },
];

const ISSUE_STATES = [
  ['open', 'Raised by a FAIL (high severity) or UNCERTAIN (medium) check on the latest run.'],
  ['in_review', 'Someone started working on it (start_review).'],
  ['resolved', 'Closed with a note by the resolver; can be reopened.'],
  ['superseded', 'Closed automatically because a later run replaced the check result.'],
];

const REVIEW_STATES = [
  ['open', 'Created when a run ends UNCERTAIN / PENDING_REVIEW, or manually. One open task per inspection.'],
  ['evidence_requested', 'The reviewer asked for more photos or counts; the next run returns the task to open.'],
  ['completed', 'A human decided PASS, FAIL or UNCERTAIN with a note. The machine verdict is kept alongside.'],
  ['cancelled', 'Withdrawn.'],
];

const A2A_OPS = [
  ['receiving.inspect', 'Create, evidence and run an inspection in one message (PO, shipment, cartons, base64 images, manual observations). Returns verdict, decision, prep_hold, issues and the sealed record.'],
  ['receiving.get_record', 'Latest sealed receiving_record.v1 for an inspection.'],
  ['receiving.verify_record', 'Recompute hashes, seals and chain for an inspection.'],
  ['agent.ping', 'Liveness and readiness of the agent.'],
];

const TROUBLESHOOTING = [
  ['"API key missing or invalid (401)"', 'Paste a valid key in the top bar or Settings and press Connect. Keys are configured on the backend in RECEIVING_API_KEYS.'],
  ['"Backend unreachable"', 'The browser could not reach the API. Check the backend is running, VITE_API_BASE_URL points at it, and CORS_ALLOWED_ORIGINS includes this site.'],
  ['PASS is refused (403)', 'Only an approver key may finalise PASS. Ask an approver, or record FAIL/UNCERTAIN with your reason.'],
  ['System status DEGRADED', 'Usually no vision provider or no seal key. Inspections still work; perception checks fall back to manual review. See System Health for the component.'],
  ['An error shows a request id', 'Quote it when reporting a problem — every backend log line carries the same id.'],
];

function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function HelpPage() {
  return (
    <div className="stack">
      <PageHeader title="Help & documentation" subtitle="How the Receiving Manager decides, and how to work with it" />

      <nav className="ui-toc" aria-label="Help sections">
        {SECTIONS.map((section) => (
          <button key={section.id} type="button" className="chip" onClick={() => scrollTo(section.id)}>{section.label}</button>
        ))}
      </nav>

      <Card id="help-workflow" title="Receiving workflow" sub="From purchase order to sealed, handed-off record">
        <ol className="ui-steps">
          {WORKFLOW.map((step, index) => (
            <li key={step.title}>
              <span className="step-num">{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
                <Link to={step.page} className="link">Open {step.page.replace(/-/g, ' ')} →</Link>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card id="help-verdicts" flush title="Verdicts" sub="The UI verdict, what is stored in the contract record, and what A2A callers receive">
        <div className="table-wrapper">
          <table className="data-table">
            <thead><tr><th>Verdict</th><th>Stored value</th><th>A2A decision</th><th>Meaning</th></tr></thead>
            <tbody>
              {VERDICTS.map((row) => (
                <tr key={row.stored}>
                  <td><VerdictBadge verdict={row.verdict} /></td>
                  <td className="mono">{row.stored}</td>
                  <td className="mono">{row.decision}</td>
                  <td>{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card id="help-rules" flush title="Decision rules" sub="The model only reports what it sees; these deterministic rules turn that into a verdict">
        <table className="policy-table">
          <thead><tr><th>Rule</th><th>What the agent does</th></tr></thead>
          <tbody>
            {[...RULES, ...EXTRA_RULES].map((rule) => (
              <tr key={rule.title}>
                <td><Icon name={rule.icon} size={16} />{rule.title}</td>
                <td>{rule.body}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ChainDiagram steps={FLOW} />
      </Card>

      <div id="help-lifecycle" className="dashboard-grid">
        <Card title="Exception (issue) lifecycle" sub="One issue per failed or uncertain check">
          <ul className="ui-def-list">
            {ISSUE_STATES.map(([status, text]) => <li key={status}><StatusBadge status={status} /><span>{text}</span></li>)}
          </ul>
        </Card>
        <Card title="Review task lifecycle" sub="Human decisions on uncertain inspections">
          <ul className="ui-def-list">
            {REVIEW_STATES.map(([status, text]) => <li key={status}><StatusBadge status={status} /><span>{text}</span></li>)}
          </ul>
        </Card>
      </div>

      <Card id="help-a2a" title="A2A integration — cube.a2a.v1" sub="How other CUBE agents talk to the Receiving Manager">
        <p className="ui-prose">
          Agents discover this service at <span className="mono">GET /.well-known/agent.json</span> and send JSON envelopes to{' '}
          <span className="mono">POST /api/agent/receive</span> with an <span className="mono">X-API-Key</span>. Every envelope carries
          a <span className="mono">message_id</span> (idempotency key per sender) and a <span className="mono">correlation_id</span> tying a
          multi-agent flow together. Protocol failures still return HTTP 200 with <span className="mono">status: &quot;failed&quot;</span> and an error code.
        </p>
        <ul className="ui-def-list">
          {A2A_OPS.map(([op, text]) => <li key={op}><span className="mono ui-def-key">{op}</span><span>{text}</span></li>)}
        </ul>
        <p className="ui-prose">
          Outbound, an inspection can be handed to <span className="mono">prep_manager</span>, <span className="mono">recovery_manager</span>,{' '}
          <span className="mono">returns_manager</span> or <span className="mono">pack_manager</span> as a <span className="mono">receiving.record_available</span> message.
          It is POSTed only if the peer is configured in A2A_PEERS; otherwise it is stored as <em>not_configured</em> — nothing is ever reported delivered that was not.
        </p>
        <div className="ui-button-row">
          <Link to="a2a" className="btn-theme"><Icon name="link" size={14} /> A2A console</Link>
          <Link to="agent-activity" className="btn-theme"><Icon name="activity" size={14} /> Agent activity log</Link>
        </div>
      </Card>

      <div id="help-shortcuts" className="dashboard-grid">
        <Card flush title="Keyboard shortcuts" sub="Not active while typing in a field">
          <table className="policy-table">
            <tbody>
              {SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.keys}>
                  <td>{shortcut.keys.split(' ').map((key) => <kbd key={key} className="ui-kbd">{key}</kbd>)}</td>
                  <td>{shortcut.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Usage tips">
          <ul className="ui-bullets">
            <li>Every filter lives in the address bar — copy the URL to share an exact filtered list.</li>
            <li>Dashboard numbers are links: click one to open the matching inspections, issues or reviews for the same date window.</li>
            <li>Detail pages have stable links, e.g. <span className="mono">#/app/inspections/&lt;id&gt;</span> — paste them into tickets.</li>
            <li>Failed actions show the backend message and a request id; successful ones confirm with a notification.</li>
            <li>Only approvers can finalise PASS. Operators can escalate to FAIL or UNCERTAIN at any time.</li>
            <li>Badges on Review Queue and Exceptions refresh every minute and after you connect.</li>
          </ul>
        </Card>
      </div>

      <Card id="help-troubleshooting" flush title="Troubleshooting">
        <table className="policy-table">
          <tbody>
            {TROUBLESHOOTING.map(([problem, fix]) => (
              <tr key={problem}><td>{problem}</td><td>{fix}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
