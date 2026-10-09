import { CHECKS, checkMeta, fmtValue } from '../constants';
import { Icon } from './Shared';

// Split-flap board, like a departures board on the dock. A row's cells flip only when the server streams that
// check's real result (each cell is keyed by its value, so a new value re-mounts and plays the flip once).
// Before a result arrives the row shows the PO value and dashes; nothing is pre-filled from the PO as "seen".
export default function CheckBoard({ checks, expected, running, footer }) {
  const byName = Object.fromEntries((checks || []).map((check) => [check.check_name, check]));
  const done = CHECKS.filter(({ key }) => byName[key]).length;

  return (
    <div className="board" role="table" aria-label={`Inspection checks, ${done} of ${CHECKS.length} evaluated`}>
      <div className="board__head" role="row" aria-rowindex={1}>
        <span role="columnheader">#</span>
        <span role="columnheader">Check</span>
        <span role="columnheader">PO expects</span>
        <span role="columnheader">Agent saw</span>
        <span role="columnheader" style={{ textAlign: 'center' }}>Result</span>
      </div>
      <ol className="board__rows" role="rowgroup">
        {CHECKS.map(({ key, label }, index) => {
          const check = byName[key];
          const meta = check ? checkMeta(check.status) : null;
          const seen = check ? fmtValue(check.observed_value) : '';
          // The check's own expected value when the backend recorded one, otherwise the PO line's value.
          const po = fmtValue(check && check.expected_value != null ? check.expected_value : expected?.[key]);
          return (
            <li key={key} className="board__row" role="row">
              <span className="board__idx" role="cell">{String(index + 1).padStart(2, '0')}</span>
              <span className="cell cell--name" role="cell"><span>{label}</span></span>
              <span className="cell cell--dim" role="cell" title={po}><span>{po}</span></span>
              <span key={`seen-${seen}-${check?.status || ''}`} className={`cell ${check ? 'flip' : 'cell--dim'}`} role="cell" title={seen} style={{ '--d': 0 }}>
                <span>{check ? seen : '— — —'}</span>
              </span>
              <span key={`st-${check?.status || 'pending'}`} role="cell"
                className={`cell cell--status ${meta ? `cell--${meta.tone} flip` : `cell--pending ${running ? 'is-running' : ''}`}`}
                style={{ '--d': 1 }} title={check ? `${check.reason_code}: ${check.reason}` : 'Not evaluated yet'}>
                {meta ? <><Icon name={meta.icon} size={14} /><span>{meta.label}</span></> : <span>{running ? 'reading' : 'idle'}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {footer && <div className="board__foot">{footer}</div>}
    </div>
  );
}
