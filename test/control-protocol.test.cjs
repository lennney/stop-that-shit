'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { toControlEvent, fromControlResult } = require('../src/adapters/codex-hooks.cjs');
const { assertControlEvent, PROTOCOL_VERSION } = require('../src/control-protocol.cjs');
const { handleControlEvent } = require('../src/controller.cjs');
const { detectDependencyIntent } = require('../src/adapters/codex-tool-classifier.cjs');
const { readRuntime } = require('../src/runtime-audit.cjs');

function dataDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-protocol-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('Codex Adapter maps Hook JSON to ControlEvent v1', () => {
  const event = toControlEvent({
    session_id: 'session-1',
    turn_id: 'turn-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_use_id: 'call-1',
    tool_input: { command: 'patch' },
    model: 'gpt-example'
  });
  assert.equal(event.protocolVersion, PROTOCOL_VERSION);
  assert.equal(event.kind, 'action.before');
  assert.equal(event.action.mutability, 'write');
  assert.equal(event.action.hashIntent, false);
  assert.equal(event.host.model, 'gpt-example');
  assertControlEvent(event);
});

test('Codex Adapter marks only high-confidence hashing actions', () => {
  const hashPatch = toControlEvent({
    session_id: 'session-1', hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: { patch: "*** Begin Patch\n+const digest = createHash('sha256').update(data).digest('hex');\n*** End Patch" }
  });
  const prosePatch = toControlEvent({
    session_id: 'session-1', hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: { patch: '*** Begin Patch\n+Document the hash policy without adding code.\n*** End Patch' }
  });
  assert.equal(hashPatch.action.hashIntent, true);
  assert.equal(prosePatch.action.hashIntent, false);
});

test('Codex Adapter extracts a patch path without guessing its semantics', () => {
  const event = toControlEvent({
    session_id: 'session-1', hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: {
      patch: "*** Begin Patch\n*** Add File: src/legacy-adapter.cjs\n+function migrateLegacyConfig(value) { return value; }\n*** End Patch"
    }
  });
  assert.deepEqual(event.action.affectedPaths, ['src/legacy-adapter.cjs']);
  assert.equal(event.action.dependencyIntent, false);
});

test('dependency intent is scoped to added lines in manifest sections', () => {
  const unrelated = `*** Begin Patch
*** Update File: package.json
@@
-  "description": "old"
+  "description": "new"
*** Update File: src/report.cjs
@@
+const dependencies = { status: 'reported' };
*** End Patch`;
  assert.equal(detectDependencyIntent('apply_patch', { patch: unrelated }), false);

  const dependency = `*** Begin Patch
*** Update File: package.json
@@
+  "dependencies": { "example": "^1.0.0" }
*** End Patch`;
  assert.equal(detectDependencyIntent('apply_patch', { patch: dependency }), true);
});

test('Codex Adapter normalizes an absolute patch path relative to hook cwd', () => {
  const cwd = process.platform === 'win32' ? 'D:\\fixture' : '/fixture';
  const absolute = process.platform === 'win32' ? 'D:\\fixture\\src\\config.cjs' : '/fixture/src/config.cjs';
  const event = toControlEvent({
    session_id: 'session-1', hook_event_name: 'PreToolUse', cwd, tool_name: 'apply_patch',
    tool_input: { patch: `*** Begin Patch\n*** Update File: ${absolute}\n@@\n-old\n+new\n*** End Patch` }
  });
  assert.deepEqual(event.action.affectedPaths, ['src/config.cjs']);
});

test('controller decisions do not depend on model metadata', (t) => {
  const firstDir = dataDir(t);
  const secondDir = dataDir(t);
  const promptEvent = {
    protocolVersion: 1,
    kind: 'prompt.submit',
    sessionId: 'session-1',
    turnId: 'turn-1',
    prompt: '$stop-that-shit review -- inspect only'
  };
  handleControlEvent({ ...promptEvent, host: { family: 'codex', model: 'gpt-a' } }, { dataDir: firstDir });
  handleControlEvent({ ...promptEvent, host: { family: 'future-host', model: 'model-b' } }, { dataDir: secondDir });

  const action = {
    protocolVersion: 1,
    kind: 'action.before',
    sessionId: 'session-1',
    turnId: 'turn-1',
    action: { name: 'write-file', input: { path: 'x' }, mutability: 'write' }
  };
  const first = handleControlEvent({ ...action, host: { family: 'codex', model: 'gpt-a' } }, { dataDir: firstDir });
  const second = handleControlEvent({ ...action, host: { family: 'future-host', model: 'model-b' } }, { dataDir: secondDir });
  assert.deepEqual(first.decision, second.decision);
  assert.equal(first.kind, second.kind);
  assert.match(first.eventId, /^evt_/);
  assert.match(second.eventId, /^evt_/);
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(first.message.replace(first.eventId, '<event>'), second.message.replace(second.eventId, '<event>'));
  assert.equal(first.kind, 'deny');
  assert.equal(readRuntime({ sessionId: 'session-1' }, { dataDir: firstDir }).events[0].decision.responseOutcome, 'permission_deny_returned');
  assert.equal(readRuntime({ sessionId: 'session-1' }, { dataDir: secondDir }).events[0].decision.responseOutcome, 'permission_deny_returned');
});

test('protocol rejects unknown versions and kinds', () => {
  assert.throws(() => assertControlEvent({ protocolVersion: 2, kind: 'prompt.submit', sessionId: 's', prompt: '' }), /protocolVersion/);
  assert.throws(() => assertControlEvent({ protocolVersion: 1, kind: 'model.changed', sessionId: 's' }), /kind/);
});

test('protocol accepts only non-negative integer delegation counts', () => {
  const event = {
    protocolVersion: 1,
    kind: 'action.before',
    sessionId: 'session-1',
    action: { name: 'delegate_task', input: {}, mutability: 'delegate' }
  };
  assert.doesNotThrow(() => assertControlEvent(event));
  assert.doesNotThrow(() => assertControlEvent({
    ...event,
    action: { ...event.action, delegationCount: 0 }
  }));
  assert.doesNotThrow(() => assertControlEvent({
    ...event,
    action: { ...event.action, delegationCount: 2 }
  }));
  for (const delegationCount of [-1, 1.5, '2']) {
    assert.throws(() => assertControlEvent({
      ...event,
      action: { ...event.action, delegationCount }
    }), /delegationCount/);
  }
});

test('Codex Adapter renders a normalized deny result back to PreToolUse JSON', () => {
  const output = fromControlResult('PreToolUse', {
    kind: 'deny',
    message: 'Stop That Shit [I/MODE_FORBIDS_MUTATION]: blocked'
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /MODE_FORBIDS_MUTATION/);
});

test('controller implementation contains no Codex Hook event names', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.cjs'), 'utf8');
  assert.doesNotMatch(source, /PreToolUse|PostToolUse|UserPromptSubmit|SubagentStart|hook_event_name/);
});
