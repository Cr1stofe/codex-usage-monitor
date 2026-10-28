const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyReadIssues, parseQuotaLine, newestSnapshot } = require('../dist/quota');
const { formatReset, presentLimits, presentQuota } = require('../dist/presentation');
const { resolveCodexHome } = require('../dist/reader');

const event = (limits, timestamp = '2026-10-28T12:00:00Z') => JSON.stringify({
  type: 'event_msg', timestamp, payload: { type: 'token_count', rate_limits: { limit_id: 'codex', ...limits } },
});
const window = (minutes, used = 40, reset = 1793304000) => ({ window_minutes: minutes, used_percent: used, resets_at: reset });

test('keeps the two limits together and highlights the most urgent window', () => {
  const snapshot = parseQuotaLine(event({ primary: window(300, 40), secondary: window(10080, 97) }));
  const state = { status: 'ready', snapshot, checkedAt: null, filesTracked: 1, issues: [] };
  const presentation = presentLimits(state, snapshot.recordedAt);
  assert.equal(presentation.text, '5h 40% · 1d8h  |  Week 97% · 1d8h');
  assert.equal(presentation.severity, 'error');
  assert.match(presentation.tooltip, /Codex 5h/);
  assert.match(presentation.tooltip, /Week/);
  assert.match(presentation.tooltip, /Used: 40% \| Remaining: 60%/);
  assert.match(presentation.tooltip, /Used: 97% \| Remaining: 3%/);
  assert.equal(presentLimits({ ...state, snapshot: null }).text, '5h —  |  Week —');
});

test('rounds the used percentage up without showing zero usage for a positive amount', () => {
  const snapshot = parseQuotaLine(event({ primary: window(300, 0.01) }));
  const state = { status: 'ready', snapshot, checkedAt: null, filesTracked: 1, issues: [] };
  assert.match(presentLimits(state, snapshot.recordedAt).text, /5h 0\.1%/);
});

test('shows compact reset times without implying an expired limit has reset', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(formatReset(null, now), '—');
  assert.equal(formatReset(now - 1, now), 'pending');
  assert.equal(formatReset(now + 1, now), '1min');
  assert.equal(formatReset(now + (150 * 60_000), now), '2h30');
  assert.equal(formatReset(now + (3 * 24 + 2) * 3600_000, now), '3d2h');
  const snapshot = parseQuotaLine(event({ primary: window(300, 40, Math.floor(now / 1000)) }));
  const state = { status: 'ready', snapshot, checkedAt: null, filesTracked: 1, issues: [] };
  assert.match(presentLimits(state, now).text, /5h · pending/);
});

test('treats skipped oversized lines as warnings and preserves real error precedence', () => {
  assert.equal(classifyReadIssues([]), 'ready');
  assert.equal(classifyReadIssues(['OVERSIZED_LINE_SKIPPED']), 'warning');
  for (const issue of ['EACCES', 'IO_ERROR', 'WATCH_UNAVAILABLE', 'UNKNOWN']) {
    assert.equal(classifyReadIssues([issue]), 'error');
    assert.equal(classifyReadIssues(['OVERSIZED_LINE_SKIPPED', issue]), 'error');
    assert.equal(classifyReadIssues([issue, 'OVERSIZED_LINE_SKIPPED']), 'error');
  }
});

test('warning tooltip keeps the quota visible without treating the warning as a read error', () => {
  const snapshot = parseQuotaLine(event({ primary: window(300, 40) }));
  const state = { status: 'warning', snapshot, checkedAt: null, filesTracked: 1, issues: ['OVERSIZED_LINE_SKIPPED'] };
  const presentation = presentQuota('Codex 5h', snapshot.fiveHour, snapshot, state, snapshot.recordedAt);
  assert.equal(presentation.text, 'Codex 5h: 60% remaining');
  assert.equal(presentation.severity, 'normal');
  assert.match(presentation.tooltip, /Warning: an oversized line was skipped/);
  assert.doesNotMatch(presentation.tooltip, /The reader encountered a problem/);
  assert.match(presentQuota('Codex 5h', snapshot.fiveHour, snapshot, { ...state, status: 'error', issues: [...state.issues, 'EACCES'] }, snapshot.recordedAt).tooltip, /The reader encountered a problem/);
});

test('identifies reversed windows and clamps percentages', () => {
  const snapshot = parseQuotaLine(event({ primary: window(10080, -5), secondary: window(300, 120) }));
  assert.equal(snapshot.fiveHour.remainingPercent, 0);
  assert.equal(snapshot.weekly.remainingPercent, 100);
  assert.equal(snapshot.fiveHour.resetsAt, 1793304000000);
});

test('accepts partial windows without filling from older snapshots', () => {
  const old = parseQuotaLine(event({ primary: window(300), secondary: window(10080) }));
  const latest = parseQuotaLine(event({ secondary: window(10080, 70), extra: 'ignored' }, '2026-10-28T13:00:00Z'));
  assert.equal(newestSnapshot([latest, old]).fiveHour, null);
  assert.equal(latest.weekly.remainingPercent, 30);
});

test('ignores unrelated, malformed and invalid events', () => {
  for (const line of ['{', 'null', '[]', event({ limit_id: 'other', primary: window(300) }),
    event({ primary: window(15) }), event({ primary: window(300, '40') }),
    event({ primary: window(300) }, 'invalid'), JSON.stringify({ type: 'session_meta' })]) {
    assert.equal(parseQuotaLine(line), null);
  }
  assert.equal(parseQuotaLine(event({ primary: window(300, 0, null) })).fiveHour.resetsAt, null);
});

test('renders missing, active, thresholds and expired windows', () => {
  const snapshot = parseQuotaLine(event({ primary: window(300, 40) }));
  const state = { status: 'ready', snapshot, checkedAt: snapshot.recordedAt, filesTracked: 1, issues: [] };
  const now = snapshot.recordedAt;
  assert.equal(presentQuota('Week', null, snapshot, state, now).text, 'Week: —');
  assert.equal(presentQuota('Codex 5h', snapshot.fiveHour, snapshot, state, now).text, 'Codex 5h: 60% remaining');
  for (const [remaining, severity] of [[20.1, 'normal'], [20, 'warning'], [5.1, 'warning'], [5, 'error'], [0, 'error']]) {
    assert.equal(presentQuota('Codex 5h', { ...snapshot.fiveHour, remainingPercent: remaining }, snapshot, state, now).severity, severity);
  }
  const expired = presentQuota('Codex 5h', snapshot.fiveHour, snapshot, state, snapshot.fiveHour.resetsAt);
  assert.match(expired.text, /Waiting for update/);
  assert.equal(expired.severity, 'normal');
  assert.match(expired.tooltip, /Last recorded/);
  assert.match(expired.tooltip, /another device/);
});

test('does not round a depleted window up to 100% free', () => {
  const snapshot = parseQuotaLine(event({ primary: window(300, 0.01) }));
  const state = { status: 'ready', snapshot, checkedAt: null, filesTracked: 1, issues: [] };
  assert.match(presentQuota('Codex 5h', snapshot.fiveHour, snapshot, state, snapshot.recordedAt).text, /99\.9%/);
});

test('resolves home in configuration, environment, default order', () => {
  assert.equal(resolveCodexHome('/custom', '/environment', '/home/user'), '/custom');
  assert.equal(resolveCodexHome('', '/environment', '/home/user'), '/environment');
  assert.equal(resolveCodexHome('', '', '/home/user'), '/home/user/.codex');
  assert.equal(resolveCodexHome('~/codex', '', '/home/user'), '/home/user/codex');
  assert.throws(() => resolveCodexHome('relative', '', '/home/user'), /INVALID_HOME/);
});
