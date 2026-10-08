/*
 * AsyncButton — a button for a real async action, with visible state: idle → loading → success | failed.
 *
 *   <AsyncButton
 *     onClick={() => addInspectionNote(id, text)}       // must return a promise
 *     label="Add note" loadingLabel="Saving…" successLabel="Saved" failedLabel="Failed — retry"
 *     icon="plus" variant="primary"                     // primary | secondary | small | danger
 *     successToast="Note added"                         // optional toast on success
 *     errorToast="Could not add note"                   // toast title on failure (default 'Action failed'; false = none)
 *     onSuccess={(result) => reload()} onError={(err) => …}
 *   />
 * The button is disabled while loading; success/failed labels revert to idle after `resetAfter` ms (default 2500).
 * Errors are caught (shown as a toast + failed state) and never rethrown.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Shared';
import { useToast } from './Toast';

const VARIANTS = { primary: 'btn-primary', secondary: 'btn-theme', small: 'detail-btn', danger: 'btn-theme ui-btn-danger' };

export default function AsyncButton({
  onClick,
  label,
  children,
  loadingLabel,
  successLabel,
  failedLabel,
  icon,
  variant = 'secondary',
  className = '',
  disabled = false,
  type = 'button',
  successToast,
  errorToast = 'Action failed',
  onSuccess,
  onError,
  resetAfter = 2500,
  title,
}) {
  const [state, setState] = useState('idle');
  const toast = useToast();
  const mounted = useRef(true);
  const timer = useRef(null);

  useEffect(() => () => { mounted.current = false; window.clearTimeout(timer.current); }, []);

  const settle = (next) => {
    if (!mounted.current) return;
    setState(next);
    window.clearTimeout(timer.current);
    if (resetAfter) timer.current = window.setTimeout(() => { if (mounted.current) setState('idle'); }, resetAfter);
  };

  const handle = async (event) => {
    if (state === 'loading') return;
    setState('loading');
    try {
      const result = await onClick?.(event);
      settle('success');
      if (successToast) toast.success(typeof successToast === 'function' ? successToast(result) : successToast);
      onSuccess?.(result);
    } catch (error) {
      settle('failed');
      if (errorToast) toast.error(error, errorToast);
      onError?.(error);
    }
  };

  const base = label ?? children;
  const text = state === 'loading' ? (loadingLabel || 'Working…')
    : state === 'success' ? (successLabel || base)
      : state === 'failed' ? (failedLabel || base)
        : base;
  const stateIcon = state === 'success' ? 'check' : state === 'failed' ? 'alert' : icon;

  return (
    <button
      type={type}
      className={`${VARIANTS[variant] || VARIANTS.secondary} ui-async-btn is-${state} ${className}`}
      onClick={handle}
      disabled={disabled || state === 'loading'}
      aria-busy={state === 'loading'}
      title={title}
    >
      {state === 'loading'
        ? <span className={`spinner ${variant === 'primary' ? '' : 'ui-spinner-accent'}`} aria-hidden="true" />
        : stateIcon && <Icon name={stateIcon} size={14} />}
      <span>{text}</span>
    </button>
  );
}
