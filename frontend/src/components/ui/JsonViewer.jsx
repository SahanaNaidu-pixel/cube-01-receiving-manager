/*
 * JsonViewer — collapsible JSON tree with a copy-to-clipboard button. For records, envelopes, raw responses.
 *   <JsonViewer data={record} title="receiving_record.v1" defaultDepth={1} maxHeight={480} />
 * defaultDepth: levels expanded initially (0 = everything collapsed). Long strings wrap.
 */
import { useState } from 'react';
import { Icon } from '../Shared';

function Primitive({ value }) {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === 'string') return <span className="json-string">&quot;{value}&quot;</span>;
  if (typeof value === 'number') return <span className="json-number">{value}</span>;
  if (typeof value === 'boolean') return <span className="json-boolean">{String(value)}</span>;
  return <span className="json-null">{String(value)}</span>;
}

function Node({ name, value, depth, defaultDepth, isLast }) {
  const isObject = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < defaultDepth);
  const comma = isLast ? '' : ',';
  const label = name !== undefined ? <span className="json-key">{JSON.stringify(name)}: </span> : null;

  if (!isObject) {
    return <div className="json-line">{label}<Primitive value={value} />{comma}</div>;
  }
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value);
  const [openBrace, closeBrace] = isArray ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return <div className="json-line">{label}{openBrace}{closeBrace}{comma}</div>;

  return (
    <div className="json-node">
      <button type="button" className="json-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
        {label}{openBrace}
        {!open && <span className="json-summary"> {entries.length} {isArray ? 'item' : 'key'}{entries.length === 1 ? '' : 's'} {closeBrace}{comma}</span>}
      </button>
      {open && (
        <>
          <div className="json-children">
            {entries.map(([key, child], index) => (
              <Node key={key} name={isArray ? undefined : key} value={child} depth={depth + 1} defaultDepth={defaultDepth} isLast={index === entries.length - 1} />
            ))}
          </div>
          <div className="json-line">{closeBrace}{comma}</div>
        </>
      )}
    </div>
  );
}

export default function JsonViewer({ data, title, defaultDepth = 1, maxHeight = 480 }) {
  const [copied, setCopied] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied('Copied');
    } catch {
      setCopied('Copy failed');
    }
  };
  return (
    <div className="ui-json">
      <div className="ui-json-head">
        <span className="ui-json-title">{title || 'JSON'}</span>
        <button type="button" className="detail-btn" onClick={copy} onBlur={() => setCopied('')}>
          <Icon name="copy" size={12} /> {copied || 'Copy'}
        </button>
      </div>
      <div className="ui-json-body" style={{ maxHeight }}>
        {data === undefined ? <span className="json-null">No data</span> : <Node value={data} depth={0} defaultDepth={defaultDepth} isLast />}
      </div>
    </div>
  );
}
