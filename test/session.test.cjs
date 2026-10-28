const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSessionMetadata, parseSessionUsage } = require('../dist/quota');
const { sessionsForWorkspace, selectSession } = require('../dist/session-selection');
const { presentLimits } = require('../dist/presentation');

const metadata = { id: 'session-1', cwd: '/work/project' };
const usageLine = (total, timestamp = '2026-10-28T12:00:00Z') => JSON.stringify({
  timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
    input_tokens: 1000, cached_input_tokens: 800, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: total,
  } } },
});

test('identifies VS Code sessions without exposing conversation text', () => {
  const line = JSON.stringify({ type: 'session_meta', payload: { ...metadata, source: 'vscode', base_instructions: 'private text' } });
  assert.deepEqual(parseSessionMetadata(line), metadata);
  assert.equal(parseSessionMetadata(JSON.stringify({ type: 'session_meta', payload: { ...metadata, source: { subagent: {} } } })), null);
  assert.equal(parseSessionMetadata(JSON.stringify({ type: 'session_meta', payload: { ...metadata, source: 'cli' } })), null);
  assert.equal(parseSessionMetadata(JSON.stringify({ type: 'session_meta', payload: { ...metadata, source: 'vscode', parent_thread_id: 'parent' } })), null);
  assert.equal(parseSessionMetadata('{'), null);
});

test('reads accumulated token counters and rejects invalid snapshots', () => {
  assert.deepEqual(parseSessionUsage(usageLine(1200), metadata), { ...metadata, recordedAt: Date.parse('2026-10-28T12:00:00Z'),
    input: 1000, cachedInput: 800, output: 200, reasoningOutput: 50, total: 1200 });
  assert.equal(parseSessionUsage(usageLine(-1), metadata), null);
  assert.equal(parseSessionUsage(usageLine(1200, 'invalid'), metadata), null);
  assert.equal(parseSessionUsage('{}', metadata), null);
});

test('selects recent project sessions or a pinned session without crossing project boundaries', () => {
  const first = parseSessionUsage(usageLine(1200), metadata);
  const second = { ...first, id: 'session-2', cwd: '/work/project/subdir', recordedAt: first.recordedAt + 1000, total: 2000 };
  const unrelated = { ...second, id: 'session-3', cwd: '/work/project-other', recordedAt: second.recordedAt + 1000 };
  const candidates = sessionsForWorkspace([first, unrelated, second], ['/work/project']);
  assert.deepEqual(candidates.map((s) => s.id), ['session-2', 'session-1']);
  assert.equal(selectSession(candidates).id, 'session-2');
  assert.equal(selectSession(candidates, 'session-1').id, 'session-1');
  assert.equal(selectSession(candidates, 'missing'), null);
  assert.deepEqual(sessionsForWorkspace([first], []), []);
  assert.deepEqual(sessionsForWorkspace([{ ...first, cwd: 'relative' }], ['/work/project']), []);
  const state = { status: 'ready', snapshot: null, checkedAt: null, filesTracked: 1, issues: [] };
  const presentation = presentLimits(state, first.recordedAt, first);
  assert.doesNotMatch(presentation.text, /Tokens/);
  assert.match(presentation.tooltip, /Conversation tokens: 1,200/);
  assert.match(presentation.tooltip, /Input: 1,000 \| Output: 200/);
  assert.match(presentation.tooltip, /Cached input: 800 \| Reasoning: 50/);
});
