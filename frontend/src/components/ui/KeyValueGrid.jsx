/*
 * KeyValueGrid — labelled facts in a responsive grid (a <dl>).
 *   <KeyValueGrid columns={3} items={[
 *     { label: 'PO', value: <Link to={pathFor('purchase-orders', po)}>{po}</Link> },
 *     { label: 'SKU', value: sku, mono: true },
 *     { label: 'Notes', value: text, span: 3 },          // span = number of columns to occupy
 *     { label: 'Hidden when empty', value: null, hideEmpty: true },
 *   ]} />
 * Empty values (null/undefined/'') render '—'; arrays are comma-joined.
 */
const display = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return value;
};

export default function KeyValueGrid({ items = [], columns = 3, dense = false }) {
  const visible = items.filter((item) => item && !(item.hideEmpty && (item.value === null || item.value === undefined || item.value === '')));
  return (
    <dl className={`ui-kv ${dense ? 'dense' : ''}`} style={{ '--kv-cols': columns }}>
      {visible.map((item) => (
        <div key={item.label} className="ui-kv-item" style={item.span ? { gridColumn: `span ${Math.min(item.span, columns)}` } : undefined}>
          <dt>{item.label}</dt>
          <dd className={item.mono ? 'mono' : undefined}>{display(item.value)}</dd>
        </div>
      ))}
    </dl>
  );
}
