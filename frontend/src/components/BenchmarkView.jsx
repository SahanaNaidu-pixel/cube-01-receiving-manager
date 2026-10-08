import { useState } from 'react';
import { analyzeInspection, createInspection, healthCheck, uploadInspectionImages } from '../services/api';
import { SCENARIOS } from '../constants';
import { toPoPayload } from './PoEditor';
import { Card, DecisionPill, Icon } from './Shared';

// The backend refuses to analyze with zero evidence, so each benchmark inspection gets one
// generated placeholder PNG (the demo scenario, not the pixels, drives the verdict).
function placeholderImage(scenario) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) { reject(new Error('Canvas is not available in this browser.')); return; }
    ctx.fillStyle = '#101c2b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#edf4ff';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('Benchmark placeholder', 40, 150);
    ctx.font = '28px sans-serif';
    ctx.fillText(scenario.key, 40, 210);
    canvas.toBlob((blob) => {
      if (blob) resolve(new File([blob], `benchmark-${scenario.key}.png`, { type: 'image/png' }));
      else reject(new Error('Could not generate the placeholder image.'));
    }, 'image/png');
  });
}

const DEMO_REQUIRED = 'The Scenario Benchmark needs the backend running with DEMO_MODE=true. In live mode the scenario is ignored and analysis requires real photos.';
const MODE_UNKNOWN = 'Could not confirm the backend is in demo mode, so the benchmark did not start (it never sends placeholder photos to a live model).';

// The health endpoint reports the perception mode. Anything other than a boolean (e.g. an older
// backend) is treated as unknown, so the benchmark refuses to start.
async function probeDemoMode() {
  const health = await healthCheck();
  return typeof health?.demo_mode === 'boolean' ? health.demo_mode : null;
}

export default function BenchmarkView({ poForm, demoMode, setDemoMode, onChanged, onOpenInspection }) {
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState('');
  const po = toPoPayload(poForm);

  const run = async () => {
    setRunning(true);
    setNotice('');
    // Confirm demo mode before every run (the backend may have restarted since demoMode was last
    // learned): placeholder photos must never reach a live model.
    setProgress('Checking the backend perception mode…');
    let mode;
    try {
      mode = await probeDemoMode();
    } catch (error) {
      setNotice(error.message);
      setProgress('');
      setRunning(false);
      return;
    }
    if (typeof mode === 'boolean') setDemoMode(mode);
    if (mode !== true) {
      setNotice(mode === false ? DEMO_REQUIRED : MODE_UNKNOWN);
      setProgress('');
      setRunning(false);
      return;
    }
    setRows([]);
    const results = [];
    for (const [index, scenario] of SCENARIOS.entries()) {
      setProgress(`Running ${index + 1}/${SCENARIOS.length}: ${scenario.label}…`);
      const row = { ...scenario, actual: null, inspectionId: '', error: '' };
      let stop = false;
      try {
        const created = await createInspection(po);
        row.inspectionId = created.inspection_id;
        await uploadInspectionImages(created.inspection_id, [await placeholderImage(scenario)], 'other');
        const result = await analyzeInspection(created.inspection_id, scenario.key);
        if (typeof result.demo_mode === 'boolean') setDemoMode(result.demo_mode);
        if (result.demo_mode === false) {
          // The backend switched to live mode mid-run; this verdict is not a benchmark result.
          row.error = 'Stopped: backend is in live mode';
          setNotice(DEMO_REQUIRED);
          stop = true;
        } else {
          row.actual = result.decision;
        }
      } catch (error) {
        row.error = error.message;
        if (error.status === 401 || error.status === 503 || error.status === 0) {
          setNotice(error.message);
          stop = true;
        }
      }
      // Record every row before stopping so a created inspection keeps its Open link.
      results.push(row);
      setRows([...results]);
      if (stop) break;
    }
    setProgress('');
    setRunning(false);
    onChanged();
  };

  const scored = rows.filter((row) => row.actual || row.error);
  const passed = rows.filter((row) => row.actual === row.expected).length;
  const pct = scored.length ? Math.round((passed / scored.length) * 100) : 0;

  return (
    <div className="stack">
      <Card
        title="Scenario benchmark"
        sub={`Each scenario creates a fresh inspection for the current PO (${po.po_id || '—'} · ${po.product_name || '—'}), uploads one generated placeholder photo and analyzes it with that demo scenario. Expected outcomes assume the PO-9001 preset (components include a cap).`}
        actions={(
          <button type="button" className="btn-primary" onClick={run} disabled={running} aria-busy={running}>
            {running ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={15} />}
            {running ? 'Running…' : `Run all ${SCENARIOS.length} scenarios`}
          </button>
        )}
      >
        <div className="status-line" role="status" aria-live="polite">{progress}</div>
        {notice && (
          <div className="alert alert-warning" role="alert"><Icon name="alert" size={16} /><span className="alert-text">{notice}</span></div>
        )}
        {rows.length > 0 && (
          <>
            <div className={`claims-summary-bar flush score-bar ${passed < scored.length ? 'is-bad' : ''}`}>
              <span>Score: {passed}/{scored.length} scenarios matched the expected decision</span>
              <span>{pct}%</span>
            </div>
            <div className="chart-bar-track" aria-hidden="true">
              <div className={`chart-bar-fill ${passed < scored.length ? 'bar-uncertain' : 'bar-contradicted'}`} style={{ width: `${pct}%` }}>{pct}%</div>
            </div>
          </>
        )}
        {rows.length === 0 && !running && (
          <div className="empty-state">
            <Icon name="flask" size={28} />
            <h3>No benchmark run yet in this session</h3>
            <p>Runs all eight demo scenarios end to end and checks every decision against the expected outcome.</p>
          </div>
        )}
      </Card>

      {rows.length > 0 && (
        <Card flush title="Results" sub="One fresh inspection per scenario">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Scenario</th><th>Expected</th><th>Actual</th><th>Result</th><th>Inspection</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td><div className="cell-strong">{row.label}</div><div className="cell-sub">{row.key}</div></td>
                    <td><DecisionPill decision={row.expected} /></td>
                    <td>{row.actual ? <DecisionPill decision={row.actual} /> : <span className="verify-result bad">{row.error || '—'}</span>}</td>
                    <td>
                      <span className={`sla-badge ${row.actual === row.expected ? 'sla-open' : 'sla-expired'}`}>
                        {row.actual === row.expected ? 'MATCH' : 'MISMATCH'}
                      </span>
                    </td>
                    <td>
                      {row.inspectionId
                        ? <button type="button" className="detail-btn" onClick={() => onOpenInspection(row.inspectionId)}>Open</button>
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
