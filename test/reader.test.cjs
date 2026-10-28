const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SessionReader } = require('../dist/reader');

function line(used, timestamp = '2026-10-28T12:00:00Z') {
  return JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', rate_limits: {
    limit_id: 'codex', primary: { used_percent: used, window_minutes: 300, resets_at: 1793304000 },
    secondary: { used_percent: 15, window_minutes: 10080, resets_at: 1793793738 },
  } } });
}

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-limits-test-'));
  const sessions = path.join(home, 'sessions');
  await fs.mkdir(sessions);
  let state;
  let updates = 0;
  const reader = new SessionReader(home, (next) => { state = next; updates++; });
  t.after(async () => { reader.dispose(); await reader.refresh(); await fs.rm(home, { recursive: true, force: true }); });
  return { reader, sessions, get state() { return state; }, get updates() { return updates; } };
}

test('streams existing files, keeps incomplete lines and reads only new complete records', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.sessions, 'chat.jsonl');
  await fs.writeFile(file, 'invalid json\n' + line(40) + '\n');
  await f.reader.refresh();
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 60);
  const next = line(55, '2026-10-28T13:00:00Z');
  await fs.appendFile(file, next.slice(0, 30));
  await f.reader.refresh();
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 60);
  await fs.appendFile(file, next.slice(30) + '\n');
  await f.reader.refresh();
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 45);
  await f.reader.refresh();
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 45);
});

test('uses timestamps across sessions regardless of project metadata or file mtime', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.sessions, 'nested'));
  await fs.writeFile(path.join(f.sessions, 'nested', 'new.jsonl'), line(70, '2026-10-28T14:00:00Z') + '\n');
  await fs.writeFile(path.join(f.sessions, 'old.jsonl'), '{"type":"session_meta","payload":{"cwd":"/another/project"}}\n' + line(10) + '\n');
  await f.reader.refresh();
  assert.equal(f.state.filesTracked, 2);
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 30);
});

test('tracks the latest cumulative counters independently from quota events', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.sessions, 'chat.jsonl');
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'session-1', cwd: '/work/project', source: 'vscode' } });
  const usage = (timestamp, total) => JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total },
  } } });
  await fs.writeFile(file, [meta, usage('2026-10-28T12:00:00Z', 100), line(40), usage('2026-10-28T13:00:00Z', 200),
    usage('2026-10-28T11:00:00Z', 50), ''].join('\n'));
  await f.reader.refresh();
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 60);
  assert.equal(f.state.sessions.length, 1);
  assert.equal(f.state.sessions[0].total, 200);
  await fs.unlink(file);
  await f.reader.refresh();
  assert.deepEqual(f.state.sessions, []);
});

test('recovers from truncation, replacement and deletion', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.sessions, 'chat.jsonl');
  await fs.writeFile(file, line(40) + '\n' + line(50) + '\n');
  await f.reader.refresh();
  await fs.writeFile(file, line(20) + '\n');
  await f.reader.refresh();
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 80);
  const replacement = path.join(f.sessions, 'replacement.tmp');
  await fs.writeFile(replacement, line(60) + '\n');
  await fs.rename(replacement, file);
  await f.reader.refresh();
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 40);
  await fs.unlink(file);
  await f.reader.refresh();
  assert.equal(f.state.snapshot, null);
});

test('detects truncate-and-regrow beyond previous offset', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.sessions, 'chat.jsonl');
  await fs.writeFile(file, line(40) + '\n');
  await f.reader.refresh();
  await fs.writeFile(file, line(15) + '\n' + ' '.repeat(500) + '\n');
  await f.reader.refresh();
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 85);
});

test('recovers when sessions directory disappears and returns', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.sessions, 'chat.jsonl'), line(40) + '\n');
  await f.reader.refresh();
  await fs.rm(f.sessions, { recursive: true });
  await f.reader.refresh();
  assert.equal(f.state.status, 'missing');
  assert.equal(f.state.snapshot, null);
  await fs.mkdir(f.sessions);
  await fs.writeFile(path.join(f.sessions, 'new.jsonl'), line(90) + '\n');
  await f.reader.refresh();
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 10);
});

test('bounds oversized lines and recovers at next newline', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.sessions, 'chat.jsonl');
  await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1) + '\n' + line(30) + '\n');
  await f.reader.refresh();
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 70);
  assert.ok(f.state.issues.includes('OVERSIZED_LINE_SKIPPED'));
  assert.equal(f.state.status, f.state.issues.includes('WATCH_UNAVAILABLE') ? 'error' : 'warning');
  await f.reader.refresh();
  assert.equal(f.state.status, f.state.issues.includes('WATCH_UNAVAILABLE') ? 'error' : 'ready');
  assert.ok(!f.state.issues.includes('OVERSIZED_LINE_SKIPPED'));
});

test('serializes concurrent refreshes and does not publish after disposal', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.sessions, 'chat.jsonl'), line(40) + '\n');
  await Promise.all([f.reader.refresh(), f.reader.refresh(), f.reader.refresh()]);
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 60);
  const updates = f.updates;
  f.reader.dispose();
  await f.reader.refresh();
  assert.equal(f.updates, updates);
});

test('watching or reconciliation detects records within 35 seconds without manual refresh', { timeout: 40000 }, async (t) => {
  const f = await fixture(t);
  const file = path.join(f.sessions, 'chat.jsonl');
  await fs.writeFile(file, line(40) + '\n');
  f.reader.start();
  await f.reader.refresh();
  await fs.appendFile(file, line(80, '2026-10-28T15:00:00Z') + '\n');
  const deadline = Date.now() + 35000;
  while (f.state.snapshot?.fiveHour.remainingPercent !== 20 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(f.state.snapshot.fiveHour.remainingPercent, 20);
  f.reader.dispose();
  const updates = f.updates;
  await fs.appendFile(file, line(95, '2026-10-28T16:00:00Z') + '\n');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(f.updates, updates);
});
