/*
 * Scenario regression (demo mode only) — ported from the first UI's BenchmarkView.
 * For each backend demo scenario: create an inspection for the PO-9001 reference line, upload one canvas-generated
 * placeholder PNG, run it with that scenario and compare the decision with the expected one. These are regression
 * checks of the deterministic rules over simulated perception — NOT a measure of real vision accuracy.
 * Only enabled while GET /health reports demo_mode=true; re-checked before every run so placeholders never reach a
 * live vision model.
 */
import { useState } from 'react';
import { createInspection, getHealth, runInspection, uploadInspectionImages } from '../../services/api';
import { pathFor } from '../../lib/router';
import { Card, EmptyState, Icon, Link, StatusBadge, VerdictBadge } from '../../components/ui';
import { DEMO_SCENARIOS, REFERENCE_PO, placeholderPng } from './a2aModel';

const NOT_DEMO = 'The backend is not in demo mode (GET /health → demo_mode=false). Scenario regression only runs against DEMO_MODE=true, because placeholder images must never reach a real vision model.';

export function ScenarioRegression({ health, healthError, onHealth }) {
  const demoMode = health?.demo_mode === true;
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState('');

  const run = async () => {
    setRunning(true);
    setNotice('');
    setProgress('Checking GET /health for demo_mode…');
    let fresh;
    try {
      fresh = await getHealth();
      onHealth?.(fresh);
    } catch (error) {
      setNotice(error.message);
      setRunning(false);
      setProgress('');
      return;
    }
    if (fresh?.demo_mode !== true) {
      setNotice(NOT_DEMO);
      setRunning(false);
      setProgress('');
      return;
    }
    setRows([]);
    const results = [];
    for (const [index, scenario] of DEMO_SCENARIOS.entries()) {
      setProgress(`Running ${index + 1}/${DEMO_SCENARIOS.length}: ${scenario.label}…`);
      const row = { ...scenario, actual: null, verdict: null, inspectionId: '', error: '' };
      let stop = false;
      try {
        /* eslint-disable no-await-in-loop */
        const created = await createInspection(REFERENCE_PO);
        row.inspectionId = created.inspection_id;
        await uploadInspectionImages(created.inspection_id, [await placeholderPng(scenario.key)], 'other');
        const result = await runInspection(created.inspection_id, { scenario: scenario.key });
        /* eslint-enable no-await-in-loop */
        if (result.demo_mode === false) {
          row.error = 'Stopped: backend switched to live mode';
          setNotice(NOT_DEMO);
          stop = true;
        } else {
          row.actual = result.decision;
          row.verdict = result.verdict;
        }
      } catch (error) {
        row.error = error.message;
        if ([0, 401, 403, 503].includes(error.status)) { setNotice(error.message); stop = true; }
      }
      results.push(row);
      setRows([...results]);
      if (stop) break;
    }
    setProgress('');
    setRunning(false);
  };

  const scored = rows.filter((r) => r.actual || r.error);
  const matched = rows.filter((r) => r.actual === r.expected).length;

  return (
    <div className="stack">
      <div className="alert alert-hold" role="note">
        <Icon name="flask" size={16} />
        <span className="alert-text">
          <strong>Demo-scenario regression checks — not real vision.</strong> Each run creates real inspections for the
          {' '}<span className="mono">{REFERENCE_PO.po_id} · {REFERENCE_PO.sku}</span> reference line with a generated placeholder PNG;
          the backend's demo provider returns the scenario's scripted observations and the deterministic rules decide.
          It proves the rules and review routing behave as specified, nothing more.
        </span>
      </div>
      <Card
        title="Scenario regression (demo mode only)"
        sub={health ? `GET /health → demo_mode=${String(health.demo_mode)} · ${health.service || ''} ${health.version || ''}` : healthError ? `GET /health failed: ${healthError.message}` : 'Checking GET /health…'}
        actions={(
          <button type="button" className="btn-primary" onClick={run} disabled={running || !demoMode} aria-busy={running}
            title={demoMode ? undefined : 'Only available while the backend reports demo_mode=true'}>
            {running ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={14} />}
            {running ? 'Running…' : `Run ${DEMO_SCENARIOS.length} scenario checks`}
          </button>
        )}
      >
        <div className="status-line" role="status" aria-live="polite">{progress}</div>
        {!demoMode && health && <div className="alert alert-warning" role="status"><Icon name="alert" size={16} /><span className="alert-text">{NOT_DEMO}</span></div>}
        {notice && <div className="alert alert-warning" role="alert"><Icon name="alert" size={16} /><span className="alert-text">{notice}</span></div>}
        {rows.length > 0 && (
          <p className={matched === scored.length ? 'ops-score ok' : 'ops-score bad'}>
            {matched}/{scored.length} scenario checks matched the expected decision
          </p>
        )}
        {rows.length === 0 && !running && (
          <EmptyState compact icon="flask" title="No regression run in this session" message="Results are not stored here; every run creates fresh inspections you can open." />
        )}
      </Card>
      {rows.length > 0 && (
        <Card flush title="Results" sub="One fresh inspection per scenario">
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Scenario</th><th>Expected</th><th>Actual</th><th>Result</th><th>Inspection</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td><div className="cell-strong">{r.label}</div><div className="cell-sub mono">{r.key}</div></td>
                    <td><VerdictBadge verdict={r.expected} label={r.expected} /></td>
                    <td>{r.actual ? <VerdictBadge verdict={r.actual} label={r.actual} /> : <span className="ops-error-text">{r.error || '—'}</span>}</td>
                    <td><StatusBadge status={r.actual === r.expected ? 'ok' : 'failed'} label={r.actual === r.expected ? 'Match' : 'Mismatch'} /></td>
                    <td>{r.inspectionId ? <Link to={pathFor('inspections', r.inspectionId)} className="link mono">{r.inspectionId}</Link> : '—'}</td>
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
