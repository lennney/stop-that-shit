'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { decide } = require('../src/decision.cjs');

const casesRoot = path.join(__dirname, '..', 'cases', '0.0.1');

for (const file of fs.readdirSync(casesRoot).filter((name) => name.endsWith('.json')).sort()) {
  const testCase = JSON.parse(fs.readFileSync(path.join(casesRoot, file), 'utf8'));
  test(`${testCase.id}: ${testCase.title}`, () => {
    const actual = decide(testCase.input);
    for (const [key, value] of Object.entries(testCase.expected)) {
      assert.deepEqual(actual[key], value, `${key} mismatch`);
    }
  });
}

test('classification precedence chooses I before H and S', () => {
  const actual = decide({
    contract: { mode: 'review', level: 'guard', agentBudget: 0, agentsUsed: 0 },
    action: {
      mutability: 'write',
      duplicate: true,
      sameTurn: true,
      reachability: 'unreachable',
      authorization: 'unapproved_expansion'
    }
  });
  assert.equal(actual.family, 'I');
});

test('classification precedence chooses H before file-scope S', () => {
  const actual = decide({
    contract: {
      mode: 'change', level: 'guard', hashPolicy: 'deny',
      dependencyPolicy: 'ask', allowedPaths: ['src/config.cjs']
    },
    action: {
      mutability: 'write', duplicate: false, hashIntent: true,
      affectedPaths: ['src/legacy.cjs']
    }
  });
  assert.equal(actual.family, 'H');
  assert.equal(actual.reasonCode, 'HASH_NOT_AUTHORIZED');
});

test('delegation budget checks the complete requested child count', () => {
  const allowed = decide({
    contract: { mode: 'change', level: 'guard', agentBudget: 3, agentsUsed: 1 },
    action: { mutability: 'delegate', delegationCount: 2 }
  });
  const denied = decide({
    contract: { mode: 'change', level: 'guard', agentBudget: 2, agentsUsed: 1 },
    action: { mutability: 'delegate', delegationCount: 2 }
  });
  const legacy = decide({
    contract: { mode: 'change', level: 'guard', agentBudget: 2, agentsUsed: 1 },
    action: { mutability: 'delegate' }
  });

  assert.equal(allowed.outcome, 'allow');
  assert.equal(denied.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
  assert.match(denied.explanation, /requires 2/);
  assert.equal(legacy.outcome, 'allow');
});

test('unbounded delegation takes precedence over a finite requested count', () => {
  const actual = decide({
    contract: { mode: 'change', level: 'guard', agentBudget: 1, agentsUsed: 1 },
    action: { mutability: 'delegate', delegationCount: 1, unboundedDelegation: true }
  });
  assert.equal(actual.reasonCode, 'UNBOUNDED_DELEGATION');
});
