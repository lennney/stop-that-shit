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
// affectedPaths is the fifth fact: a proven write names its target, and a write
// that names no target stays unproven rather than widening the file boundary.
const cases = [
  ['git branch --list -- -D', 'read', false, false],
  ['git branch -D scratch', 'write', false, false],
  ['git status --short && git diff --stat', 'read', false, false],
  ['git status --short > status.txt', 'write', false, false, 'shell_redirection', ['status.txt']],
  ["rg --fixed-strings 'npm install sha256sum' README.md", 'read', false, false],
  ['npm install example-package', 'write', false, true],
  ['sha256sum artifact.zip', 'unknown', true, false, 'shell_command_unproven'],
  ["rg -- '--pre' README.md", 'read', false, false],
  ['rg --pre helper pattern README.md', 'unknown', false, false, 'shell_execution_option'],
  ['git diff --output', 'write', false, false, 'git_output_file'],
  ['git diff --word-diff-regex', 'unknown', false, false, 'option_value_missing'],
  ['git status; custom-build', 'unknown', false, false, 'shell_command_unproven']
];

for (const [command, mutability, hashIntent, dependencyIntent, analysisReason, affectedPaths] of cases) {
  test(`shell policy facts agree across hosts: ${command}`, () => {
    const expected = { mutability, hashIntent, dependencyIntent };
    assert.deepEqual(analyzeShell(command), {
      ...expected,
      ...(analysisReason ? { analysisReason } : {}),
      affectedPaths: affectedPaths || []
    });
    for (const [host, analyze] of Object.entries(hosts)) {
      const result = analyze(command);
      assert.deepEqual({ mutability: result.mutability, hashIntent: result.hashIntent,
        dependencyIntent: result.dependencyIntent }, expected, host);
    }
  });
}

// A write command whose target the parser can read must report it. The command
// still classifies exactly as before, so a host that ignores affectedPaths keeps
// its old behavior while a file-locked host can now prove the target.
const namedWriteCases = [
  ['mkdir -p src/new', ['src/new']],
  ['rm -rf src/old', ['src/old']],
  ['touch src/new.txt', ['src/new.txt']],
  ['mv src/a.txt src/b.txt', ['src/a.txt', 'src/b.txt']],
  ['cp src/a.txt src/b.txt', ['src/b.txt']],
  ['git add src/a.txt src/b.txt', ['src/a.txt', 'src/b.txt']],
  ['git -C sub add src/a.txt', ['src/a.txt']],
  ["Set-Content -Path src/config.cjs -Value 'x'", ['src/config.cjs']],
  ['Remove-Item -Recurse -Force src/old', ['src/old']],
  ['echo hi > src/out.txt', ['src/out.txt']],
  ['echo hi >> "src/spaced name.txt"', ['src/spaced name.txt']]
];

for (const [command, expectedPaths] of namedWriteCases) {
  test(`write command names the path it writes: ${command}`, () => {
    const analysis = analyzeShell(command);
    assert.equal(analysis.mutability, 'write');
    assert.deepEqual(analysis.affectedPaths, expectedPaths);
  });
}

// Anything the parser cannot read ends the proof. An empty list keeps the file
// lock closed instead of narrowing the boundary to a partial match.
const unnamedWriteCases = [
  'git add -A',
  'mkdir --unexpected-option src/new',
  'echo hi > $OUT',
  'echo hi > >&2',
  'echo hi > ~/notes.txt',
  'echo "hi" > "$OUT.txt"'
];

for (const command of unnamedWriteCases) {
  test(`unproven write keeps its target open: ${command}`, () => {
    assert.deepEqual(analyzeShell(command).affectedPaths, []);
  });
}

// Reads never contribute paths: their operands are data, and a read may name a
// file the contract never authorized for writing.
test('reads report no affected paths even when they name files', () => {
  for (const command of ['cat src/a.txt', 'rg pattern src/**', 'git status --short']) {
    assert.deepEqual(analyzeShell(command).affectedPaths, [], command);
  }
});

// A chain is only proven when every command in it is proven.
test('a chain with one unproven write reports no affected paths', () => {
  assert.deepEqual(analyzeShell('mkdir -p src/new && custom-build').affectedPaths, []);
});

test('a proven shell command reaches every host adapter as an affected path', () => {
  const expected = { mutability: 'write', affectedPaths: ['src/new.txt'] };
  for (const [host, analyze] of Object.entries(hosts)) {
    const result = analyze('touch src/new.txt');
    assert.deepEqual({ mutability: result.mutability, affectedPaths: result.affectedPaths }, expected, host);
  }
});

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
