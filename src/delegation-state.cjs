'use strict';

function reservationsOf(state) {
  return state && state.reservations && typeof state.reservations === 'object'
    ? state.reservations
    : {};
}

function seenAgentIds(state) {
  return Array.isArray(state && state.agentIdsSeen) ? state.agentIdsSeen : [];
}

function stoppedAgentIds(state) {
  return Array.isArray(state && state.stoppedAgentIds) ? state.stoppedAgentIds : [];
}

function acceptedActions(state) {
  return state && state.acceptedActions && typeof state.acceptedActions === 'object'
    ? state.acceptedActions
    : {};
}

function acceptedActionCount(state, actionId) {
  if (typeof actionId !== 'string' || !actionId) return null;
  const count = acceptedActions(state)[actionId];
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function activeDelegationCount(state) {
  return Object.values(reservationsOf(state)).reduce((total, reservation) => {
    const pendingCount = Number.isSafeInteger(reservation && reservation.pendingCount) && reservation.pendingCount >= 0
      ? reservation.pendingCount
      : 0;
    const agentCount = Array.isArray(reservation && reservation.agentIds)
      ? reservation.agentIds.length
      : 0;
    return total + pendingCount + agentCount;
  }, 0);
}

function reserveDelegation(state, reservationId, actionId, count) {
  if (typeof reservationId !== 'string' || !reservationId) throw new TypeError('reservationId must be a non-empty string.');
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('reservation count must be a non-negative safe integer.');
  const reservations = reservationsOf(state);
  if (reservations[reservationId]) return state;
  const normalizedActionId = String(actionId || '');
  const priorCount = acceptedActionCount(state, normalizedActionId);
  if (priorCount !== null) return state;
  const accepted = { ...acceptedActions(state) };
  if (normalizedActionId) accepted[normalizedActionId] = count;
  return {
    ...state,
    acceptedActions: accepted,
    reservations: {
      ...reservations,
      [reservationId]: {
        actionId: normalizedActionId,
        asyncLaunched: null,
        pendingCount: count,
        agentIds: []
      }
    }
  };
}

function markReservationAsync(state, reservationId, asyncLaunched) {
  if (!reservationsOf(state)[reservationId] || typeof asyncLaunched !== 'boolean') return state;
  const reservation = reservationsOf(state)[reservationId];
  if (reservation.asyncLaunched === true || reservation.asyncLaunched === asyncLaunched) return state;
  return {
    ...state,
    reservations: {
      ...reservationsOf(state),
      [reservationId]: { ...reservation, asyncLaunched }
    }
  };
}

function bindSubagent(state, agentId, reservationId) {
  if (typeof agentId !== 'string' || !agentId) return state;
  if (seenAgentIds(state).includes(agentId)) return state;
  const reservations = reservationsOf(state);
  const reservation = reservations[reservationId];
  if (stoppedAgentIds(state).includes(agentId)) {
    if (!reservation || !Number.isInteger(reservation.pendingCount) || reservation.pendingCount <= 0) return state;
    const nextReservations = { ...reservations };
    if (reservation.pendingCount === 1 && (!Array.isArray(reservation.agentIds) || reservation.agentIds.length === 0)) {
      delete nextReservations[reservationId];
    } else {
      nextReservations[reservationId] = { ...reservation, pendingCount: reservation.pendingCount - 1 };
    }
    return {
      ...state,
      agentIdsSeen: [...new Set([...seenAgentIds(state), agentId])],
      reservations: nextReservations
    };
  }
  if (Object.values(reservations).some((reservation) => Array.isArray(reservation.agentIds) && reservation.agentIds.includes(agentId))) {
    return state;
  }
  if (!reservation || !Number.isInteger(reservation.pendingCount) || reservation.pendingCount <= 0) return state;
  return {
    ...state,
    agentIdsSeen: [...new Set([...seenAgentIds(state), agentId])],
    reservations: {
      ...reservations,
      [reservationId]: {
        ...reservation,
        pendingCount: reservation.pendingCount - 1,
        agentIds: [...(Array.isArray(reservation.agentIds) ? reservation.agentIds : []), agentId]
      }
    }
  };
}

function releaseSubagent(state, agentId) {
  if (typeof agentId !== 'string' || !agentId) return state;
  const stopped = stoppedAgentIds(state);
  const reservations = reservationsOf(state);
  for (const [reservationId, reservation] of Object.entries(reservations)) {
    const agentIds = Array.isArray(reservation.agentIds) ? reservation.agentIds : [];
    if (!agentIds.includes(agentId)) continue;
    const remainingAgents = agentIds.filter((value) => value !== agentId);
    const nextReservations = { ...reservations };
    if (reservation.pendingCount === 0 && remainingAgents.length === 0) {
      delete nextReservations[reservationId];
    } else {
      nextReservations[reservationId] = { ...reservation, agentIds: remainingAgents };
    }
    return {
      ...state,
      stoppedAgentIds: [...new Set([...stopped, agentId])],
      reservations: nextReservations
    };
  }
  if (stopped.includes(agentId)) return state;
  return { ...state, stoppedAgentIds: [...stopped, agentId] };
}

function releaseReservation(state, reservationId) {
  if (typeof reservationId !== 'string' || !reservationId || !reservationsOf(state)[reservationId]) return state;
  const reservations = { ...reservationsOf(state) };
  delete reservations[reservationId];
  return { ...state, reservations };
}

function clearDelegations(state) {
  return { ...state, reservations: {} };
}

function reservationForAction(state, actionId) {
  if (typeof actionId !== 'string' || !actionId) return null;
  for (const [reservationId, reservation] of Object.entries(reservationsOf(state))) {
    if (reservation && reservation.actionId === actionId) return reservationId;
  }
  return null;
}

// Callers consume this summary; reservation layout and deduplication stay here.
function inspectDelegation(state, intent = {}) {
  const acceptedCount = acceptedActionCount(state, intent.id);
  const count = intent.delegationCount ?? 0;
  return {
    reservedUpperBound: activeDelegationCount(state),
    unresolvedReasons: [...new Set(Object.values(state && state.unresolved || {}))],
    unknownResults: Object.values(reservationsOf(state)).filter(value => value.resultUnknown).length,
    alreadyReserved: acceptedCount !== null && acceptedCount === count,
    duplicateActionConflict: acceptedCount !== null && acceptedCount !== count
  };
}

function bindReportedAliases(state) {
  let next = state;
  for (const [id, reservation] of Object.entries(reservationsOf(state))) {
    if (reservation.completionScope === 'call') continue;
    for (const alias of reservation.reportedAliases || []) {
      const agentId = state.agentAliases && state.agentAliases[alias];
      if (agentId) next = bindSubagent(next, agentId, id);
    }
  }
  return next;
}

function applyDelegationFact(state, fact) {
  const actionId = fact.id;
  const reservationId = reservationForAction(state, actionId);
  if (fact.kind === 'accepted') {
    if (acceptedActionCount(state, actionId) !== null) return state;
    const id = `reservation:${actionId}`;
    let next = reserveDelegation(state, id, actionId, fact.count);
    next = { ...next, reservations: { ...next.reservations,
      [id]: { ...next.reservations[id], completionScope: fact.completionScope || 'children' } } };
    if (fact.uncertainty) next = { ...next, unresolved: { ...next.unresolved, [actionId]: fact.uncertainty } };
    return next;
  }
  if (fact.kind === 'joined' || fact.kind === 'not_started') {
    if (!reservationId && !Object.prototype.hasOwnProperty.call(state.unresolved || {}, actionId)) return state;
    // A late denial cannot contradict an already observed execution.
    const reservation = reservationsOf(state)[reservationId];
    if (fact.kind === 'not_started' && reservation && (reservation.observedRunning || reservation.agentIds.length)) return state;
    const unresolved = { ...state.unresolved };
    delete unresolved[actionId];
    return { ...releaseReservation(state, reservationId), unresolved };
  }
  if (fact.kind === 'running' || fact.kind === 'unknown') {
    if (!reservationId) return state;
    let next = state;
    if (fact.agentId && state.reservations[reservationId].completionScope !== 'call') {
      next = bindSubagent(next, fact.agentId, reservationId);
    }
    if (fact.agentAliases && next.reservations[reservationId]) {
      next = { ...next, reservations: { ...next.reservations, [reservationId]: {
        ...next.reservations[reservationId], reportedAliases: [...new Set(fact.agentAliases)] } } };
      next = bindReportedAliases(next);
    }
    const reservation = next.reservations[reservationId];
    if (!reservation) return next;
    return { ...next, reservations: { ...next.reservations,
      [reservationId]: { ...reservation,
        observedRunning: reservation.observedRunning || fact.kind === 'running',
        resultUnknown: fact.kind === 'unknown' } } };
  }
  if (fact.kind === 'child_started') {
    if (fact.agentAlias && fact.agentId) {
      state = bindReportedAliases({ ...state, agentAliases: { ...state.agentAliases, [fact.agentAlias]: fact.agentId } });
    }
    const reservation = reservationsOf(state)[fact.reservationId];
    if (reservation && reservation.completionScope === 'call') return state;
    return bindSubagent(state, fact.agentId, fact.reservationId);
  }
  if (fact.kind === 'child_stopped') return releaseSubagent(state, fact.agentId);
  if (fact.kind === 'all_stopped') return { ...clearDelegations(state), unresolved: {} };
  return state;
}

module.exports = {
  inspectDelegation,
  applyDelegationFact,
  acceptedActionCount,
  activeDelegationCount,
  bindSubagent,
  clearDelegations,
  markReservationAsync,
  releaseReservation,
  releaseSubagent,
  reserveDelegation,
  reservationForAction
};
