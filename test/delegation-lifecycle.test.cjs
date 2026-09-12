'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const { handleClaudeHook } = require(path.join(root, 'src/adapters/claude-hooks.cjs'));
const { registerPiExtension } = require(path.join(root, 'src/adapters/pi-extension.cjs'));
const { handleOpenCodeMessage } = require(path.join(root, 'src/adapters/opencode-hooks.cjs'));
const { readState } = require(path.join(root, 'src/state.cjs'));
const { activeDelegationCount } = require(path.join(root, 'src/delegation-state.cjs'));

const temporaryRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sts-lifecycle-'));
require('node:test').after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
function dataDir() { return fs.mkdtempSync(path.join(temporaryRoot, 'state-')); }
function claude() {
  const dir = dataDir();
  const session_id = 'synthetic-parent';
  const hook = (hook_event_name, fields = {}) => handleClaudeHook({ session_id, cwd: root, hook_event_name, ...fields }, { dataDir: dir });
  hook('UserPromptSubmit', { prompt: '$stop-that-shit change agents=1 -- inspect' });
  const tool = (phase, id, extra = {}) => hook(phase, {
    tool_name: 'Agent', tool_use_id: id,
    tool_input: { prompt: 'inspect', description: 'inspect', subagent_type: 'general-purpose' }, ...extra
  });
  return { hook, tool, active: () => activeDelegationCount(readState(session_id, dir).delegation) };
}

test('Claude joined foreground call releases, and duplicate late lifecycle events do not consume another slot', () => {
  const s = claude();
  assert.equal(s.tool('PreToolUse', 'call-A'), null);
  s.hook('SubagentStop', { agent_id: 'A', agent_type: 'general-purpose', stop_hook_active: false });
  s.hook('SubagentStart', { agent_id: 'A', agent_type: 'general-purpose' });
  s.tool('PostToolUse', 'call-A', { tool_response: { status: 'completed', agentId: 'A' } });
  assert.equal(s.active(), 0);
  assert.equal(s.tool('PreToolUse', 'call-B'), null);
  s.hook('SubagentStart', { agent_id: 'A', agent_type: 'general-purpose' });
  s.hook('SubagentStop', { agent_id: 'A', agent_type: 'general-purpose', stop_hook_active: false });
  s.tool('PostToolUse', 'call-A', { tool_response: { status: 'completed', agentId: 'A' } });
  assert.equal(s.active(), 1);
  assert.equal(s.tool('PreToolUse', 'call-C').hookSpecificOutput.permissionDecision, 'deny');
});

test('Claude cannot resume an unversioned agent through SendMessage under a finite limit', () => {
  const s = claude();
  s.tool('PreToolUse', 'call-A');
  s.hook('SubagentStart', { agent_id: 'A', agent_type: 'general-purpose' });
  s.tool('PostToolUse', 'call-A', { tool_response: { status: 'completed', agentId: 'A' } });
  s.hook('SubagentStop', { agent_id: 'A', agent_type: 'general-purpose', stop_hook_active: false });
  assert.equal(s.active(), 0);
  const send = s.hook('PreToolUse', { tool_name: 'SendMessage', tool_use_id: 'resume-A', tool_input: { to: 'A', message: 'Continue the inspection' } });
  assert.equal(send?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(send.hookSpecificOutput.permissionDecisionReason, /DELEGATION_LIFECYCLE_UNPROVEN/);
  assert.equal(s.active(), 0);
  assert.equal(s.tool('PreToolUse', 'call-B'), null);
});

test('Claude messaging remains available without a finite plugin limit', () => {
  const s = claude();
  s.hook('UserPromptSubmit', { prompt: `$stop-that-shit change agents=${Number.MAX_SAFE_INTEGER} -- inspect` });
  assert.equal(s.hook('PreToolUse', { tool_name: 'SendMessage', tool_use_id: 'message-1', tool_input: { to: 'A', message: 'Continue' } }), null);
});

async function opencode() {
  const dir = dataDir();
  const sessions = { parent: { id: 'parent' }, child: { id: 'child', parentID: 'parent' } };
  const client = { session: { get: async ({ path: p }) => ({ data: sessions[p.id] }) }, app: { log: async () => {} } };
  const { StopThatShitPlugin } = await import(pathToFileURL(path.join(root, 'opencode/stop-that-shit.mjs')));
  const hooks = await StopThatShitPlugin({ client, directory: root }, { dataDir: dir });
  handleOpenCodeMessage({ sessionID: 'parent' }, { parts: [{ type: 'text', text: '$stop-that-shit change agents=1 -- inspect' }] }, {}, { dataDir: dir });
  const before = (id, args) => hooks['tool.execute.before']({ tool: 'task', sessionID: 'parent', callID: id }, { args });
  const after = (id, args, metadata) => hooks['tool.execute.after']({ tool: 'task', sessionID: 'parent', callID: id, args }, { title: 'inspect', output: 'task result', metadata });
  const event = (type, properties) => hooks.event({ event: { type, properties } });
  return { before, after, event, sessions, prompt: text => handleOpenCodeMessage({ sessionID: 'parent' }, { parts: [{ type: 'text', text }] }, {}, { dataDir: dir }), active: () => activeDelegationCount(readState('parent', dir).delegation) };
}
const taskArgs = { prompt: 'inspect files', description: 'inspect', subagent_type: 'explore' };

test('OpenCode default foreground task releases on documented tool.execute.after fields', async (t) => {
  const s = await opencode();
  await s.before('task-1', taskArgs);
  await s.event('session.created', { info: s.sessions.child });
  await s.event('session.idle', { sessionID: 'child' });
  await s.after('task-1', taskArgs, { sessionId: 'child', parentSessionId: 'parent' });
  const activeAfterCompletion = s.active();
  let nextError = null;
  try { await s.before('task-2', taskArgs); } catch (error) { nextError = error.message; }
  t.diagnostic(JSON.stringify({ activeAfterCompletion, secondLaunch: nextError ? 'deny' : 'allow', nextError }));
  assert.equal(activeAfterCompletion, 0);
  assert.equal(nextError, null);
});

test('OpenCode foreground task promoted to background retains its slot based on output metadata', async (t) => {
  const s = await opencode();
  const args = { ...taskArgs, background: false };
  await s.before('task-1', args);
  await s.event('session.created', { info: s.sessions.child });
  await s.after('task-1', args, { sessionId: 'child', parentSessionId: 'parent', background: true, jobId: 'child' });
  const activeAfterPromotion = s.active();
  let denied = false;
  try { await s.before('task-2', taskArgs); } catch { denied = true; }
  t.diagnostic(JSON.stringify({ activeAfterPromotion, secondLaunch: denied ? 'deny' : 'allow' }));
  assert.equal(activeAfterPromotion, 1);
  assert.equal(denied, true);
});

test('OpenCode explicit background launch stays reserved until completion evidence', async () => {
  const s = await opencode();
  const args = { ...taskArgs, background: true };
  await s.before('task-1', args);
  await s.after('task-1', args, { sessionId: 'child', parentSessionId: 'parent', background: true, jobId: 'child' });
  assert.equal(s.active(), 1);
  await assert.rejects(s.before('task-2', taskArgs), /AGENT_BUDGET_EXHAUSTED/);
});

function pi() {
  const dir = dataDir();
  const handlers = new Map();
  const ctx = { cwd: root, mode: 'tui', hasUI: false, sessionManager: { getSessionId: () => 'pi-parent' } };
  registerPiExtension({ on: (name, handler) => handlers.set(name, handler) }, { dataDir: dir });
  handlers.get('input')({ type: 'input', text: '$stop-that-shit change agents=1 -- inspect', source: 'interactive' }, ctx);
  return { call: (id, input) => handlers.get('tool_call')({ type: 'tool_call', toolCallId: id, toolName: 'subagent', input }, ctx),
    result: (id, input, extra = {}) => handlers.get('tool_result')({ type: 'tool_result', toolCallId: id, toolName: 'subagent', input, content: [{ type: 'text', text: 'done' }], details: { mode: 'single', results: [] }, isError: false, ...extra }, ctx),
    active: () => activeDelegationCount(readState('pi-parent', dir).delegation) };
}

test('Pi official synchronous subagent tool releases on the real tool_result shape', (t) => {
  const s = pi();
  const input = { agent: 'scout', task: 'inspect files' };
  assert.equal(s.call('task-1', input), undefined);
  s.result('task-1', input);
  const activeAfterCompletion = s.active();
  const next = s.call('task-2', input);
  t.diagnostic(JSON.stringify({ activeAfterCompletion, secondLaunch: next?.block ? 'deny' : 'allow' }));
  assert.equal(activeAfterCompletion, 0);
  assert.equal(next, undefined);
});

test('Pi two-step sequential chain requires only one concurrent slot', (t) => {
  const s = pi();
  const result = s.call('chain-1', { chain: [{ agent: 'scout', task: 'inspect' }, { agent: 'scout', task: 'summarize {previous}' }] });
  t.diagnostic(JSON.stringify({ sequentialChain: result?.block ? 'deny' : 'allow', result }));
  assert.equal(result, undefined);
  s.result('chain-1', {}, { details: { mode: 'chain', results: [] } });
  assert.equal(s.active(), 0);
  assert.equal(s.call('parallel-1', { tasks: [{ agent: 'scout', task: 'A' }, { agent: 'scout', task: 'B' }] }).block, true);
});

for (const order of [
  ['start', 'after', 'stop'], ['start', 'stop', 'after'],
  ['after', 'start', 'stop'], ['after', 'stop', 'start'],
  ['stop', 'start', 'after'], ['stop', 'after', 'start']
]) {
  test(`OpenCode background lifecycle releases once in order ${order.join('/')}`, async () => {
    const s = await opencode();
    const args = { ...taskArgs, background: true };
    await s.before('task-1', args);
    const actions = {
      start: () => s.event('session.created', { info: s.sessions.child }),
      after: () => s.after('task-1', args, { sessionId: 'child', background: true }),
      stop: () => s.event('session.idle', { sessionID: 'child' })
    };
    // The host may deliver idle before session.created; resolve its parent via
    // the SDK rather than relying on a previously delivered creation event.
    for (const step of order) await actions[step]();
    assert.equal(s.active(), 0);
    await s.before('task-2', taskArgs);
    for (const step of order) await actions[step]();
    assert.equal(s.active(), 1);
  });
}

test('OpenCode unknown result does not release a request marked foreground', async () => {
  const s = await opencode();
  const args = { ...taskArgs, background: false };
  await s.before('task-1', args);
  await s.after('task-1', args, {});
  assert.equal(s.active(), 1);
  await assert.rejects(s.before('task-2', taskArgs), /AGENT_BUDGET_EXHAUSTED/);
});

test('OpenCode finite limit prevents task_id from bypassing new delegation accounting', async () => {
  const s = await opencode();
  await assert.rejects(s.before('resume-1', { ...taskArgs, task_id: 'child' }), /DELEGATION_LIFECYCLE_UNPROVEN/);
  assert.equal(s.active(), 0);
  await s.before('task-1', taskArgs);
});

test('Claude a completed result overrides the original background request', () => {
  const s = claude();
  const tool_input = { prompt: 'inspect', run_in_background: true };
  s.tool('PreToolUse', 'call-A', { tool_input });
  s.tool('PostToolUse', 'call-A', { tool_input, tool_response: { status: 'completed', agentId: 'A' } });
  assert.equal(s.active(), 0);
  assert.equal(s.tool('PreToolUse', 'call-B'), null);
});

test('Claude unknown completion retains a foreground reservation', () => {
  const s = claude();
  const tool_input = { prompt: 'inspect', run_in_background: false };
  s.tool('PreToolUse', 'call-A', { tool_input });
  s.tool('PostToolUse', 'call-A', { tool_input });
  assert.equal(s.active(), 1);
});

test('Pi failed joined child releases its slot and repeated results cannot release the next call', () => {
  const s = pi();
  const input = { agent: 'scout', task: 'inspect' };
  s.call('task-1', input);
  s.result('task-1', input, { isError: true });
  assert.equal(s.active(), 0);
  s.call('task-2', input);
  s.result('task-1', input, { isError: true });
  assert.equal(s.active(), 1);
});

test('Pi custom asynchronous results and unknown results keep their slots', () => {
  for (const details of [{ mode: 'single', results: [], background: true }, { jobId: 'custom-job' }]) {
    const s = pi();
    const input = { agent: 'scout', task: 'inspect' };
    s.call('task-1', input);
    s.result('task-1', input, { details });
    assert.equal(s.active(), 1);
    assert.equal(s.call('task-2', input).block, true);
  }
});

test('switching from watch to guard counts delegations that watch allowed to proceed', () => {
  const s = claude();
  s.hook('UserPromptSubmit', { prompt: '$stop-that-shit change watch agents=1 -- inspect' });
  s.tool('PreToolUse', 'call-A');
  const observed = s.tool('PreToolUse', 'call-B');
  assert.equal(observed?.hookSpecificOutput?.permissionDecision, undefined);
  assert.equal(s.active(), 2);
  s.hook('UserPromptSubmit', { prompt: '$stop-that-shit change guard agents=1 -- inspect' });
  assert.equal(s.tool('PreToolUse', 'call-C')?.hookSpecificOutput?.permissionDecision, 'deny');
  for (const agentId of ['A', 'B']) {
    s.tool('PostToolUse', `call-${agentId}`, { tool_response: { status: 'completed', agentId } });
  }
  assert.equal(s.active(), 0);
  assert.equal(s.tool('PreToolUse', 'call-D'), null);
});

test('valid schema-4 agents=0 state is read without a migration write', () => {
  const state = require(path.join(root, 'src/state.cjs'));
  const dir = dataDir();
  const current = state.freshState();
  current.contract.agentBudget = 0;
  state.writeState('zero', current, dir);
  const file = state.statePath('zero', dir);
  const oldTime = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(file, oldTime, oldTime);
  assert.equal(state.readState('zero', dir).contract.agentBudget, 0);
  assert.equal(fs.statSync(file).mtimeMs, oldTime.getTime());
});

test('prompt updates share the delegation lock and preserve a concurrent reservation', async () => {
  const { spawn } = require('node:child_process');
  const state = require(path.join(root, 'src/state.cjs'));
  const { reserveDelegation } = require(path.join(root, 'src/delegation-state.cjs'));
  const dir = dataDir();
  const session = 'prompt-lock';
  const release = state.acquireSessionLock(session, dir);
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const open = fs.openSync;
    let reported = false;
    fs.openSync = function (...args) {
      try { return open.apply(this, args); }
      catch (error) {
        if (!reported && error.code === 'EEXIST' && String(args[0]).endsWith('.lock')) {
          reported = true;
          process.stdout.write('waiting\\n');
        }
        throw error;
      }
    };
    const { handleControlEvent } = require('./src/controller.cjs');
    handleControlEvent({ protocolVersion: 2, lifecycleVersion: 2, kind: 'prompt.submit', sessionId: process.argv[1],
      prompt: '$stop-that-shit change agents=1 -- inspect' }, { dataDir: process.argv[2] });
    process.stdout.write('done\\n');
  `, session, dir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  try {
    const firstOutput = await new Promise((resolve, reject) => {
      child.stdout.once('data', (data) => resolve(String(data)));
      child.once('error', reject);
      child.once('close', () => resolve('closed'));
    });
    assert.match(firstOutput, /waiting/);
    const current = state.freshState();
    current.delegation = reserveDelegation(current.delegation, 'reservation:call-1', 'call-1', 1);
    state.writeState(session, current, dir);
    release();
    assert.equal(await completion, 0);
    assert.equal(activeDelegationCount(state.readState(session, dir).delegation), 1);
    assert.equal(state.readState(session, dir).contract.agentBudget, 1);
  } finally {
    release();
    child.kill();
  }
});


for (const setting of ['watch agents=1', 'off agents=1', `guard agents=${Number.MAX_SAFE_INTEGER}`]) {
  test(`unversioned resume under ${setting} prevents later finite delegation`, () => {
    const s = claude();
    s.tool('PreToolUse', 'A');
    s.tool('PostToolUse', 'A', { tool_response: { status: 'completed', agentId: 'A' } });
    s.hook('UserPromptSubmit', { prompt: `$stop-that-shit change ${setting} -- inspect` });
    const wake = s.hook('PreToolUse', { tool_name: 'SendMessage', tool_use_id: 'wake-A', tool_input: { to: 'A', message: 'Continue' } });
    assert.notEqual(wake?.hookSpecificOutput?.permissionDecision, 'deny');
    s.hook('SubagentStart', { agent_id: 'A', agent_type: 'general-purpose' });
    s.hook('UserPromptSubmit', { prompt: '$stop-that-shit change guard agents=1 -- inspect' });
    assert.match(s.tool('PreToolUse', 'B')?.hookSpecificOutput?.permissionDecisionReason || '', /DELEGATION_STATE_UNPROVEN/);
    // An unversioned stop can belong to the previous run, so it cannot restore certainty.
    s.hook('SubagentStop', { agent_id: 'A', agent_type: 'general-purpose', stop_hook_active: false });
    assert.match(s.tool('PreToolUse', 'C')?.hookSpecificOutput?.permissionDecisionReason || '', /DELEGATION_STATE_UNPROVEN/);
  });
}

test('reading a legacy snapshot cannot overwrite a concurrently committed reservation', () => {
  const state = require('../src/state.cjs');
  const { handleControlEvent } = require('../src/controller.cjs');
  const dir = dataDir(), sessionId = 'migration-race';
  const initial = state.freshState();
  initial.schemaVersion = 2;
  Object.assign(initial.contract, { mode: 'change', level: 'off', agentBudget: 1 });
  state.writeState(sessionId, initial, dir);
  const file = state.statePath(sessionId, dir);
  const launch = id => handleControlEvent({ protocolVersion: 2, lifecycleVersion: 2, sessionId, kind: 'action.before', action: { id, name: 'Agent', mutability: 'delegate' } }, { dataDir: dir });
  const originalRead = fs.readFileSync;
  let first;
  fs.readFileSync = function(p, ...args) {
    const snapshot = originalRead.call(this, p, ...args);
    if (String(p) === file) {
      fs.readFileSync = originalRead;
      first = launch('A');
    }
    return snapshot;
  };
  try { state.readState(sessionId, dir); }
  finally { fs.readFileSync = originalRead; }
  assert.equal(first.kind, 'none');
  assert.equal(activeDelegationCount(state.readState(sessionId, dir).delegation), 1);
  handleControlEvent({ protocolVersion: 2, lifecycleVersion: 2, sessionId, kind: 'prompt.submit', prompt: '$stop-that-shit change guard agents=1 -- continue' }, { dataDir: dir });
  assert.equal(launch('B').kind, 'deny');
});

for (const setting of ['watch agents=1', 'off agents=1', `guard agents=${Number.MAX_SAFE_INTEGER}`]) {
  test(`OpenCode continuation under ${setting} prevents later finite delegation`, async () => {
    const s = await opencode();
    s.prompt(`$stop-that-shit change ${setting} -- inspect`);
    await s.before('resume-1', { ...taskArgs, task_id: 'child' });
    s.prompt('$stop-that-shit change guard agents=1 -- inspect');
    await assert.rejects(s.before('task-1', taskArgs), /DELEGATION_STATE_UNPROVEN/);
    await s.event('session.idle', { sessionID: 'child' });
    await assert.rejects(s.before('task-2', taskArgs), /DELEGATION_STATE_UNPROVEN/);
  });
}

test('uncertain accounting preserves reads and unlimited delegation; fresh sessions can enforce limits', () => {
  const s = claude();
  s.hook('UserPromptSubmit', { prompt: '$stop-that-shit change off agents=1 -- inspect' });
  s.hook('PreToolUse', { tool_name: 'SendMessage', tool_use_id: 'wake-A', tool_input: { to: 'A', message: 'Continue' } });
  s.hook('UserPromptSubmit', { prompt: '$stop-that-shit change guard agents=1 -- inspect' });
  assert.equal(s.hook('PreToolUse', { tool_name: 'Read', tool_use_id: 'read-1', tool_input: { file_path: 'README.md' } }), null);
  s.hook('UserPromptSubmit', { prompt: `$stop-that-shit change guard agents=${Number.MAX_SAFE_INTEGER} -- inspect` });
  assert.equal(s.tool('PreToolUse', 'unlimited-1'), null);
  const fresh = claude();
  assert.equal(fresh.tool('PreToolUse', 'fresh-1'), null);
  assert.equal(fresh.tool('PreToolUse', 'fresh-2')?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('Claude stop attempts cannot reclaim a running agent when another hook may continue it', () => {
  const s = claude();
  s.tool('PreToolUse', 'running-A');
  s.tool('PostToolUse', 'running-A', { tool_response: { status: 'async_launched', agentId: 'A' } });
  for (const stop_hook_active of [false, true]) {
    s.hook('SubagentStop', { agent_id: 'A', agent_type: 'general-purpose', stop_hook_active, last_assistant_message: 'Review complete' });
    assert.equal(s.active(), 1);
    assert.equal(s.tool('PreToolUse', 'blocked-B').hookSpecificOutput.permissionDecision, 'deny');
  }
});
