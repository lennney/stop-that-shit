'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  handlePiPrompt,
  handlePiTool,
  handlePiToolAfter,
  normalizePiPrompt,
  toActionAfterEvent,
  toActionEvent
} = require('../src/adapters/pi-hooks.cjs');
const {
  classifyPiTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  piDelegationShape
} = require('../src/adapters/pi-tool-classifier.cjs');
const { readRuntime } = require('../src/runtime-audit.cjs');
const { readState } = require('../src/state.cjs');

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-pi-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir };
}

function context(sessionId = 'pi-session', extra = {}) {
  return {
    sessionId,
    cwd: '/repo',
    mode: 'tui',
    hasUI: true,
    model: { provider: 'openai', id: 'test' },
    ...extra
  };
}

function prompt(sessionId, text) {
  return [{ type: 'input', text, source: 'interactive' }, context(sessionId)];
}

function tool(sessionId, toolName, input) {
  return [{ type: 'tool_call', toolCallId: `${toolName}-1`, toolName, input }, context(sessionId)];
}

test('Pi native skill invocation normalizes to the host-neutral directive', () => {
  assert.equal(
    normalizePiPrompt('/skill:stop-that-shit review agents=1 -- inspect only'),
    '$stop-that-shit review agents=1 -- inspect only'
  );
});

test('Pi Adapter maps current built-in tool fields to ControlEvent v1', () => {
  const event = toActionEvent(...tool('session-1', 'edit', {
    path: '/repo/src/config.cjs',
    edits: [{ oldText: 'old', newText: 'new' }]
  }));

  assert.equal(event.kind, 'action.before');
  assert.equal(event.sessionId, 'session-1');
  assert.equal(event.host.family, 'pi');
  assert.equal(event.host.mode, 'tui');
  assert.equal(event.host.hasUI, true);
  assert.equal(event.action.id, 'edit-1');
  assert.equal(event.action.mutability, 'write');
  assert.deepEqual(event.action.affectedPaths, ['src/config.cjs']);
  assert.equal(event.action.cwd, '/repo');
});

test('Pi Adapter maps tool completion to action.after using toolCallId', () => {
  const event = toActionAfterEvent({
    type: 'tool_result',
    toolCallId: 'subagent-1',
    toolName: 'subagent',
    async_launched: false
  }, context('session-1'));

  assert.equal(event.kind, 'action.after');
  assert.equal(event.sessionId, 'session-1');
  assert.equal(event.action.id, 'subagent-1');
  assert.equal(event.action.lifecycle, 'unknown');
});

test('Pi completion events leave async status unknown when the host omits it', () => {
  assert.equal(toActionAfterEvent({ toolCallId: 'subagent-1', toolName: 'subagent' }).action.asyncLaunched, undefined);
});

test('Pi delegation reservations are released by action.after', (t) => {
  const options = workspace(t);
  handlePiPrompt(...prompt('delegation-session', '$stop-that-shit change agents=1 -- delegate'), options);
  assert.equal(handlePiTool(...tool('delegation-session', 'subagent', {
    agent: 'scout',
    task: 'inspect'
  }), options).kind, 'none');

  assert.equal(handlePiToolAfter({
    type: 'tool_result', toolCallId: 'subagent-1', toolName: 'subagent',
    input: { agent: 'scout', task: 'inspect' }, content: [], isError: false,
    details: { mode: 'single', results: [] }
  }, context('delegation-session'), options).kind, 'none');
  assert.deepEqual(readState('delegation-session', options.dataDir).delegation.reservations, {});
  assert.equal(handlePiTool({
    type: 'tool_call', toolCallId: 'subagent-2', toolName: 'subagent',
    input: { agent: 'scout', task: 'inspect again' }
  }, context('delegation-session'), options).kind, 'none');
});

test('Pi uses an explicit built-in allowlist and conservative custom-tool fallback', () => {
  for (const name of ['read', 'grep', 'find', 'ls']) {
    assert.equal(classifyPiTool(name, {}), 'read');
  }
  assert.equal(classifyPiTool('write', { path: 'a' }), 'write');
  assert.equal(classifyPiTool('edit', { path: 'a' }), 'write');
  assert.equal(classifyPiTool('bash', { command: 'git diff --stat' }), 'read');
  assert.equal(classifyPiTool('powershell', { command: 'Set-Content out.txt x' }), 'write');
  assert.equal(classifyPiTool('custom_read_database', {}), 'unknown');
});

test('Pi paths normalize for POSIX and Windows workspaces', () => {
  assert.deepEqual(extractAffectedPaths('write', { path: '/repo/src/a.cjs' }, '/repo'), ['src/a.cjs']);
  assert.deepEqual(
    extractAffectedPaths('edit', { path: 'C:\\repo\\src\\a.cjs', edits: [] }, 'C:\\repo'),
    ['src/a.cjs']
  );
});

test('Pi detects dependency and hash intent in current write and edit shapes', () => {
  assert.equal(detectDependencyIntent('write', {
    path: 'package.json',
    content: '{"dependencies":{"yaml":"^2.0.0"}}'
  }), true);
  assert.equal(detectDependencyIntent('edit', {
    path: 'requirements.txt',
    edits: [{ oldText: '', newText: 'requests==2.32.0' }]
  }), true);
  assert.equal(detectHashIntent('edit', {
    path: 'src/hash.cjs',
    edits: [{ oldText: 'old', newText: "createHash('sha256').update(value).digest('hex')" }]
  }), true);
  assert.equal(detectHashIntent('powershell', { command: 'Get-FileHash artifact.zip' }), true);
});

test('official Pi subagent schemas produce deterministic delegation counts', () => {
  assert.deepEqual(piDelegationShape('subagent', { agent: 'scout', task: 'inspect' }), { count: 1, unbounded: false });
  assert.deepEqual(piDelegationShape('subagent', { tasks: [{}, {}, {}] }), { count: 3, unbounded: false });
  assert.deepEqual(piDelegationShape('subagent', { chain: [{}, {}] }), { count: 1, unbounded: false });
  assert.deepEqual(piDelegationShape('subagent', { tasks: [{}], chain: [{}] }), { count: 0, unbounded: true });
  assert.deepEqual(piDelegationShape('other', { tasks: [{}, {}] }), { count: 0, unbounded: false });
});

test('review blocks Pi writes and records an execution denial', (t) => {
  const options = workspace(t);
  handlePiPrompt(...prompt('review-session', '$stop-that-shit review -- inspect only'), options);
  const result = handlePiTool(...tool('review-session', 'write', {
    path: '/repo/src/value.cjs', content: 'changed'
  }), options);

  assert.equal(result.kind, 'deny');
  assert.match(result.message, /I\/MODE_FORBIDS_MUTATION/);
  assert.match(result.message, /pre-execution denial/);
  const runtime = readRuntime({ sessionId: 'review-session' }, options);
  assert.equal(runtime.summary.executionDenialResponses, 1);
});

test('change allows an in-scope Pi edit and blocks an out-of-scope edit', (t) => {
  const options = workspace(t);
  handlePiPrompt(...prompt('lock-session', '$stop-that-shit lock change files=src/value.cjs -- update value'), options);
  assert.equal(handlePiTool(...tool('lock-session', 'edit', {
    path: '/repo/src/value.cjs', edits: [{ oldText: '1', newText: '2' }]
  }), options).kind, 'none');
  assert.match(handlePiTool(...tool('lock-session', 'write', {
    path: '/repo/README.md', content: 'changed'
  }), options).message, /S\/PATH_OUTSIDE_CONTRACT/);
});

test('unknown Pi tools fail open before a contract and block under review', (t) => {
  const options = workspace(t);
  assert.equal(handlePiTool(...tool('unknown-open', 'custom_tool', {}), options).kind, 'none');
  handlePiPrompt(...prompt('unknown-review', '$stop-that-shit review -- inspect'), options);
  assert.match(handlePiTool(...tool('unknown-review', 'custom_tool', {}), options).message, /MUTABILITY_UNPROVEN/);
});

test('Pi subagent batches reserve atomically against agents=N', (t) => {
  const options = workspace(t);
  handlePiPrompt(...prompt('batch-denied', '$stop-that-shit change agents=1 -- delegate once'), options);
  const denied = handlePiTool(...tool('batch-denied', 'subagent', {
    tasks: [{ agent: 'scout', task: 'A' }, { agent: 'scout', task: 'B' }]
  }), options);
  assert.match(denied.message, /S\/AGENT_BUDGET_EXHAUSTED/);
  assert.deepEqual(readState('batch-denied', options.dataDir).delegation.reservations, {});

  handlePiPrompt(...prompt('batch-allowed', '$stop-that-shit change agents=2 -- delegate twice'), options);
  assert.equal(handlePiTool(...tool('batch-allowed', 'subagent', {
    tasks: [{ agent: 'worker', task: 'A' }, { agent: 'reviewer', task: 'B' }]
  }), options).kind, 'none');
  assert.equal(readState('batch-allowed', options.dataDir).delegation.reservations['reservation:subagent-1'].pendingCount, 2);
});
