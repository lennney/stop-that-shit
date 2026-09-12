'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { fromControlResult, handleClaudeHook, toControlEvent } = require('../src/adapters/claude-hooks.cjs');
const { classifyClaudeTool, extractAffectedPaths, normalizePath } = require('../src/adapters/claude-tool-classifier.cjs');
const { readState } = require('../src/state.cjs');

const root = path.join(__dirname, '..');

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-claude-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir };
}

function prompt(session, text, cwd = root) {
  return { session_id: session, hook_event_name: 'UserPromptSubmit', prompt: text, cwd, permission_mode: 'default' };
}

function expansion(session, args, commandName = 'stop-that-shit:stop-that-shit') {
  return {
    session_id: session,
    hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command',
    command_name: commandName,
    command_args: args,
    cwd: root
  };
}

function pre(session, toolName, toolInput, cwd = root, toolUseId = `${toolName}-1`) {
  return {
    session_id: session,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: toolUseId,
    tool_input: toolInput,
    cwd,
    permission_mode: 'default'
  };
}

test('Claude Adapter maps official Hook fields to ControlEvent v2', () => {
  const event = toControlEvent(pre('map-session', 'NotebookEdit', {
    notebook_path: path.join(root, 'notebooks', 'demo.ipynb'),
    new_source: 'print(1)'
  }));
  assert.equal(event.kind, 'action.before');
  assert.equal(event.host.family, 'claude-code');
  assert.equal(event.host.permissionMode, 'default');
  assert.equal(event.action.mutability, 'write');
  assert.deepEqual(event.action.affectedPaths, ['notebooks/demo.ipynb']);
  assert.equal(event.action.cwd, root);
});

test('Claude Adapter maps lifecycle Hook fields to ControlEvent v2', () => {
  const after = toControlEvent({
    session_id: 'lifecycle-session',
    hook_event_name: 'PostToolUse',
    tool_use_id: 'call-1',
    tool_name: 'Agent',
    tool_input: { prompt: 'inspect', run_in_background: false },
    tool_response: { status: 'completed', agentId: 'agent-1' }
  });
  assert.equal(after.kind, 'action.after');
  assert.deepEqual(after.action, { id: 'call-1', agentId: 'agent-1', lifecycle: 'joined' });

  const start = toControlEvent({
    session_id: 'lifecycle-session',
    hook_event_name: 'SubagentStart',
    agent_id: 'agent-1',
  });
  assert.equal(start.kind, 'subagent.start');
  assert.equal(start.agentId, 'agent-1');
  assert.equal(start.reservationId, undefined);

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

test('Claude prompt hooks reject split directives and accept formal agents syntax', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('invalid-directive', '$stop-that-shit change total-agents=4 -- bounded delegation'), options);
  const output = handleClaudeHook(prompt('invalid-directive', '$stop-that-shit change agents=1 -- set concurrency'), options);
  assert.match(output.hookSpecificOutput.additionalContext, /agents=0\/1/);

  const expansionOutput = handleClaudeHook(expansion('invalid-expansion', 'agents=1'), options);
  assert.ok(expansionOutput);
  assert.equal(readState('invalid-expansion', options.dataDir).contract.agentBudget, 1);

  assert.deepEqual(fromControlResult('UserPromptExpansion', {
    kind: 'prompt-error',
    message: 'invalid prompt'
  }), { decision: 'block', reason: 'invalid prompt' });
});

test('Claude foreground completion releases while stop attempts preserve background state', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('lifecycle', '$stop-that-shit change agents=4 -- delegate'), options);
  handleClaudeHook(pre('lifecycle', 'Agent', { prompt: 'inspect', run_in_background: true }, root, 'call-1'), options);

  handleClaudeHook({
    session_id: 'lifecycle',
    hook_event_name: 'SubagentStart',
    agent_id: 'agent-1',
    cwd: root
  }, options);
  handleClaudeHook({
    session_id: 'lifecycle',
    hook_event_name: 'PostToolUse',
    tool_use_id: 'call-1',
    tool_name: 'Agent',
    tool_input: { prompt: 'inspect', run_in_background: true },
    tool_response: { status: 'async_launched', agentId: 'agent-1' },
    cwd: root
  }, options);
  assert.deepEqual(readState('lifecycle', options.dataDir).delegation.reservations['reservation:call-1'].agentIds, ['agent-1']);

  const stopped = handleClaudeHook({
    session_id: 'lifecycle',
    hook_event_name: 'SubagentStop',
    agent_id: 'agent-1',
    cwd: root
  }, options);
  assert.equal(stopped, null);
  assert.deepEqual(Object.keys(readState('lifecycle', options.dataDir).delegation.reservations), ['reservation:call-1']);

  handleClaudeHook(pre('lifecycle', 'Agent', { prompt: 'inspect again', run_in_background: false }, root, 'call-2'), options);
  const completed = handleClaudeHook({
    session_id: 'lifecycle',
    hook_event_name: 'PostToolUse',
    tool_use_id: 'call-2',
    tool_name: 'Agent',
    tool_input: { prompt: 'inspect again', run_in_background: false },
    tool_response: { status: 'completed', agentId: 'agent-2' },
    cwd: root
  }, options);
  assert.equal(completed, null);
  assert.deepEqual(Object.keys(readState('lifecycle', options.dataDir).delegation.reservations), ['reservation:call-1']);

  handleClaudeHook(pre('lifecycle', 'Agent', { prompt: 'inspect final', run_in_background: false }, root, 'call-3'), options);
  const ended = handleClaudeHook({
    session_id: 'lifecycle',
    hook_event_name: 'SessionEnd',
    reason: 'other',
    cwd: root
  }, options);
  assert.equal(ended, null);
  assert.equal(readState('lifecycle', options.dataDir).delegation.reservations['reservation:call-3'].pendingCount, 1);
});

test('Claude keeps a reservation when a foreground Agent moves to the background', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('foreground-background', '$stop-that-shit change agents=1 -- delegate'), options);
  handleClaudeHook(pre('foreground-background', 'Agent', {
    prompt: 'inspect',
    run_in_background: false
  }, root, 'call-foreground'), options);

  handleClaudeHook({
    session_id: 'foreground-background',
    hook_event_name: 'PostToolUse',
    tool_use_id: 'call-foreground',
    tool_name: 'Agent',
    tool_input: { prompt: 'inspect', run_in_background: false },
    tool_response: { status: 'async_launched', agentId: 'agent-background' },
    cwd: root
  }, options);

  const retained = readState('foreground-background', options.dataDir);
  assert.equal(retained.delegation.reservations['reservation:call-foreground'].observedRunning, true);
  assert.deepEqual(retained.delegation.reservations['reservation:call-foreground'].agentIds, ['agent-background']);
  const denied = handleClaudeHook(pre('foreground-background', 'Agent', {
    prompt: 'second',
    run_in_background: true
  }, root, 'call-second'), options);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /S\/AGENT_BUDGET_EXHAUSTED/);

  handleClaudeHook({
    session_id: 'foreground-background',
    hook_event_name: 'SubagentStop',
    agent_id: 'agent-background',
    cwd: root
  }, options);
  assert.deepEqual(readState('foreground-background', options.dataDir).delegation.reservations['reservation:call-foreground'].agentIds, ['agent-background']);
});

test('Claude background stop notification does not establish final completion', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('background-complete', '$stop-that-shit change agents=1 -- delegate'), options);
  handleClaudeHook(pre('background-complete', 'Agent', {
    prompt: 'inspect',
    run_in_background: true
  }, root, 'call-background'), options);

  handleClaudeHook({
    session_id: 'background-complete',
    hook_event_name: 'SubagentStart',
    agent_id: 'agent-background',
    agent_type: 'Explore',
    cwd: root
  }, options);
  handleClaudeHook({
    session_id: 'background-complete',
    hook_event_name: 'PostToolUse',
    tool_use_id: 'call-background',
    tool_name: 'Agent',
    tool_input: { prompt: 'inspect', run_in_background: true },
    tool_response: { status: 'async_launched', agentId: 'agent-background' },
    cwd: root
  }, options);
  assert.deepEqual(readState('background-complete', options.dataDir).delegation.reservations['reservation:call-background'].agentIds, ['agent-background']);

  handleClaudeHook({
    session_id: 'background-complete',
    hook_event_name: 'SubagentStop',
    agent_id: 'agent-background',
    agent_type: 'Explore',
    cwd: root
  }, options);
  assert.deepEqual(readState('background-complete', options.dataDir).delegation.reservations['reservation:call-background'].agentIds, ['agent-background']);

  const next = handleClaudeHook(pre('background-complete', 'Agent', {
    prompt: 'inspect again',
    run_in_background: false
  }, root, 'call-next'), options);
  assert.equal(next.hookSpecificOutput.permissionDecision, 'deny');
});

test('Claude foreground Agent completion releases its slot for the next call', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('foreground-complete', '$stop-that-shit change agents=1 -- delegate'), options);
  handleClaudeHook(pre('foreground-complete', 'Agent', {
    prompt: 'inspect',
    run_in_background: false
  }, root, 'call-foreground'), options);
  handleClaudeHook({
    session_id: 'foreground-complete',
    hook_event_name: 'PostToolUse',
    tool_use_id: 'call-foreground',
    tool_name: 'Agent',
    tool_input: { prompt: 'inspect', run_in_background: false },
    tool_response: { status: 'completed', agentId: 'agent-foreground' },
    cwd: root
  }, options);

  assert.deepEqual(readState('foreground-complete', options.dataDir).delegation.reservations, {});
  const next = handleClaudeHook(pre('foreground-complete', 'Agent', {
    prompt: 'inspect again',
    run_in_background: false
  }, root, 'call-next'), options);
  assert.equal(next, null);
});

test('Claude ignores PostToolUse events without a valid action identifier', () => {
  for (const identifier of [undefined, null, '', '   ', 42]) {
    const input = {
      session_id: 'malformed-after',
      hook_event_name: 'PostToolUse',
      tool_use_id: identifier
    };
    assert.equal(toControlEvent(input), null);
    assert.equal(handleClaudeHook(input), null);
  }

  const fallback = toControlEvent({
    session_id: 'fallback-after',
    hook_event_name: 'PostToolUse',
    tool_use_id: 42,
    tool_call_id: 'fallback-call'
  });
  assert.equal(fallback.action.id, 'fallback-call');
});

test('review contract blocks Claude Write', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('claude-review', '$stop-that-shit review -- inspect only'), options);
  const output = handleClaudeHook(pre('claude-review', 'Write', { file_path: path.join(root, 'tmp.txt'), content: 'x' }), options);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /I\/MODE_FORBIDS_MUTATION/);
});

test('direct plugin slash invocation arms the same review contract before expansion', (t) => {
  const options = workspace(t);
  const context = handleClaudeHook(expansion('slash-review', 'review -- inspect only'), options);
  assert.match(context.hookSpecificOutput.additionalContext, /mode=review/);
  assert.equal(readState('slash-review', options.dataDir).contract.mode, 'review');
  const denied = handleClaudeHook(pre('slash-review', 'Edit', {
    file_path: path.join(root, 'src', 'state.cjs'), old_string: 'a', new_string: 'b'
  }), options);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
});

test('unrelated slash expansion is ignored', (t) => {
  const options = workspace(t);
  assert.equal(handleClaudeHook(expansion('slash-other', 'review', 'other-plugin:review'), options), null);
  assert.equal(readState('slash-other', options.dataDir).contract.mode, 'unconfirmed');
});

test('slash invocation through UserPromptSubmit arms hosts without UserPromptExpansion', (t) => {
  const options = workspace(t);
  const context = handleClaudeHook(prompt('slash-submit', '/stop-that-shit:stop-that-shit review -- inspect only'), options);
  assert.match(context.hookSpecificOutput.additionalContext, /mode=review/);
  assert.equal(readState('slash-submit', options.dataDir).contract.mode, 'review');
  const denied = handleClaudeHook(pre('slash-submit', 'Edit', {
    file_path: path.join(root, 'src', 'state.cjs'), old_string: 'a', new_string: 'b'
  }), options);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');

  const bare = handleClaudeHook(prompt('slash-bare', '/stop-that-shit change -- fix it'), options);
  assert.equal(readState('slash-bare', options.dataDir).contract.mode, 'change');
  assert.ok(bare === null || /mode=change/.test(bare.hookSpecificOutput.additionalContext));
});

test('plain prose not starting with the slash form stays on the normal prompt path', (t) => {
  const options = workspace(t);
  const output = handleClaudeHook(prompt('plain', 'review this diff please'), options);
  assert.equal(readState('plain', options.dataDir).contract.mode, 'unconfirmed');
  assert.ok(output === null || !/mode=review/.test(output.hookSpecificOutput.additionalContext));
});

test('Claude absolute paths are normalized and file locks enforce only writes', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('path-lock', '$stop-that-shit lock change files=src/state.cjs -- edit only state'), options);

  assert.equal(handleClaudeHook(pre('path-lock', 'Edit', {
    file_path: path.join(root, 'src', 'state.cjs'), old_string: 'a', new_string: 'b'
  }), options), null);

  const denied = handleClaudeHook(pre('path-lock', 'Write', {
    file_path: path.join(root, 'README.md'), content: 'x'
  }), options);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /S\/PATH_OUTSIDE_CONTRACT/);

  // A read-only MCP-style tool with a path must not be converted into a write-scope decision.
  assert.deepEqual(extractAffectedPaths('mcp__fs__read_file', { path: path.join(root, 'README.md') }, root), []);
});

test('Windows absolute paths normalize relative to a Windows hook cwd', () => {
  assert.equal(normalizePath('C:\\repo\\src\\ok.js', 'C:\\repo'), 'src/ok.js');
  const outside = normalizePath('D:\\other\\no.js', 'C:\\repo');
  assert.ok(outside !== 'src/ok.js');
  assert.ok(outside.includes('D:') || outside.startsWith('../'));
});

test('NotebookEdit participates in review and file-lock enforcement', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('notebook-review', '$stop-that-shit review -- inspect notebook'), options);
  const reviewDenied = handleClaudeHook(pre('notebook-review', 'NotebookEdit', {
    notebook_path: path.join(root, 'demo.ipynb'), new_source: '1 + 1'
  }), options);
  assert.equal(reviewDenied.hookSpecificOutput.permissionDecision, 'deny');

  handleClaudeHook(prompt('notebook-lock', '$stop-that-shit lock change files=allowed.ipynb -- edit one notebook'), options);
  const scopeDenied = handleClaudeHook(pre('notebook-lock', 'NotebookEdit', {
    notebook_path: path.join(root, 'other.ipynb'), new_source: '1 + 1'
  }), options);
  assert.match(scopeDenied.hookSpecificOutput.permissionDecisionReason, /S\/PATH_OUTSIDE_CONTRACT/);
});

test('PowerShell and manifest edits preserve dependency authority', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('deps-ps', '$stop-that-shit change -- change one value'), options);
  const shellDenied = handleClaudeHook(pre('deps-ps', 'PowerShell', { command: 'npm install lodash' }), options);
  assert.match(shellDenied.hookSpecificOutput.permissionDecisionReason, /S\/DEPENDENCY_NOT_AUTHORIZED/);

  handleClaudeHook(prompt('deps-write', '$stop-that-shit change -- update package metadata'), options);
  const fileDenied = handleClaudeHook(pre('deps-write', 'Write', {
    file_path: path.join(root, 'package.json'),
    content: '{"dependencies":{"lodash":"^4.17.21"}}'
  }), options);
  assert.match(fileDenied.hookSpecificOutput.permissionDecisionReason, /S\/DEPENDENCY_NOT_AUTHORIZED/);
});

test('Monitor command sources reuse shell hash/dependency enforcement while WebSocket monitors stay read-only', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('monitor-deps', '$stop-that-shit change -- observe the build'), options);
  const dependencyDenied = handleClaudeHook(pre('monitor-deps', 'Monitor', { command: 'npm install lodash' }), options);
  assert.match(dependencyDenied.hookSpecificOutput.permissionDecisionReason, /S\/DEPENDENCY_NOT_AUTHORIZED/);

  handleClaudeHook(prompt('monitor-hash', '$stop-that-shit change deps=allow -- observe checks'), options);
  const hashDenied = handleClaudeHook(pre('monitor-hash', 'Monitor', { command: 'sha256sum artifact.bin' }), options);
  assert.match(hashDenied.hookSpecificOutput.permissionDecisionReason, /H\/HASH_NOT_AUTHORIZED/);
  assert.equal(classifyClaudeTool('Monitor', { ws: { url: 'wss://example.test/events' } }), 'read');
});

test('Claude Agent uses the shared active agent limit', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('agent-budget', '$stop-that-shit change agents=1 -- use one specialist'), options);
  assert.equal(handleClaudeHook(pre('agent-budget', 'Agent', { prompt: 'inspect tests', async_launched: false }), options), null);
  const denied = handleClaudeHook(pre('agent-budget', 'Agent', { prompt: 'inspect docs', async_launched: false }, root, 'Agent-2'), options);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /S\/AGENT_BUDGET_EXHAUSTED/);
});

test('Claude Workflow cannot bypass configured limits with opaque internal fan-out', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('workflow-budget', '$stop-that-shit change agents=8 -- bounded delegation only'), options);
  const denied = handleClaudeHook(pre('workflow-budget', 'Workflow', { workflow: 'parallel-review' }), options);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /S\/UNBOUNDED_DELEGATION/);
  assert.deepEqual(readState('workflow-budget', options.dataDir).delegation.reservations, {});
});

test('newer Claude built-ins classify without weakening read-only and worktree boundaries', () => {
  assert.equal(classifyClaudeTool('LSP', { operation: 'goToDefinition' }), 'read');
  assert.equal(classifyClaudeTool('ListMcpResourcesTool', {}), 'read');
  assert.equal(classifyClaudeTool('EnterPlanMode', {}), 'control');
  assert.equal(classifyClaudeTool('ReportFindings', {}), 'control');
  assert.equal(classifyClaudeTool('EnterWorktree', {}), 'write');
  assert.equal(classifyClaudeTool('Workflow', {}), 'delegate');
});

test('SessionStart and SubagentStart inject current contract context', (t) => {
  const options = workspace(t);
  const initial = handleClaudeHook({ session_id: 'life', hook_event_name: 'SessionStart', source: 'startup', cwd: root }, options);
  assert.match(initial.hookSpecificOutput.additionalContext, /watch-only mode/);
  handleClaudeHook(prompt('life', '$stop-that-shit review -- inspect only'), options);
  const subagent = handleClaudeHook({ session_id: 'life', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore', cwd: root }, options);
  assert.equal(subagent.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.match(subagent.hookSpecificOutput.additionalContext, /mode=review/);
});

test('Claude hook entrypoint runs from CLAUDE_PLUGIN_ROOT and persists in CLAUDE_PLUGIN_DATA', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-claude-entry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entrypoint = path.join(root, 'hooks', 'stop-that-shit-claude.cjs');
  const first = spawnSync(process.execPath, [entrypoint], {
    cwd: root,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir },
    input: JSON.stringify(expansion('entry-session', 'review -- inspect only')),
    encoding: 'utf8', timeout: 5000
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /mode=review/);

  const second = spawnSync(process.execPath, [entrypoint], {
    cwd: root,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir },
    input: JSON.stringify(pre('entry-session', 'Write', { file_path: path.join(root, 'x.txt'), content: 'x' })),
    encoding: 'utf8', timeout: 5000
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('Claude tool classification covers native read, write, control, delegation, and unknown tools', () => {
  assert.equal(classifyClaudeTool('Read', { file_path: 'x' }), 'read');
  assert.equal(classifyClaudeTool('Write', { file_path: 'x' }), 'write');
  assert.equal(classifyClaudeTool('NotebookEdit', { notebook_path: 'x' }), 'write');
  assert.equal(classifyClaudeTool('Agent', {}), 'delegate');
  assert.equal(classifyClaudeTool('AskUserQuestion', {}), 'control');
  assert.equal(classifyClaudeTool('Bash', { command: 'git diff --stat' }), 'read');
  assert.equal(classifyClaudeTool('PowerShell', { command: 'Get-Content README.md' }), 'read');
  assert.equal(classifyClaudeTool('Bash', { command: 'node scripts/custom.js' }), 'unknown');
});

test('parallel Claude Agent hook processes cannot oversubscribe agents=1', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-claude-parallel-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  handleClaudeHook(prompt('parallel-agent', '$stop-that-shit change agents=1 -- one subagent'), { dataDir });
  const entrypoint = path.join(root, 'hooks', 'stop-that-shit-claude.cjs');
  const payloads = [
    JSON.stringify(pre('parallel-agent', 'Agent', { prompt: 'inspect', async_launched: false }, root, 'Agent-1')),
    JSON.stringify(pre('parallel-agent', 'Agent', { prompt: 'inspect', async_launched: false }, root, 'Agent-2'))
  ];
  const children = payloads.map((payload) => require('node:child_process').spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir },
    stdio: ['pipe', 'pipe', 'pipe']
  }));
  children.forEach((child, index) => child.stdin.end(payloads[index]));
  return Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  }))).then((results) => {
    assert.deepEqual(results.map((r) => r.code), [0, 0], results.map((r) => r.stderr).join('\n'));
    const parsed = results.map((r) => r.stdout.trim() ? JSON.parse(r.stdout) : null);
    const denied = parsed.filter((value) => value?.hookSpecificOutput?.permissionDecision === 'deny');
    const allowed = parsed.filter((value) => value === null);
    assert.equal(denied.length, 1);
    assert.equal(allowed.length, 1);
    assert.equal(Object.keys(readState('parallel-agent', dataDir).delegation.reservations).length, 1);
  });
});
