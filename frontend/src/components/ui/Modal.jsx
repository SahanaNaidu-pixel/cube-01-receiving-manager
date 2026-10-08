/*
 * Modal — accessible dialog.
 *   {open && (
 *     <Modal title="Add note" subtitle="INS-…" onClose={close} footer={<><button…>Cancel</button><AsyncButton…/></>}>
 *       …form…
 *     </Modal>
 *   )}
 * - role="dialog" + aria-modal, labelled by the title
 * - focus moves to the first focusable element (or the dialog), Tab/Shift+Tab cycle inside (focus-trap-lite)
 * - Esc and backdrop click call onClose (pass dismissible={false} to block both while an action runs)
 * - focus returns to the previously focused element on close; body scroll is locked
 * Props: title, subtitle, onClose, footer, wide, dismissible, initialFocusRef, children.
 */
import { useEffect, useId, useRef } from 'react';
import { Icon } from '../Shared';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({ title, subtitle, onClose, footer, wide = false, dismissible = true, initialFocusRef, children }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const first = initialFocusRef?.current || dialog?.querySelector(`.modal-body ${FOCUSABLE}`) || dialog;
    first?.focus();
    document.body.classList.add('modal-open');

    const onKey = (event) => {
      if (event.key === 'Escape' && dismissibleRef.current) {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) { event.preventDefault(); dialog.focus(); return; }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === firstItem || document.activeElement === dialog)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Effects clean up after the DOM update, so only unlock scrolling when no other dialog remains open.
      if (!document.querySelector('.modal-overlay.open')) document.body.classList.remove('modal-open');
      if (previous && previous.focus) previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="modal-overlay open"
      onMouseDown={(event) => { if (event.target === event.currentTarget && dismissibleRef.current) onCloseRef.current?.(); }}
    >
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
        <div className="modal-header">
          <div>
            <h2 id={titleId} className="modal-title">{title}</h2>
            {subtitle && <div className="modal-sub">{subtitle}</div>}
          </div>
          <button type="button" className="modal-close" onClick={() => onCloseRef.current?.()} aria-label="Close dialog" disabled={!dismissible}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  );
}
