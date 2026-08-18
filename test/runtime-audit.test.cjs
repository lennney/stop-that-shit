'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { recordDecision, readRuntime } = require('../src/runtime-audit.cjs');
const { recordAnnotation } = require('../src/runtime-annotations.cjs');

function dataDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function facts(overrides = {}) {
  return {
    sessionId: 'private-session-id',
    action: {
      name: 'apply_patch',
      mutability: 'write',
      affectedPaths: ['private/project/secret.cjs'],
      hashIntent: false,
      dependencyIntent: false,
      input: { patch: 'PRIVATE_CODE' }
    },
    contract: {
      mode: 'review',
      level: 'guard',
      agentBudget: 0,
      agentsUsed: 0,
      hashPolicy: 'deny',
      dependencyPolicy: 'ask',
      allowedPaths: ['private/project/secret.cjs']
    },
    decision: {
      outcome: 'deny_and_explain',
      family: 'I',
      reasonCode: 'MODE_FORBIDS_MUTATION',
      explanation: 'PRIVATE_EXPLANATION',
      nextStep: 'PRIVATE_NEXT_STEP'
    },
    responseOutcome: 'permission_deny_returned',
    ...overrides
  };
}

test('runtime audit appends metadata-only decisions with stable outcome dimensions', (t) => {
  const directory = dataDir(t);
  const now = () => new Date('2026-08-13T00:00:00.000Z');
  const first = recordDecision(facts(), { dataDir: directory, now });
  const second = recordDecision(facts({
    decision: { outcome: 'allow', family: null, reasonCode: 'WITHIN_CONTRACT' },
    responseOutcome: 'none'
  }), { dataDir: directory, now });
  const runtime = readRuntime({ sessionId: 'private-session-id' }, { dataDir: directory });

  assert.match(first.eventId, /^evt_[0-9a-f-]+$/);
  assert.notEqual(first.eventId, second.eventId);
  assert.deepEqual(runtime.events.map((event) => event.eventId), [first.eventId, second.eventId]);
  assert.equal(runtime.summary.checkedActions, 2);
  assert.equal(runtime.summary.permissionDenyResponses, 1);
  assert.equal(runtime.summary.executionDenialResponses, undefined);
  assert.equal(runtime.summary.contextResponses, 0);
  assert.equal(runtime.events[0].controlState, 'armed');
  assert.equal(runtime.events[0].decision.hostEffect, 'unobserved');

  const serialized = JSON.stringify(runtime);
  for (const forbidden of [
    'private-session-id', 'private/project/secret.cjs', 'PRIVATE_CODE',
    'PRIVATE_EXPLANATION', 'PRIVATE_NEXT_STEP', 'affectedPaths', 'allowedPaths', 'input'
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('runtime audit records delegation count without task input', (t) => {
  const directory = dataDir(t);
  recordDecision(facts({
    action: {
      name: 'delegate_task',
      mutability: 'delegate',
      delegationCount: 2,
      input: { tasks: [{ goal: 'PRIVATE_DELEGATION_GOAL' }] }
    }
  }), { dataDir: directory });
  const runtime = readRuntime({ sessionId: 'private-session-id' }, { dataDir: directory });
  assert.equal(runtime.events[0].action.delegationCount, 2);
  assert.equal(JSON.stringify(runtime).includes('PRIVATE_DELEGATION_GOAL'), false);
});

test('runtime reader tolerates a damaged final JSONL record', (t) => {
  const directory = dataDir(t);
  const event = recordDecision(facts(), { dataDir: directory });
  const runtimeDirectory = path.join(directory, 'runtime');
  const log = fs.readdirSync(runtimeDirectory).find((name) => name.endsWith('.jsonl'));
  fs.appendFileSync(path.join(runtimeDirectory, log), '{damaged-tail');

  const runtime = readRuntime({ eventId: event.eventId }, { dataDir: directory });
  assert.equal(runtime.events.length, 1);
  assert.equal(runtime.summary.damagedRecords, 1);
});

test('annotations are append-only and summaries use the latest label', (t) => {
  const directory = dataDir(t);
  const event = recordDecision(facts(), { dataDir: directory });
  recordAnnotation(event.eventId, 'incorrect', { dataDir: directory });
  recordAnnotation(event.eventId, 'correct', { dataDir: directory });

  const runtime = readRuntime({ eventId: event.eventId }, { dataDir: directory });
  assert.equal(runtime.annotations.length, 2);
  assert.equal(runtime.events[0].label, 'correct');
  assert.deepEqual(runtime.summary.labels, { correct: 1, incorrect: 0, inconclusive: 0 });
});

test('off decisions are not recorded and audit write errors fail open', (t) => {
  const directory = dataDir(t);
  assert.equal(recordDecision(facts({ contract: { mode: 'review', level: 'off' } }), { dataDir: directory }), null);
  const blocker = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => recordDecision(facts(), { dataDir: blocker }));
  assert.equal(recordDecision(facts(), { dataDir: blocker }), null);
});
