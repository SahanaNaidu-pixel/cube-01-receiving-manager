/*
 * Building blocks shared by the review / exceptions / evidence / audit pages.
 *
 *   <MultiFilter label="Status" options={[{value,label}]} value={['open']} onChange={(list) => …} />
 *   <TextFilter label="Inspection id" value={q.inspection_id} onChange={(v) => setQuery({inspection_id: v, page: 1})} />
 *   <EvidenceThumb inspectionId imageId alt size="sm|md|lg" to? onOpen? />   lazy-loads the image blob with the API key
 *   <useImageUrl(inspectionId, imageId, {enabled})> → {url, error, loading}
 *   <NotesPanel notes={[…]} onAdd={(text) => promise} />                   list + composer
 *   <ChecksList checks={record.checks} />                                    FAIL/UNCERTAIN highlighted first
 *   <TraceChain steps={[{label, value, to}]} />                              Inspection → Issue → Evidence
 *   <InlineError error={err} />                                              backend message + status + request id
 *   <AssignForm current principal onAssign={(who) => promise} onDone />        assignee input + Assign button
 *   <IssueActionDialog issue action="resolve|reopen" onCancel onDone />        confirm + optional note
 *   <ConfidenceBar value={0.82} />                                            reading confidence
 */
import { useEffect, useRef, useState } from 'react';
import { fetchInspectionImageUrl, issueAction } from '../../services/api';
import { formatDateTime, humanize } from '../../lib/format';
import { pathFor } from '../../lib/router';
import { AsyncButton, ConfirmDialog, Icon, Link, Modal } from '../../components/ui';
import { checkTone, sortChecks, stateText } from './helpers';

// ── multi-select filter (popover with checkboxes) ──

export function MultiFilter({ label, options, value = [], onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = new Set(value);
  // Values in the URL that the option list does not know (e.g. a new reason code) stay selectable.
  const all = [...options, ...value.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: v }))];

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (event) => { if (ref.current && !ref.current.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggle = (v) => {
    const next = selected.has(v) ? value.filter((x) => x !== v) : [...value, v];
    onChange(next);
  };
  const summary = value.length === 0 ? 'All'
    : value.length === 1 ? (all.find((o) => o.value === value[0])?.label || value[0])
      : `${value.length} selected`;

  return (
    <div className="rv-multi" ref={ref}>
      <button type="button" className={`filter-select rv-multi-btn ${value.length ? 'is-active' : ''}`}
        aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="rv-multi-label">{label}:</span> <span>{summary}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="rv-multi-pop" role="listbox" aria-multiselectable="true" aria-label={label}>
          {all.map((option) => (
            <label key={option.value} className="rv-multi-opt">
              <input type="checkbox" checked={selected.has(option.value)} onChange={() => toggle(option.value)} />
              <span>{option.label}</span>
            </label>
          ))}
          <div className="rv-multi-foot">
            <button type="button" className="detail-btn" onClick={() => onChange([])} disabled={!value.length}>Clear</button>
            <button type="button" className="detail-btn" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── debounced free-text filter for exact-match fields ──

export function TextFilter({ label, value = '', onChange, placeholder, width = 170 }) {
  const [text, setText] = useState(value || '');
  const timer = useRef(null);
  useEffect(() => { setText(value || ''); }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const send = (next) => { window.clearTimeout(timer.current); if (next !== (value || '')) onChange(next); };
  return (
    <label className="rv-text-filter">
      <span className="sr-only">{label}</span>
      <input
        className="filter-input"
        style={{ width }}
        value={text}
        placeholder={placeholder || label}
        aria-label={label}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => send(next.trim()), 450);
        }}
        onKeyDown={(event) => { if (event.key === 'Enter') send(text.trim()); }}
      />
    </label>
  );
}

// ── images (fetched with the API key → object URL) ──

export function useImageUrl(inspectionId, imageId, { enabled = true } = {}) {
  const [state, setState] = useState({ url: '', error: null, loading: false });
  useEffect(() => {
    if (!enabled || !inspectionId || !imageId) return undefined;
    let cancelled = false;
    let url = '';
    setState({ url: '', error: null, loading: true });
    fetchInspectionImageUrl(inspectionId, imageId)
      .then((objectUrl) => {
        url = objectUrl;
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setState({ url: objectUrl, error: null, loading: false });
      })
      .catch((error) => { if (!cancelled) setState({ url: '', error, loading: false }); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [inspectionId, imageId, enabled]);
  return state;
}

/** Thumbnail that only fetches once scrolled into view. `to` makes it a link; `onOpen` a button. */
export function EvidenceThumb({ inspectionId, imageId, alt, size = 'md', to, onOpen, caption, selected = false }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visible || !ref.current) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  const { url, error, loading } = useImageUrl(inspectionId, imageId, { enabled: visible });

  const body = (
    <>
      <span className="rv-thumb-frame">
        {url && <img src={url} alt={alt || imageId} loading="lazy" />}
        {!url && (loading || !visible) && <span className="ui-skeleton rv-thumb-skel" aria-hidden="true" />}
        {error && <span className="rv-thumb-error" title={error.message}><Icon name="image" size={18} /> Unavailable</span>}
      </span>
      {caption !== undefined ? caption : <span className="rv-thumb-cap mono">{imageId}</span>}
    </>
  );
  const cls = `rv-thumb rv-thumb-${size} ${selected ? 'is-selected' : ''}`;
  if (to) return <Link to={to} className={cls} aria-label={`Open evidence ${imageId}`}><span ref={ref} className="rv-thumb-inner">{body}</span></Link>;
  if (onOpen) return <button type="button" className={cls} onClick={onOpen} aria-pressed={selected || undefined}><span ref={ref} className="rv-thumb-inner">{body}</span></button>;
  return <div className={cls}><span ref={ref} className="rv-thumb-inner">{body}</span></div>;
}

// ── notes ──

export function NotesList({ notes = [], empty = 'No notes yet.' }) {
  if (!notes.length) return <p className="hint">{empty}</p>;
  return (
    <ol className="rv-notes">
      {[...notes].reverse().map((note) => (
        <li key={note.note_id || note.created_at} className="rv-note">
          <div className="rv-note-head">
            <strong>{note.author || 'unknown'}</strong>
            {note.role && <span className="ui-badge tone-neutral">{note.role}</span>}
            <time className="hint" dateTime={note.created_at}>{formatDateTime(note.created_at)}</time>
          </div>
          <p className="rv-note-text">{note.text}</p>
        </li>
      ))}
    </ol>
  );
}

export function NoteComposer({ onAdd, label = 'Add comment', placeholder = 'Write a comment for the record…', onDone }) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  return (
    <div className="rv-composer">
      <label className="field">
        <span className="field-label">{label}</span>
        <textarea className="filter-input full" value={text} maxLength={2000} placeholder={placeholder}
          onChange={(event) => setText(event.target.value)} />
      </label>
      <div className="rv-composer-foot">
        <span className="hint">{trimmed.length}/2000</span>
        <AsyncButton
          label={label} loadingLabel="Saving…" successLabel="Saved" icon="plus" variant="primary"
          disabled={!trimmed}
          onClick={() => onAdd(trimmed)}
          successToast="Comment added" errorToast="Could not add comment"
          onSuccess={() => { setText(''); onDone?.(); }}
        />
      </div>
    </div>
  );
}

// ── machine checks ──

export function ChecksList({ checks = [], imageLink }) {
  if (!checks.length) return <p className="hint">No checks recorded — the inspection has not been analysed yet.</p>;
  return (
    <ul className="rv-checks">
      {sortChecks(checks).map((check) => {
        const tone = checkTone(check.verdict);
        return (
          <li key={check.check_key || check.check_name} className={`rv-check tone-${tone}`}>
            <div className="rv-check-head">
              <span className={`ui-badge tone-${tone}`}>{check.verdict}</span>
              <strong>{humanize(check.check_key || check.check_name)}</strong>
              {check.reason_code && <span className="mono rv-code">{check.reason_code}</span>}
              {check.model_version && <span className="hint rv-check-src" title="Decided by">{check.model_version}</span>}
            </div>
            {check.reason && <p className="rv-check-reason">{check.reason}</p>}
            <dl className="rv-check-states">
              <div><dt>Expected</dt><dd>{stateText(check.expected_state)}</dd></div>
              <div><dt>Observed</dt><dd>{stateText(check.observed_state)}</dd></div>
            </dl>
            {check.image_ids?.length > 0 && (
              <div className="rv-check-images">
                <span className="hint">Evidence:</span>
                {check.image_ids.map((id) => (
                  <Link key={id} to={imageLink ? imageLink(id) : pathFor('evidence', id)} className="link mono">{id}</Link>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── traceability ──

export function TraceChain({ steps = [] }) {
  return (
    <nav className="rv-trace" aria-label="Traceability">
      {steps.filter(Boolean).map((step, index) => (
        <span key={`${step.label}-${index}`} className="rv-trace-step">
          {index > 0 && <Icon name="arrowRight" size={14} />}
          <span className="rv-trace-box">
            <span className="rv-trace-label">{step.label}</span>
            {step.to
              ? <Link to={step.to} className="link mono">{step.value}</Link>
              : <span className="mono">{step.value ?? '—'}</span>}
            {step.badge}
          </span>
        </span>
      ))}
    </nav>
  );
}

// ── errors ──

export function InlineError({ error, title }) {
  if (!error) return null;
  return (
    <div className="rv-inline-error" role="alert">
      <Icon name="alert" size={14} />
      <div>
        {title && <strong>{title}: </strong>}
        <span>{error.message || String(error)}</span>
        <span className="hint rv-inline-meta">
          {typeof error.status === 'number' && (error.status === 0 ? ' · network error' : ` · HTTP ${error.status}`)}
          {error.code ? ` · ${error.code}` : ''}
          {error.requestId ? ` · request ${error.requestId}` : ''}
        </span>
      </div>
    </div>
  );
}

export function IdChip({ value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span>—</span>;
  return (
    <button type="button" className="ui-chip-btn mono" title="Copy"
      onClick={async (event) => {
        event.stopPropagation();
        try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); }
      }}
      onBlur={() => setCopied(false)}>
      <Icon name="copy" size={11} /> {copied ? 'Copied' : value}
    </button>
  );
}


// ── large preview modal ──

export function ImagePreviewModal({ file, onClose }) {
  const { url, error, loading } = useImageUrl(file?.inspection_id, file?.evidence_id || file?.image_id);
  if (!file) return null;
  const id = file.evidence_id || file.image_id;
  return (
    <Modal
      wide
      title={file.filename || id}
      subtitle={`${id} · ${humanize(file.view)} view`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-theme" onClick={onClose}>Close</button>
          <Link to={pathFor('evidence', id)} className="btn-primary" onClick={onClose}>
            <Icon name="external" size={14} /> Evidence details
          </Link>
        </>
      )}
    >
      <div className="rv-preview">
        {loading && <span className="spinner ui-spinner-accent" aria-label="Loading image" />}
        {error && <InlineError error={error} title="Image could not be loaded" />}
        {url && <img src={url} alt={file.filename || id} />}
      </div>
    </Modal>
  );
}

// ── assignment (operator id; "Me" shortcut from the connected principal) ──

export function AssignForm({ current, principal, onAssign, onDone }) {
  const [who, setWho] = useState(current || '');
  const trimmed = who.trim();
  return (
    <div className="rv-inline-form">
      <label className="field">
        <span className="field-label">Assignee (operator id)</span>
        <input className="filter-input full" value={who} maxLength={200} placeholder="operator id"
          onChange={(event) => setWho(event.target.value)} />
      </label>
      {principal?.operator_id && principal.operator_id !== current && (
        <button type="button" className="detail-btn" onClick={() => setWho(principal.operator_id)}>Me ({principal.operator_id})</button>
      )}
      <AsyncButton icon="users" label="Assign" loadingLabel="Assigning…" successLabel="Assigned"
        disabled={!trimmed || trimmed === current} onClick={() => onAssign(trimmed)}
        successToast={`Assigned to ${trimmed}`} errorToast="Could not assign" onSuccess={onDone} />
    </div>
  );
}

// ── reading confidence ──

export function ConfidenceBar({ value }) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return <span className="hint">—</span>;
  const ratio = Math.max(0, Math.min(1, Number(value)));
  const level = ratio < 0.6 ? 'low' : ratio >= 0.85 ? 'high' : '';
  return (
    <span className="rv-conf" title={`Confidence ${(ratio * 100).toFixed(0)}%`}>
      <span className={`rv-conf-bar ${level}`}><span style={{ width: `${ratio * 100}%` }} /></span>
      <span className="mono">{(ratio * 100).toFixed(0)}%</span>
    </span>
  );
}

// ── issue resolve / reopen confirmation ──

/** Confirm resolve / reopen with an optional note (stored on the issue). */
export function IssueActionDialog({ issue, action, onCancel, onDone }) {
  const [note, setNote] = useState('');
  const resolve = action === 'resolve';
  return (
    <ConfirmDialog
      title={resolve ? `Resolve ${issue.issue_id}?` : `Reopen ${issue.issue_id}?`}
      message={resolve
        ? `The ${humanize(issue.issue_type).toLowerCase()} issue will be closed as resolved by you. It can be reopened later.`
        : 'The issue returns to open and its resolution stamp is cleared.'}
      confirmLabel={resolve ? 'Resolve issue' : 'Reopen issue'}
      tone={resolve ? 'primary' : 'danger'}
      onConfirm={() => issueAction(issue.issue_id, action, { note: note.trim() || undefined })}
      onCancel={onCancel}
      onDone={onDone}
      successToast={resolve ? `${issue.issue_id} resolved` : `${issue.issue_id} reopened`}
    >
      <label className="field">
        <span className="field-label">Note (optional, kept on the issue)</span>
        <textarea className="filter-input full" rows={3} maxLength={2000} value={note}
          placeholder={resolve ? 'How was it resolved? e.g. supplier credit agreed' : 'Why reopen?'}
          onChange={(event) => setNote(event.target.value)} />
      </label>
    </ConfirmDialog>
  );
}
