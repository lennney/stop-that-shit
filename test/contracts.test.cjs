'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { defaultContract, parseContractPrompt } = require('../src/contracts.cjs');

test('explicit review directive enables guard by default', () => {
  const result = parseContractPrompt('$stop-that-shit review -- inspect the diff', defaultContract());
  assert.equal(result.contract.mode, 'review');
  assert.equal(result.contract.level, 'guard');
  assert.equal(result.contract.hashPolicy, 'deny');
});

test('hash policy defaults to deny and accepts an explicit override', () => {
  assert.equal(defaultContract().hashPolicy, 'deny');
  const result = parseContractPrompt('$stop-that-shit change hash=allow -- add the required release checksum');
  assert.equal(result.contract.hashPolicy, 'allow');
});

test('hash ask policy requires a separate approval decision', () => {
  const result = parseContractPrompt('$stop-that-shit change hash=ask -- implement the feature');
  assert.equal(result.contract.hashPolicy, 'ask');
});

test('optional lock fields parse from the directive head', () => {
  const result = parseContractPrompt('$stop-that-shit lock change files=src/config.cjs|test/** deps=allow -- implement it');
  assert.deepEqual(result.contract.allowedPaths, ['src/config.cjs', 'test/**']);
  assert.equal(result.contract.dependencyPolicy, 'allow');
});

test('files values preserve path casing while directive keywords stay case-insensitive', () => {
  const result = parseContractPrompt('$stop-that-shit LOCK CHANGE FILES=/Workspace/example/Config.toml|src/Config.cjs -- update config');
  assert.equal(result.contract.mode, 'change');
  assert.equal(result.contract.level, 'lock');
  assert.deepEqual(result.contract.allowedPaths, ['/Workspace/example/Config.toml', 'src/Config.cjs']);
});

test('Windows drive paths do not terminate the directive head', () => {
  const result = parseContractPrompt('$stop-that-shit lock change files=C:/Workspace/Config.toml: update config');
  assert.equal(result.contract.mode, 'change');
  assert.equal(result.contract.level, 'lock');
  assert.deepEqual(result.contract.allowedPaths, ['C:/Workspace/Config.toml']);
});

test('an explicit empty files value creates an empty file boundary', () => {
  const empty = parseContractPrompt('$stop-that-shit lock change files= -- update nothing');
  const omitted = parseContractPrompt('$stop-that-shit lock change -- update files');

  assert.deepEqual(empty.contract.allowedPaths, []);
  assert.equal(omitted.contract.allowedPaths, null);
});

test('agent limits default to the maximum safe integer', () => {
  const contract = defaultContract();
  assert.equal(contract.agentBudget, Number.MAX_SAFE_INTEGER);
  assert.equal('totalAgentBudget' in contract, false);
  assert.equal('concurrentAgentBudget' in contract, false);
  assert.equal('agentsUsed' in contract, false);
});

test('agents is the formal active concurrency limit', () => {
  const result = parseContractPrompt('$stop-that-shit lock change agents=3 -- implement it');
  assert.equal(result.contract.mode, 'change');
  assert.equal(result.contract.level, 'lock');
  assert.equal(result.contract.agentBudget, 3);
  assert.equal(result.error, null);
  assert.equal(result.warning, null);
});

test('zero is accepted and disables delegation', () => {
  const result = parseContractPrompt('$stop-that-shit change agents=0 -- implement it');
  assert.equal(result.contract.agentBudget, 0);
  assert.equal(result.error, null);
});

test('invalid agent limits return a structured error without changing the contract', () => {
  const previous = {
    ...defaultContract(),
    mode: 'change',
    level: 'guard',
    agentBudget: 4
  };
  for (const token of ['agents=-1', 'agents=1.5', 'agents=NaN', `agents=${Number.MAX_SAFE_INTEGER + 1}`]) {
    const result = parseContractPrompt(`$stop-that-shit change ${token} -- implement it`, previous);
    assert.equal(result.error.code, 'INVALID_AGENT_LIMIT');
    assert.equal(result.error.token, token);
    assert.equal(result.changed, false);
    assert.deepEqual(result.contract, previous);
  }
});

test('split agent directives are rejected without partial updates', () => {
  const previous = {
    ...defaultContract(),
    mode: 'review',
    level: 'guard',
    agentBudget: 4
  };
  for (const token of ['total-agents=9', 'concurrent-agents=2']) {
    const result = parseContractPrompt(`$stop-that-shit change ${token} agents=1 -- implement it`, previous);
    assert.equal(result.error.code, 'UNSUPPORTED_AGENT_DIRECTIVE');
    assert.equal(result.error.token, token);
    assert.equal(result.changed, false);
    assert.deepEqual(result.contract, previous);
  }
});

test('a long path does not truncate a later agent limit', () => {
  const longPath = `src/${'nested/'.repeat(20)}file.cjs`;
  const result = parseContractPrompt(`$stop-that-shit change files=${longPath} agents=7 -- implement it`);
  assert.equal(result.contract.agentBudget, 7);
  assert.deepEqual(result.contract.allowedPaths, [longPath]);
});

test('implicit invocation stays watch-only until mode is confirmed', () => {
  const result = parseContractPrompt('Please avoid overengineering this task.');
  assert.equal(result.contract.mode, 'unconfirmed');
  assert.equal(result.contract.level, 'watch');
});

test('explicit fix request updates a prior review contract', () => {
  const prior = { ...defaultContract(), mode: 'review', level: 'guard' };
  const result = parseContractPrompt('Fix the P1 finding now. Do not change the others.', prior);
  assert.equal(result.contract.mode, 'change');
});

test('negative review language wins over the word fix', () => {
  const prior = { ...defaultContract(), mode: 'change', level: 'guard' };
  const result = parseContractPrompt("Review only. Don't fix anything.", prior);
  assert.equal(result.contract.mode, 'review');
});

test('off remains off before a mode is confirmed', () => {
  const result = parseContractPrompt('$stop-that-shit off');
  assert.equal(result.contract.level, 'off');
});

test('quoted, embedded, and code examples do not update the contract', () => {
  const command = '$stop-that-shit off change agents=9 hash=allow deps=allow files=** -- example';
  const examples = [
    `请解释这段示例：${command}，不执行`,
    `Explain this example: ${command}`,
    `"${command}"`,
    `'${command}'`,
    `\`${command}\``,
    `> ${command}`,
    `- ${command}`,
    `\`\`\`text\n${command}\n\`\`\``,
    `~~~text\n${command}\n~~~`,
    `    ${command}`,
    `\t${command}`,
    `Example:\n${command}`,
    command.replace('$stop-that-shit', '$stop-that-shit-example')
  ];
  for (const previous of [defaultContract(), {
    ...defaultContract(), mode: 'review', level: 'lock', agentBudget: 0,
    allowedPaths: ['src/config.cjs']
  }]) {
    for (const prompt of examples) {
      const result = parseContractPrompt(prompt, previous);
      assert.deepEqual(result.contract, previous, prompt);
      assert.equal(result.directive, false, prompt);
      assert.equal(result.changed, false, prompt);
      assert.equal(result.error, null, prompt);
    }
  }
});

test('a direct directive still updates authority after blank lines and light indentation', () => {
  const previous = { ...defaultContract(), mode: 'review', level: 'guard' };
  for (const prefix of ['', '\n', '\r\n\r\n', '  ']) {
    const result = parseContractPrompt(`${prefix}$stop-that-shit change hash=allow -- add the required checksum`, previous);
    assert.equal(result.contract.mode, 'change');
    assert.equal(result.contract.hashPolicy, 'allow');
    assert.equal(result.error, null);
  }
});

test('directive fields cannot spill into the next line or task body', () => {
  const previous = { ...defaultContract(), mode: 'review', level: 'guard' };
  for (const separator of ['\n', '\r\n', ' -- ', ': ']) {
    const result = parseContractPrompt(`$stop-that-shit${separator}change hash=allow`, previous);
    assert.equal(result.contract.mode, 'review');
    assert.equal(result.contract.hashPolicy, 'deny');
    assert.equal(result.changed, false);
  }
  const result = parseContractPrompt('$stop-that-shit review\n$stop-that-shit off change hash=allow', previous);
  assert.equal(result.contract.mode, 'review');
  assert.equal(result.contract.level, 'guard');
  assert.equal(result.contract.hashPolicy, 'deny');
});

test('ambiguous directive heads fail atomically rather than selecting permissive tokens', () => {
  const previous = { ...defaultContract(), mode: 'review', level: 'lock', agentBudget: 0 };
  for (const head of [
    'example change hash=allow', 'change review', 'review change',
    'lock off change', 'change agents=0 agents=3',
    'change hash=deny hash=allow', 'change deps=ask deps=allow',
    'change files=src/** files=**', 'change hash=alow'
  ]) {
    const result = parseContractPrompt(`$stop-that-shit ${head} -- example`, previous);
    assert.ok(result.error, head);
    assert.deepEqual(result.contract, previous, head);
    assert.equal(result.changed, false, head);
  }
  const good = parseContractPrompt('$stop-that-shit change change hash=allow HASH=ALLOW -- required checksum', previous);
  assert.equal(good.error, null);
  assert.equal(good.contract.mode, 'change');
  assert.equal(good.contract.hashPolicy, 'allow');
});

test('natural corrections ignore quoted examples without disabling real task corrections', () => {
  const previous = { ...defaultContract(), mode: 'change', level: 'guard' };
  for (const example of [
    '```text\n$stop-that-shit review -- review only\n```',
    '~~~text\nanswer only\n~~~',
    '> review only',
    '    monitor only',
    '\t只审查',
    '`review only`',
    '``example `review only` here``',
    '"review only"',
    "'Don't edit anything'",
    '“只看不改”',
    '「不要修改文件」',
    '『只回答』',
    '‘monitor only’'
  ]) {
    const result = parseContractPrompt(`Add this usage example to README.md:\n${example}`, previous);
    assert.deepEqual(result.contract, previous, example);
    assert.equal(result.correction, false, example);
  }
  for (const text of ['Review only. Do not edit anything.', '只审查，不要修改代码。']) {
    assert.equal(parseContractPrompt(text, previous).contract.mode, 'review');
  }
  assert.equal(parseContractPrompt('"review only" is an example.\nReview only.', previous).contract.mode, 'review');
  assert.equal(parseContractPrompt('review `example` only', previous).contract.mode, 'change');
  const review = { ...previous, mode: 'review' };
  assert.equal(parseContractPrompt('Fix "src/config.cjs" now.', review).contract.mode, 'change');
  assert.equal(parseContractPrompt('"Fix the bug" is an example.', review).contract.mode, 'review');
  assert.equal(parseContractPrompt("Don't edit anything.", previous).contract.mode, 'review');
});
