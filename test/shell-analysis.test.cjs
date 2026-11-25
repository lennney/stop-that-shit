'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeShell } = require('../src/shell-analysis.cjs');
const { decide } = require('../src/decision.cjs');
const { analyzeDshTool } = require('../src/adapters/dsh-tool-classifier.cjs');
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
  ['git --no-optional-locks status --short', 'read', false, false],
  ['git --no-optional-locks diff --output=review.patch', 'write', false, false, 'git_output_file'],
  ['git -C fixture worktree list --porcelain -z', 'read', false, false],
  ['git -C fixture worktree prune', 'unknown', false, false, 'git_arguments_unproven'],
  ['git merge-base --is-ancestor HEAD main', 'read', false, false],
  ['git merge-base --future-option HEAD main', 'unknown', false, false, 'git_arguments_unproven'],
  ['git cat-file -p HEAD', 'read', false, false],
  ['git cat-file --batch-command', 'unknown', false, false, 'git_arguments_unproven'],
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

test('reviewing worktree layout allows listing and requires approval for pruning', () => {
  const contract = { mode: 'review', level: 'guard' };
  for (const [host, analyze] of Object.entries(hosts)) {
    const listing = decide({ contract, action: analyze('git worktree list --porcelain') });
    const pruning = decide({ contract, action: analyze('git worktree prune') });
    assert.equal(listing.outcome, 'allow', host);
    assert.equal(pruning.outcome, 'require_user_approval', host);
    assert.equal(pruning.reasonCode, 'MUTABILITY_UNPROVEN', host);
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

test('Guard review permits listing local archive formats and requires approval for archive creation', () => {
  const contract = { mode: 'review', level: 'guard' };
  const listing = ['git archive --list', 'git archive -l'];
  const unproven = [
    'git archive --output=bundle.tar HEAD',
    'git archive --format=tar -o bundle.tar HEAD',
    'git archive --format=tar HEAD',
    'git archive --remote=fixture --list',
    'git archive --list --output=bundle.tar'
  ];
  for (const [host, analyze] of Object.entries(hosts)) {
    for (const command of listing) {
      const action = analyze(command);
      assert.equal(action.mutability, 'read', `${host}: ${command}`);
      assert.equal(decide({ contract, action }).outcome, 'allow', `${host}: ${command}`);
    }
    for (const command of unproven) {
      const action = analyze(command);
      assert.equal(action.mutability, 'unknown', `${host}: ${command}`);
      assert.equal(decide({ contract, action }).reasonCode, 'MUTABILITY_UNPROVEN', `${host}: ${command}`);
    }
  }
});

test('shell path metadata cannot authorize archive output under a file-scoped Guard contract', () => {
  const cwd = '/repo';
  const contract = { mode: 'change', level: 'guard', allowedPaths: ['src/**'] };
  const input = { command: 'git archive --output=outside/bundle.tar HEAD', path: 'src/hint' };
  const actions = [
    claude.analyzeClaudeTool('Bash', input, cwd),
    opencode.analyzeOpenCodeTool('bash', input, cwd),
    analyzeDshTool('bash', input, cwd)
  ];
  for (const action of actions) {
    assert.deepEqual(action.affectedPaths, []);
    const result = decide({ contract, action: { ...action, cwd } });
    assert.equal(result.outcome, 'require_user_approval');
    assert.equal(result.reasonCode, 'WRITE_PATH_UNPROVEN');
  }
});
