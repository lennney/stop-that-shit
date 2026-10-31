'use strict';

const path = require('node:path');
const stateStore = require('./state.cjs');
const contracts = require('./contracts.cjs');

function agentIdFor(event) {
  const value = event && event.agent && event.agent.agentId;
  return typeof value === 'string' && value.trim() && Buffer.byteLength(value, 'utf8') <= 4096 ? value : null;
}

function scopedCapability(sessionId, agentId, dataDir) {
  if (typeof stateStore.childStatePath !== 'function' || typeof contracts.narrowContract !== 'function') return null;
  try {
    const childPath = stateStore.childStatePath(sessionId, agentId, dataDir);
    const parentPath = stateStore.statePath(sessionId, dataDir);
    return typeof childPath === 'string' && typeof parentPath === 'string'
      && path.resolve(childPath) !== path.resolve(parentPath) ? childPath : null;
  } catch { return null; }
}

function resolve(event, options) {
  if (!event || event.agent === undefined || event.agent === null) return { child: false, available: true, agentId: null };
  const agentId = agentIdFor(event);
  if (!agentId) return { child: true, available: false, agentId: null };
  const childPath = scopedCapability(event.sessionId, agentId, options.dataDir);
  return { child: true, available: Boolean(childPath), agentId, childPath };
}

function effectiveChildContract(parentContract, childContract) {
  // Keep the host's child contract semantics. Parent constraints are applied
  // only to the returned effective contract, never copied into child state.
  return contracts.narrowContract(parentContract, childContract);
}

function read(event, options) {
  const scope = resolve(event, options);
  if (!scope.child) {
    const state = stateStore.readState(event.sessionId, options.dataDir);
    return { ...state, scope, childContract: state.contract, effectiveContract: state.contract };
  }
  if (!scope.available) return { scope, storageError: { code: 'CHILD_SCOPE_UNAVAILABLE', message: 'Child-scoped policy state is unavailable.' } };
  const parent = stateStore.readState(event.sessionId, options.dataDir);
  const child = stateStore.readState(event.sessionId, options.dataDir, { agentId: scope.agentId });
  if (parent.storageError || child.storageError) return { ...child, scope, storageError: parent.storageError || child.storageError };
  let effectiveContract;
  try { effectiveContract = effectiveChildContract(parent.contract, child.contract); }
  catch { return { ...child, scope, storageError: { code: 'CHILD_SCOPE_UNAVAILABLE', message: 'Child-scoped policy state is unavailable.' } }; }
  return { ...child, scope, parentContract: parent.contract, childContract: child.contract, effectiveContract, contract: effectiveContract };
}

function update(event, options, callback) {
  const scope = resolve(event, options);
  if (!scope.child) return stateStore.updateSession(event.sessionId, options.dataDir, callback);
  if (!scope.available) throw new Error('Child-scoped policy state is unavailable.');
  const { withCoordinationLock } = require('./dependency-handoff.cjs');
  return withCoordinationLock(event.sessionId, options.dataDir, () => {
    const parent = stateStore.readState(event.sessionId, options.dataDir);
    if (parent.storageError) throw new Error('Parent policy state is unavailable.');
    return stateStore.updateSession(event.sessionId, options.dataDir, child => {
      const scoped = read(event, options);
      if (scoped.storageError) throw new Error('Child policy state is unavailable.');
      scoped.actionApproval = child.actionApproval;
      scoped.expiredApprovalEventId = child.expiredApprovalEventId;
      scoped.delegation = child.delegation;
      const result = callback(scoped, scoped.effectiveContract);
      child.actionApproval = scoped.actionApproval;
      child.expiredApprovalEventId = scoped.expiredApprovalEventId;
      child.delegation = scoped.delegation;
      child.directiveWarning = scoped.directiveWarning;
      child.directiveError = scoped.directiveError;
      child.lastPromptContext = scoped.lastPromptContext;
      // Contract mutation is intentionally handled by the child prompt path,
      // which parses against childContract and writes that explicit contract.
      if (scoped.childContract !== undefined) child.contract = scoped.childContract;
      return result;
    }, { agentId: scope.agentId });
  });
}

function policyDigest(contract) {
  if (!contract || typeof contract !== 'object') return null;
  const bound = {
    mode: contract.mode,
    level: contract.level,
    hashPolicy: contract.hashPolicy,
    dependencyPolicy: contract.dependencyPolicy,
    allowedPaths: contract.allowedPaths === null ? null : Array.isArray(contract.allowedPaths) ? [...contract.allowedPaths].sort() : undefined
  };
  if (Object.values(bound).some(value => value === undefined)) return null;
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(JSON.stringify(bound)).digest('hex');
}

module.exports = { agentIdFor, resolve, read, update, policyDigest, effectiveChildContract };
