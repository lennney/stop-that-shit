const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleControlEvent } = require('../src/controller.cjs');

for (const level of ['guard', 'watch', 'off']) {
  test(`invalid directive residue respects ${level} during later delegation`, t => {
    const { handleClaudeHook } = require('../src/adapters/claude-hooks.cjs');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-directive-level-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const hook = (hook_event_name, fields = {}) => handleClaudeHook({ session_id: level, hook_event_name, ...fields }, { dataDir });
    hook('UserPromptSubmit', { prompt: `$stop-that-shit change ${level} agents=2 -- inspect` });
    hook('UserPromptSubmit', { prompt: '$stop-that-shit agents=-1' });
    hook('UserPromptSubmit', { prompt: 'Continue reading source' });
    const launch = id => hook('PreToolUse', { tool_name: 'Agent', tool_use_id: id,
      tool_input: { description: 'Inspect', prompt: 'Read the controller', subagent_type: 'general-purpose' } });
    const result = launch('A');
    assert.equal(result?.hookSpecificOutput?.permissionDecision === 'deny', level === 'guard');
    if (level === 'watch') assert.match(result.hookSpecificOutput.additionalContext, /INVALID_DIRECTIVE/);
    if (level === 'off') assert.equal(result, null);
    // A corrected finite guard keeps work that watch/off actually permitted.
    hook('UserPromptSubmit', { prompt: '$stop-that-shit change guard agents=1 -- inspect' });
    assert.equal(launch('B')?.hookSpecificOutput?.permissionDecision === 'deny', level !== 'guard');
    const activeCall = level === 'guard' ? 'B' : 'A';
    hook('PostToolUse', { tool_name: 'Agent', tool_use_id: activeCall,
      tool_response: { status: 'completed', agentId: 'finished-child' } });
    assert.equal(launch('C'), null);
  });
}

function session(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-facts-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const send = (kind, fields = {}) => handleControlEvent({ protocolVersion: 2, lifecycleVersion: 2, sessionId: 'parent', kind, ...fields }, { dataDir });
  return { send, prompt: text => send('prompt.submit', { prompt: `$stop-that-shit change ${text} -- inspect` }),
    before: (id, extra = {}) => send('action.before', { action: { id, name: 'Agent', mutability: 'delegate', ...extra } }),
    after: (id, lifecycle, extra = {}) => send('action.after', { action: { id, lifecycle, ...extra } }) };
}
test('unbounded calls keep separate uncertainty until each whole call joins', t => {
  const s = session(t);
  s.prompt('watch agents=2');
  s.before('workflow-A', { name: 'Workflow', unboundedDelegation: true });
  s.before('workflow-B', { name: 'Workflow', unboundedDelegation: true });
  s.prompt('guard agents=2');
  assert.equal(s.before('new-1').decision.reasonCode, 'DELEGATION_STATE_UNPROVEN');
  s.after('workflow-A', 'joined');
  assert.equal(s.before('new-2').decision.reasonCode, 'DELEGATION_STATE_UNPROVEN');
  s.after('workflow-B', 'joined');
  assert.equal(s.before('new-3').kind, 'none');
  s.after('workflow-A', 'joined');
  s.before('workflow-A', { name: 'Workflow', unboundedDelegation: true });
  assert.equal(s.before('new-4').kind, 'none');
  assert.equal(s.before('new-5').decision.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
});

test('Claude auto denial restores capacity while a failed running tool keeps it reserved', t => {
  const { handleClaudeHook } = require('../src/adapters/claude-hooks.cjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-denial-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const hook = (hook_event_name, id, fields = {}) => handleClaudeHook({ session_id: 'claude', hook_event_name,
    tool_name: 'Agent', tool_use_id: id, tool_input: { prompt: 'inspect', subagent_type: 'general-purpose' }, ...fields }, { dataDir });
  hook('UserPromptSubmit', null, { prompt: '$stop-that-shit change agents=1 -- inspect' });
  assert.equal(hook('PreToolUse', 'A'), null);
  hook('PermissionDenied', 'A', { permission_mode: 'auto', reason: 'Classifier unavailable' });
  assert.equal(hook('PreToolUse', 'B'), null);
  hook('PermissionDenied', 'A', { permission_mode: 'auto', reason: 'Classifier unavailable' });
  hook('PostToolUseFailure', 'B', { error: 'Tool failed', is_interrupt: false });
  assert.equal(hook('PreToolUse', 'C').hookSpecificOutput.permissionDecision, 'deny');
  hook('PostToolUse', 'B', { tool_response: { status: 'completed', agentId: 'child-B' } });
  assert.equal(hook('PreToolUse', 'D'), null);
});
test('Hermes dispatch aliases correlate late start and only confirmed stop releases capacity', t => {
  const { handleHermesHook } = require('../src/adapters/hermes-hooks.cjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-hermes-facts-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const hook = (hook_event_name, fields = {}) => handleHermesHook({ session_id: 'hermes', hook_event_name, ...fields }, { dataDir });
  hook('pre_llm_call', { extra: { user_message: '$stop-that-shit change agents=1 -- inspect' } });
  const call = { tool_name: 'delegate_task', tool_call_id: 'A', tool_input: { goal: 'inspect' } };
  assert.equal(hook('pre_tool_call', call), null);
  hook('post_tool_call', { ...call, extra: { result: JSON.stringify({ status: 'dispatched', mode: 'background', subagent_ids: ['short-A'] }) } });
  hook('subagent_start', { extra: { child_session_id: 'long-A', child_subagent_id: 'short-A' } });
  hook('subagent_stop', { extra: { child_session_id: 'long-A', child_status: 'timeout' } });
  assert.equal(hook('pre_tool_call', { ...call, tool_call_id: 'B' }).action, 'block');
  hook('subagent_stop', { extra: { child_session_id: 'long-A', child_status: 'completed' } });
  assert.equal(hook('pre_tool_call', { ...call, tool_call_id: 'C' }), null);
});

test('call-scoped capacity survives individual step stops and ordinary session end', t => {
  const s = session(t);
  s.prompt('guard agents=1');
  s.before('chain', { completionScope: 'call' });
  s.send('subagent.start', { agentId: 'step-1', reservationId: 'reservation:chain' });
  s.send('subagent.stop', { agentId: 'step-1' });
  s.send('session.end');
  assert.equal(s.before('B').decision.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
  s.after('chain', 'joined');
  assert.equal(s.before('C').kind, 'none');
});
test('legacy completion flags cannot mutate the ledger; declared facts can', t => {
  const s = session(t);
  s.prompt('guard agents=1');
  s.before('A', { asyncLaunched: false });
  s.send('action.after', { protocolVersion: 1, action: { id: 'A', asyncLaunched: false } });
  assert.equal(s.before('B').decision.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
  s.send('action.after', { protocolVersion: 1, action: { id: 'A', completed: true } });
  assert.equal(s.before('legacy-completed').decision.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
  s.after('A', 'joined');
  assert.equal(s.before('C').kind, 'none');
});
test('child sessions with equal call IDs do not share reservations', t => {
  const s = session(t);
  s.prompt('guard agents=2');
  for (const sourceSessionId of ['child-A', 'child-B']) {
    assert.equal(s.send('action.before', { sourceSessionId, action: { id: 'same', name: 'task', mutability: 'delegate' } }).kind, 'none');
  }
  s.send('action.after', { sourceSessionId: 'child-A', action: { id: 'same', lifecycle: 'joined' } });
  s.send('action.after', { sourceSessionId: 'child-A', action: { id: 'same', lifecycle: 'joined' } });
  assert.equal(s.before('C').kind, 'none');
  assert.equal(s.before('D').decision.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
});

test('finite limits detect legacy launch, control and unknown adapters without blocking ordinary reads', t => {
  const s = session(t);
  s.prompt('guard agents=1');
  for (const mutability of ['delegate', 'control', 'unknown']) {
    const result = s.send('action.before', { protocolVersion: 1,
      action: { id: `legacy-${mutability}`, name: 'old-tool', mutability } });
    assert.equal(result.decision?.reasonCode, 'LIFECYCLE_PROTOCOL_REQUIRED');
  }
  assert.equal(s.send('action.before', { protocolVersion: 1, action: { name: 'Read', mutability: 'read' } }).kind, 'none');
  assert.equal(s.send('action.before', { protocolVersion: 1, action: { name: 'Write', mutability: 'write' } }).kind, 'none');
  assert.equal(s.before('current').kind, 'none');
  s.after('current', 'running', { agentId: 'child' });
  s.send('subagent.stop', { protocolVersion: 1, agentId: 'child' });
  assert.equal(s.before('after-legacy-stop').decision?.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
});

test('legacy controls allowed while off leave uncertainty when a finite guard is enabled', t => {
  const s = session(t);
  s.prompt('off');
  assert.equal(s.send('action.before', { protocolVersion: 1, action: { name: 'SendMessage', mutability: 'control' } }).kind, 'none');
  s.prompt('guard agents=1');
  assert.equal(s.before('new').decision?.reasonCode, 'DELEGATION_STATE_UNPROVEN');
});

test('every existing pre-v4 ledger has unverified history, while a new session starts clean', t => {
  const { readState, statePath } = require('../src/state.cjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-legacy-facts-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  for (const [sessionId, legacy] of Object.entries({
    'empty-v3': { schemaVersion: 3, delegation: { reservations: {}, acceptedActions: {} } },
    'old-total': { schemaVersion: 2, delegation: { totalAgentsUsed: 2 } },
    'unversioned-state': {}
  })) {
    const file = statePath(sessionId, dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...legacy, contract: { mode: 'change', level: 'guard', agentBudget: 0 } }));
    const before = fs.readFileSync(file, 'utf8');
    const state = readState(sessionId, dataDir);
    assert.equal(state.contract.agentBudget, 0);
    assert.equal(state.delegation.unresolved['legacy:history'], 'legacy_history_unverified');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  assert.deepEqual(readState('brand-new', dataDir).delegation.unresolved, {});
});
