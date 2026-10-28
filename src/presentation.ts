import type { MonitorState, QuotaSnapshot, QuotaWindow, SessionUsage } from './quota';

export interface QuotaPresentation {
  text: string;
  tooltip: string;
  severity: 'normal' | 'warning' | 'error';
}

const percent = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const dates = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
const date = (value: number): string => dates.format(value);
const integer = new Intl.NumberFormat('en-GB');

export function formatReset(resetAt: number | null, now: number): string {
  if (resetAt === null) return '—';
  const remaining = resetAt - now;
  if (remaining <= 0) return 'pending';
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d${hours ? `${hours}h` : ''}`;
  if (hours) return `${hours}h${minutes % 60 ? String(minutes % 60).padStart(2, '0') : ''}`;
  return `${minutes}min`;
}

function quotaDetails(label: string, window: QuotaWindow | null, now: number): string[] {
  const expired = window?.resetsAt != null && window.resetsAt <= now;
  const lines = [label];
  if (window) {
    lines.push(`${expired ? 'Last recorded — ' : ''}Used: ${percent.format(window.usedPercent)}% | Remaining: ${percent.format(window.remainingPercent)}%`);
    lines.push(`Resets: ${window.resetsAt === null ? 'unknown' : date(window.resetsAt)}`);
    if (expired) lines.push('Waiting for a new Codex record after the reset.');
  } else lines.push('No data available for this window.');
  return lines;
}

function commonDetails(state: MonitorState, snapshot: QuotaSnapshot | null): string[] {
  const lines: string[] = [];
  if (snapshot) lines.push(`Last quota record: ${date(snapshot.recordedAt)}`);
  if (state.checkedAt) lines.push(`Last local read: ${date(state.checkedAt)}`);
  if (state.status === 'loading') lines.push('Reading local records…');
  if (state.status === 'missing') lines.push('Session directory unavailable. The monitor will retry automatically.');
  if (state.status === 'warning') lines.push('Warning: an oversized line was skipped; remaining records are still read. Open diagnostics for details.');
  else if (state.issues.length) lines.push('The reader encountered a problem. Open diagnostics for details.');
  lines.push('Local records may not include recent usage from another device.', 'Refresh reads local files only.', 'Click to open the menu.');
  return lines;
}

export function presentQuota(
  label: string, window: QuotaWindow | null, snapshot: QuotaSnapshot | null,
  state: MonitorState, now = Date.now(),
): QuotaPresentation {
  const expired = window?.resetsAt != null && window.resetsAt <= now;
  let detail = '—';
  let severity: QuotaPresentation['severity'] = 'normal';
  if (window) {
    if (expired) detail = 'Waiting for update';
    else {
      const remaining = Math.floor(window.remainingPercent * 10 + 1e-8) / 10;
      detail = `${percent.format(remaining)}% remaining`;
      severity = window.remainingPercent <= 5 ? 'error' : window.remainingPercent <= 20 ? 'warning' : 'normal';
    }
  }
  const lines = [...quotaDetails(label, window, now), ...commonDetails(state, snapshot)];
  return { text: `${label}: ${detail}`, tooltip: lines.join('\n'), severity };
}

export function presentLimits(state: MonitorState, now = Date.now(), usage: SessionUsage | null = null): QuotaPresentation {
  const fiveHour = presentQuota('Codex 5h', state.snapshot?.fiveHour ?? null, state.snapshot, state, now);
  const weekly = presentQuota('Week', state.snapshot?.weekly ?? null, state.snapshot, state, now);
  const severity = [fiveHour.severity, weekly.severity].includes('error') ? 'error'
    : [fiveHour.severity, weekly.severity].includes('warning') ? 'warning' : 'normal';
  const compactWindow = (label: string, window: QuotaWindow | null): string => {
    if (!window) return `${label} —`;
    if (window.resetsAt !== null && window.resetsAt <= now) return `${label} · pending`;
    const used = Math.ceil(window.usedPercent * 10 - 1e-8) / 10;
    return `${label} ${percent.format(used)}% · ${formatReset(window.resetsAt, now)}`;
  };
  const tokenTooltip = usage ? [
    `Conversation tokens: ${integer.format(usage.total)}`,
    `Input: ${integer.format(usage.input)} | Output: ${integer.format(usage.output)}`,
    `Cached input: ${usage.cachedInput === null ? '—' : integer.format(usage.cachedInput)} | Reasoning: ${usage.reasoningOutput === null ? '—' : integer.format(usage.reasoningOutput)}`,
    'Cached tokens are included in input; reasoning tokens are included in output.',
    `Updated: ${date(usage.recordedAt)}`,
  ].join('\n') : 'Conversation tokens unavailable for this selection.';
  return {
    text: `${compactWindow('5h', state.snapshot?.fiveHour ?? null)}  |  ${compactWindow('Week', state.snapshot?.weekly ?? null)}`,
    tooltip: [quotaDetails('Codex 5h', state.snapshot?.fiveHour ?? null, now).join('\n'),
      quotaDetails('Week', state.snapshot?.weekly ?? null, now).join('\n'), tokenTooltip,
      commonDetails(state, state.snapshot).join('\n')].join('\n\n'),
    severity,
  };
}
