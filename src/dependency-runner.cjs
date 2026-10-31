'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { readState } = require('./state.cjs');
const { live, proposalStillAllowed } = require('./action-approval.cjs');
const { bindingForRecord, consumeHandoff, withCoordinationLock } = require('./dependency-handoff.cjs');
const { unchanged } = require('./dependency-manager.cjs');
const { decide } = require('./decision.cjs');
const { inspectDelegation } = require('./delegation-state.cjs');
const approvalScope = require('./approval-scope.cjs');

function claim(sessionId, dataDir, ticket, agentId = '') {
  return withCoordinationLock(sessionId, dataDir, () => {
    let state;
    let contract;
    if (agentId) {
      const store = require('./state.cjs');
      const contracts = require('./contracts.cjs');
      if (typeof store.childStatePath !== 'function' || typeof contracts.narrowContract !== 'function'
          || store.childStatePath(sessionId, agentId, dataDir) === store.statePath(sessionId, dataDir)) {
        throw new Error('Child-scoped approval is unavailable');
      }
      const parent = readState(sessionId, dataDir);
      state = readState(sessionId, dataDir, { agentId });
      if (parent.storageError || state.storageError) throw new Error('Approval policy state is unavailable');
      contract = approvalScope.effectiveChildContract(parent.contract, state.contract);
    } else {
      state = readState(sessionId, dataDir);
      contract = state.contract;
    }
    const record = state.actionApproval;
    if (state.storageError || !live(record) || record.status !== 'issued' || record.ticket !== ticket
        || (agentId ? record.scopeAgentId !== agentId : record.scopeAgentId !== undefined)
        || contract.mode !== 'change' || contract.level !== 'guard'
        || contract.dependencyPolicy !== 'ask'
        || !proposalStillAllowed(record, contract, state)) throw new Error('Approval is unavailable or expired');
    if (!record.requestedCwd || !record.targetCwd || fs.realpathSync(record.requestedCwd) !== record.targetCwd
        || fs.realpathSync(record.targetCwd) !== record.targetCwd || !fs.statSync(record.targetCwd).isDirectory()) throw new Error('Approved directory changed');
    if (!unchanged(record.manager.entry)
        || record.manager.kind === 'native' && (!record.manager.launchPath || fs.realpathSync(record.manager.launchPath) !== record.manager.entry.path)
        || record.manager.kind === 'node' && !unchanged(record.manager.executable)) throw new Error('Approved package manager changed');
    if (!record.approvedAction || typeof record.approvedAction !== 'object') throw new Error('Approved action facts unavailable');
    const action = { ...record.approvedAction, cwd: record.targetCwd, dependencyIntent: false };
    const decision = decide({ contract, action, delegation: inspectDelegation(state.delegation), state });
    if (decision.outcome !== 'allow') throw new Error(`Approved operation no longer satisfies current policy: ${decision.reasonCode}`);
    consumeHandoff(record.handoff, bindingForRecord(sessionId, record, ticket));
    return { cwd: record.targetCwd, manager: record.manager, args: record.argv.slice(1) };
  });
}

function main(sessionId, dataDir, ticket, agentId = '') {
  if (!sessionId || !dataDir || !/^[a-f0-9]{64}$/.test(ticket || '')) throw new Error('Invalid approval ticket');
  if (agentId && (typeof agentId !== 'string' || !agentId.trim() || Buffer.byteLength(agentId, 'utf8') > 4096)) {
    throw new Error('Invalid approval scope');
  }
  const operation = claim(sessionId, dataDir, ticket, agentId);
  const executable = operation.manager.kind === 'node' ? operation.manager.executable.path : operation.manager.launchPath;
  const args = operation.manager.kind === 'node' ? [operation.manager.entry.path, ...operation.args] : operation.args;
  const child = spawn(executable, args, { cwd: operation.cwd, shell: false, stdio: 'inherit' });
  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardTermination = () => child.kill('SIGTERM');
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTermination);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off('SIGINT', forwardInterrupt);
      process.off('SIGTERM', forwardTermination);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (status, signal) => {
      cleanup();
      resolve(Number.isInteger(status) ? status : signal === 'SIGINT' ? 130 : 1);
    });
  });
}

async function run(sessionId, dataDir, ticket, agentId = '') {
  try { process.exitCode = await main(sessionId, dataDir, ticket, agentId); }
  catch (error) { process.stderr.write(`Stop That Shit: controlled dependency operation failed: ${error.message}\n`); process.exitCode = 1; }
}

if (require.main === module) run(...process.argv.slice(2));
module.exports = { run };
