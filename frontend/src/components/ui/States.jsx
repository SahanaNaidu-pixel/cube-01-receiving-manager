/*
 * Page/section states.
 *   <EmptyState icon="inbox" title="No inspections" message="…" action={<button…/>} />
 *   <ErrorState error={err} onRetry={reload} title="Could not load inspections" />
 *        shows err.message, HTTP status/code and the request id (copyable) for support
 *   <LoadingState label="Loading inspections…" />           spinner + label (aria-live)
 *   <Skeleton lines={3} />                                  grey placeholder bars
 *   <ConnectPrompt />                                       "connect an API key" state, links to Settings
 */
import { useState } from 'react';
import { Icon } from '../Shared';
import Link from './Link';

export function EmptyState({ icon = 'inbox', title, message, action, compact = false }) {
  return (
    <div className={`empty-state ui-empty ${compact ? 'compact' : ''}`}>
      <Icon name={icon} size={26} />
      {title && <h3>{title}</h3>}
      {message && <p>{message}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, title = 'Something went wrong', onRetry, compact = false }) {
  const [copied, setCopied] = useState(false);
  const message = error?.message || String(error || 'Unknown error');
  const requestId = error?.requestId;
  const copy = async () => {
    try { await navigator.clipboard.writeText(requestId); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <div className={`ui-error ${compact ? 'compact' : ''}`} role="alert">
      <div className="ui-error-head">
        <Icon name="alert" size={18} />
        <strong>{title}</strong>
      </div>
      <p className="ui-error-message">{message}</p>
      <div className="ui-error-meta">
        {typeof error?.status === 'number' && <span>{error.status === 0 ? 'Network error' : `HTTP ${error.status}`}</span>}
        {error?.code && <span className="mono">{error.code}</span>}
        {requestId && (
          <button type="button" className="ui-chip-btn mono" onClick={copy} title="Copy request id">
            <Icon name="copy" size={12} /> {copied ? 'Copied' : requestId}
          </button>
        )}
      </div>
      {(onRetry || error?.status === 401) && (
        <div className="ui-error-actions">
          {onRetry && <button type="button" className="btn-theme" onClick={onRetry}><Icon name="refresh" size={14} /> Retry</button>}
          {error?.status === 401 && <Link to="settings" className="btn-theme">Check API key</Link>}
        </div>
      )}
    </div>
  );
}

export function LoadingState({ label = 'Loading…', compact = false }) {
  return (
    <div className={`ui-loading ${compact ? 'compact' : ''}`} role="status" aria-live="polite">
      <span className="spinner ui-spinner-accent" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ lines = 3, height = 12 }) {
  return (
    <div className="ui-skeleton-stack" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="ui-skeleton" style={{ height, width: `${100 - ((index * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function ConnectPrompt({ message = 'Enter an operator API key in the top bar (or Settings) and press Connect to load live data.' }) {
  return (
    <EmptyState
      icon="key"
      title="Not connected"
      message={message}
      action={<Link to="settings" className="btn-theme"><Icon name="settings" size={14} /> Open settings</Link>}
    />
  );
}
