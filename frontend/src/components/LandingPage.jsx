import { Icon } from './Shared';
import { ChainDiagram } from './RulesView';
import { PIPELINE } from './DashboardView';

const MANUAL = [
  'Clerk counts cartons by hand and signs the carrier\'s paperwork before anyone opens a box',
  'Wrong variants and missing parts surface weeks later, at pick time',
  'Damage claims stall because nobody photographed the delivery at receipt',
  'No record of who accepted what, or why',
];

const WITH_AGENT = [
  'Every delivery is checked against the PO line: quantity, cartons, SKU, variant, condition, components',
  'Exceptions are flagged at the dock while the carrier is still there',
  'Photos are hashed into a sealed, tamper-evident evidence record',
  'Low-confidence or failed perception goes to a human — never auto-accepted',
];

const WORKFLOW = [
  { title: 'PO line', sub: 'Expected values from the purchase order' },
  { title: 'Capture', sub: 'Pallet, carton, label, unit, kit photos' },
  { title: 'Perceive', sub: 'Vision model reads counts & labels' },
  { title: 'Decide', sub: 'Deterministic rules, per check' },
  { title: 'Seal', sub: 'Hash-chained, HMAC-signed record' },
];

const PRINCIPLES = [
  { tag: 'FAIL-OPEN', tone: 't-purple', title: 'Never auto-accept on doubt', body: 'If perception fails or times out, the delivery goes on prep hold for review instead of into stock.' },
  { tag: 'PO IS TRUTH', tone: 't-blue', title: 'Expected values come from the PO', body: 'SKU, variant and quantities are never taken from what the camera claims to see.' },
  { tag: 'EVIDENCE', tone: 't-green', title: 'Tamper-evident by design', body: 'Each analysis and override appends a new sealed record version you can verify at any time.' },
  { tag: 'HUMAN', tone: 't-amber', title: 'Operators stay in control', body: 'Overrides need a reason, and only approvers can release a delivery as Passed.' },
];

export default function LandingPage({ theme, onToggleTheme, onOpenApp, health }) {
  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

  return (
    <>
      <header className="public-navbar">
        <div className="public-nav-container">
          <button type="button" className="brand-logo" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <span className="brand-mark"><Icon name="box" size={18} /></span>
            <span>
              <span className="brand-logo-text">RECEIVING</span>
              <span className="brand-logo-sub">Manager · Pod 01</span>
            </span>
          </button>
          <nav className="public-nav-links" aria-label="Page sections">
            <button type="button" className="nav-link" onClick={() => scrollTo('why')}>Why</button>
            <button type="button" className="nav-link" onClick={() => scrollTo('workflow')}>How it works</button>
            <button type="button" className="nav-link" onClick={() => scrollTo('principles')}>Principles</button>
            <button type="button" className="nav-link" onClick={() => onOpenApp('rules')}>Rules</button>
          </nav>
          <div className="public-nav-actions">
            <button type="button" className="btn-theme" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} /><span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
            <button type="button" className="btn-primary" onClick={() => onOpenApp('dashboard')}>
              Open workspace <Icon name="arrowRight" size={15} />
            </button>
          </div>
        </div>
      </header>

      <main className="public-page-wrapper">
        <section className="landing-hero">
          <span className="hero-badge"><Icon name="scan" size={13} /> AI receiving inspection</span>
          <h1 className="hero-title">Catch supplier discrepancies <span>at the dock, not on the shelf</span></h1>
          <p className="hero-subtitle">
            Photograph each inbound delivery and the receiving agent checks it against the purchase order line:
            counts, cartons, SKU, variant, damage and missing parts. Every verdict is sealed with its evidence.
          </p>
          <div className="hero-cta-group">
            <button type="button" className="btn-primary btn-large no-offset" onClick={() => onOpenApp('scanner')}>
              <Icon name="scan" size={17} /> Inspect a delivery
            </button>
            <button type="button" className="btn-theme btn-large" onClick={() => onOpenApp('benchmark')}>
              <Icon name="gauge" size={17} /> Run the 8-scenario benchmark
            </button>
          </div>
          <div className="hero-teaser-card">
            <ChainDiagram steps={PIPELINE} activeIndex={2} />
            <p className="teaser-caption">Each inspection moves through four stages; the decision is never made without photo evidence.</p>
          </div>
        </section>

        <section id="why" className="landing-section landing-anchor">
          <span className="section-tag">Why</span>
          <h2 className="section-heading">Receiving is where inventory errors are cheapest to fix</h2>
          <p className="section-desc">
            A short shipment or wrong variant costs minutes to dispute at the dock, and days once it reaches the pick face.
          </p>
          <div className="comparison-grid">
            <div className="comp-card negative">
              <h3 className="comp-title"><Icon name="xCircle" size={18} /> Manual receiving</h3>
              <ul className="comp-list">
                {MANUAL.map((item) => <li key={item}><Icon name="x" size={14} />{item}</li>)}
              </ul>
            </div>
            <div className="comp-card positive">
              <h3 className="comp-title"><Icon name="check" size={18} /> With the receiving agent</h3>
              <ul className="comp-list">
                {WITH_AGENT.map((item) => <li key={item}><Icon name="check" size={14} />{item}</li>)}
              </ul>
            </div>
          </div>
        </section>

        <section id="workflow" className="landing-section landing-anchor">
          <span className="section-tag">How it works</span>
          <h2 className="section-heading">From purchase order to sealed evidence</h2>
          <p className="section-desc">The model only reports what it sees. A deterministic rules engine turns those readings into the verdict.</p>
          <div className="workflow-diagram">
            {WORKFLOW.map((step, index) => (
              <div key={step.title} style={{ display: 'contents' }}>
                {index > 0 && <span className="wf-arrow" aria-hidden="true">→</span>}
                <div className="wf-box">
                  <div className="wf-title">{step.title}</div>
                  <div className="wf-sub">{step.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="principles" className="landing-section landing-anchor">
          <span className="section-tag">Principles</span>
          <h2 className="section-heading">Built to be trusted on the dock</h2>
          <p className="section-desc">Four rules the agent never breaks.</p>
          <div className="principles-grid">
            {PRINCIPLES.map((item) => (
              <article key={item.tag} className="principle-card">
                <span className={`principle-tag ${item.tone}`}>{item.tag}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <footer className="public-footer">
          <div className="footer-container">
            <div className="footer-brand">
              <button type="button" className="brand-logo" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
                <span className="brand-mark"><Icon name="box" size={18} /></span>
                <span className="brand-logo-text">RECEIVING</span>
              </button>
              <p>AI-assisted inbound inspection: verify supplier deliveries against purchase orders with sealed photo evidence.</p>
            </div>
            <div className="footer-col">
              <h4>Workspace</h4>
              <ul className="footer-links">
                <li><button type="button" onClick={() => onOpenApp('dashboard')}>Dashboard</button></li>
                <li><button type="button" onClick={() => onOpenApp('scanner')}>Receiving inspection</button></li>
                <li><button type="button" onClick={() => onOpenApp('ledger')}>Inspections</button></li>
              </ul>
            </div>
            <div className="footer-col">
              <h4>Quality</h4>
              <ul className="footer-links">
                <li><button type="button" onClick={() => onOpenApp('benchmark')}>Scenario benchmark</button></li>
                <li><button type="button" onClick={() => onOpenApp('rules')}>Receiving rules</button></li>
              </ul>
            </div>
            <div className="footer-col">
              <h4>Status</h4>
              <div className="footer-status">
                <span className={`status-dot ${health.ok === null ? '' : health.ok ? 'connected' : 'error'}`} />
                {health.text}
              </div>
            </div>
          </div>
          <div className="footer-bottom">
            <span>Receiving Manager · Pod 01</span>
            <span>Demo scenarios are simulated — use live mode with a vision model for real deliveries.</span>
          </div>
        </footer>
      </main>
    </>
  );
}
