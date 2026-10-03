'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { recordDecision, readRuntime } = require('../src/runtime-audit.cjs');
const { readAnnotations, recordAnnotation } = require('../src/runtime-annotations.cjs');
const { sessionKey } = require('../src/state.cjs');

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
      agentBudget: 2,
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

test('runtime audit stores only a fixed analysis code and drops free-form metadata', (t) => {
  const directory = dataDir(t);
  const values = ['shell_execution_option', 'PRIVATE_COMMAND', 'toString', ['shell_execution_option'], { toString: () => 'shell_execution_option', untrustedInput: 'PRIVATE_CODE' }];
  for (const analysisReason of values) {
    recordDecision(facts({ action: { ...facts().action, analysisReason } }), { dataDir: directory });
  }
  const runtime = readRuntime({ sessionId: 'private-session-id' }, { dataDir: directory });
  assert.deepEqual(runtime.events.map(event => event.action.analysisReason), ['shell_execution_option', undefined, undefined, undefined, undefined]);
  assert.doesNotMatch(JSON.stringify(runtime), /PRIVATE_COMMAND|PRIVATE_CODE/);
});

test('runtime audit records delegation count without task input', (t) => {
  const directory = dataDir(t);
  recordDecision(facts({
    action: {
      name: 'delegate_task',
      mutability: 'delegate',
      delegationCount: 2,
      input: { tasks: [{ goal: 'PRIVATE_DELEGATION_GOAL' }] }
    },
    delegation: {
      reservations: { 'reservation:private': { actionId: 'private', pendingCount: 1, agentIds: ['private-agent'] } }
    }
  }), { dataDir: directory });
  const runtime = readRuntime({ sessionId: 'private-session-id' }, { dataDir: directory });
  assert.equal(runtime.events[0].action.delegationCount, 2);
  assert.equal(runtime.events[0].contract.agentBudget, 2);
  assert.equal(runtime.events[0].contract.reservedUpperBound, 2);
  assert.equal('totalAgentBudget' in runtime.events[0].contract, false);
  assert.equal('concurrentAgentBudget' in runtime.events[0].contract, false);
  assert.equal('totalAgentsUsed' in runtime.events[0].contract, false);
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

test('runtime reader handles a large session log and retains filtered labels and damage counts', t => {
  const directory = dataDir(t);
  const first = recordDecision(facts(), { dataDir: directory });
  const file = path.join(directory, 'runtime', `${sessionKey(facts().sessionId)}.jsonl`);
  const count = 150000;
  const event = {
    schemaVersion: 1, occurredAt: '2026-08-13T00:00:00.000Z', controlState: 'armed',
    action: { toolName: 'read', mutability: 'read' }, contract: { mode: 'review' },
    decision: { policyOutcome: 'allow', reasonCode: 'WITHIN_CONTRACT', responseOutcome: 'none' }
  };
  const id = index => `evt_${index.toString(16).padStart(32, '0')}`;
  fs.writeFileSync(file, Array.from({ length: count }, (_, index) =>
    JSON.stringify({ ...event, eventId: id(index) })).join('\n') + '\n{}\n{damaged-tail');
  recordAnnotation(id(count - 1), 'correct', { dataDir: directory });
  recordAnnotation(first.eventId, 'incorrect', { dataDir: directory });

  const latest = readRuntime({ sessionId: facts().sessionId, limit: 1 }, { dataDir: directory });
  assert.deepEqual(latest.events.map(event => event.eventId), [id(count - 1)]);
  assert.equal(latest.events[0].label, 'correct');
  assert.equal(latest.summary.checkedActions, 1);
  assert.equal(latest.summary.damagedRecords, 2);
  assert.equal(latest.annotations.length, 1);

  const selected = readRuntime({ eventId: id(1) }, { dataDir: directory });
  assert.deepEqual(selected.events.map(event => event.eventId), [id(1)]);
  assert.equal(selected.summary.damagedRecords, 2);
  assert.deepEqual(selected.annotations, []);
});

test('runtime limit zero returns no events or labels', t => {
  const directory = dataDir(t);
  const event = recordDecision(facts(), { dataDir: directory });
  recordAnnotation(event.eventId, 'correct', { dataDir: directory });
  const runtime = readRuntime({ limit: 0 }, { dataDir: directory });
  assert.deepEqual(runtime.events, []);
  assert.deepEqual(runtime.annotations, []);
  assert.equal(runtime.summary.checkedActions, 0);
});

test('runtime isolates structurally damaged events and labels while retaining valid evidence', (t) => {
  const directory = dataDir(t);
  const event = recordDecision(facts(), { dataDir: directory });
  recordAnnotation(event.eventId, 'correct', { dataDir: directory });
  const logs = path.join(directory, 'runtime');
  const log = fs.readdirSync(logs).find(name => name !== 'annotations.jsonl');
  fs.appendFileSync(path.join(logs, log), '{}\nnull\n{"occurredAt":12}\n');
  fs.appendFileSync(path.join(logs, 'annotations.jsonl'), '{}\n' + JSON.stringify({ eventId: event.eventId, label: '__proto__' }) + '\n');
  const runtime = readRuntime({ eventId: event.eventId }, { dataDir: directory });
  assert.equal(runtime.events.length, 1);
  assert.equal(runtime.events[0].label, 'correct');
  assert.equal(runtime.summary.damagedRecords, 5);
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

test('filtered runtime queries preserve label history and count damage outside the selection', t => {
  const directory = dataDir(t);
  const options = { dataDir: directory, now: () => new Date('2026-08-13T00:00:00.000Z') };
  const first = recordDecision(facts(), options);
  const other = recordDecision(facts({ sessionId: 'other-session' }), options);
  recordAnnotation(first.eventId, 'incorrect', options);
  recordAnnotation(other.eventId, 'inconclusive', options);
  // Label precedence follows append order even if the system clock moves back.
  recordAnnotation(first.eventId, 'correct', { ...options, now: () => new Date('2026-08-12T00:00:00.000Z') });
  fs.appendFileSync(path.join(directory, 'runtime', 'annotations.jsonl'), 'null\n{broken\n');
  fs.appendFileSync(path.join(directory, 'runtime', `${sessionKey('other-session')}.jsonl`), '{}\n{unfinished');

  const selected = readRuntime({ eventId: first.eventId }, options);
  assert.deepEqual(selected.events.map(event => [event.eventId, event.label]), [[first.eventId, 'correct']]);
  assert.deepEqual(selected.annotations.map(annotation => annotation.label), ['incorrect', 'correct']);
  assert.equal(selected.summary.damagedRecords, 4);

  const allLabels = readAnnotations(options);
  assert.deepEqual(allLabels.records.map(annotation => annotation.label), ['incorrect', 'inconclusive', 'correct']);
  assert.equal(allLabels.damaged, 2);
  for (const query of [{ eventId: 'evt_0000' }, { limit: 0 }]) {
    const empty = readRuntime(query, options);
    assert.deepEqual(empty.events, []);
    assert.deepEqual(empty.annotations, []);
    assert.equal(empty.summary.damagedRecords, 4);
  }
});

test('off decisions are not recorded and audit write errors fail open', (t) => {
  const directory = dataDir(t);
  assert.equal(recordDecision(facts({ contract: { mode: 'review', level: 'off' } }), { dataDir: directory }), null);
  const blocker = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  assert.doesNotThrow(() => recordDecision(facts(), { dataDir: blocker }));
  assert.equal(recordDecision(facts(), { dataDir: blocker }), null);
});
