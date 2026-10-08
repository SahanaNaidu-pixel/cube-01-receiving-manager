/*
 * ConfirmDialog — "are you sure?" for consequential actions, built on Modal + AsyncButton.
 *   {confirming && (
 *     <ConfirmDialog
 *       title="Resolve issue?" message="The issue will be closed as resolved."
 *       confirmLabel="Resolve" tone="danger"                      // tone: 'primary' (default) | 'danger'
 *       onConfirm={() => issueAction(id, 'resolve', { note })}   // promise; dialog closes on success
 *       onCancel={() => setConfirming(false)}
 *       successToast="Issue resolved" onDone={reload}
 *     >optional extra content (e.g. a note field)</ConfirmDialog>
 *   )}
 * On failure the dialog stays open, the button shows the failed state and a toast carries the error.
 */
import Modal from './Modal';
import AsyncButton from './AsyncButton';

export default function ConfirmDialog({
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  onConfirm,
  onCancel,
  onDone,
  successToast,
  errorToast,
  confirmDisabled = false,
  children,
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={(
        <>
          <button type="button" className="btn-theme" onClick={onCancel}>{cancelLabel}</button>
          <AsyncButton
            variant={tone === 'danger' ? 'danger' : 'primary'}
            label={confirmLabel}
            loadingLabel="Working…"
            disabled={confirmDisabled}
            onClick={onConfirm}
            successToast={successToast}
            errorToast={errorToast || `${confirmLabel} failed`}
            onSuccess={(result) => { onDone?.(result); onCancel?.(); }}
            resetAfter={0}
          />
        </>
      )}
    >
      {message && <p className="ui-confirm-message">{message}</p>}
      {children}
    </Modal>
  );
}
