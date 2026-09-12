'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  activeDelegationCount,
  bindSubagent,
  clearDelegations,
  releaseReservation,
  releaseSubagent,
  reserveDelegation
} = require('../src/delegation-state.cjs');
const { readState, statePath } = require('../src/state.cjs');

function emptyDelegation() {
  return { reservations: {}, agentIdsSeen: [], stoppedAgentIds: [], acceptedActions: {} };
}

test('reservation increases active count by the requested batch size', () => {
  const next = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 2);
  assert.equal('totalAgentsUsed' in next, false);
  assert.deepEqual(next.reservations['reservation-1'], {
    actionId: 'action-1',
    asyncLaunched: null,
    pendingCount: 2,
    agentIds: []
  });
  assert.equal(activeDelegationCount(next), 2);
});

test('an agent binds once and duplicate starts do not increase activity', () => {
  const reserved = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 2);
  const bound = bindSubagent(reserved, 'agent-1', 'reservation-1');
  const duplicate = bindSubagent(bound, 'agent-1', 'reservation-1');
  assert.deepEqual(bound.reservations['reservation-1'], {
    actionId: 'action-1',
    asyncLaunched: null,
    pendingCount: 1,
    agentIds: ['agent-1']
  });
  assert.deepEqual(duplicate, bound);
  assert.equal(activeDelegationCount(duplicate), 2);
});

test('stopping an unknown or already stopped agent is idempotent', () => {
  const reserved = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 1);
  const bound = bindSubagent(reserved, 'agent-1', 'reservation-1');
  const stopped = releaseSubagent(bound, 'agent-1');
  assert.equal(activeDelegationCount(stopped), 0);
  assert.deepEqual(releaseSubagent(stopped, 'agent-1'), stopped);
  const unknownStopped = releaseSubagent(stopped, 'unknown');
  assert.deepEqual(releaseSubagent(unknownStopped, 'unknown'), unknownStopped);
  assert.deepEqual(unknownStopped.stoppedAgentIds, ['agent-1', 'unknown']);
});

test('duplicate late starts consume at most one pending unit after stop-before-start', () => {
  let state = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 2);
  state = releaseSubagent(state, 'agent-1');
  state = bindSubagent(state, 'agent-1', 'reservation-1');
  assert.equal(activeDelegationCount(state), 1);
  assert.equal(state.reservations['reservation-1'].pendingCount, 1);

  const duplicate = bindSubagent(state, 'agent-1', 'reservation-1');
  assert.deepEqual(duplicate, state);
  assert.equal(activeDelegationCount(duplicate), 1);
  assert.equal(duplicate.reservations['reservation-1'].pendingCount, 1);
  assert.deepEqual(state.stoppedAgentIds, ['agent-1']);
});

test('late duplicate starts do not reactivate a later reservation', () => {
  let state = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 1);
  state = bindSubagent(state, 'agent-1', 'reservation-1');
  state = releaseSubagent(state, 'agent-1');
  state = reserveDelegation(state, 'reservation-2', 'action-2', 1);
  const duplicate = bindSubagent(state, 'agent-1', 'reservation-2');

  assert.equal(activeDelegationCount(duplicate), 1);
  assert.equal(duplicate.reservations['reservation-2'].pendingCount, 1);
  assert.deepEqual(duplicate.stoppedAgentIds, ['agent-1']);
});

test('late duplicate starts remain idempotent after action.after removed the reservation', () => {
  let state = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 1);
  state = bindSubagent(state, 'agent-1', 'reservation-1');
  state = releaseReservation(state, 'reservation-1');
  state = reserveDelegation(state, 'reservation-2', 'action-2', 1);

  const duplicate = bindSubagent(state, 'agent-1', 'reservation-2');
  assert.deepEqual(duplicate, state);
  assert.equal(duplicate.reservations['reservation-2'].pendingCount, 1);
});

test('after releases all remaining activity for one reservation', () => {
  let state = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 2);
  state = bindSubagent(state, 'agent-1', 'reservation-1');
  state = reserveDelegation(state, 'reservation-2', 'action-2', 1);
  const released = releaseReservation(state, 'reservation-1');
  assert.equal(activeDelegationCount(released), 1);
  assert.equal(released.reservations['reservation-1'], undefined);
});

test('session end clears reservations', () => {
  const state = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 2);
  const cleared = clearDelegations(state);
  assert.deepEqual(cleared.reservations, {});
  assert.equal(activeDelegationCount(cleared), 0);
});

test('readState migrates legacy agent state to schema 4', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-state-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = statePath('legacy-session', dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    contract: {
      mode: 'change',
      level: 'guard',
      agentBudget: 8,
      agentsUsed: 5,
      hashPolicy: 'allow',
      allowedPaths: ['src/**'],
      dependencyPolicy: 'deny',
      source: 'directive'
    },
    lastPromptContext: 'legacy context'
  }));

  const state = readState('legacy-session', dataDir);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.contract.mode, 'change');
  assert.equal(state.contract.hashPolicy, 'allow');
  assert.deepEqual(state.contract.allowedPaths, ['src/**']);
  assert.equal(state.contract.agentBudget, 8);
  assert.equal('totalAgentBudget' in state.contract, false);
  assert.equal('concurrentAgentBudget' in state.contract, false);
  assert.equal('agentsUsed' in state.contract, false);
  assert.deepEqual(state.delegation.reservations, {});
  assert.deepEqual(state.delegation.agentIdsSeen, []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 1);
  require('../src/controller.cjs').handleControlEvent({ protocolVersion: 1,
    kind: 'prompt.submit', sessionId: 'legacy-session', prompt: 'Continue' }, { dataDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).delegation.agentIdsSeen, []);
  assert.equal(state.directiveError, null);
  assert.equal(state.directiveWarning, null);
  assert.equal(state.lastPromptContext, null);
});

test('readState preserves a legacy zero agent budget', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-state-zero-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = statePath('legacy-zero', dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    contract: { mode: 'change', level: 'guard', agentBudget: 0, agentsUsed: 2 }
  }));

  const state = readState('legacy-zero', dataDir);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.contract.agentBudget, 0);
  assert.equal('totalAgentBudget' in state.contract, false);
  assert.deepEqual(state.delegation.reservations, {});
});

test('readState migrates current split state conservatively', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-state-split-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = statePath('split-session', dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    contract: {
      mode: 'change',
      level: 'guard',
      totalAgentBudget: 0,
      concurrentAgentBudget: Number.MAX_SAFE_INTEGER,
      directiveWarning: { code: 'DEPRECATED_AGENT_DIRECTIVE' }
    },
    delegation: {
      totalAgentsUsed: 9,
      reservations: {
        'reservation:old-call': {
          actionId: 'old-call',
          asyncLaunched: true,
          pendingCount: 1,
          agentIds: ['agent-old']
        }
      },
      agentIdsSeen: ['agent-old'],
      stoppedAgentIds: ['agent-stopped'],
      acceptedActions: { 'old-call': 2 }
    },
    directiveWarning: { code: 'DEPRECATED_AGENT_DIRECTIVE' },
    directiveError: null,
    lastPromptContext: 'old split context'
  }));

  const state = readState('split-session', dataDir);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.contract.agentBudget, 0);
  assert.equal(state.delegation.totalAgentsUsed, undefined);
  assert.equal(state.delegation.reservations['reservation:old-call'].pendingCount, 1);
  assert.deepEqual(state.delegation.agentIdsSeen, ['agent-old']);
  assert.deepEqual(state.delegation.stoppedAgentIds, ['agent-stopped']);
  assert.deepEqual(state.delegation.acceptedActions, { 'old-call': 2 });
  assert.equal(state.directiveWarning, null);
  assert.equal(state.lastPromptContext, null);
});

test('readState prefers a finite previous concurrent limit over total limit', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-state-priority-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = statePath('priority-session', dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    contract: { totalAgentBudget: 7, concurrentAgentBudget: 2 }
  }));

  assert.equal(readState('priority-session', dataDir).contract.agentBudget, 2);
});
