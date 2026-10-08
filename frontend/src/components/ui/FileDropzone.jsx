/*
 * FileDropzone — drag & drop + browse, image previews, size, and a per-file status the caller drives.
 *
 *   const [files, setFiles] = useState([]);
 *   <FileDropzone
 *     items={files} onChange={setFiles}
 *     accept={['image/jpeg', 'image/png', 'image/webp']}   // mime types and/or extensions ('.csv')
 *     maxSizeMb={systemInfo?.environment?.max_image_size_mb} maxFiles={systemInfo?.environment?.upload_max_images}
 *     label="Drop delivery photos here" hint="JPEG, PNG or WebP"
 *     renderExtra={(item) => <select …>view</select>}       // optional per-file controls (e.g. capture view)
 *   />
 *   // while uploading: setFiles((list) => updateFileItem(list, item.id, { status: 'uploading' }))
 *   // after:          setFiles((list) => updateFileItem(list, item.id, { status: 'done', message: 'IMG-0001' }))
 *
 * Item shape: { id, file, status: 'ready'|'uploading'|'done'|'error'|'rejected', message, meta }
 * Files failing accept/maxSizeMb are added with status 'rejected' and a reason, so the operator sees why.
 * Object-URL previews are created for images and revoked on removal/unmount.
 */
import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../../lib/format';
import { Icon } from '../Shared';

let seq = 0;

function matchesAccept(file, accept) {
  if (!accept || !accept.length) return true;
  const name = file.name.toLowerCase();
  return accept.some((rule) => {
    const value = String(rule).toLowerCase().trim();
    if (value.startsWith('.')) return name.endsWith(value);
    if (value.endsWith('/*')) return file.type.startsWith(value.slice(0, -1));
    return file.type === value;
  });
}

/** Wrap File objects as dropzone items, validating type and size. */
export function createFileItems(files, { accept, maxSizeMb } = {}) {
  return [...files].map((file) => {
    let status = 'ready';
    let message = '';
    if (!matchesAccept(file, accept)) { status = 'rejected'; message = 'File type not allowed'; }
    else if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) { status = 'rejected'; message = `Larger than ${maxSizeMb} MB`; }
    seq += 1;
    return { id: `f${Date.now().toString(36)}${seq}`, file, status, message, meta: {} };
  });
}

/** Immutable patch of one item: setFiles((list) => updateFileItem(list, id, { status: 'done' })). */
export function updateFileItem(items, id, patch) {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

const STATUS_LABEL = { ready: 'Ready', uploading: 'Uploading…', done: 'Uploaded', error: 'Failed', rejected: 'Rejected' };
const STATUS_TONE = { ready: 'neutral', uploading: 'info', done: 'success', error: 'danger', rejected: 'danger' };

function Preview({ file }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file.type.startsWith('image/')) return undefined;
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return url
    ? <img src={url} alt="" className="ui-file-thumb" />
    : <span className="ui-file-thumb ui-file-icon"><Icon name="file" size={20} /></span>;
}

export default function FileDropzone({
  items = [],
  onChange,
  accept,
  maxSizeMb,
  maxFiles,
  multiple = true,
  disabled = false,
  label = 'Drop files here or browse',
  hint,
  renderExtra,
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const add = (fileList) => {
    if (disabled || !fileList?.length) return;
    let next = createFileItems(fileList, { accept, maxSizeMb });
    if (!multiple) next = next.slice(0, 1);
    let combined = multiple ? [...items, ...next] : next;
    if (maxFiles) {
      const accepted = combined.filter((item) => item.status !== 'rejected');
      if (accepted.length > maxFiles) {
        const keep = new Set(accepted.slice(0, maxFiles).map((item) => item.id));
        combined = combined.map((item) => (item.status !== 'rejected' && !keep.has(item.id)
          ? { ...item, status: 'rejected', message: `Limit is ${maxFiles} file(s)` }
          : item));
      }
    }
    onChange(combined);
  };

  const remove = (id) => onChange(items.filter((item) => item.id !== id));
  const acceptAttr = accept?.length ? accept.join(',') : undefined;

  return (
    <div className="ui-dropzone-wrap">
      <div
        className={`ui-dropzone ${dragging ? 'is-drag' : ''} ${disabled ? 'is-disabled' : ''}`}
        onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); add(event.dataTransfer.files); }}
      >
        <Icon name="upload" size={24} />
        <div className="ui-dropzone-text">
          <strong>{label}</strong>
          <span className="hint">
            {hint}
            {maxSizeMb ? `${hint ? ' · ' : ''}max ${maxSizeMb} MB each` : ''}
            {maxFiles ? ` · up to ${maxFiles} file(s)` : ''}
          </span>
        </div>
        <button type="button" className="btn-theme" onClick={() => inputRef.current?.click()} disabled={disabled}>
          <Icon name="plus" size={14} /> Browse
        </button>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept={acceptAttr}
          multiple={multiple}
          disabled={disabled}
          tabIndex={-1}
          onChange={(event) => { add(event.target.files); event.target.value = ''; }}
        />
      </div>

      {items.length > 0 && (
        <ul className="ui-file-list">
          {items.map((item) => (
            <li key={item.id} className={`ui-file-item status-${item.status}`}>
              <Preview file={item.file} />
              <div className="ui-file-info">
                <span className="ui-file-name" title={item.file.name}>{item.file.name}</span>
                <span className="hint">{formatBytes(item.file.size)}{item.message ? ` · ${item.message}` : ''}</span>
                {renderExtra && item.status !== 'rejected' && <div className="ui-file-extra">{renderExtra(item)}</div>}
              </div>
              <span className={`ui-badge tone-${STATUS_TONE[item.status] || 'neutral'}`}>
                {item.status === 'uploading' && <span className="spinner ui-spinner-accent ui-spinner-xs" aria-hidden="true" />}
                {STATUS_LABEL[item.status] || item.status}
              </span>
              <button
                type="button"
                className="ui-icon-btn"
                onClick={() => remove(item.id)}
                disabled={item.status === 'uploading'}
                aria-label={`Remove ${item.file.name}`}
              >
                <Icon name="x" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
