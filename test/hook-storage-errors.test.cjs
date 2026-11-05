'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { freshState, readState, statePath, writeState } = require('../src/state.cjs');
const { readRuntime } = require('../src/runtime-audit.cjs');

const hook = path.join(__dirname, '..', 'hooks', 'stop-that-shit.cjs');

function fixture(t, sessionId, contract) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-hook-storage-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const state = freshState();
  state.contract = { ...state.contract, ...contract };
  writeState(sessionId, state, dataDir);
  return { dataDir, sessionId };
}

function holdSessionLock(t, dataDir, sessionId) {
  const lock = `${statePath(sessionId, dataDir)}.lock`;
  fs.mkdirSync(lock);
  const owner = path.join(lock, `${process.pid}-${crypto.randomUUID()}`);
  fs.writeFileSync(owner, '');
  t.after(() => fs.rmSync(lock, { recursive: true, force: true }));
}

function invokeHook(dataDir, input) {
  return spawnSync(process.execPath, [hook], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PLUGIN_DATA: dataDir, STS_RUNTIME_DATA: dataDir },
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 5000
  });
}

test('the public hook denies a guarded delegation when state locking times out', (t) => {
  const { dataDir, sessionId } = fixture(t, 'guarded-lock-timeout', {
    mode: 'change', level: 'lock', agentBudget: 0, source: 'directive'
  });
  const input = {
    hook_event_name: 'PreToolUse', session_id: sessionId, turn_id: 't', cwd: process.cwd(),
    tool_name: 'spawn_agent', tool_use_id: 'locked-delegation',
    tool_input: { task_name: 'audit', message: 'Inspect the fixture.' }
  };

  assert.match(invokeHook(dataDir, input).stdout, /"permissionDecision":"deny"/);
  holdSessionLock(t, dataDir, sessionId);
  const result = invokeHook(dataDir, input);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
  assert.match(result.stdout, /STS_LOCK_TIMEOUT/);
  assert.doesNotMatch(result.stderr, /failed open/i);
  const audit = readRuntime({ sessionId }, { dataDir }).events.find(event =>
    event.decision.reasonCode === 'SESSION_STATE_UNAVAILABLE');
  assert.ok(audit);
  assert.equal(audit.decision.storageErrorCode, 'STS_LOCK_TIMEOUT');
});

test('a missing contract remains watch-only when delegation state cannot be saved', (t) => {
  const { dataDir, sessionId } = fixture(t, 'watch-only-lock-timeout', {});
  holdSessionLock(t, dataDir, sessionId);
  const result = invokeHook(dataDir, {
    hook_event_name: 'PreToolUse', session_id: sessionId, turn_id: 't', cwd: process.cwd(),
    tool_name: 'spawn_agent', tool_use_id: 'watch-only-delegation',
    tool_input: { task_name: 'audit', message: 'Inspect the fixture.' }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /"permissionDecision":"deny"/);
});

test('the public hook reports a contract update was not applied when state locking times out', (t) => {
  const { dataDir, sessionId } = fixture(t, 'prompt-lock-timeout', {
    mode: 'review', level: 'guard', source: 'directive'
  });
  holdSessionLock(t, dataDir, sessionId);
  const result = invokeHook(dataDir, {
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, turn_id: 't', cwd: process.cwd(),
    prompt: '$stop-that-shit change -- fix the fixture'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CONTRACT_UPDATE_FAILED/);
  assert.match(result.stdout, /not applied/i);
  assert.doesNotMatch(result.stderr, /failed open/i);
  assert.equal(readState(sessionId, dataDir).contract.mode, 'review');
});

test('an ordinary prompt does not claim a contract update failed when it requested none', (t) => {
  const { dataDir, sessionId } = fixture(t, 'ordinary-prompt-lock-timeout', {
    mode: 'review', level: 'guard', source: 'directive'
  });
  holdSessionLock(t, dataDir, sessionId);
  const result = invokeHook(dataDir, {
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, turn_id: 't', cwd: process.cwd(),
    prompt: 'Please explain the current status.'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /CONTRACT_UPDATE_FAILED|not applied/i);
  assert.match(result.stdout, /Stop That Shit \(active\): mode=review/);
});

for (const target of ['session', 'coordination']) {
  test(`a committed launch survives ${target} lock cleanup failure without leaking capacity`, (t) => {
    const { handleControlEvent } = require('../src/controller.cjs');
    const { inspectDelegation } = require('../src/delegation-state.cjs');
    const { dataDir, sessionId } = fixture(t, `release-${target}`, {
      mode: 'change', level: 'guard', agentBudget: 1, source: 'directive'
    });
    const send = (kind, action) => handleControlEvent({
      protocolVersion: 2, lifecycleVersion: 2, sessionId, kind, action
    }, { dataDir });
    const before = id => send('action.before', { id, name: 'Agent', mutability: 'delegate' });
    const original = fs.rmdirSync;
    let failures = 0;
    fs.rmdirSync = function (directory, ...args) {
      const relevant = target === 'session'
        ? String(directory) === `${statePath(sessionId, dataDir)}.lock`
        : String(directory).includes('stop-that-shit-coordination');
      if (relevant && failures++ === 0) throw Object.assign(new Error('cleanup failure'), { code: 'EIO' });
      return original.call(this, directory, ...args);
    };
    try {
      assert.equal(before('A').kind, 'none');
    } finally {
      fs.rmdirSync = original;
    }
    assert.equal(failures, 1);
    assert.equal(inspectDelegation(readState(sessionId, dataDir).delegation).reservedUpperBound, 1);
    // The empty lock container is retained conservatively until stale. Age only
    // this empty container, never bypassing a live owner's marker.
    const lockRoot = target === 'session' ? path.dirname(statePath(sessionId, dataDir))
      : path.join(os.tmpdir(), 'stop-that-shit-coordination', 'sessions');
    for (const name of fs.readdirSync(lockRoot).filter(name => name.endsWith('.lock'))) {
      const lock = path.join(lockRoot, name);
      if (fs.readdirSync(lock).length === 0) {
        const old = new Date(Date.now() - 20000);
        fs.utimesSync(lock, old, old);
      }
    }
    assert.equal(before('B').decision.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
    send('action.after', { id: 'A', lifecycle: 'joined' });
    assert.equal(before('C').kind, 'none');
    assert.equal(inspectDelegation(readState(sessionId, dataDir).delegation).reservedUpperBound, 1);
    assert.equal(readRuntime({ sessionId }, { dataDir }).events.some(event =>
      event.decision.reasonCode === 'SESSION_STATE_UNAVAILABLE'), false);
  });
}

test('a failed reservation write denies launch and a later successful write can use the slot', (t) => {
  const { handleControlEvent } = require('../src/controller.cjs');
  const { inspectDelegation } = require('../src/delegation-state.cjs');
  const { dataDir, sessionId } = fixture(t, 'write-failure', {
    mode: 'change', level: 'guard', agentBudget: 1, source: 'directive'
  });
  const before = id => handleControlEvent({ protocolVersion: 2, lifecycleVersion: 2, sessionId,
    kind: 'action.before', action: { id, name: 'Agent', mutability: 'delegate' }
  }, { dataDir });
  const original = fs.renameSync;
  fs.renameSync = function (source, destination, ...args) {
    if (destination === statePath(sessionId, dataDir)) throw Object.assign(new Error('write failure'), { code: 'EIO' });
    return original.call(this, source, destination, ...args);
  };
  try {
    assert.equal(before('A').decision.reasonCode, 'SESSION_STATE_UNAVAILABLE');
  } finally {
    fs.renameSync = original;
  }
  assert.equal(inspectDelegation(readState(sessionId, dataDir).delegation).reservedUpperBound, 0);
  assert.equal(before('B').kind, 'none');
  assert.equal(before('C').decision.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
});

test('a retained live lock owner blocks retries without undoing its committed launch', (t) => {
  const { handleControlEvent } = require('../src/controller.cjs');
  const { inspectDelegation } = require('../src/delegation-state.cjs');
  const { dataDir, sessionId } = fixture(t, 'owner-release-failure', {
    mode: 'change', level: 'guard', agentBudget: 1, source: 'directive'
  });
  const lock = `${statePath(sessionId, dataDir)}.lock`;
  const before = id => handleControlEvent({ protocolVersion: 2, lifecycleVersion: 2, sessionId,
    kind: 'action.before', action: { id, name: 'Agent', mutability: 'delegate' }
  }, { dataDir });
  const original = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (path.dirname(String(file)) === lock) throw Object.assign(new Error('owner cleanup failure'), { code: 'EIO' });
    return original.call(this, file, ...args);
  };
  try {
    assert.equal(before('A').kind, 'none');
  } finally {
    fs.unlinkSync = original;
  }
  assert.equal(fs.readdirSync(lock).length, 1);
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(lock, old, old);
  assert.equal(before('B').decision.reasonCode, 'SESSION_STATE_UNAVAILABLE');
  assert.equal(fs.readdirSync(lock).length, 1);
  assert.equal(inspectDelegation(readState(sessionId, dataDir).delegation).reservedUpperBound, 1);
});

for (const damagedScope of ['parent', 'child']) {
  for (const damage of ['json', 'legacy-lock']) {
    test(`the public hook denies child delegation with damaged ${damagedScope} ${damage}`, t => {
      const { childStatePath } = require('../src/state.cjs');
      const { dataDir, sessionId } = fixture(t, `child-${damagedScope}-${damage}`, {
        mode: 'change', level: 'guard', agentBudget: 0, source: 'directive'
      });
      const child = freshState();
      child.contract = { ...child.contract, mode: 'change', level: 'guard', agentBudget: 1, source: 'directive' };
      writeState(sessionId, child, dataDir, { agentId: 'child-agent' });
      const parentPath = statePath(sessionId, dataDir);
      const childPath = childStatePath(sessionId, 'child-agent', dataDir);
      const file = damagedScope === 'parent' ? parentPath : childPath;
      if (damage === 'json') fs.writeFileSync(file, '{broken');
      else {
        fs.writeFileSync(`${file}.lock`, 'damaged-owner');
        const old = new Date(Date.now() - 20000);
        fs.utimesSync(`${file}.lock`, old, old);
      }
      const preserved = [parentPath, childPath, ...(damage === 'legacy-lock' ? [`${file}.lock`] : [])]
        .map(file => [file, fs.readFileSync(file, 'utf8')]);
      const result = invokeHook(dataDir, {
        hook_event_name: 'PreToolUse', session_id: sessionId, agent_id: 'child-agent',
        tool_name: 'spawn_agent', tool_use_id: 'child-delegation',
        tool_input: { task_name: 'audit', message: 'Inspect the fixture.' }
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /"permissionDecision":"deny"/);
      assert.match(result.stdout, /SESSION_STATE_UNAVAILABLE/);
      assert.doesNotMatch(result.stderr, /failed open/i);
      for (const [file, contents] of preserved) assert.equal(fs.readFileSync(file, 'utf8'), contents);
      const event = readRuntime({ sessionId }, { dataDir }).events.find(event =>
        event.decision.reasonCode === 'SESSION_STATE_UNAVAILABLE');
      assert.ok(event);
      assert.equal(event.decision.storageErrorCode, damage === 'json' ? 'STATE_DAMAGED' : 'STS_LOCK_DAMAGED');
    });
  }
}

test('healthy scoped state permits a child delegation within the parent limit', t => {
  const { dataDir, sessionId } = fixture(t, 'healthy-child-delegation', {
    mode: 'change', level: 'guard', agentBudget: 1, source: 'directive'
  });
  const child = freshState();
  child.contract = { ...child.contract, mode: 'change', level: 'guard', agentBudget: 1, source: 'directive' };
  writeState(sessionId, child, dataDir, { agentId: 'child-agent' });
  const result = invokeHook(dataDir, {
    hook_event_name: 'PreToolUse', session_id: sessionId, agent_id: 'child-agent',
    tool_name: 'spawn_agent', tool_use_id: 'child-delegation',
    tool_input: { task_name: 'audit', message: 'Inspect the fixture.' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /"permissionDecision":"deny"/);
  assert.doesNotMatch(result.stderr, /failed open/i);
  assert.equal(require('../src/delegation-state.cjs').inspectDelegation(
    readState(sessionId, dataDir, { agentId: 'child-agent' }).delegation).reservedUpperBound, 1);
});

test('unexpected scoped updater errors still propagate instead of being treated as storage failures', t => {
  const scope = require('../src/approval-scope.cjs');
  const { handleControlEvent } = require('../src/controller.cjs');
  const { dataDir, sessionId } = fixture(t, 'scoped-programmer-error', {
    mode: 'change', level: 'guard', agentBudget: 1, source: 'directive'
  });
  const original = scope.update;
  const failure = new Error('unexpected callback bug');
  scope.update = () => { throw failure; };
  try {
    assert.throws(() => handleControlEvent({ protocolVersion: 2, lifecycleVersion: 2,
      kind: 'action.before', sessionId, agent: { agentId: 'child-agent' },
      action: { id: 'A', name: 'Agent', mutability: 'delegate' }
    }, { dataDir }), error => error === failure);
  } finally {
    scope.update = original;
  }
});
