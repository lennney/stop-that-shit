'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeShell } = require('../src/shell-analysis.cjs');
const { analyzeCodexTool } = require('../src/adapters/codex-tool-classifier.cjs');

function check(command, dependencyIntent, hashIntent) {
  for (const result of [analyzeShell(command), analyzeCodexTool('exec_command', { command })]) {
    assert.equal(result.dependencyIntent, dependencyIntent, command);
    assert.equal(result.hashIntent, hashIntent, command);
    assert.notEqual(result.mutability, 'read', command);
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
  check("echo 'pnpm install sha256sum' > report.txt", true, true);
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
