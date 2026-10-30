'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const root = path.join(__dirname, '..');
test('literal diagnostic writes do not authorize or perform dependency operations', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-literal-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const call = (event, input) => {
    const r = spawnSync(process.execPath, [path.join(root, 'hooks/stop-that-shit.cjs')], { env: { ...process.env, PLUGIN_DATA: dataDir, STS_RUNTIME_DATA: dataDir }, input: JSON.stringify({ session_id: 'literal', turn_id: 't', hook_event_name: event, ...input }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout ? JSON.parse(r.stdout) : null;
  };
  call('UserPromptSubmit', { prompt: '$stop-that-shit change deps=ask -- work' });
  for (const command of ["Set-Content -Path report.md -Value 'pnpm install failed'", "Add-Content report.md 'pnpm install failed'"]) {
    assert.equal(call('PreToolUse', { tool_name: 'Bash', tool_use_id: command, tool_input: { command } }), null, command);
  }
  for (const command of ['pnpm install --offline', 'echo ok && pnpm install', 'echo $(pnpm install)', "pwsh -Command 'pnpm install'", "node tool.js 'pnpm install'"]) {
    assert.match(call('PreToolUse', { tool_name: 'Bash', tool_use_id: command, tool_input: { command } }).hookSpecificOutput.permissionDecisionReason, /DEPENDENCY_NOT_AUTHORIZED/, command);
  }
});

test('only statically parsed content cmdlets treat arguments as literal data', () => {
  const { analyzeShell } = require('../src/shell-analysis.cjs');
  for (const command of ["Set-Content report.md 'pnpm install failed'", "Add-Content report.md 'sha256sum failed'"]) {
    const result = analyzeShell(command);
    assert.equal(result.mutability, 'write');
    assert.equal(result.dependencyIntent, false);
    assert.equal(result.hashIntent, false);
  }
  for (const command of ["Set-Content report.md 'pnpm install failed'; pnpm install", 'Set-Content report.md $(pnpm install)', "pwsh -Command 'pnpm install'", "node tool.js 'pnpm install'", "echo 'pnpm install failed' > report.md"]) {
    assert.equal(analyzeShell(command).dependencyIntent, true, command);
  }
  assert.equal(analyzeShell("Set-Content report.md 'sha256sum failed'; sha256sum file").hashIntent, true);
});
