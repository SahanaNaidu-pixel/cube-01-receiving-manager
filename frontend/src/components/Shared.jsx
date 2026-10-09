import { useEffect, useRef, useState } from 'react';
import { fetchInspectionImageUrl, verifyInspection } from '../services/api';
import { checkCategory, checkLabel, checkMeta, decisionMeta, fmtValue, shortHash } from '../constants';

// Stroke icons on a 24px grid. Each entry is one SVG path string.
const ICONS = {
  scan: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  gauge: 'M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
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
  minus: 'M5 12h14',
  help: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
  ruler: 'M21.3 8.7L8.7 21.3a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4zM7.5 10.5l2 2M10.5 7.5l2 2M13.5 4.5l2 2M4.5 13.5l2 2',
  cpu: 'M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 9h6v6H9z',
  pen: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  stream: 'M4 6h16M4 12h10M4 18h6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  home: 'M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  menu: 'M3 6h18M3 12h18M3 18h18',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  clipboard: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6v4H9zM8 12h8M8 16h5',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  chevronRight: 'M9 18l6-6-6-6',
  chevronLeft: 'M15 18l-6-6 6-6',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  server: 'M2 4h20v6H2zM2 14h20v6H2zM6 7h.01M6 17h.01',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
};

export function Icon({ name, size = 18, className = '' }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ICONS[name] || ICONS.box} />
    </svg>
  );
}

export function Badge({ tone = 'neutral', children, dot = true }) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot && <span className="badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

// Verdict badge: PASS / FAIL / UNCERTAIN, plus the qualifier when the backend value needs one
// (EXCEPTION -> FAIL "Exception", PENDING_REVIEW -> UNCERTAIN "Not analyzed").
export function DecisionPill({ decision, qualifier = true }) {
  const meta = decisionMeta(decision || 'NOT_ANALYZED');
  return (
    <span className="verdict-pill" title={decision ? `Backend value: ${decision}` : undefined}>
      <Badge tone={meta.tone}>{meta.label}</Badge>
      {qualifier && meta.qualifier && decision === 'PENDING_REVIEW' && <span className="tag tag--hold">{meta.qualifier}</span>}
    </span>
  );
}

export function StatCard({ label, value, tone = '', icon, hint, onClick, share }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`stat-card ${tone ? `stat-card--${tone}` : ''} ${onClick ? 'is-link' : ''}`} onClick={onClick}>
      <div className="stat-card__top">
        <span className="stat-card__label">{label}</span>
        {icon && <span className="stat-card__icon"><Icon name={icon} size={16} /></span>}
      </div>
      <strong className="stat-card__value">{value}</strong>
      {share !== undefined && <div className="stat-card__bar" aria-hidden="true"><i style={{ width: `${Math.round(share * 100)}%` }} /></div>}
      {hint && <span className="stat-card__hint">{hint}</span>}
    </Tag>
  );
}

export function EmptyState({ icon = 'box', title, children, action }) {
  return (
    <div className="empty">
      <span className="empty__icon"><Icon name={icon} size={22} /></span>
      {title && <h3>{title}</h3>}
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// Standard loading / not-connected / error gate for pages that read the inspection list.
export function DataGate({ connected, loading, error, onRetry, onConnect, hasData, children }) {
  if (!connected) {
    return (
      <EmptyState icon="key" title="Not connected"
        action={onConnect && <button type="button" className="btn btn--primary btn--sm" onClick={onConnect}><Icon name="key" size={14} /> Connect operator key</button>}>
        Connect with an operator API key to load inspection data from the backend.
      </EmptyState>
    );
  }
  if (loading && !hasData) {
    return <div className="loading-block" role="status"><span className="spinner" aria-hidden="true" /> Loading inspections…</div>;
  }
  if (error && !hasData) {
    return (
      <EmptyState icon="alert" title="Could not load inspections"
        action={onRetry && <button type="button" className="btn btn--sm" onClick={onRetry}><Icon name="refresh" size={14} /> Retry</button>}>
        {error}
      </EmptyState>
    );
  }
  return children;
}

export function CheckStatus({ status }) {
  const meta = checkMeta(status);
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function Panel({ title, icon, actions, sub, children, className = '', bodyClass = '', ...rest }) {
  return (
    <section className={`panel ${className}`} {...rest}>
      {(title || actions) && (
        <header className="panel__head">
          <h2 className="panel__title">{icon && <Icon name={icon} size={16} />}{title}</h2>
          {actions && <div className="toolbar">{actions}</div>}
        </header>
      )}
      {sub && <p className="panel__sub">{sub}</p>}
      <div className={`panel__body ${bodyClass}`}>{children}</div>
    </section>
  );
}

// <img> cannot send the API key header, so the photo is fetched with it and shown from an object URL.
export function EvidenceImage({ inspectionId, imageId, alt }) {
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let url = '';
    setFailed(false);
    fetchInspectionImageUrl(inspectionId, imageId)
      .then((value) => {
        if (cancelled) URL.revokeObjectURL(value);
        else { url = value; setSrc(value); }
      })
      .catch(() => { if (!cancelled) { setSrc(''); setFailed(true); } });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [inspectionId, imageId]);
  return src
    ? <img src={src} alt={alt} loading="lazy" />
    : (
      <span className={`image-placeholder ${failed ? 'is-missing' : ''}`} role="img" aria-label={failed ? `${alt} (unavailable)` : alt}>
        <Icon name={failed ? 'alert' : 'image'} size={20} />
        {failed && <small>Image unavailable</small>}
      </span>
    );
}

export function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div className="alert alert--fail" role="alert">
      <Icon name="alert" />
      <span className="alert__text">{message}</span>
      {onDismiss && <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss}>Dismiss</button>}
    </div>
  );
}

export function ChecksTable({ checks }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Check</th><th>Expected (PO)</th><th>Observed</th><th>Confidence</th><th>Result</th><th>Reason</th></tr></thead>
        <tbody>
          {checks.map((check) => {
            const category = check.status === 'FAIL' ? checkCategory(check.check_name) : '';
            return (
              <tr key={check.check_name}>
                <td className="table__strong">{checkLabel(check.check_name)} {category && <span className="tag tag--fail">{category}</span>}</td>
                <td className="mono">{fmtValue(check.expected_value)}</td>
                <td className="mono">{fmtValue(check.observed_value)}</td>
                <td className="mono">{typeof check.confidence === 'number' && check.confidence > 0 ? `${Math.round(check.confidence * 100)}%` : '—'}</td>
                <td><CheckStatus status={check.status} /></td>
                <td>{check.reason} {check.reason_code && <code>{check.reason_code}</code>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Calls GET /verify: recomputes every record hash, HMAC seal and the version chain on the server.
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
  return (
    <div className="verify">
      <button type="button" className={`btn ${compact ? 'btn--ghost' : ''} btn--sm`} onClick={run} disabled={busy}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="shield" size={15} />}
        {busy ? 'Verifying…' : compact ? 'Verify' : 'Verify sealed record'}
      </button>
      <div aria-live="polite">
        {error && <div className="verify__result verify__result--bad">{error}</div>}
        {result?.integrity_verified && (
          <div className="verify__result verify__result--good">
            <Icon name="check" size={14} /> {result.records} record(s) verified · {shortHash(result.latest_content_hash)}
          </div>
        )}
        {result && !result.integrity_verified && (
          <div className="verify__result verify__result--bad">
            Integrity NOT verified{result.records ? '' : ' (no sealed record yet: run the inspection first)'}
            {(result.problems || []).length > 0 && <ul>{result.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          </div>
        )}
      </div>
    </div>
  );
}

// Accessible modal: Esc / backdrop click closes; focus moves in and back.
export function Modal({ title, subtitle, onClose, children, footer }) {
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
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} ref={dialogRef}>
        <header className="modal__header">
          <div>
            <h2 id="modal-title" className="modal__title">{title}</h2>
            {subtitle && <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>{subtitle}</p>}
          </div>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close dialog"><Icon name="x" /></button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}
