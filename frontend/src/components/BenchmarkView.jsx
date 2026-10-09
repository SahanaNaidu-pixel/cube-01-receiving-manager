import { useState } from 'react';
import { analyzeInspection, createInspection, uploadInspectionImages } from '../services/api';
import { SCENARIOS } from '../constants';
import { toPoPayload } from './PoEditor';
import { DecisionPill, Icon, Panel } from './Shared';

// The backend refuses to analyze with zero evidence, so each benchmark inspection gets one generated
// placeholder PNG. The scripted scenario, not the pixels, drives the verdict; that is the whole point:
// this measures the rules engine, never the vision model.
function placeholderImage(scenario) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) { reject(new Error('Canvas is not available in this browser.')); return; }
    ctx.fillStyle = '#15171a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ff5a1f';
    ctx.fillRect(0, 0, 640, 8);
    ctx.fillStyle = '#ecebe6';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText('SCRIPTED BENCHMARK', 40, 150);
    ctx.font = '26px monospace';
    ctx.fillText(scenario.key, 40, 205);
    canvas.toBlob((blob) => {
      if (blob) resolve(new File([blob], `benchmark-${scenario.key}.png`, { type: 'image/png' }));
      else reject(new Error('Could not generate the placeholder image.'));
    }, 'image/png');
  });
}

const DEMO_REQUIRED = 'Scripted scenarios are disabled on this backend (DEMO_MODE=false), so the benchmark would send placeholder images to the real model. Start the backend with DEMO_MODE=true to run it.';

export default function BenchmarkView({ poForm, perception, onChanged, onOpenInspection }) {
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState('');
  const [notice, setNotice] = useState('');
  const po = toPoPayload(poForm);

  const run = async () => {
    if (!perception) { setNotice('Backend status unknown: connect to the backend first.'); return; }
    if (!perception.demo_scenarios) { setNotice(DEMO_REQUIRED); return; }
    setRunning(true);
    setNotice('');
    setRows([]);
    const results = [];
    for (const scenario of SCENARIOS) {
      setCurrent(scenario.key);
      const row = { ...scenario, actual: null, inspectionId: '', error: '', ms: 0 };
      const started = performance.now();
      try {
        const created = await createInspection(po);
        row.inspectionId = created.inspection_id;
        await uploadInspectionImages(created.inspection_id, [await placeholderImage(scenario)], 'other');
        const result = await analyzeInspection(created.inspection_id, scenario.key);
        if (result.demo_mode === false) { setNotice(DEMO_REQUIRED); break; }
        row.actual = result.decision;
      } catch (error) {
        row.error = error.message;
        if ([401, 503, 0].includes(error.status)) {
          results.push(row);
          setRows([...results]);
          setNotice(error.message);
          break;
        }
      }
      row.ms = Math.round(performance.now() - started);
      results.push(row);
      setRows([...results]);
    }
    setCurrent('');
    setRunning(false);
    onChanged();
  };

  const scored = rows.filter((row) => row.actual || row.error);
  const passed = rows.filter((row) => row.actual === row.expected).length;
  const pending = SCENARIOS.filter((s) => !rows.some((r) => r.key === s.key));

  return (
    <div className="stack">
      <div className="alert alert--info">
        <Icon name="flask" size={16} />
        <span className="alert__text">
          <strong>This tests the rules, not the AI.</strong>
          Each scenario feeds fixed, scripted readings for SKU BLUE-BOTTLE-001 into the real decision engine and sealing path.
          It says nothing about how well the vision model reads real photos. Run it against the PO-9001 sample line; current
          manifest: <span className="mono">{po.po_id || '—'} · {po.sku || '—'}</span>.
        </span>
      </div>
      <Panel title="Verdict paths" icon="gauge"
        actions={(
          <button type="button" className="btn btn--primary btn--sm" onClick={run} disabled={running} aria-busy={running}>
            {running ? <span className="spinner" /> : <Icon name="play" size={14} />}{running ? 'Running…' : `Run ${SCENARIOS.length} scenarios`}
          </button>
        )}>
        {notice && <div className="alert alert--warn" role="alert" style={{ marginBottom: 12 }}><Icon name="alert" size={16} /><span className="alert__text">{notice}</span></div>}
        {scored.length > 0 && (
          <div className="score" aria-live="polite">
            <strong>{passed}/{scored.length}</strong>
            <div className="score__bar"><i style={{ width: `${(passed / scored.length) * 100}%` }} /></div>
            <span className="eyebrow">expected verdicts</span>
          </div>
        )}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Scenario</th><th>Expected</th><th>Actual</th><th>Result</th><th>Time</th><th /></tr></thead>
            <tbody>
              {[...rows, ...pending.map((s) => ({ ...s, placeholder: true }))].map((row) => (
                <tr key={row.key} style={row.placeholder ? { opacity: current === row.key ? 1 : 0.55 } : undefined}>
                  <td><div className="table__strong">{row.label}</div><div className="table__sub mono">{row.key}</div></td>
                  <td><DecisionPill decision={row.expected} /></td>
                  <td>{row.placeholder ? (current === row.key ? <span className="spinner" /> : '—')
                    : row.actual ? <DecisionPill decision={row.actual} /> : <span style={{ color: 'var(--fail)' }}>{row.error || '—'}</span>}</td>
                  <td>{row.placeholder ? '' : <span className={`tag ${row.actual === row.expected ? 'tag--pass' : 'tag--fail'}`}>{row.actual === row.expected ? 'match' : 'mismatch'}</span>}</td>
                  <td className="mono">{row.ms ? `${row.ms} ms` : ''}</td>
                  <td>{row.inspectionId ? <button type="button" className="btn btn--ghost btn--sm" onClick={() => onOpenInspection(row.inspectionId)}>Open</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
