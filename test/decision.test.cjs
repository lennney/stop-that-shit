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
    contract: { mode: 'review', level: 'guard' },
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

test('absolute allowlists compare against cwd-relative affected paths', () => {
  const cwd = process.platform === 'win32' ? 'D:\\Workspace\\project' : '/Workspace/project';
  const allowed = process.platform === 'win32'
    ? 'D:/Workspace/Config.toml'
    : '/Workspace/Config.toml';

  const inside = decide({
    contract: { mode: 'change', level: 'lock', allowedPaths: [allowed] },
    action: { mutability: 'write', affectedPaths: ['../Config.toml'], cwd }
  });
  const outside = decide({
    contract: { mode: 'change', level: 'lock', allowedPaths: [allowed] },
    action: { mutability: 'write', affectedPaths: ['../Other.toml'], cwd }
  });

  assert.equal(inside.outcome, 'allow');
  assert.equal(outside.reasonCode, 'PATH_OUTSIDE_CONTRACT');
});

test('file boundary requires approval when an unknown action omits affected paths', () => {
  const actual = decide({
    contract: { mode: 'change', level: 'lock', allowedPaths: ['src/**'] },
    action: { mutability: 'unknown' }
  });

  assert.equal(actual.outcome, 'require_user_approval');
  assert.equal(actual.reasonCode, 'WRITE_PATH_UNPROVEN');
});

test('delegation limit checks the complete batch against active usage', () => {
  const allowed = decide({
    contract: { mode: 'change', level: 'guard', agentBudget: 3 },
    state: { delegation: { reservations: {} } },
    action: { mutability: 'delegate', delegationCount: 2 }
  });
  const activeDenied = decide({
    contract: { mode: 'change', level: 'guard', agentBudget: 2 },
    state: { delegation: { reservations: { 'reservation-1': { pendingCount: 1, agentIds: [] } } } },
    action: { mutability: 'delegate', delegationCount: 2 }
  });
  const zeroDenied = decide({
    contract: { mode: 'change', level: 'guard', agentBudget: 0 },
    action: { mutability: 'delegate', delegationCount: 1 }
  });
  const defaultLimit = decide({
    contract: { mode: 'change', level: 'guard' },
    action: { mutability: 'delegate' }
  });

  assert.equal(allowed.outcome, 'allow');
  assert.equal(activeDenied.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
  assert.match(activeDenied.explanation, /requires 2/);
  assert.equal(zeroDenied.reasonCode, 'AGENT_BUDGET_EXHAUSTED');
  assert.equal(defaultLimit.outcome, 'allow');
});

test('active delegation count includes pending batch units', () => {
  const actual = decide({
    contract: { mode: 'change', level: 'guard', agentBudget: 4 },
    state: {
      delegation: {
        reservations: { 'reservation-1': { pendingCount: 1, agentIds: [] } }
      }
    },
    action: { mutability: 'delegate', delegationCount: 2 }
  });
  assert.equal(actual.outcome, 'allow');
});

test('invalid directives block delegation before budget checks', () => {
  const actual = decide({
    contract: { mode: 'change', level: 'guard', agentBudget: 4 },
    state: { directiveError: { code: 'INVALID_AGENT_LIMIT' } },
    action: { mutability: 'delegate', delegationCount: 1 }
  });
  assert.equal(actual.reasonCode, 'INVALID_DIRECTIVE');
});

test('unbounded delegation takes precedence over a finite requested count', () => {
  const actual = decide({
    contract: { mode: 'change', level: 'guard', agentBudget: 1 },
    action: { mutability: 'delegate', delegationCount: 1, unboundedDelegation: true }
  });
  assert.equal(actual.reasonCode, 'UNBOUNDED_DELEGATION');
});
