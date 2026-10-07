import { useEffect, useState } from 'react';
import { analyzeInspection, createInspection, uploadInspectionImages } from '../services/api';
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

export default function BenchmarkView({ poForm, demoMode, setDemoMode, onChanged, onOpenInspection, onBusyChange }) {
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState('');
  const po = toPoPayload(poForm);
  const live = demoMode === false;
  useEffect(() => { onBusyChange?.(running); }, [running, onBusyChange]);

  const run = async () => {
    // Already known to be live: don't send placeholder photos to the real model.
    if (demoMode === false) { setNotice(DEMO_REQUIRED); return; }
    setRunning(true);
    setNotice('');
    setRows([]);
    const results = [];
    for (const [index, scenario] of SCENARIOS.entries()) {
      setProgress(`Running ${index + 1}/${SCENARIOS.length}: ${scenario.label}…`);
      const row = { ...scenario, actual: null, inspectionId: '', error: '' };
      try {
        const created = await createInspection(po);
        row.inspectionId = created.inspection_id;
        await uploadInspectionImages(created.inspection_id, [await placeholderImage(scenario)], 'other');
        const result = await analyzeInspection(created.inspection_id, scenario.key);
        if (typeof result.demo_mode === 'boolean') setDemoMode(result.demo_mode);
        if (result.demo_mode === false) {
          setNotice(DEMO_REQUIRED);
          break;
        }
        row.actual = result.decision;
      } catch (error) {
        row.error = error.message;
        if (error.status === 401 || error.status === 503 || error.status === 0) {
          results.push(row);
          setRows([...results]);
          setNotice(error.message);
          break;
        }
      }
      results.push(row);
      setRows([...results]);
    }
    setProgress('');
    setRunning(false);
    onChanged();
  };

  const scored = rows.filter((row) => row.actual || row.error);
  const passed = rows.filter((row) => row.actual === row.expected).length;

  return (
    <Card
      title="Scenario Benchmark"
      icon="gauge"
      subtitle={`Each scenario creates a fresh inspection for the current PO (${po.po_id || '—'} · ${po.product_name || '—'}), uploads one generated placeholder photo (image_type other) and analyzes it with that demo scenario. Expected outcomes assume a PO whose components include a cap (the PO-9001 preset).`}
      actions={(
        <button type="button" className="btn btn--primary" onClick={run} disabled={running || live} title={live ? DEMO_REQUIRED : undefined} aria-busy={running}>
          {running ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={15} />}
          {running ? 'Running…' : `Run all ${SCENARIOS.length} scenarios`}
        </button>
      )}
    >
      <div className="status-line" role="status" aria-live="polite">{progress}</div>
      {live && !notice && (
        <div className="alert alert--warning" role="status"><Icon name="alert" /><span className="alert__text">{DEMO_REQUIRED}</span></div>
      )}
      {notice && (
        <div className="alert alert--warning" role="alert"><Icon name="alert" /><span className="alert__text">{notice}</span></div>
      )}
      {rows.length === 0 && !running && (
        <div className="empty-inline"><Icon name="flask" size={22} /><span>No benchmark run yet in this session.</span></div>
      )}

      {rows.length > 0 && (
        <>
          <div className="score">
            <div className="score-line">
              <span className="score__label">Score:</span> <strong className="score__value">{passed}/{scored.length}</strong>
              {scored.length ? <span className="score__pct"> ({Math.round((passed / scored.length) * 100)}%)</span> : ''}
            </div>
            <div className="score__bar"><span style={{ width: `${scored.length ? (passed / scored.length) * 100 : 0}%` }} /></div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Scenario</th><th>Expected</th><th>Actual</th><th>Result</th><th>Inspection</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td><div className="table__strong">{row.label}</div><div className="table__sub mono">{row.key}</div></td>
                    <td><DecisionPill decision={row.expected} /></td>
                    <td>{row.actual ? <DecisionPill decision={row.actual} /> : <span className="verify__result verify__result--bad">{row.error || '—'}</span>}</td>
                    <td>
                      <span className={`tag ${row.actual === row.expected ? 'tag--success' : 'tag--danger'}`}>
                        {row.actual === row.expected ? 'MATCH' : 'MISMATCH'}
                      </span>
                    </td>
                    <td>
                      {row.inspectionId ? (
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onOpenInspection(row.inspectionId)}>Open</button>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
