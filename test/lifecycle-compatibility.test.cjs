'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const current = require('../src/adapters/claude-hooks.cjs');
const { handleControlEvent } = require('../src/controller.cjs');

// Load the unchanged historical adapter with the installed current dependencies.
// A made-up protocolVersion: 1 event would miss the runtime-import regression.
const adapterPath = require.resolve('../src/adapters/claude-hooks.cjs');
const oldModule = new Module(adapterPath, module);
oldModule.filename = adapterPath;
oldModule.paths = Module._nodeModulePaths(path.dirname(adapterPath));
oldModule._compile(fs.readFileSync(path.join(__dirname, 'fixtures/claude-hooks-before-facts.cjs'), 'utf8'), adapterPath);
const legacy = oldModule.exports;

function session(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-mixed-lifecycle-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const hook = (adapter, hook_event_name, fields = {}) => adapter.handleClaudeHook({ session_id: 'parent', hook_event_name, ...fields }, { dataDir });
  const prompt = text => hook(current, 'UserPromptSubmit', { prompt: `$stop-that-shit change ${text} -- inspect` });
  const launch = (adapter, id) => hook(adapter, 'PreToolUse', { tool_name: 'Agent', tool_use_id: id,
    tool_input: { description: 'Inspect', prompt: 'Read the controller', subagent_type: 'general-purpose' } });
  const send = (kind, fields = {}) => handleControlEvent({ protocolVersion: 2, sessionId: 'parent', kind, ...fields }, { dataDir });
  prompt('guard agents=1');
  return { hook, prompt, launch, send };
}

test('a historical adapter cannot borrow the current runtime protocol to launch under a finite limit', t => {
  const s = session(t);
  const denied = s.launch(legacy, 'old-A');
  assert.match(denied?.hookSpecificOutput?.permissionDecisionReason || '', /LIFECYCLE_PROTOCOL_REQUIRED/);
  assert.equal(s.hook(legacy, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'README.md' } }), null);
  assert.equal(s.launch(current, 'current-A'), null);
});

test('a historical stop attempt cannot release work accepted by the current adapter', t => {
  const s = session(t);
  s.launch(current, 'A');
  s.hook(current, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'A', tool_response: { status: 'async_launched', agentId: 'child-A' } });
  s.hook(legacy, 'SubagentStop', { agent_id: 'child-A', agent_type: 'general-purpose', stop_hook_active: false });
  assert.equal(s.launch(current, 'B')?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('legacy activity permitted in watch remains unresolved after legacy completion and a guard switch', t => {
  const s = session(t);
  s.prompt('watch agents=1');
  assert.notEqual(s.launch(legacy, 'A')?.hookSpecificOutput?.permissionDecision, 'deny');
  s.hook(legacy, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'A', tool_response: { status: 'completed', agentId: 'child-A' } });
  s.prompt('guard agents=1');
  assert.match(s.launch(current, 'B')?.hookSpecificOutput?.permissionDecisionReason || '', /DELEGATION_STATE_UNPROVEN/);
  s.send('action.after', { lifecycleVersion: 2, action: { id: 'A', lifecycle: 'joined' } });
  assert.equal(s.launch(current, 'C'), null);
});

test('missing or unsupported lifecycle declarations deny admission without throwing or releasing', t => {
  for (const lifecycleVersion of [undefined, null, 1, 3, '2']) {
    const s = session(t);
    const old = s.send('action.before', { lifecycleVersion, action: { id: 'old-A', name: 'Agent', mutability: 'delegate' } });
    assert.equal(old.decision?.reasonCode, 'LIFECYCLE_PROTOCOL_REQUIRED');
    assert.equal(s.launch(current, 'A'), null);
    s.hook(current, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'A', tool_response: { status: 'async_launched', agentId: 'child-A' } });
    s.send('action.after', { lifecycleVersion, action: { id: 'A', lifecycle: 'joined', completed: true, endedAgentIds: ['child-A'] } });
    s.send('subagent.stop', { lifecycleVersion, agentId: 'child-A' });
    s.send('session.end', { lifecycleVersion, allDelegationsStopped: true });
    assert.equal(s.launch(current, 'B')?.hookSpecificOutput?.permissionDecision, 'deny');
  }
});
