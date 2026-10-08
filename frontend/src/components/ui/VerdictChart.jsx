/*
 * VerdictChart — stacked daily verdict bars (pure CSS, from real data such as GET /api/dashboard `daily`).
 *   <VerdictChart days={dashboard.daily} onSelect={(date, verdict) => navigate('inspections', { date_from: date, date_to: date, verdict })} />
 * days: [{ date: 'YYYY-MM-DD', pass, fail, uncertain, not_analyzed }]. Each segment is a button (keyboard accessible);
 * clicking a segment passes its verdict (PASS|FAIL|UNCERTAIN|NOT_ANALYZED), clicking the date label passes none.
 */
import { formatDate } from '../../lib/format';

export const VERDICT_SERIES = [
  { key: 'pass', verdict: 'PASS', label: 'Pass', className: 'seg-pass' },
  { key: 'fail', verdict: 'FAIL', label: 'Fail', className: 'seg-fail' },
  { key: 'uncertain', verdict: 'UNCERTAIN', label: 'Uncertain', className: 'seg-uncertain' },
  { key: 'not_analyzed', verdict: 'NOT_ANALYZED', label: 'Not analyzed', className: 'seg-na' },
];

const shortDay = (date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return String(date);
  const [, m, d] = date.split('-');
  return `${Number(d)}/${Number(m)}`;
};

export default function VerdictChart({ days = [], onSelect, height = 180 }) {
  const totals = days.map((day) => VERDICT_SERIES.reduce((sum, s) => sum + (Number(day[s.key]) || 0), 0));
  const max = Math.max(1, ...totals);
  const labelEvery = days.length > 16 ? Math.ceil(days.length / 10) : 1;

  return (
    <div className="ui-vchart">
      <div className="ui-vchart-legend" aria-hidden="true">
        {VERDICT_SERIES.map((s) => <span key={s.key}><i className={s.className} />{s.label}</span>)}
      </div>
      <div className="ui-vchart-plot" style={{ height }}>
        <div className="ui-vchart-axis" aria-hidden="true">
          <span>{max}</span><span>{Math.round(max / 2)}</span><span>0</span>
        </div>
        <div className="ui-vchart-bars">
          {days.map((day, index) => (
            <div key={day.date} className="ui-vchart-col">
              <div className="ui-vchart-stack" title={`${formatDate(day.date)}: ${totals[index]} inspection(s)`}>
                {VERDICT_SERIES.map((s) => {
                  const value = Number(day[s.key]) || 0;
                  if (!value) return null;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      className={`ui-vchart-seg ${s.className}`}
                      style={{ height: `${(value / max) * 100}%` }}
                      onClick={onSelect ? () => onSelect(day.date, s.verdict) : undefined}
                      disabled={!onSelect}
                      aria-label={`${formatDate(day.date)}: ${value} ${s.label}`}
                      title={`${formatDate(day.date)} · ${s.label}: ${value}`}
                    />
                  );
                })}
              </div>
              <button
                type="button"
                className="ui-vchart-label"
                onClick={onSelect ? () => onSelect(day.date) : undefined}
                disabled={!onSelect}
                aria-label={`${formatDate(day.date)}: ${totals[index]} inspection(s)`}
              >
                {index % labelEvery === 0 ? shortDay(day.date) : ''}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
