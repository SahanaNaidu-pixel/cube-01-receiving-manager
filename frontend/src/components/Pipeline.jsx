import { Icon } from './Shared';

// The delivery's path through the agent. Each stop's state is derived only from what really happened:
// local steps (inspection opened, photos stored) and the server's streamed events. The belt into a stop
// moves only while that stop is really running.
const STOPS = [
  { key: 'manifest', label: 'Manifest', icon: 'file' },
  { key: 'capture', label: 'Capture', icon: 'camera' },
  { key: 'vision', label: 'Vision', icon: 'eye' },
  { key: 'second', label: '2nd look', icon: 'refresh' },
  { key: 'rules', label: 'Rules', icon: 'ruler' },
  { key: 'seal', label: 'Seal', icon: 'lock' },
];

export function stationStates({ events, phase, hasInspection, hasPhotos, analyzed }) {
  const has = (type) => events.some((event) => event.type === type);
  const finished = has('decision') || has('done');
  const s = {};
  s.manifest = phase === 'creating' ? 'active' : hasInspection ? 'done' : 'idle';
  s.capture = phase === 'uploading' ? 'active' : hasPhotos ? 'done' : 'idle';
  if (!events.some((event) => event.type !== 'local')) {
    // Nothing streamed this session (e.g. opened from the ledger): we know the outcome, not how that run went.
    const past = analyzed ? 'done' : 'idle';
    return { ...s, vision: past, second: 'idle', rules: past, seal: past };
  }
  s.vision = has('perception_failed') ? 'fail'
    : has('perception_done') || has('photo') ? 'done'
      : has('perception') || has('start') ? 'active' : 'idle';
  s.second = has('second_look_failed') ? 'fail'
    : has('second_look_merged') ? 'done'
      : has('second_look') ? 'active'
        : finished ? 'skip' : 'idle';
  s.rules = has('decision') ? 'done' : has('check') ? 'active' : 'idle';
  s.seal = has('sealed') ? 'done' : has('error') ? 'fail' : 'idle';
  return s;
}

const STATE_TEXT = { idle: 'waiting', active: 'running', done: 'done', fail: 'failed', skip: 'not needed' };

export default function Pipeline({ states }) {
  return (
    <ol className="conveyor" aria-label="Agent pipeline">
      {STOPS.map((stop, index) => {
        const state = states[stop.key] || 'idle';
        return (
          <li key={stop.key} className={`conveyor__stop conveyor__stop--${state}`}>
            {index > 0 && <span className="conveyor__belt" aria-hidden="true" />}
            <span className="conveyor__node">
              <Icon name={state === 'done' ? 'check' : state === 'fail' ? 'x' : stop.icon} size={17} />
            </span>
            <span className="conveyor__label">{stop.label}</span>
            <span className="conveyor__state">{STATE_TEXT[state]}</span>
          </li>
        );
      })}
    </ol>
  );
}
