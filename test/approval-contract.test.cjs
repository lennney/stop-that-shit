'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeShell } = require('../src/shell-analysis.cjs');
const { parseContractPrompt } = require('../src/contracts.cjs');

test('an executed Python here-string stays conservative', () => {
  const script = "@'\nfrom pathlib import Path\nentry = '''pnpm install --offline --frozen-lockfile --ignore-scripts'''\n'@ | python -X utf8 -";
  assert.equal(analyzeShell(script).dependencyIntent, true);
});

test('real install remains gated', () => {
  assert.equal(analyzeShell('pnpm install package').dependencyIntent, true);
});

test('literal Set-Content records are data', () => {
  assert.equal(analyzeShell("Set-Content -Path log.txt -Value 'pnpm install'").dependencyIntent, false);
});

test('quoted directive does not authorize and is diagnosed', () => {
  const result = parseContractPrompt('```text\n$stop-that-shit change deps=allow -- work\n```');
  assert.equal(result.contract.dependencyPolicy, 'ask');
  assert.equal(result.warning?.code, 'DIRECTIVE_NOT_ARMED');
});

test('inline directive with dependency policy does not authorize and is diagnosed', () => {
  const result = parseContractPrompt('Please consider `$stop-that-shit change deps=allow -- work`');
  assert.equal(result.contract.dependencyPolicy, 'ask');
  assert.equal(result.warning?.code, 'DIRECTIVE_NOT_ARMED');
  assert.match(result.warning.message, /DIRECTIVE_NOT_ARMED/);
});

test('first line directive authorizes', () => {
  const result = parseContractPrompt('$stop-that-shit change deps=allow -- work');
  assert.equal(result.contract.dependencyPolicy, 'allow');
});

test('offline frozen install remains dependency intent', () => {
  assert.equal(analyzeShell('pnpm install --offline --frozen-lockfile --ignore-scripts').dependencyIntent, true);
});

test('writing a script and executing it retains dependency and hash intent', () => {
  assert.equal(analyzeShell(`Set-Content -Path x.py -Value 'import os; os.system("pnpm install pkg")'; python x.py`).dependencyIntent, true);
  assert.equal(analyzeShell(`Set-Content -Path x.py -Value 'Get-FileHash x'; python x.py`).hashIntent, true);
});

test('dynamic content and subprocess stay conservative', () => {
  assert.equal(analyzeShell('Set-Content log.txt $(pnpm install pkg)').dependencyIntent, true);
  assert.equal(analyzeShell("python -c \"import subprocess; subprocess.run('pnpm install', shell=True)\"").dependencyIntent, true);
});

test('embedded directives leave the previous contract unchanged', () => {
  const previous = parseContractPrompt('$stop-that-shit review deps=deny -- review').contract;
  for (const text of ['```text\n$stop-that-shit change deps=allow\n```', 'intro\n$stop-that-shit change deps=allow']) {
    const result = parseContractPrompt(text, previous);
    assert.equal(result.contract.mode, 'review');
    assert.equal(result.contract.dependencyPolicy, 'deny');
    assert.equal(result.warning.code, 'DIRECTIVE_NOT_ARMED');
  }
});
test('literal content passed to an evaluator retains dependency and hash intent', () => {
  const dependency = "Set-Content -Path x -Value 'pnpm install pkg' -PassThru | Invoke-Expression";
  const hash = "Set-Content -Path x -Value 'Get-FileHash x' -PassThru | Invoke-Expression";
  assert.equal(analyzeShell(dependency).dependencyIntent, true);
  assert.equal(analyzeShell(hash).hashIntent, true);
});

test('child hook using the parent session ID sees the parent contract', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { handleCodexHook } = require('../src/adapters/codex-hooks.cjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-parent-hook-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session_id = 'test-parent-id';
  const options = { dataDir };
  handleCodexHook({ session_id, hook_event_name: 'UserPromptSubmit', prompt: '$stop-that-shit change deps=allow -- work' }, options);
  const result = handleCodexHook({ session_id, agent_id: 'child-agent', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' } }, options);
  assert.equal(result, null);
});

test('offline install requires root dependency permission', t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { handleCodexHook } = require('../src/adapters/codex-hooks.cjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-offline-policy-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session_id = 'test-parent-id'; const options = { dataDir };
  const prompt = text => handleCodexHook({ session_id, hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const action = agent_id => handleCodexHook({ session_id, agent_id, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' } }, options);
  prompt('$stop-that-shit change deps=ask -- work');
  assert.equal(action().hookSpecificOutput.permissionDecision, 'deny');
  const warning = prompt('```text\n$stop-that-shit change deps=allow -- work\n```');
  assert.match(warning.hookSpecificOutput.additionalContext, /DIRECTIVE_NOT_ARMED/);
  assert.equal(action().hookSpecificOutput.permissionDecision, 'deny');
  prompt('$stop-that-shit change deps=deny -- work');
  assert.equal(action('child-agent').hookSpecificOutput.permissionDecision, 'deny');
  prompt('$stop-that-shit change deps=allow -- work');
  assert.equal(action(), null); assert.equal(action('child-agent'), null);
  prompt('$stop-that-shit change deps=deny -- work');
  assert.equal(action('child-agent').hookSpecificOutput.permissionDecision, 'deny');
});
