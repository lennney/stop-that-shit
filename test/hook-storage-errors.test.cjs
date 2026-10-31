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
