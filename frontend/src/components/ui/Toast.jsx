/*
 * Toast notifications for the outcome of async actions.
 *   const toast = useToast();
 *   toast.success('Note added');
 *   toast.error(err, 'Could not add note')   // err = ApiError → message + request id shown
 *   toast.info('Export started');
 *   toast.show({ tone: 'warning', title: '…', message: '…', duration: 8000 })
 * Success/info auto-dismiss after 4 s, errors after 9 s; every toast has a close button.
 * <ToastProvider> is mounted once in App.jsx.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Icon } from '../Shared';

const ToastContext = createContext(null);
const ICONS = { success: 'checkCircle', danger: 'alert', warning: 'alert', info: 'info' };
let nextId = 1;

function ToastItem({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast.duration) return undefined;
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  return (
    <div className={`ui-toast tone-${toast.tone}`} role={toast.tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={ICONS[toast.tone] || 'info'} size={16} />
      <div className="ui-toast-body">
        {toast.title && <strong>{toast.title}</strong>}
        {toast.message && <span>{toast.message}</span>}
        {toast.requestId && <span className="ui-toast-meta mono">request {toast.requestId}</span>}
      </div>
      <button type="button" className="ui-toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification">
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((item) => item.id !== id)), []);

  const show = useCallback(({ tone = 'info', title, message, requestId, duration }) => {
    const id = nextId++;
    const item = { id, tone, title, message, requestId, duration: duration ?? (tone === 'danger' ? 9000 : 4000) };
    setToasts((list) => [...list.slice(-4), item]);
    return id;
  }, []);

  const api = useMemo(() => ({
    show,
    dismiss,
    success: (message, title) => show({ tone: 'success', title: title || message, message: title ? message : undefined }),
    info: (message, title) => show({ tone: 'info', title: title || message, message: title ? message : undefined }),
    warning: (message, title) => show({ tone: 'warning', title: title || message, message: title ? message : undefined }),
    error: (error, title = 'Action failed') => show({
      tone: 'danger',
      title,
      message: error?.message || String(error || 'Unknown error'),
      requestId: error?.requestId,
    }),
  }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ui-toast-region" aria-live="polite">
        {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast() must be used inside <ToastProvider>.');
  return value;
}
