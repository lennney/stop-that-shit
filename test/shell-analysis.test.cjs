'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeShell } = require('../src/shell-analysis.cjs');
const codex = require('../src/adapters/codex-tool-classifier.cjs');
const claude = require('../src/adapters/claude-tool-classifier.cjs');
const hermes = require('../src/adapters/hermes-tool-classifier.cjs');
const opencode = require('../src/adapters/opencode-tool-classifier.cjs');
const pi = require('../src/adapters/pi-tool-classifier.cjs');
const omp = require('../src/adapters/omp-tool-classifier.cjs');

const hosts = {
  codex: command => codex.analyzeCodexTool('exec_command', { command }),
  claude: command => claude.analyzeClaudeTool('PowerShell', { command }),
  hermes: command => hermes.analyzeHermesTool('terminal', { command }),
  opencode: command => opencode.analyzeOpenCodeTool('bash', { command }),
  pi: command => pi.analyzePiTool('bash', { command }),
  omp: command => omp.classifyOmpAction('bash', { command })
};

// Paired reads and operations must retain the same policy facts on every host.
const cases = [
  ['git branch --list -- -D', 'read', false, false],
  ['git branch -D scratch', 'write', false, false],
  ['git status --short && git diff --stat', 'read', false, false],
  ['git status --short > status.txt', 'write', false, false, 'shell_redirection'],
  ["rg --fixed-strings 'npm install sha256sum' README.md", 'read', false, false],
  ['npm install example-package', 'write', false, true],
  ['sha256sum artifact.zip', 'unknown', true, false, 'shell_command_unproven'],
  ["rg -- '--pre' README.md", 'read', false, false],
  ['rg --pre helper pattern README.md', 'unknown', false, false, 'shell_execution_option'],
  ['git diff --output', 'write', false, false, 'git_output_file'],
  ['git diff --word-diff-regex', 'unknown', false, false, 'option_value_missing'],
  ['git status; custom-build', 'unknown', false, false, 'shell_command_unproven']
];

for (const [command, mutability, hashIntent, dependencyIntent, analysisReason] of cases) {
  test(`shell policy facts agree across hosts: ${command}`, () => {
    const expected = { mutability, hashIntent, dependencyIntent };
    assert.deepEqual(analyzeShell(command), {
      ...expected,
      ...(analysisReason ? { analysisReason } : {})
    });
    for (const [host, analyze] of Object.entries(hosts)) {
      const result = analyze(command);
      assert.deepEqual({ mutability: result.mutability, hashIntent: result.hashIntent,
        dependencyIntent: result.dependencyIntent }, expected, host);
    }
  });
}

test('legacy shell payloads retain intent without proving a command is read-only', () => {
  const analyze = [
    input => codex.analyzeCodexTool('Bash', input),
    input => claude.analyzeClaudeTool('PowerShell', input),
    input => hermes.analyzeHermesTool('terminal', input)
  ];
  for (const read of analyze) {
    for (const key of ['patch', 'content', 'new_string']) {
      const result = read({ [key]: 'npm install example-package' });
      assert.equal(result.mutability, 'unknown');
      assert.equal(result.dependencyIntent, true);
      assert.equal(result.analysisReason, 'shell_syntax_unproven');
    }
    assert.equal(read({ new_source: 'npm install example-package' }).dependencyIntent, false);
    assert.equal(read({ command: 'git status', content: 'npm install example-package' }).dependencyIntent, false);
  }
});
