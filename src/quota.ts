export interface QuotaWindow {
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
}

export interface QuotaSnapshot {
  recordedAt: number;
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
}

export interface SessionUsage {
  id: string;
  cwd: string;
  recordedAt: number;
  input: number;
  cachedInput: number | null;
  output: number;
  reasoningOutput: number | null;
  total: number;
}

export interface SessionMetadata {
  id: string;
  cwd: string;
}

export interface MonitorState {
  status: 'loading' | 'ready' | 'warning' | 'missing' | 'error';
  snapshot: QuotaSnapshot | null;
  checkedAt: number | null;
  filesTracked: number;
  issues: string[];
  sessions?: SessionUsage[];
}

export function classifyReadIssues(issues: Iterable<string>): 'ready' | 'warning' | 'error' {
  let status: 'ready' | 'warning' = 'ready';
  for (const issue of issues) {
    if (issue !== 'OVERSIZED_LINE_SKIPPED') return 'error';
    status = 'warning';
  }
  return status;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSessionMetadata(line: string): SessionMetadata | null {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return null; }
  if (!record(event) || event.type !== 'session_meta' || !record(event.payload)) return null;
  const { id, cwd, source } = event.payload;
  if (source !== 'vscode' || typeof id !== 'string' || !id || typeof cwd !== 'string' || !cwd
    || typeof event.payload.parent_thread_id === 'string') return null;
  return { id, cwd };
}

export function parseSessionUsage(line: string, metadata: SessionMetadata): SessionUsage | null {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return null; }
  if (!record(event) || event.type !== 'event_msg' || typeof event.timestamp !== 'string' || !record(event.payload)
    || event.payload.type !== 'token_count' || !record(event.payload.info)
    || !record(event.payload.info.total_token_usage)) return null;
  const usage = event.payload.info.total_token_usage;
  const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const total = count(usage.total_tokens);
  const recordedAt = Date.parse(event.timestamp);
  if (input === null || output === null || total === null || !Number.isFinite(recordedAt)) return null;
  return { ...metadata, recordedAt, input, output, total, cachedInput: count(usage.cached_input_tokens),
    reasoningOutput: count(usage.reasoning_output_tokens) };
}

function parseWindow(value: unknown): QuotaWindow | null {
  if (!record(value) || typeof value.used_percent !== 'number' || !Number.isFinite(value.used_percent)) return null;
  const usedPercent = Math.max(0, Math.min(100, value.used_percent));
  const reset = value.resets_at;
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: typeof reset === 'number' && Number.isFinite(reset) && reset > 0 && reset <= 8.64e12
      ? reset * 1000 : null,
  };
}

export function parseQuotaLine(line: string): QuotaSnapshot | null {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return null; }
  if (!record(event) || event.type !== 'event_msg' || typeof event.timestamp !== 'string') return null;
  const payload = event.payload;
  if (!record(payload) || payload.type !== 'token_count') return null;
  const limits = payload.rate_limits;
  if (!record(limits) || limits.limit_id !== 'codex') return null;
  const recordedAt = Date.parse(event.timestamp);
  if (!Number.isFinite(recordedAt)) return null;
  let fiveHour: QuotaWindow | null = null;
  let weekly: QuotaWindow | null = null;
  for (const candidate of [limits.primary, limits.secondary]) {
    if (!record(candidate)) continue;
    if (candidate.window_minutes === 300) fiveHour = parseWindow(candidate);
    if (candidate.window_minutes === 10080) weekly = parseWindow(candidate);
  }
  if (!fiveHour && !weekly) return null;
  return { recordedAt, fiveHour, weekly };
}

export function newestSnapshot(values: Iterable<QuotaSnapshot | null>): QuotaSnapshot | null {
  let latest: QuotaSnapshot | null = null;
  for (const value of values) {
    if (value && (!latest || value.recordedAt > latest.recordedAt)) latest = value;
  }
  return latest;
}
