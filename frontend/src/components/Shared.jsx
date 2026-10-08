import { useEffect, useRef, useState } from 'react';
import { fetchInspectionImageUrl, verifyInspection } from '../services/api';
import { checkCategory, checkMeta, decisionMeta, formatTime, shortHash, viewLabel } from '../constants';

// Stroke icons (24px grid). Each entry is one SVG path string.
const ICONS = {
  scan: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  gauge: 'M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  layers: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  box: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
  tag: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  package: 'M16.5 9.4L7.5 4.21M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  play: 'M6 4l13 8-13 8V4z',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  menu: 'M3 12h18M3 6h18M3 18h18',
  x: 'M18 6L6 18M6 6l12 12',
  alert: 'M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  image: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  check: 'M20 6L9 17l-5-5',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  truck: 'M1 3h15v13H1zM16 8h4l3 3v5h-7V8zM5.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  flask: 'M9 3h6M10 3v6L4 20a1 1 0 0 0 .9 1.5h14.2A1 1 0 0 0 20 20l-6-11V3',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  minus: 'M8 12h8M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  ruler: 'M21.3 8.7L8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4zM7.5 10.5l2 2M10.5 7.5l2 2M13.5 4.5l2 2M4.5 13.5l2 2',
  home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10',
  arrowRight: 'M5 12h14M12 5l7 7-7 7',
  xCircle: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6',
};

export function Icon({ name, size = 18, className = '' }) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICONS[name] || ICONS.box} />
    </svg>
  );
}

// Decision pill (PASS, EXCEPTION, …) in the design's verdict-badge style.
export function DecisionPill({ decision }) {
  const value = decision || 'NOT_ANALYZED';
  return <span className={`verdict-badge v-${value}`}>{decisionMeta(value).label}</span>;
}

export function CheckStatus({ status }) {
  return <span className={`verdict-badge v-${status}`}>{checkMeta(status).label}</span>;
}

export function Card({ title, sub, actions, children, className = '', flush = false, ...rest }) {
  return (
    <section className={`card ${className}`} {...rest}>
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2>{title}</h2>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {flush ? children : <div className="card-body">{children}</div>}
    </section>
  );
}

export function EvidenceImage({ inspectionId, imageId, alt }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let cancelled = false;
    let url = '';
    fetchInspectionImageUrl(inspectionId, imageId)
      .then((value) => {
        // If the component unmounted (or ids changed) before the fetch resolved, free the blob now.
        if (cancelled) URL.revokeObjectURL(value);
        else { url = value; setSrc(value); }
      })
      .catch(() => { if (!cancelled) setSrc(''); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [inspectionId, imageId]);
  return src
    ? <img src={src} alt={alt} />
    : <span className="image-placeholder"><Icon name="image" size={22} /><span>{alt}</span></span>;
}

export function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div className="alert alert-danger" role="alert">
      <Icon name="alert" size={16} />
      <span className="alert-text">{message}</span>
      {onDismiss && <button type="button" className="detail-btn" onClick={onDismiss}>Dismiss</button>}
    </div>
  );
}

const fmt = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export const checkLabel = (name) => {
  const text = String(name).replace(/_check$/, '').replace(/_/g, ' ');
  return text === 'sku' ? 'SKU' : text.charAt(0).toUpperCase() + text.slice(1);
};

export function Confidence({ value }) {
  if (typeof value !== 'number') return '—';
  const pct = Math.round(value * 100);
  return (
    <span className="confidence">
      <span className="confidence-bar"><span style={{ width: `${pct}%` }} /></span>
      {pct}%
    </span>
  );
}

export function ChecksTable({ checks }) {
  return (
    <div className="table-wrapper bordered">
      <table className="data-table">
        <thead>
          <tr><th>Check</th><th>Expected</th><th>Observed</th><th>Confidence</th><th>Status</th><th>Reason</th></tr>
        </thead>
        <tbody>
          {checks.map((check) => {
            const category = check.status === 'FAIL' ? checkCategory(check.check_name) : '';
            return (
              <tr key={check.check_name}>
                <td>
                  {checkLabel(check.check_name)}
                  {category && <span className="dup-flag">{category}</span>}
                </td>
                <td className="mono">{fmt(check.expected_value)}</td>
                <td className="mono">{fmt(check.observed_value)}</td>
                <td><Confidence value={check.confidence} /></td>
                <td><CheckStatus status={check.status} /></td>
                <td className="reason">
                  {check.reason}
                  {check.reason_code ? <span className="reason-code">{check.reason_code}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// The same checks as "evidence DNA" cards, used inside the details modal.
export function CheckCards({ checks }) {
  return (
    <div className="dna-node-grid">
      {checks.map((check) => (
        <div key={check.check_name} className="dna-node-card">
          <div className="dna-node-header">
            <span className="dna-node-source">{checkLabel(check.check_name)}</span>
            <CheckStatus status={check.status} />
          </div>
          <div className="dna-node-field">Expected: <span className="dna-node-val">{fmt(check.expected_value)}</span></div>
          <div className="dna-node-field">Observed: <span className="dna-node-val">{fmt(check.observed_value)}</span></div>
          <div className="dna-node-field">Confidence: <Confidence value={check.confidence} /></div>
          {check.reason && <div className="hint" style={{ marginTop: 6 }}>{check.reason}</div>}
        </div>
      ))}
    </div>
  );
}

// Calls GET /verify and shows the hash-chain / seal result inline.
export function VerifyIntegrity({ inspectionId, compact = false }) {
  const [state, setState] = useState({ busy: false, result: null, error: '' });
  useEffect(() => setState({ busy: false, result: null, error: '' }), [inspectionId]);

  const run = async () => {
    setState({ busy: true, result: null, error: '' });
    try {
      setState({ busy: false, result: await verifyInspection(inspectionId), error: '' });
    } catch (error) {
      setState({ busy: false, result: null, error: error.message });
    }
  };

  const { busy, result, error } = state;
  const recordCount = result ? (Array.isArray(result.records) ? result.records.length : result.records) : 0;
  return (
    <div className="verify">
      <button type="button" className={compact ? 'detail-btn' : 'btn-theme'} onClick={run} disabled={busy}>
        {!compact && <Icon name="shield" size={15} />}
        {busy ? 'Verifying…' : compact ? 'Verify' : 'Verify integrity'}
      </button>
      <div aria-live="polite">
        {error && <div className="verify-result bad">{error}</div>}
        {result && result.integrity_verified && (
          <div className="verify-result good">
            <Icon name="check" size={14} /> Verified: {recordCount} record(s){compact ? '' : `, latest hash ${shortHash(result.latest_content_hash)}`}
          </div>
        )}
        {result && !result.integrity_verified && (
          <div className="verify-result bad">
            Integrity NOT verified{recordCount ? '' : ' (no sealed records yet — analyze first)'}
            {(result.problems || []).length > 0 && (
              <ul>{result.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Accessible modal: Esc / backdrop click closes, focus moves into the dialog and back on close.
export function Modal({ title, subtitle, onClose, children, footer, wide = false }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
      if (previous && previous.focus) previous.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-overlay open" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} ref={dialogRef}>
        <div className="modal-header">
          <div>
            <h2 id="modal-title" className="modal-title">{title}</h2>
            {subtitle && <div className="modal-sub">{subtitle}</div>}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close dialog">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  );
}

export function ModalSection({ title, children }) {
  return (
    <div className="modal-section">
      <div className="modal-section-title">{title}</div>
      {children}
    </div>
  );
}

export function HeroStats({ items, flush = false }) {
  return (
    <div className={`modal-hero-grid ${flush ? 'flush' : ''}`}>
      {items.map((item) => (
        <div key={item.label} className="modal-hero-stat">
          <div className="modal-hero-lbl">{item.label}</div>
          <div className={`modal-hero-val ${item.className || ''}`}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export function Gallery({ inspectionId, images }) {
  return (
    <div className="gallery">
      {images.map((image) => (
        <figure key={image.image_id} className="thumb">
          <EvidenceImage inspectionId={inspectionId} imageId={image.image_id} alt={image.filename} />
          <figcaption>
            <span className="thumb-view">{viewLabel(image.image_type)}</span>
            <span className="thumb-name">{image.filename}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export function OverrideTimeline({ overrides, fallback }) {
  if (!overrides.length && !fallback) return null;
  return (
    <div className="timeline-list flush">
      {overrides.length === 0 && (
        <div className="timeline-item item-charge">
          <div className="timeline-content"><strong>{fallback.decision}</strong><p>{fallback.reason || 'no reason recorded'}</p></div>
        </div>
      )}
      {overrides.map((item) => (
        <div key={item.override_id || item.created_at} className="timeline-item item-charge">
          <div className="timeline-content">
            <strong>{item.from_verdict} → {item.to_verdict}</strong>
            <p>{item.reason}</p>
            <div className="timeline-meta">by {item.operator_id || 'operator'}{item.role ? ` (${item.role})` : ''} · {formatTime(item.created_at)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
