'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fromControlResult, handleCodexHook, toControlEvent } = require('../src/adapters/codex-hooks.cjs');
const { assertControlEvent, PROTOCOL_VERSION } = require('../src/control-protocol.cjs');
const { handleControlEvent } = require('../src/controller.cjs');
const { detectDependencyIntent } = require('../src/adapters/codex-tool-classifier.cjs');
const { readRuntime } = require('../src/runtime-audit.cjs');
const { readState } = require('../src/state.cjs');

function dataDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-protocol-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('Codex Adapter maps Hook JSON to ControlEvent v2', () => {
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

test('Codex Adapter maps lifecycle Hook fields to ControlEvent v2', () => {
  const after = toControlEvent({
    session_id: 'lifecycle-session',
    hook_event_name: 'PostToolUse',
    tool_use_id: 'call-1',
    tool_name: 'Agent',
    tool_input: { prompt: 'inspect' }
  });
  assert.equal(after.kind, 'action.after');
  assert.deepEqual(after.action, { id: 'call-1', lifecycle: 'unknown' });

  const start = toControlEvent({
    session_id: 'lifecycle-session',
    hook_event_name: 'SubagentStart',
    agent_id: 'agent-1',
    reservation_id: 'reservation:call-1'
  });
  assert.equal(start, null);

  const stop = toControlEvent({
    session_id: 'lifecycle-session',
    hook_event_name: 'SubagentStop',
    agent_id: 'agent-1'
  });
  assert.equal(stop, null);

  const end = toControlEvent({
    session_id: 'lifecycle-session',
    hook_event_name: 'SessionEnd',
    reason: 'other'
  });
  assert.equal(end.kind, 'session.end');
  for (const hookEventName of ['PostToolUse', 'SubagentStop', 'SessionEnd']) {
    assert.equal(fromControlResult(hookEventName, { kind: 'context', text: 'observer context' }), null);
  }
});

test('Codex ignores PostToolUse events without a valid action identifier', () => {
  for (const identifier of [undefined, null, '', '   ', 42]) {
    const input = {
      session_id: 'malformed-after',
      hook_event_name: 'PostToolUse',
      tool_use_id: identifier
    };
    assert.equal(toControlEvent(input), null);
    assert.equal(handleCodexHook(input), null);
  }

  const fallback = toControlEvent({
    session_id: 'fallback-after',
    hook_event_name: 'PostToolUse',
    tool_use_id: 42,
    tool_call_id: 'fallback-call'
  });
  assert.equal(fallback.action.id, 'fallback-call');
});

test('Codex prompt hooks reject split directives and accept formal agents syntax', (t) => {
  const directory = dataDir(t);
  handleCodexHook({
    session_id: 'invalid-directive',
    hook_event_name: 'UserPromptSubmit',
    prompt: '$stop-that-shit change total-agents=4 -- bounded delegation'
  }, { dataDir: directory });
  const output = handleCodexHook({
    session_id: 'invalid-directive',
    hook_event_name: 'UserPromptSubmit',
    prompt: '$stop-that-shit change agents=1 -- set concurrency'
  }, { dataDir: directory });
  assert.match(output.hookSpecificOutput.additionalContext, /agents=0\/1/);
  assert.equal(readState('invalid-directive', directory).contract.agentBudget, 1);
  assert.equal(readState('invalid-directive', directory).directiveError, null);
  assert.equal(readState('invalid-directive', directory).directiveWarning, null);
  assert.deepEqual(fromControlResult('UserPromptSubmit', {
    kind: 'prompt-error',
    message: 'invalid prompt'
  }), { decision: 'block', reason: 'invalid prompt' });
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
  assert.equal(event.action.cwd, cwd);
});

test('controller decisions do not depend on model metadata', (t) => {
  const firstDir = dataDir(t);
  const secondDir = dataDir(t);
  const promptEvent = {
    protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
    kind: 'prompt.submit',
    sessionId: 'session-1',
    turnId: 'turn-1',
    prompt: '$stop-that-shit review -- inspect only'
  };
  handleControlEvent({ ...promptEvent, host: { family: 'codex', model: 'gpt-a' } }, { dataDir: firstDir });
  handleControlEvent({ ...promptEvent, host: { family: 'future-host', model: 'model-b' } }, { dataDir: secondDir });

  const action = {
    protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
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
  assert.throws(() => assertControlEvent({ protocolVersion: 99, kind: 'prompt.submit', sessionId: 's', prompt: '' }), /protocolVersion/);
  assert.throws(() => assertControlEvent({ protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2, kind: 'model.changed', sessionId: 's' }), /kind/);
});

test('protocol accepts only non-negative integer delegation counts', () => {
  const event = {
    protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
    kind: 'action.before',
    sessionId: 'session-1',
    action: { id: 'delegate-call', name: 'delegate_task', input: {}, mutability: 'delegate' }
  };
  assert.doesNotThrow(() => assertControlEvent(event));
  assert.doesNotThrow(() => assertControlEvent({
    ...event,
    action: { ...event.action, delegationCount: 0 }
  }));
  assert.doesNotThrow(() => assertControlEvent({
    ...event,
    action: { ...event.action, delegationCount: 2, asyncLaunched: false }
  }));
  assert.doesNotThrow(() => assertControlEvent({
    ...event,
    action: { ...event.action, asyncLaunched: true }
  }));
  assert.throws(() => assertControlEvent({
    ...event,
    action: { ...event.action, asyncLaunched: 'true' }
  }), /asyncLaunched/);
  for (const delegationCount of [-1, 1.5, '2']) {
    assert.throws(() => assertControlEvent({
      ...event,
      action: { ...event.action, delegationCount }
    }), /delegationCount/);
  }
});

test('protocol requires action identifiers only for delegation before-events', () => {
  assert.doesNotThrow(() => assertControlEvent({
    protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
    kind: 'action.before',
    sessionId: 'session-1',
    action: { name: 'write-file', mutability: 'write' }
  }));

  for (const id of [undefined, null, '', '   ', 42]) {
    assert.throws(() => assertControlEvent({
      protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
      kind: 'action.before',
      sessionId: 'session-1',
      action: { id, name: 'delegate_task', mutability: 'delegate', delegationCount: 1 }
    }), /action\.id/);
  }

  assert.doesNotThrow(() => assertControlEvent({
    protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
    kind: 'action.before',
    sessionId: 'session-1',
    action: { id: 'delegate-call', name: 'delegate_task', mutability: 'delegate', delegationCount: 1 }
  }));
});

test('protocol accepts lifecycle events and action identifiers', () => {
  assert.doesNotThrow(() => assertControlEvent({
    protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
    kind: 'action.after',
    sessionId: 'session-1',
    action: { id: 'call-1', agentId: 'agent-1' }
  }));
  assert.doesNotThrow(() => assertControlEvent({
    protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
    kind: 'subagent.start',
    sessionId: 'session-1',
    agentId: 'agent-1',
    reservationId: 'reservation-1'
  }));
  assert.doesNotThrow(() => assertControlEvent({
    protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
    kind: 'subagent.stop',
    sessionId: 'session-1',
    agentId: 'agent-1'
  }));
  assert.doesNotThrow(() => assertControlEvent({
    protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
    kind: 'session.end',
    sessionId: 'session-1'
  }));
});

test('controller applies the active agent limit atomically', (t) => {
  const directory = dataDir(t);
  const base = { protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2, sessionId: 'ledger-session' };
  handleControlEvent({
    ...base,
    kind: 'prompt.submit',
    prompt: '$stop-that-shit change agents=2 -- delegate'
  }, { dataDir: directory });

  const first = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-1', name: 'delegate_task', mutability: 'delegate', delegationCount: 2, asyncLaunched: false }
  }, { dataDir: directory });
  assert.equal(first.kind, 'none');
  assert.equal(readState('ledger-session', directory).delegation.reservations['reservation:call-1'].pendingCount, 2);

  const concurrentDenied = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-2', name: 'delegate_task', mutability: 'delegate', delegationCount: 1, asyncLaunched: false }
  }, { dataDir: directory });
  assert.equal(concurrentDenied.decision.reasonCode, 'AGENT_BUDGET_EXHAUSTED');

  handleControlEvent({ ...base, kind: 'action.after', action: { id: 'call-1', completed: true } }, { dataDir: directory });
  const lastUnit = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-3', name: 'delegate_task', mutability: 'delegate', delegationCount: 1, asyncLaunched: false }
  }, { dataDir: directory });
  assert.equal(lastUnit.kind, 'none');

  const batchDenied = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-4', name: 'delegate_task', mutability: 'delegate', delegationCount: 1, asyncLaunched: false }
  }, { dataDir: directory });
  assert.equal(batchDenied.kind, 'none');

  const overLimit = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-5', name: 'delegate_task', mutability: 'delegate', delegationCount: 2, asyncLaunched: false }
  }, { dataDir: directory });
  assert.equal(overLimit.decision.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
});

test('subagent start and stop events are idempotent and synchronous action.after releases work', (t) => {
  const directory = dataDir(t);
  const base = { protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2, sessionId: 'lifecycle-session' };
  handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change agents=2 -- delegate' }, { dataDir: directory });
  handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-1', name: 'delegate_task', mutability: 'delegate', delegationCount: 2, asyncLaunched: false }
  }, { dataDir: directory });

  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-1', reservationId: 'reservation:call-1' }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-1', reservationId: 'reservation:call-1' }, { dataDir: directory });
  assert.equal(readState('lifecycle-session', directory).delegation.reservations['reservation:call-1'].pendingCount, 1);
  handleControlEvent({ ...base, kind: 'subagent.stop', agentId: 'agent-1' }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.stop', agentId: 'agent-1' }, { dataDir: directory });
  assert.equal(readState('lifecycle-session', directory).delegation.reservations['reservation:call-1'].pendingCount, 1);
  handleControlEvent({ ...base, kind: 'action.after', action: { id: 'call-1', completed: true } }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'action.after', action: { id: 'call-1', completed: true } }, { dataDir: directory });
  assert.equal(Object.keys(readState('lifecycle-session', directory).delegation.reservations).length, 0);

  handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-2', name: 'delegate_task', mutability: 'delegate', delegationCount: 1, asyncLaunched: false }
  }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-1' }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.stop', agentId: 'agent-1' }, { dataDir: directory });
  assert.equal(readState('lifecycle-session', directory).delegation.reservations['reservation:call-2'].pendingCount, 1);
  handleControlEvent({ ...base, kind: 'action.after', action: { id: 'call-2', completed: true } }, { dataDir: directory });
});

test('late duplicate starts cannot release another pending agent slot', (t) => {
  const directory = dataDir(t);
  const base = { protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2, sessionId: 'late-start-session' };
  handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change agents=2 -- delegate' }, { dataDir: directory });
  handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-1', name: 'delegate_task', mutability: 'delegate', delegationCount: 2, asyncLaunched: true }
  }, { dataDir: directory });

  handleControlEvent({ ...base, kind: 'subagent.stop', agentId: 'agent-a' }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-a', reservationId: 'reservation:call-1' }, { dataDir: directory });
  const duplicate = handleControlEvent({
    ...base,
    kind: 'subagent.start',
    agentId: 'agent-a',
    reservationId: 'reservation:call-1'
  }, { dataDir: directory });

  assert.ok(duplicate);
  const state = readState('late-start-session', directory);
  assert.equal(state.delegation.reservations['reservation:call-1'].pendingCount, 1);
  assert.equal(state.delegation.reservations['reservation:call-1'].agentIds.length, 0);
});

test('asynchronous action.after retains activity until explicit agent stops', (t) => {
  const directory = dataDir(t);
  const base = { protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2, sessionId: 'async-lifecycle-session' };
  handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change agents=1 -- delegate' }, { dataDir: directory });
  handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-1', name: 'delegate_task', mutability: 'delegate', delegationCount: 1, asyncLaunched: true }
  }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'action.after', action: { id: 'call-1', asyncLaunched: true } }, { dataDir: directory });

  const denied = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-2', name: 'delegate_task', mutability: 'delegate', delegationCount: 1, asyncLaunched: true }
  }, { dataDir: directory });
  assert.equal(denied.decision.reasonCode, 'AGENT_BUDGET_EXHAUSTED');

  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-1', reservationId: 'reservation:call-1' }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.stop', agentId: 'agent-1' }, { dataDir: directory });
  const allowed = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-3', name: 'delegate_task', mutability: 'delegate', delegationCount: 1, asyncLaunched: false }
  }, { dataDir: directory });
  assert.equal(allowed.kind, 'none');
});

test('subagent start requires an explicit reservation and does not use FIFO pairing', (t) => {
  const directory = dataDir(t);
  const base = { protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2, sessionId: 'out-of-order-session' };
  handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change agents=2 -- delegate' }, { dataDir: directory });
  for (const id of ['call-a', 'call-b']) {
    handleControlEvent({
      ...base,
      kind: 'action.before',
      action: { id, name: 'delegate_task', mutability: 'delegate', delegationCount: 1, asyncLaunched: true }
    }, { dataDir: directory });
  }

  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-b', reservationId: 'reservation:call-b' }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-a', reservationId: 'reservation:call-a' }, { dataDir: directory });
  const state = readState('out-of-order-session', directory);
  assert.deepEqual(state.delegation.reservations['reservation:call-a'].agentIds, ['agent-a']);
  assert.deepEqual(state.delegation.reservations['reservation:call-b'].agentIds, ['agent-b']);

  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-unmatched' }, { dataDir: directory });
  const unchanged = readState('out-of-order-session', directory);
  assert.deepEqual(unchanged.delegation.reservations['reservation:call-a'].agentIds, ['agent-a']);
  assert.deepEqual(unchanged.delegation.reservations['reservation:call-b'].agentIds, ['agent-b']);
});

test('replayed action ids do not reserve twice and conflicting counts are denied', (t) => {
  const directory = dataDir(t);
  const base = { protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2, sessionId: 'replay-session' };
  handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change agents=2 -- delegate' }, { dataDir: directory });
  const first = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'replayed-call', name: 'delegate_task', mutability: 'delegate', delegationCount: 1, asyncLaunched: false }
  }, { dataDir: directory });
  assert.equal(first.kind, 'none');
  handleControlEvent({ ...base, kind: 'action.after', action: { id: 'replayed-call', completed: true } }, { dataDir: directory });

  const replay = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'replayed-call', name: 'delegate_task', mutability: 'delegate', delegationCount: 1, asyncLaunched: false }
  }, { dataDir: directory });
  assert.equal(replay.kind, 'none');
  assert.equal(readState('replay-session', directory).delegation.acceptedActions['replayed-call'], 1);

  const conflict = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'replayed-call', name: 'delegate_task', mutability: 'delegate', delegationCount: 2, asyncLaunched: false }
  }, { dataDir: directory });
  assert.equal(conflict.decision.reasonCode, 'DUPLICATE_ACTION_ID');
});

test('formal agents directive clears an earlier split-directive error', (t) => {
  const directory = dataDir(t);
  const base = { protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2, sessionId: 'directive-session' };
  const invalid = handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change total-agents=4 -- delegate' }, { dataDir: directory });
  assert.equal(invalid.kind, 'prompt-error');
  const valid = handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change agents=1 -- delegate' }, { dataDir: directory });
  assert.notEqual(valid.kind, 'prompt-error');
  assert.equal(readState('directive-session', directory).contract.agentBudget, 1);
  assert.equal(readState('directive-session', directory).directiveError, null);
  assert.equal(readState('directive-session', directory).directiveWarning, null);

  const denied = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-1', name: 'delegate_task', mutability: 'delegate', delegationCount: 1 }
  }, { dataDir: directory });
  assert.equal(denied.kind, 'none');
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
