'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readState } = require('../src/state.cjs');

const root = path.join(__dirname, '..');

function adapter() {
  return require('../src/adapters/hermes-hooks.cjs');
}

function classifier() {
  return require('../src/adapters/hermes-tool-classifier.cjs');
}

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-hermes-adapter-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir };
}

// These fixtures deliberately retain the real Hermes Shell Hook envelope.
// Fields irrelevant to one event are still present rather than substituting a
// Claude Code payload shape.
function hermesEnvelope(overrides = {}) {
  return {
    hook_event_name: 'pre_tool_call',
    tool_name: 'read_file',
    tool_input: { path: 'README.md' },
    session_id: 'hermes-session',
    cwd: root,
    extra: { user_message: '' },
    ...overrides
  };
}

function prompt(session, userMessage, cwd = root) {
  return hermesEnvelope({
    hook_event_name: 'pre_llm_call',
    tool_name: null,
    tool_input: {},
    session_id: session,
    cwd,
    extra: { user_message: userMessage, turn_id: 'turn-1' }
  });
}

function pre(session, toolName, toolInput, cwd = root) {
  return hermesEnvelope({
    hook_event_name: 'pre_tool_call',
    tool_name: toolName,
    tool_input: toolInput,
    session_id: session,
    cwd,
    tool_call_id: `${toolName}-call`,
    extra: { user_message: '', tool_call_id: `${toolName}-call` }
  });
}

function post(session, toolName, toolInput, toolCallId = `${toolName}-call`, extra = {}) {
  return hermesEnvelope({
    hook_event_name: 'post_tool_call',
    tool_name: toolName,
    tool_input: toolInput,
    tool_call_id: toolCallId,
    session_id: session,
    extra: { user_message: '', tool_call_id: toolCallId, ...extra }
  });
}

function lifecycle(session, hookEventName, extra = {}) {
  return hermesEnvelope({
    hook_event_name: hookEventName,
    tool_name: null,
    tool_input: null,
    session_id: session,
    extra
  });
}

test('maps real Hermes hook envelope fields to ControlEvent v2', () => {
  const { toControlEvent } = adapter();
  const promptEvent = toControlEvent(prompt('map-session', '$stop-that-shit review -- inspect only'));
  assert.equal(promptEvent.kind, 'prompt.submit');
  assert.equal(promptEvent.sessionId, 'map-session');
  assert.equal(promptEvent.turnId, 'turn-1');
  assert.equal(promptEvent.prompt, '$stop-that-shit review -- inspect only');
  assert.equal(promptEvent.host.family, 'hermes-agent');

  const actionEvent = toControlEvent(pre('map-session', 'write_file', { path: 'notes.txt', content: 'x' }));
  assert.equal(actionEvent.kind, 'action.before');
  assert.equal(actionEvent.action.name, 'write_file');
  assert.equal(actionEvent.action.mutability, 'write');
  assert.deepEqual(actionEvent.action.affectedPaths, ['notes.txt']);
  assert.equal(actionEvent.action.cwd, root);
});

test('maps Hermes post-tool and lifecycle envelopes to ControlEvent v2', () => {
  const { toControlEvent } = adapter();

  const afterEvent = toControlEvent(post('lifecycle-session', 'delegate_task', {
    goal: 'inspect the changed files'
  }, 'delegate-call', { result: 'done', status: 'success' }));
  assert.equal(afterEvent.kind, 'action.after');
  assert.equal(afterEvent.sessionId, 'lifecycle-session');
  assert.equal(afterEvent.action.id, 'delegate-call');

  const startEvent = toControlEvent(lifecycle('lifecycle-session', 'subagent_start', {
    parent_session_id: 'lifecycle-session',
    parent_turn_id: 'turn-2',
    child_session_id: 'child-session',
    child_subagent_id: 'child-agent',
    child_goal: 'inspect the changed files'
  }));
  assert.equal(startEvent.kind, 'subagent.start');
  assert.equal(startEvent.sessionId, 'lifecycle-session');
  assert.equal(startEvent.turnId, 'turn-2');
  assert.equal(startEvent.agentId, 'child-session');
  assert.equal(startEvent.agentAlias, 'child-agent');

  const stopEvent = toControlEvent(lifecycle('lifecycle-session', 'subagent_stop', {
    parent_session_id: 'lifecycle-session',
    child_session_id: 'child-session',
    child_status: 'completed'
  }));
  assert.equal(stopEvent.kind, 'subagent.stop');
  assert.equal(stopEvent.agentId, 'child-session');

  const endEvent = toControlEvent(lifecycle('lifecycle-session', 'on_session_end', {
    completed: true,
    interrupted: false
  }));
  assert.equal(endEvent.kind, 'session.end');
  assert.equal(endEvent.sessionId, 'lifecycle-session');
});

test('classifies only the explicit Hermes tool table and reuses shell evidence', () => {
  const { classifyHermesTool } = classifier();
  assert.equal(classifyHermesTool('read_file', { path: 'x' }), 'read');
  assert.equal(classifyHermesTool('web_extract', { urls: ['https://example.test'] }), 'read');
  assert.equal(classifyHermesTool('write_file', { path: 'x' }), 'write');
  assert.equal(classifyHermesTool('patch', { path: 'x' }), 'write');
  assert.equal(classifyHermesTool('delegate_task', { goal: 'inspect' }), 'delegate');
  assert.equal(classifyHermesTool('delegate_task', { action: 'list' }), 'control');
  assert.equal(classifyHermesTool('delegate_task', { action: 'steer' }), 'control');
  assert.equal(classifyHermesTool('delegate_task', { action: 'stop' }), 'control');
  assert.equal(classifyHermesTool('todo', { todos: [] }), 'control');
  assert.equal(classifyHermesTool('terminal', { command: 'git diff --stat' }), 'read');
  assert.equal(classifyHermesTool('terminal', { command: 'printf x > output.txt' }), 'write');
  assert.equal(classifyHermesTool('terminal', { command: 'node scripts/custom.js' }), 'unknown');
  assert.equal(classifyHermesTool('mcp__filesystem__read_file', { path: 'x' }), 'unknown');
  assert.equal(classifyHermesTool('execute_code', { code: 'print(1)' }), 'unknown');
});

test('maps Hermes delegate_task inputs to the number of new child agents', () => {
  const { toControlEvent } = adapter();
  const single = toControlEvent(pre('count-session', 'delegate_task', { goal: 'Inspect the controller' }));
  const batch = toControlEvent(pre('count-session', 'delegate_task', {
    tasks: [{ goal: 'Inspect the controller' }, { goal: 'Inspect the adapters' }]
  }));
  const empty = toControlEvent(pre('count-session', 'delegate_task', { tasks: [] }));

  assert.equal(single.action.mutability, 'delegate');
  assert.equal(single.action.delegationCount, 1);
  assert.equal(batch.action.mutability, 'delegate');
  assert.equal(batch.action.delegationCount, 2);
  assert.equal(empty.action.mutability, 'delegate');
  assert.equal(empty.action.delegationCount, 0);

  for (const action of ['list', 'steer', 'stop']) {
    const control = toControlEvent(pre('count-session', 'delegate_task', {
      action,
      goal: 'must not count'
    }));
    assert.equal(control.action.mutability, 'control');
    assert.equal(control.action.delegationCount, 0);
  }
});

// Hermes tools/delegate_tool_tasks.py normalizes an empty batch to the legacy
// goal form and recovers JSON-array strings before it chooses a task list.
test('Hermes empty tasks with a goal require one slot at the hook entrypoint', (t) => {
  const { handleHermesHook } = adapter();
  const options = workspace(t);
  for (const [suffix, tasks] of [['array', []], ['string', '[]']]) {
    const session = `empty-tasks-${suffix}`;
    const input = { tasks, goal: 'Inspect the controller' };
    handleHermesHook(prompt(session, '$stop-that-shit change agents=0 -- inspect'), options);
    const denied = handleHermesHook(pre(session, 'delegate_task', input), options);
    assert.equal(denied?.action, 'block');
    assert.match(denied.message, /AGENT_BUDGET_EXHAUSTED/);
    assert.deepEqual(readState(session, options.dataDir).delegation.reservations, {});

    handleHermesHook(prompt(session, '$stop-that-shit change agents=1 -- inspect'), options);
    assert.equal(handleHermesHook(pre(session, 'delegate_task', input), options), null);
    assert.equal(readState(session, options.dataDir).delegation.acceptedActions['delegate_task-call'], 1);
    const next = { ...pre(session, 'delegate_task', { goal: 'Inspect the adapters' }), tool_call_id: 'next-call' };
    assert.equal(handleHermesHook(next, options)?.action, 'block');
  }
});

test('Hermes JSON-array task strings use atomic batch admission at the hook entrypoint', (t) => {
  const { handleHermesHook } = adapter();
  const options = workspace(t);
  const session = 'string-task-batch';
  const input = { tasks: JSON.stringify([{ goal: 'Inspect the controller' }, { goal: 'Inspect the adapters' }]) };
  handleHermesHook(prompt(session, '$stop-that-shit change agents=1 -- inspect'), options);
  const denied = handleHermesHook(pre(session, 'delegate_task', input), options);
  assert.equal(denied?.action, 'block');
  assert.match(denied.message, /AGENT_BUDGET_EXHAUSTED/);
  assert.deepEqual(readState(session, options.dataDir).delegation.reservations, {});

  handleHermesHook(prompt(session, '$stop-that-shit change agents=2 -- inspect'), options);
  assert.equal(handleHermesHook(pre(session, 'delegate_task', input), options), null);
  assert.equal(readState(session, options.dataDir).delegation.acceptedActions['delegate_task-call'], 2);
  handleHermesHook(post(session, 'delegate_task', input, 'delegate_task-call', {
    result: JSON.stringify({ results: [{ status: 'completed' }, { status: 'completed' }] })
  }), options);
  const next = { ...pre(session, 'delegate_task', { goal: 'Inspect one more file' }), tool_call_id: 'next-call' };
  assert.equal(handleHermesHook(next, options), null);
});

test('extracts write_file, default replace, and every real Hermes V4A patch target', () => {
  const { extractAffectedPaths } = classifier();
  assert.deepEqual(extractAffectedPaths('write_file', { path: path.join(root, 'src', 'one.cjs') }, root), ['src/one.cjs']);
  assert.deepEqual(extractAffectedPaths('write_file', { path: 'C:\\repo\\src\\windows.cjs' }, 'C:\\repo'), ['src/windows.cjs']);
  assert.deepEqual(extractAffectedPaths('patch', { path: 'test/default.test.cjs' }, root), ['test/default.test.cjs']);
  assert.deepEqual(extractAffectedPaths('patch', { mode: 'replace', path: 'test/one.test.cjs' }, root), ['test/one.test.cjs']);
  const patchText = [
    '*** Begin Patch',
    '***Add File: src/new.cjs',
    '+new',
    '*** Update File: src/old.cjs',
    '@@',
    '-old',
    '+changed',
    '*** Move File: src/old.cjs -> src/moved.cjs',
    '*** Delete File: test/obsolete.test.cjs',
    '*** End Patch'
  ].join('\n');
  assert.deepEqual(
    extractAffectedPaths('patch', { mode: 'patch', patch: patchText }, root),
    ['src/new.cjs', 'src/old.cjs', 'src/moved.cjs', 'test/obsolete.test.cjs']
  );
  assert.deepEqual(extractAffectedPaths('read_file', { path: 'README.md' }, root), []);
});

test('review returns context then blocks write while change allows it', (t) => {
  const { handleHermesHook } = adapter();
  const options = workspace(t);
  const context = handleHermesHook(prompt('review-write', '$stop-that-shit review -- inspect only'), options);
  assert.match(context.context, /mode=review/);
  const blocked = handleHermesHook(pre('review-write', 'write_file', { path: 'tmp.txt', content: 'x' }), options);
  assert.equal(blocked.action, 'block');
  assert.match(blocked.message, /I\/MODE_FORBIDS_MUTATION/);

  handleHermesHook(prompt('change-write', '$stop-that-shit change -- update tmp.txt'), options);
  assert.equal(handleHermesHook(pre('change-write', 'write_file', { path: 'tmp.txt', content: 'x' }), options), null);
});

test('file lock allows an in-scope patch and blocks an out-of-scope or unproven write', (t) => {
  const { handleHermesHook } = adapter();
  const options = workspace(t);
  handleHermesHook(prompt('file-lock', '$stop-that-shit lock change files=src/allowed.cjs -- edit one file'), options);
  assert.equal(handleHermesHook(pre('file-lock', 'patch', {
    mode: 'replace', path: 'src/allowed.cjs', old_string: 'a', new_string: 'b'
  }), options), null);
  const outside = handleHermesHook(pre('file-lock', 'patch', {
    mode: 'replace', path: 'README.md', old_string: 'a', new_string: 'b'
  }), options);
  assert.match(outside.message, /S\/PATH_OUTSIDE_CONTRACT/);
  const unproven = handleHermesHook(pre('file-lock', 'write_file', { content: 'x' }), options);
  assert.match(unproven.message, /S\/WRITE_PATH_UNPROVEN/);
});

test('review allows proven terminal reads but blocks writes and ambiguous commands', (t) => {
  const { handleHermesHook } = adapter();
  const options = workspace(t);
  handleHermesHook(prompt('terminal-review', '$stop-that-shit review -- inspect only'), options);
  assert.equal(handleHermesHook(pre('terminal-review', 'terminal', { command: 'git diff --stat' }), options), null);
  assert.match(handleHermesHook(pre('terminal-review', 'terminal', { command: 'printf x > out.txt' }), options).message, /I\/MODE_FORBIDS_MUTATION/);
  assert.match(handleHermesHook(pre('terminal-review', 'terminal', { command: 'node scripts/custom.js' }), options).message, /MUTABILITY_UNPROVEN/);
});

test('ambiguous and unknown tools fail open before a contract but block in review', (t) => {
  const { handleHermesHook } = adapter();
  const options = workspace(t);
  assert.equal(handleHermesHook(pre('unknown-open', 'execute_code', { code: 'print(1)' }), options), null);
  handleHermesHook(prompt('unknown-review', '$stop-that-shit review -- inspect only'), options);
  const blocked = handleHermesHook(pre('unknown-review', 'plugin_custom_tool', { path: 'README.md' }), options);
  assert.equal(blocked.action, 'block');
  assert.match(blocked.message, /MUTABILITY_UNPROVEN/);
});

test('dependency and hash intents retain existing contract authority', (t) => {
  const { handleHermesHook } = adapter();
  const options = workspace(t);
  handleHermesHook(prompt('intent-session', '$stop-that-shit change -- update one value'), options);
  assert.match(handleHermesHook(pre('intent-session', 'terminal', { command: 'npm install yaml' }), options).message, /S\/DEPENDENCY_NOT_AUTHORIZED/);
  assert.match(handleHermesHook(pre('intent-session', 'terminal', { command: 'sha256sum artifact.zip' }), options).message, /H\/HASH_NOT_AUTHORIZED/);
  assert.match(handleHermesHook(pre('intent-session', 'patch', {
    mode: 'replace', path: 'package.json', old_string: '{}', new_string: '{"dependencies":{"yaml":"^2.0.0"}}'
  }), options).message, /S\/DEPENDENCY_NOT_AUTHORIZED/);
  assert.match(handleHermesHook(pre('intent-session', 'patch', {
    mode: 'replace', path: 'src/hash.cjs', old_string: 'old', new_string: "require('node:crypto').createHash('sha256')"
  }), options).message, /H\/HASH_NOT_AUTHORIZED/);
});

test('Hermes dependency declarations are detected across every real file mutation shape', () => {
  const { detectDependencyIntent } = classifier();
  const manifests = [
    ['package.json', '{"dependencies":{"yaml":"^2.0.0"}}'],
    ['requirements.txt', 'requests==2.32.0'],
    ['Cargo.toml', '[dependencies]\nserde = "1.0"'],
    ['go.mod', 'module example.test\n\nrequire example.com/dependency v1.2.3'],
    ['Gemfile', 'gem "rails", "~> 7.0"']
  ];

  for (const [manifest, declaration] of manifests) {
    assert.equal(
      detectDependencyIntent('write_file', { path: manifest, content: declaration }),
      true,
      `write_file should detect ${manifest}`
    );
    assert.equal(
      detectDependencyIntent('patch', { path: manifest, new_string: declaration }),
      true,
      `default patch replace should detect ${manifest}`
    );
    assert.equal(
      detectDependencyIntent('patch', { mode: 'replace', path: manifest, new_string: declaration }),
      true,
      `explicit patch replace should detect ${manifest}`
    );
    assert.equal(
      detectDependencyIntent('patch', {
        mode: 'patch',
        patch: `*** Begin Patch\n***Add File: ${manifest}\n${declaration.split('\n').map((line) => `+${line}`).join('\n')}\n*** End Patch`
      }),
      true,
      `compact V4A patch should detect ${manifest}`
    );
  }
});

test('delegate_task reserves the complete batch or leaves the budget unchanged', (t) => {
  const { handleHermesHook } = adapter();
  const options = workspace(t);
  handleHermesHook(prompt('batch-denied', '$stop-that-shit change agents=1 -- delegate once'), options);
  const denied = handleHermesHook(pre('batch-denied', 'delegate_task', {
    tasks: [{ goal: 'Inspect the controller' }, { goal: 'Inspect the adapters' }]
  }), options);
  assert.match(denied.message, /S\/AGENT_BUDGET_EXHAUSTED/);
  assert.deepEqual(readState('batch-denied', options.dataDir).delegation.reservations, {});

  handleHermesHook(prompt('batch-allowed', '$stop-that-shit change agents=2 -- delegate twice'), options);
  assert.equal(handleHermesHook(pre('batch-allowed', 'delegate_task', {
    tasks: [{ goal: 'Inspect the controller' }, { goal: 'Inspect the adapters' }]
  }), options), null);
  assert.equal(readState('batch-allowed', options.dataDir).delegation.reservations['reservation:delegate_task-call'].pendingCount, 2);
});

test('Hermes joined batch releases while a session-end notification alone does not', (t) => {
  const { handleHermesHook } = adapter();
  const options = workspace(t);
  handleHermesHook(prompt('lifecycle-session', '$stop-that-shit change agents=2 -- delegate'), options);
  const tasks = { tasks: [{ goal: 'Inspect the controller' }, { goal: 'Inspect the adapters' }] };
  assert.equal(handleHermesHook(pre('lifecycle-session', 'delegate_task', tasks), options), null);
  handleHermesHook(post('lifecycle-session', 'delegate_task', tasks, 'delegate_task-call', {
    result: JSON.stringify({ results: [{ status: 'completed' }, { status: 'error' }] })
  }), options);
  assert.deepEqual(readState('lifecycle-session', options.dataDir).delegation.reservations, {});
  handleHermesHook(prompt('end-session', '$stop-that-shit change agents=1 -- delegate'), options);
  handleHermesHook(pre('end-session', 'delegate_task', { goal: 'inspect once' }), options);
  assert.equal(handleHermesHook(lifecycle('end-session', 'on_session_end'), options), null);
  assert.equal(readState('end-session', options.dataDir).delegation.reservations['reservation:delegate_task-call'].pendingCount, 1);
});

// Hermes _run_single_child returns failed for provider/output-schema failures
// after its worker has returned and finally cleanup has run. Timeout and
// interrupted results can still have a live worker and must retain capacity.
// https://github.com/NousResearch/hermes-agent/blob/main/tools/delegate_tool.py
for (const mode of ['sync', 'background']) {
  for (const [status, releases] of [
    ['completed', true], ['failed', true], ['error', true],
    ['timeout', false], ['interrupted', false]
  ]) {
    test(`Hermes ${mode} ${status} result ${releases ? 'permits' : 'blocks'} the next delegation`, (t) => {
      const { handleHermesHook } = adapter();
      const options = workspace(t);
      const session = `${mode}-${status}`;
      const input = { goal: 'Inspect the controller sources' };
      handleHermesHook(prompt(session, '$stop-that-shit change agents=1 -- inspect'), options);
      assert.equal(handleHermesHook(pre(session, 'delegate_task', input), options), null);

      if (mode === 'background') {
        handleHermesHook(lifecycle(session, 'subagent_start', {
          parent_session_id: session, child_session_id: 'child-session', child_subagent_id: 'short-child'
        }), options);
        handleHermesHook(post(session, 'delegate_task', input, 'delegate_task-call', {
          result: JSON.stringify({ status: 'dispatched', mode: 'background', count: 1, subagent_ids: ['short-child'] })
        }), options);
        handleHermesHook(lifecycle(session, 'subagent_stop', {
          parent_session_id: session, child_session_id: 'child-session', child_status: status
        }), options);
      } else {
        handleHermesHook(post(session, 'delegate_task', input, 'delegate_task-call', {
          result: JSON.stringify({ results: [{ task_index: 0, status }], total_duration_seconds: 1 })
        }), options);
      }

      const next = { ...pre(session, 'delegate_task', input), tool_call_id: 'next-call' };
      const result = handleHermesHook(next, options);
      if (releases) assert.equal(result, null);
      else {
        assert.equal(result?.action, 'block');
        assert.match(result.message, /AGENT_BUDGET_EXHAUSTED/);
      }
    });
  }
}

test('Hermes delegation control actions do not reserve agent slots', (t) => {
  const { handleHermesHook } = adapter();
  const options = workspace(t);
  handleHermesHook(prompt('delegate-control', '$stop-that-shit change agents=1 -- manage delegation'), options);
  for (const action of ['list', 'steer', 'stop']) {
    assert.equal(handleHermesHook(pre('delegate-control', 'delegate_task', { action }), options), null);
    assert.deepEqual(readState('delegate-control', options.dataDir).delegation.reservations, {});
  }
  assert.equal(handleHermesHook(pre('delegate-control', 'delegate_task', { goal: 'inspect' }), options), null);
  assert.equal(readState('delegate-control', options.dataDir).delegation.reservations['reservation:delegate_task-call'].pendingCount, 1);
});

test('unknown hook events and empty payloads are not applicable', () => {
  const { handleHermesHook, toControlEvent } = adapter();
  assert.equal(toControlEvent(null), null);
  assert.equal(handleHermesHook(hermesEnvelope({ hook_event_name: 'post_tool_call' })), null);
});
