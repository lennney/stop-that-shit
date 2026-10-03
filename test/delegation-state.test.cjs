'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  activeDelegationCount,
  bindSubagent,
  clearDelegations,
  releaseReservation,
  releaseSubagent,
  reserveDelegation
} = require('../src/delegation-state.cjs');

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
