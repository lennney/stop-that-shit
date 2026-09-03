'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { handleClaudeHook, toControlEvent } = require('../src/adapters/claude-hooks.cjs');
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

function pre(session, toolName, toolInput, cwd = root) {
  return {
    session_id: session,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: `${toolName}-1`,
    tool_input: toolInput,
    cwd,
    permission_mode: 'default'
  };
}

test('Claude Adapter maps official Hook fields to ControlEvent v1', () => {
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

test('Claude Agent uses the shared subagent budget', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('agent-budget', '$stop-that-shit change agents=1 -- use one specialist'), options);
  assert.equal(handleClaudeHook(pre('agent-budget', 'Agent', { prompt: 'inspect tests' }), options), null);
  const denied = handleClaudeHook(pre('agent-budget', 'Agent', { prompt: 'inspect docs' }), options);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /S\/AGENT_BUDGET_EXHAUSTED/);
});

test('Claude Workflow cannot bypass agents=N with opaque internal fan-out', (t) => {
  const options = workspace(t);
  handleClaudeHook(prompt('workflow-budget', '$stop-that-shit change agents=8 -- bounded delegation only'), options);
  const denied = handleClaudeHook(pre('workflow-budget', 'Workflow', { workflow: 'parallel-review' }), options);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /S\/UNBOUNDED_DELEGATION/);
  assert.equal(readState('workflow-budget', options.dataDir).contract.agentsUsed, 0);
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
  const payload = JSON.stringify(pre('parallel-agent', 'Agent', { prompt: 'inspect' }));
  const children = [0, 1].map(() => require('node:child_process').spawn(process.execPath, [entrypoint], {
    cwd: root,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir },
    stdio: ['pipe', 'pipe', 'pipe']
  }));
  for (const child of children) child.stdin.end(payload);
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
    assert.equal(readState('parallel-agent', dataDir).contract.agentsUsed, 1);
  });
});
