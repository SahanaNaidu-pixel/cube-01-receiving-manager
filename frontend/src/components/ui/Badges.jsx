/*
 * Badges.
 *   <VerdictBadge verdict="EXCEPTION" />  → "Fail" (accepts PASS/FAIL/EXCEPTION/UNCERTAIN/PENDING_REVIEW/null)
 *   <SeverityBadge severity="high" />     → high (red) | medium (amber) | low (grey)
 *   <StatusBadge status="open" />         → tone picked from STATUS_TONES;
 *                                           override with tone="success|danger|warning|info|hold|neutral"
 */
import { toUiVerdict, VERDICT_LABELS, humanize } from '../../lib/format';

export function VerdictBadge({ verdict, label }) {
  const value = toUiVerdict(verdict);
  return (
    <span className={`verdict-badge v-${value}`} title={verdict ? `Stored verdict: ${verdict}` : 'Not analyzed'}>
      {label || VERDICT_LABELS[value]}
    </span>
  );
}

const SEVERITY_TONES = { high: 'danger', critical: 'danger', medium: 'warning', low: 'neutral' };

export function SeverityBadge({ severity }) {
  const tone = SEVERITY_TONES[String(severity || '').toLowerCase()] || 'neutral';
  return <span className={`ui-badge tone-${tone}`}>{humanize(severity)}</span>;
}

/** Known statuses across issues, reviews, POs, activity, readiness, evidence and cartons. */
export const STATUS_TONES = {
  open: 'info',
  in_review: 'hold',
  evidence_requested: 'warning',
  resolved: 'success',
  completed: 'success',
  superseded: 'neutral',
  cancelled: 'neutral',
  overridden: 'hold',
  partially_received: 'warning',
  received: 'success',
  discrepancy: 'danger',
  delivered: 'success',
  failed: 'danger',
  not_configured: 'neutral',
  inbound: 'info',
  outbound: 'hold',
  healthy: 'success',
  degraded: 'warning',
  unavailable: 'danger',
  ok: 'success',
  analyzed: 'success',
  not_analyzed: 'neutral',
  perception_unavailable: 'warning',
  none: 'success',
  short: 'danger',
  over: 'warning',
  unverified: 'neutral',
  intact: 'success',
  good: 'success',
  broken: 'danger',
  resealed: 'warning',
  crushed: 'danger',
  torn: 'danger',
  punctured: 'danger',
  wet: 'danger',
  label_damaged: 'warning',
  unknown: 'neutral',
};

export function StatusBadge({ status, tone, label }) {
  const resolved = tone || STATUS_TONES[String(status || '').toLowerCase()] || 'neutral';
  return <span className={`ui-badge tone-${resolved}`}>{label || humanize(status)}</span>;
}
