'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { readState } = require('../src/state.cjs');

const root = path.join(__dirname, '..');
const pluginRoot = path.join(root, '.hermes-plugin');
const entrypoint = path.join(pluginRoot, 'runtime', 'stop-that-shit.cjs');
const legacyEntrypoint = path.join(root, 'hooks', ['stop-that-shit', 'hermes.cjs'].join('-'));

function hermesEnvelope(overrides = {}) {
  return {
    hook_event_name: 'pre_tool_call',
    tool_name: 'read_file',
    tool_input: { path: 'README.md' },
    session_id: 'hermes-hook-session',
    cwd: root,
    extra: { user_message: '' },
    ...overrides
  };
}

function prompt(session, text) {
  return hermesEnvelope({
    hook_event_name: 'pre_llm_call',
    tool_name: null,
    tool_input: {},
    session_id: session,
    extra: { user_message: text, turn_id: 'turn-1' }
  });
}

function pre(session, toolName, toolInput, toolCallId = `${toolName}-call`) {
  return hermesEnvelope({
    hook_event_name: 'pre_tool_call',
    tool_name: toolName,
    tool_input: toolInput,
    session_id: session,
    tool_call_id: toolCallId,
    extra: { user_message: '', tool_call_id: toolCallId }
  });
}

function post(session, toolName, toolInput, toolCallId = `${toolName}-call`) {
  return hermesEnvelope({
    hook_event_name: 'post_tool_call',
    tool_name: toolName,
    tool_input: toolInput,
    tool_call_id: toolCallId,
    session_id: session,
    extra: {
      user_message: '',
      tool_call_id: toolCallId,
      result: 'done'
    }
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

function temporaryHome(t, prefix = 'sts-hermes-home-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function runHook(home, payload) {
  return spawnSync(process.execPath, [entrypoint], {
    cwd: root,
    env: { ...process.env, HERMES_HOME: home },
    input: payload,
    encoding: 'utf8',
    timeout: 5000
  });
}


test('legacy Hermes Shell Hook entrypoint is removed', () => {
  assert.equal(fs.existsSync(legacyEntrypoint), false);
});

function runHookAsync(home, payload) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: { ...process.env, HERMES_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin.end(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('Hermes entrypoint emits context for pre_llm_call and block JSON for denied pre_tool_call', (t) => {
  const home = temporaryHome(t);
  const armed = runHook(home, JSON.stringify(prompt('wire-session', '$stop-that-shit review -- inspect only')));
  assert.equal(armed.status, 0, armed.stderr);
  assert.deepEqual(Object.keys(JSON.parse(armed.stdout)), ['context']);
  assert.match(JSON.parse(armed.stdout).context, /mode=review/);

  const denied = runHook(home, JSON.stringify(pre('wire-session', 'write_file', { path: 'blocked.txt', content: 'secret-free' })));
  assert.equal(denied.status, 0, denied.stderr);
  const response = JSON.parse(denied.stdout);
  assert.equal(response.action, 'block');
  assert.match(response.message, /I\/MODE_FORBIDS_MUTATION/);
});

test('allow, unknown events, and empty stdin exit zero without stdout', (t) => {
  const home = temporaryHome(t);
  const empty = runHook(home, '');
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, '');

  const unknown = runHook(home, JSON.stringify(hermesEnvelope({ hook_event_name: 'post_tool_call' })));
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(unknown.stdout, '');

  const allowed = runHook(home, JSON.stringify(pre('unconfirmed-session', 'read_file', { path: 'README.md' })));
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');
});

test('invalid JSON reports only a clipped error type and never echoes payload', (t) => {
  const home = temporaryHome(t);
  const marker = 'DO_NOT_ECHO_THIS_SECRET_MARKER';
  const invalid = runHook(home, `{not-json:${marker}}`);
  assert.equal(invalid.status, 0);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /SyntaxError|invalid json/i);
  assert.doesNotMatch(invalid.stderr, new RegExp(marker));
  assert.ok(invalid.stderr.length < 300, `stderr was not clipped: ${invalid.stderr.length}`);
});

test('HERMES_HOME profiles isolate contract state and use stop-that-shit subdirectories', (t) => {
  const firstHome = temporaryHome(t, 'sts-hermes-profile-a-');
  const secondHome = temporaryHome(t, 'sts-hermes-profile-b-');
  const session = 'same-session-id';

  const armed = runHook(firstHome, JSON.stringify(prompt(session, '$stop-that-shit review -- inspect only')));
  assert.equal(armed.status, 0, armed.stderr);

  const first = runHook(firstHome, JSON.stringify(pre(session, 'write_file', { path: 'x.txt', content: 'x' })));
  const second = runHook(secondHome, JSON.stringify(pre(session, 'write_file', { path: 'x.txt', content: 'x' })));
  assert.equal(JSON.parse(first.stdout).action, 'block');
  assert.equal(second.stdout, '');
  assert.ok(fs.existsSync(path.join(firstHome, 'stop-that-shit')));
  assert.ok(fs.existsSync(path.join(secondHome, 'stop-that-shit')));
});

test('parallel Hermes hook processes cannot oversubscribe agents=1', async (t) => {
  const home = temporaryHome(t);
  const session = 'parallel-budget';
  const armed = runHook(home, JSON.stringify(prompt(session, '$stop-that-shit change agents=1 -- one delegation')));
  assert.equal(armed.status, 0, armed.stderr);

  const results = await Promise.all([
    runHookAsync(home, pre(session, 'delegate_task', { goal: 'inspect tests' }, 'delegate_task-call-a')),
    runHookAsync(home, pre(session, 'delegate_task', { goal: 'inspect tests' }, 'delegate_task-call-b'))
  ]);
  assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join('\n'));
  const parsed = results.map((result) => result.stdout.trim() ? JSON.parse(result.stdout) : null);
  assert.equal(parsed.filter((value) => value === null).length, 1);
  assert.equal(parsed.filter((value) => value?.action === 'block' && /AGENT_BUDGET_EXHAUSTED/.test(value.message)).length, 1);
});

test('parallel Hermes batches reserve all child agents atomically', async (t) => {
  const home = temporaryHome(t);
  const session = 'parallel-batch-budget';
  const armed = runHook(home, JSON.stringify(prompt(session, '$stop-that-shit change agents=2 -- one complete batch')));
  assert.equal(armed.status, 0, armed.stderr);

  const taskInput = { tasks: [{ goal: 'Inspect the controller' }, { goal: 'Inspect the adapters' }] };
  const results = await Promise.all([
    runHookAsync(home, pre(session, 'delegate_task', taskInput, 'delegate_task-call-a')),
    runHookAsync(home, pre(session, 'delegate_task', taskInput, 'delegate_task-call-b'))
  ]);
  assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join('\n'));
  const parsed = results.map((result) => result.stdout.trim() ? JSON.parse(result.stdout) : null);
  assert.equal(parsed.filter((value) => value === null).length, 1);
  assert.equal(parsed.filter((value) => value?.action === 'block' && /AGENT_BUDGET_EXHAUSTED/.test(value.message)).length, 1);
  const state = readState(session, path.join(home, 'stop-that-shit'));
  assert.equal(Object.keys(state.delegation.reservations).length, 1);
  assert.equal(Object.values(state.delegation.reservations)[0].pendingCount, 2);
});

test('Hermes runtime consumes post-tool and lifecycle events without observer output', (t) => {
  const home = temporaryHome(t);
  const session = 'wire-lifecycle-session';
  const armed = runHook(home, JSON.stringify(prompt(session, '$stop-that-shit change agents=2 -- delegate')));
  assert.equal(armed.status, 0, armed.stderr);

  const delegated = runHook(home, JSON.stringify(pre(session, 'delegate_task', {
    tasks: [{ goal: 'Inspect the controller' }, { goal: 'Inspect the adapters' }]
  })));
  assert.equal(delegated.status, 0, delegated.stderr);
  assert.equal(delegated.stdout, '');

  const started = runHook(home, JSON.stringify(lifecycle(session, 'subagent_start', {
    child_session_id: 'wire-child-session',
    child_subagent_id: 'short-A'
  })));
  const stopped = runHook(home, JSON.stringify(lifecycle(session, 'subagent_stop', {
    child_session_id: 'wire-child-session', child_status: 'completed'
  })));
  const dispatched = post(session, 'delegate_task', {
    tasks: [{ goal: 'Inspect the controller' }, { goal: 'Inspect the adapters' }]
  });
  dispatched.extra.result = JSON.stringify({ status: 'dispatched', mode: 'background', subagent_ids: ['short-A', 'short-B'] });
  const returned = runHook(home, JSON.stringify(dispatched));
  for (const result of [started, stopped, returned]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  assert.equal(readState(session, path.join(home, 'stop-that-shit')).delegation.reservations['reservation:delegate_task-call'].pendingCount, 1);

  const ended = runHook(home, JSON.stringify(lifecycle(session, 'on_session_end')));
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(ended.stdout, '');
  assert.equal(readState(session, path.join(home, 'stop-that-shit')).delegation.reservations['reservation:delegate_task-call'].pendingCount, 1);
  for (const [event, extra] of [
    ['subagent_start', { child_session_id: 'wire-child-B', child_subagent_id: 'short-B' }],
    ['subagent_stop', { child_session_id: 'wire-child-B', child_status: 'completed' }]
  ]) {
    const result = runHook(home, JSON.stringify(lifecycle(session, event, extra)));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(readState(session, path.join(home, 'stop-that-shit')).delegation.reservations, {});
});

for (const mode of ['sync', 'background']) {
  for (const [status, releases] of [['completed', true], ['failed', true], ['timeout', false], ['interrupted', false]]) {
    test(`Hermes runtime ${mode} ${status} result ${releases ? 'permits' : 'blocks'} the next delegation`, (t) => {
      const home = temporaryHome(t);
      const session = `wire-${mode}-${status}`;
      const input = { goal: 'Inspect the controller sources' };
      const send = (payload) => {
        const result = runHook(home, JSON.stringify(payload));
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim() ? JSON.parse(result.stdout) : null;
      };
      send(prompt(session, '$stop-that-shit change agents=1 -- inspect'));
      assert.equal(send(pre(session, 'delegate_task', input)), null);

      const returned = post(session, 'delegate_task', input);
      if (mode === 'background') {
        assert.equal(send(lifecycle(session, 'subagent_start', {
          parent_session_id: session, child_session_id: 'child-session', child_subagent_id: 'short-child'
        })), null);
        returned.extra.result = JSON.stringify({ status: 'dispatched', mode: 'background', count: 1, subagent_ids: ['short-child'] });
        assert.equal(send(returned), null);
        assert.equal(send(lifecycle(session, 'subagent_stop', {
          parent_session_id: session, child_session_id: 'child-session', child_status: status
        })), null);
      } else {
        returned.extra.result = JSON.stringify({ results: [{ task_index: 0, status }], total_duration_seconds: 1 });
        assert.equal(send(returned), null);
      }

      const next = send(pre(session, 'delegate_task', input, 'next-call'));
      if (releases) assert.equal(next, null);
      else {
        assert.equal(next?.action, 'block');
        assert.match(next.message, /AGENT_BUDGET_EXHAUSTED/);
      }
    });
  }
}
