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

test('lock level and agent budget are parsed from the directive head', () => {
  const result = parseContractPrompt('$stop-that-shit lock change agents=2 -- implement it');
  assert.equal(result.contract.mode, 'change');
  assert.equal(result.contract.level, 'lock');
  assert.equal(result.contract.agentBudget, 2);
});

test('implicit invocation stays watch-only until mode is confirmed', () => {
  const result = parseContractPrompt('Please avoid overengineering this task.');
  assert.equal(result.contract.mode, 'unconfirmed');
  assert.equal(result.contract.level, 'watch');
});

test('explicit fix request updates a prior review contract', () => {
  const prior = { mode: 'review', level: 'guard', agentBudget: 0, agentsUsed: 0 };
  const result = parseContractPrompt('Fix the P1 finding now. Do not change the others.', prior);
  assert.equal(result.contract.mode, 'change');
});

test('negative review language wins over the word fix', () => {
  const prior = { mode: 'change', level: 'guard', agentBudget: 0, agentsUsed: 0 };
  const result = parseContractPrompt("Review only. Don't fix anything.", prior);
  assert.equal(result.contract.mode, 'review');
});

test('off remains off before a mode is confirmed', () => {
  const result = parseContractPrompt('$stop-that-shit off');
  assert.equal(result.contract.level, 'off');
});
