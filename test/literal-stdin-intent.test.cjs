'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeShell } = require('../src/shell-analysis.cjs');
const { decide } = require('../src/decision.cjs');
const { analyzeCodexTool } = require('../src/adapters/codex-tool-classifier.cjs');

function check(command, dependencyIntent, hashIntent, mutability = 'unknown') {
  for (const result of [analyzeShell(command), analyzeCodexTool('exec_command', { command })]) {
    assert.equal(result.dependencyIntent, dependencyIntent, command);
    assert.equal(result.hashIntent, hashIntent, command);
    assert.equal(result.mutability, mutability, command);
  }
}

test('literal stdin pair: a named Node script does not turn diagnostic text into an operation', () => {
  for (const script of ['record.cjs', 'record.mjs', 'record.js']) {
    check(`echo '{"message":"pnpm install sha256sum"}' | node ${script}`, false, false);
  }
});

test('literal stdin pair: evaluators, unknown consumers and actual operations retain intent', () => {
  for (const sink of ['bash', 'sh', 'pwsh -Command -', 'Invoke-Expression', 'node', 'node -',
    'node -e eval', 'node -p eval', 'node --input-type=module', 'node --require hook.cjs record.cjs', 'unknown']) {
    check(`echo 'pnpm install sha256sum' | ${sink}`, true, true);
  }
  for (const separator of [';', '&&', '||']) check(`echo 'pnpm install sha256sum' ${separator} node record.cjs`, true, true);
  check("echo 'pnpm install sha256sum' | node record.cjs; bash saved.sh", true, true);
  check("echo 'pnpm install sha256sum' > report.txt", true, true, 'write');
  check("echo 'ok' | node record.cjs 'pnpm install sha256sum'", true, true);
});

test('literal stdin pair: cross-shell metacharacters and expansions keep conservative scanning', () => {
  for (const char of ['&', '|', '<', '>', '^', '%', '!', '\r', '\n', '(', ')', '$', '`']) {
    for (const quote of ["'", '"']) {
      check(`echo ${quote}pnpm install sha256sum ${char}${quote} | node record.cjs`, true, true);
      check(`echo 'pnpm install sha256sum' | node ${quote}record${char}.cjs${quote}`, true, true);
    }
  }
  check('echo $(pnpm install sha256sum) | node record.cjs', true, true);
});


test('literal stdin Guard pair: data proceeds while dependency/hash operations retain contract decisions', () => {
  const contract = { mode: 'change', level: 'guard', dependencyPolicy: 'ask', hashPolicy: 'deny' };
  const decisionFor = command => decide({ contract, action: analyzeCodexTool('exec_command', { command }) });
  const good = decisionFor(`echo '{"message":"pnpm install sha256sum"}' | node record.cjs`);
  assert.equal(good.outcome, 'allow');
  for (const command of ["echo 'pnpm install' | bash", "echo ok | node record.cjs 'pnpm install'", 'pnpm install example-package']) {
    const actual = decisionFor(command);
    assert.equal(actual.outcome, 'require_user_approval', command);
    assert.equal(actual.reasonCode, 'DEPENDENCY_NOT_AUTHORIZED', command);
  }
  for (const command of ["echo 'sha256sum' | node -", "echo ok | node record.cjs 'sha256sum'", 'sha256sum artifact.zip']) {
    const actual = decisionFor(command);
    assert.equal(actual.outcome, 'deny_and_explain', command);
    assert.equal(actual.reasonCode, 'HASH_NOT_AUTHORIZED', command);
  }
});
