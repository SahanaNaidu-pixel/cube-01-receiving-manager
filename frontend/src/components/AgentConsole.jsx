import { useEffect, useRef } from 'react';
import { Icon } from './Shared';

// One row per real pipeline event from /analyze/stream. Nothing here is invented client-side: the only local
// value is the wall-clock time while waiting. High-frequency stream events (per-observation, progress) are shown
// on the photo stage and run stats instead of here.
const KIND = {
  local: { label: 'Dock', icon: 'upload', tone: '' },
  start: { label: 'Intake', icon: 'truck', tone: '' },
  perception: { label: 'Vision', icon: 'eye', tone: 'accent' },
  model_reading: { label: 'Reading', icon: 'scan', tone: 'accent' },
  perception_done: { label: 'Model', icon: 'cpu', tone: 'accent' },
  photo: { label: 'Photo', icon: 'image', tone: '' },
  warning: { label: 'Warning', icon: 'alert', tone: 'warn' },
  perception_failed: { label: 'Fail-open', icon: 'clock', tone: 'hold' },
  second_look: { label: '2nd look', icon: 'refresh', tone: 'accent' },
  second_look_done: { label: 'Model', icon: 'cpu', tone: 'accent' },
  second_look_merged: { label: '2nd look', icon: 'check', tone: 'accent' },
  second_look_failed: { label: '2nd look', icon: 'alert', tone: 'warn' },
  check: { label: 'Rule', icon: 'ruler', tone: 'by-status' },
  decision: { label: 'Verdict', icon: 'shield', tone: 'by-decision' },
  sealed: { label: 'Sealed', icon: 'lock', tone: '' },
  done: { label: 'Done', icon: 'check', tone: 'pass' },
  error: { label: 'Error', icon: 'alert', tone: 'fail' },
};
export const TRACE_HIDDEN = new Set(['heartbeat', 'model_observation', 'model_progress']);
const STATUS_TONE = { PASS: 'pass', FAIL: 'fail', UNCERTAIN: 'warn' };
const DECISION_TONE = { PASS: 'pass', EXCEPTION: 'fail', UNCERTAIN: 'warn', PENDING_REVIEW: 'hold' };

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

export default function AgentConsole({ events, waiting }) {
  const listRef = useRef(null);
  const shown = events.filter((event) => !TRACE_HIDDEN.has(event.type));
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [shown.length, waiting]);

  return (
    <ol className="trace" ref={listRef} aria-live="polite" aria-relevant="additions" aria-label="Agent trace">
      {shown.length === 0 && !waiting && (
        <li className="trace__empty">Idle. When you run the agent, every step it takes is listed here as it happens, with server timestamps.</li>
      )}
      {shown.map((event, index) => {
        const kind = KIND[event.type] || KIND.start;
        const tone = kind.tone === 'by-status' ? STATUS_TONE[event.check?.status] || ''
          : kind.tone === 'by-decision' ? DECISION_TONE[event.decision] || '' : kind.tone;
        return (
          <li key={`${index}-${event.type}`} className={`trace__item ${tone ? `trace__item--${tone}` : ''}`}>
            <span className="trace__t">{event.t_ms != null ? `+${seconds(event.t_ms)}` : 'local'}</span>
            <span className="trace__icon"><Icon name={kind.icon} size={12} /></span>
            <span className="trace__msg"><b>{kind.label}</b>{event.message}</span>
          </li>
        );
      })}
      {waiting && (
        <li className="trace__item trace__item--waiting">
          <span className="trace__t">+{seconds(waiting.t_ms)}</span>
          <span className="trace__icon"><Icon name="clock" size={12} /></span>
          <span className="trace__msg"><b>Waiting</b>{waiting.message}</span>
        </li>
      )}
    </ol>
  );
}
