'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultContract } = require('./contracts.cjs');

const CURRENT_SCHEMA_VERSION = 4;

function dataRoot(override) {
  return override || process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'stop-that-shit-dev');
}

function sessionKey(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId || 'unknown')).digest('hex').slice(0, 24);
}

function statePath(sessionId, override) {
  return path.join(dataRoot(override), 'sessions', `${sessionKey(sessionId)}.json`);
}

function freshState() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    contract: defaultContract(),
    delegation: {
      reservations: {},
      agentIdsSeen: [],
      stoppedAgentIds: [],
      unresolved: {},
      acceptedActions: {}
    },
    directiveWarning: null,
    directiveError: null,
    lastPromptContext: null
  };
}

function recoveryState(error = { code: 'STATE_DAMAGED', message: 'The saved control state cannot be read. Read-only recovery is active; restore the state from a known-good backup or start a new host session. The damaged file has been preserved.' }) {
  const state = freshState();
  state.contract = { ...state.contract, mode: 'review', level: 'guard', source: 'recovery' };
  state.storageError = error;
  state.delegation.unresolved['state:damaged'] = 'state_unavailable';
  return state;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validAgentBudget(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function migratedAgentBudget(contract) {
  const legacyBudget = validAgentBudget(contract.agentBudget);
  if (legacyBudget !== null) return legacyBudget;

  const concurrentBudget = validAgentBudget(contract.concurrentAgentBudget);
  if (concurrentBudget !== null && concurrentBudget !== Number.MAX_SAFE_INTEGER) return concurrentBudget;

  const totalBudget = validAgentBudget(contract.totalAgentBudget);
  if (totalBudget !== null && totalBudget !== Number.MAX_SAFE_INTEGER) return totalBudget;

  return Number.MAX_SAFE_INTEGER;
}

function normalizeDelegation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const reservations = {};
  if (source.reservations && typeof source.reservations === 'object') {
    for (const [reservationId, reservation] of Object.entries(source.reservations)) {
      if (!reservation || typeof reservation !== 'object') continue;
      reservations[reservationId] = {
        reportedAliases: Array.isArray(reservation.reportedAliases) ? reservation.reportedAliases.filter(value => typeof value === 'string' && value) : [],
        completionScope: reservation.completionScope === 'call' ? 'call' : 'children',
        observedRunning: reservation.observedRunning === true || reservation.asyncLaunched === true,
        notStartedAmbiguous: reservation.notStartedAmbiguous === true,
        resultUnknown: reservation.resultUnknown === true,
        actionId: typeof reservation.actionId === 'string' ? reservation.actionId : '',
        asyncLaunched: typeof reservation.asyncLaunched === 'boolean' ? reservation.asyncLaunched : null,
        pendingCount: safeCount(reservation.pendingCount),
        agentIds: Array.isArray(reservation.agentIds)
          ? [...new Set(reservation.agentIds.filter((agentId) => typeof agentId === 'string' && agentId))]
          : []
      };
    }
  }
  const acceptedActions = source.acceptedActions && typeof source.acceptedActions === 'object'
    ? Object.fromEntries(Object.entries(source.acceptedActions)
      .filter(([actionId, count]) => typeof actionId === 'string' && actionId
        && Number.isSafeInteger(count) && count >= 0))
    : {};
  for (const reservation of Object.values(reservations)) {
    if (!reservation.actionId || Object.prototype.hasOwnProperty.call(acceptedActions, reservation.actionId)) continue;
    acceptedActions[reservation.actionId] = reservation.pendingCount + reservation.agentIds.length;
  }
  return {
    reservations,
    agentIdsSeen: Array.isArray(source.agentIdsSeen)
      ? [...new Set(source.agentIdsSeen.filter((agentId) => typeof agentId === 'string' && agentId))]
      : [],
    stoppedAgentIds: Array.isArray(source.stoppedAgentIds)
      ? [...new Set(source.stoppedAgentIds.filter((agentId) => typeof agentId === 'string' && agentId))]
      : [],
    acceptedActions,
    agentAliases: Object.fromEntries(Object.entries(source.agentAliases || {}).filter(([alias, id]) => alias && typeof id === 'string' && id)),
    unresolved: Object.fromEntries(Object.entries(source.unresolved || {}).filter(([key, reason]) => key && typeof reason === 'string' && reason))
  };
}

function normalizeState(parsed) {
  const fresh = freshState();
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const legacyContract = source.contract && typeof source.contract === 'object' ? source.contract : {};
  const contract = { ...fresh.contract, ...legacyContract };
  delete contract.agentBudget;
  contract.agentBudget = migratedAgentBudget(legacyContract);
  delete contract.totalAgentBudget;
  delete contract.concurrentAgentBudget;
  delete contract.agentsUsed;
  delete contract.directiveWarning;
  delete contract.directiveError;
  const delegation = normalizeDelegation(source.delegation);
  if (source.delegationLifecycleUnproven === true) delegation.unresolved['legacy:unproven'] = 'legacy_history_unverified';
  // Older versions could erase running work or omit it from the ledger. Even
  // an empty persisted ledger cannot establish a clean execution history.
  if (source.schemaVersion === undefined || source.schemaVersion < CURRENT_SCHEMA_VERSION) {
    delegation.unresolved['legacy:history'] = 'legacy_history_unverified';
  }
  const directiveWarning = source.directiveWarning && typeof source.directiveWarning === 'object'
    && source.directiveWarning.code !== 'DEPRECATED_AGENT_DIRECTIVE'
    ? source.directiveWarning
    : null;
  const directiveError = source.directiveError && typeof source.directiveError === 'object'
    && source.directiveError.code !== 'LEGACY_AGENT_DIRECTIVE'
    ? source.directiveError
    : null;
  const hasCurrentContract = Object.prototype.hasOwnProperty.call(legacyContract, 'agentBudget')
    && !Object.prototype.hasOwnProperty.call(legacyContract, 'totalAgentBudget')
    && !Object.prototype.hasOwnProperty.call(legacyContract, 'concurrentAgentBudget')
    && !Object.prototype.hasOwnProperty.call(legacyContract, 'agentsUsed');
  const hasCurrentDelegation = source.delegation
    && typeof source.delegation === 'object'
    && Object.prototype.hasOwnProperty.call(source.delegation, 'reservations')
    && Object.prototype.hasOwnProperty.call(source.delegation, 'agentIdsSeen')
    && Object.prototype.hasOwnProperty.call(source.delegation, 'stoppedAgentIds')
    && Object.prototype.hasOwnProperty.call(source.delegation, 'acceptedActions')
    && !Object.prototype.hasOwnProperty.call(source.delegation, 'totalAgentsUsed');
  const migrated = source.schemaVersion !== CURRENT_SCHEMA_VERSION
    || !hasCurrentContract
    || !hasCurrentDelegation
    || directiveWarning === null && source.directiveWarning !== null
    || directiveError === null && source.directiveError !== null;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    contract,
    delegation,
    directiveWarning,
    directiveError,
    lastPromptContext: migrated ? null : source.lastPromptContext ?? null
  };
}

function validStoredContract(contract, schemaVersion) {
  const checks = {
    mode: value => ['unconfirmed', 'answer', 'review', 'change', 'monitor', 'open'].includes(value),
    level: value => ['watch', 'guard', 'lock', 'off'].includes(value),
    agentBudget: value => validAgentBudget(value) !== null,
    hashPolicy: value => ['deny', 'ask', 'allow'].includes(value),
    dependencyPolicy: value => ['deny', 'ask', 'allow'].includes(value),
    allowedPaths: value => value === null || Array.isArray(value) && value.every(item => typeof item === 'string')
  };
  return Object.entries(checks).every(([key, check]) =>
    !Object.hasOwn(contract, key) && schemaVersion !== CURRENT_SCHEMA_VERSION || check(contract[key]));
}

function validStoredDelegation(value) {
  const record = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  const string = item => typeof item === 'string' && item.length > 0;
  const count = item => Number.isSafeInteger(item) && item >= 0;
  const strings = items => Array.isArray(items) && items.every(string) && new Set(items).size === items.length;
  const entries = (item, check) => record(item) && Object.entries(item).every(([key, entry]) => string(key) && check(entry));
  if (!record(value) || !record(value.reservations) || !strings(value.agentIdsSeen)
      || !strings(value.stoppedAgentIds) || !entries(value.acceptedActions, count)
      || !entries(value.unresolved, string)
      || value.agentAliases !== undefined && !entries(value.agentAliases, string)) return false;
  return Object.entries(value.reservations).every(([id, reservation]) => string(id) && record(reservation)
    && string(reservation.actionId) && count(reservation.pendingCount) && strings(reservation.agentIds)
    && Object.hasOwn(value.acceptedActions, reservation.actionId)
    && reservation.pendingCount + reservation.agentIds.length <= value.acceptedActions[reservation.actionId]
    && (reservation.reportedAliases === undefined || strings(reservation.reportedAliases))
    && (reservation.completionScope === undefined || ['call', 'children'].includes(reservation.completionScope))
    && (reservation.asyncLaunched == null || typeof reservation.asyncLaunched === 'boolean')
    && ['observedRunning', 'notStartedAmbiguous', 'resultUnknown'].every(key => reservation[key] === undefined || typeof reservation[key] === 'boolean'));
}

function readState(sessionId, override) {
  const file = statePath(sessionId, override);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || parsed.schemaVersion !== undefined && (!Number.isSafeInteger(parsed.schemaVersion)
          || parsed.schemaVersion < 1 || parsed.schemaVersion > CURRENT_SCHEMA_VERSION)
        || !parsed.contract || typeof parsed.contract !== 'object' || Array.isArray(parsed.contract)
        || !validStoredContract(parsed.contract, parsed.schemaVersion)
        || parsed.schemaVersion === CURRENT_SCHEMA_VERSION && !validStoredDelegation(parsed.delegation)) {
      throw new SyntaxError('Invalid control state structure');
    }
    // Reads may run without the session lock. Normalize in memory only;
    // the next locked mutation persists the current schema and latest ledger.
    return normalizeState(parsed);
  } catch (error) {
    if (error && error.code === 'ENOENT') return freshState();
    if (error && error.name === 'SyntaxError') {
      return recoveryState();
    }
    throw error;
  }
}

function writeState(sessionId, state, override) {
  const file = statePath(sessionId, override);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // Do not replace an atomic rename with a partial overwrite on Windows.
  try {
    // Concurrent readers can briefly prevent replacement on Windows. Keep the
    // same atomic rename and session lock; never fall back to partial overwrite.
    const started = Date.now();
    while (true) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM' || Date.now() - started >= 100) throw error;
        sleepSync(10);
      }
    }
  }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}


function lockPath(sessionId, override) {
  return `${statePath(sessionId, override)}.lock`;
}

function sleepSync(milliseconds) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, milliseconds);
}

function acquireSessionLock(sessionId, override, options = {}) {
  const file = lockPath(sessionId, override);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 10000;
  const started = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  while (true) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      const token = `${process.pid}:${crypto.randomUUID()}`;
      fs.writeFileSync(fd, `${token} ${Date.now()}\n`, 'utf8');
      return () => {
        try { fs.closeSync(fd); } catch {}
        try {
          const owner = fs.readFileSync(file, 'utf8').trim().split(/\s+/, 1)[0];
          if (owner === token) fs.unlinkSync(file);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(file);
          continue;
        }
      } catch (statError) {
        if (statError && statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - started >= timeoutMs) {
        const timeout = new Error(`Timed out waiting for Stop That Shit session lock: ${sessionKey(sessionId)}`);
        timeout.code = 'STS_LOCK_TIMEOUT';
        throw timeout;
      }
      sleepSync(10);
    }
  }
}

function withSessionLock(sessionId, override, fn, options) {
  const release = acquireSessionLock(sessionId, override, options);
  try {
    return fn();
  } finally {
    release();
  }
}

function updateSession(sessionId, override, update) {
  return withSessionLock(sessionId, override, () => {
    const state = readState(sessionId, override);
    const damaged = Boolean(state.storageError);
    const result = update(state);
    if (!damaged) writeState(sessionId, state, override);
    return result;
  });
}

module.exports = {
  updateSession,
  acquireSessionLock,
  dataRoot,
  freshState,
  recoveryState,
  readState,
  sessionKey,
  statePath,
  withSessionLock,
  writeState
};
