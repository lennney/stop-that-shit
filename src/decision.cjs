'use strict';

const nodePath = require('node:path');
const { DEFAULT_AGENT_LIMIT } = require('./contracts.cjs');
const { inspectDelegation } = require('./delegation-state.cjs');

function decision(outcome, family, reasonCode, explanation, nextStep) {
  return { outcome, family, reasonCode, explanation, nextStep };
}

function controlledOutcome(level, guarded = 'deny_and_explain') {
  return level === 'watch' ? 'report_and_defer' : guarded;
}

function isWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(String(value || ''));
}

function normalizeComparablePath(value, cwd) {
  let normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  const base = String(cwd || '').trim();
  if (base && isWindowsAbsolute(normalized) && isWindowsAbsolute(base)) {
    normalized = nodePath.win32.relative(base, normalized).replace(/\\/g, '/');
  } else if (base && nodePath.posix.isAbsolute(normalized) && nodePath.posix.isAbsolute(base.replace(/\\/g, '/'))) {
    normalized = nodePath.posix.relative(base.replace(/\\/g, '/'), normalized);
  }
  return nodePath.posix.normalize(normalized).replace(/^\.\//, '');
}

function pathAllowed(path, allowedPaths, cwd) {
  const normalizedPath = normalizeComparablePath(path, cwd);
  return allowedPaths.some((value) => {
    const allowed = normalizeComparablePath(value, cwd);
    const caseInsensitive = isWindowsAbsolute(cwd) || (isWindowsAbsolute(path) && isWindowsAbsolute(value));
    const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
    const comparableAllowed = caseInsensitive ? allowed.toLowerCase() : allowed;
    if (comparableAllowed === '**') return true;
    if (comparableAllowed.endsWith('/**')) {
      const base = comparableAllowed.slice(0, -3);
      return comparablePath === base || comparablePath.startsWith(`${base}/`);
    }
    return comparablePath === comparableAllowed;
  });
}

function decide({ contract, action, state = {}, delegation = inspectDelegation(state.delegation) }) {
  const mode = contract.mode || 'unconfirmed';
  const level = contract.level || 'watch';

  const delegationCount = action.mutability === 'delegate'
    ? (Number.isInteger(action.delegationCount) ? action.delegationCount : 1)
    : 0;
  if (level === 'off' || mode === 'unconfirmed') {
    return decision('allow', null, 'CONTROL_INACTIVE', 'No confirmed enforcing contract is active.', null);
  }
  if (action.mutability === 'delegate' && state.directiveError) {
    return decision(
      controlledOutcome(level),
      'S',
      'INVALID_DIRECTIVE',
      `The active Stop That Shit directive is invalid: ${state.directiveError.message || state.directiveError.code || 'unknown directive error'}.`,
      'Submit a corrected agents=N directive before delegating.'
    );
  }

  const agentBudget = Number.isSafeInteger(contract.agentBudget) && contract.agentBudget >= 0
    ? contract.agentBudget
    : DEFAULT_AGENT_LIMIT;
  if (action.legacyDelegationProtocol && agentBudget < DEFAULT_AGENT_LIMIT) {
    return decision(
      controlledOutcome(level),
      'S',
      'LIFECYCLE_PROTOCOL_REQUIRED',
      'This adapter has no supported lifecycle declaration, so it cannot prove that delegation and resume actions obey the finite limit.',
      'Update the host adapter and runtime together before using agents=N. Ordinary read and write actions remain available.'
    );
  }

  const nonMutatingMode = ['answer', 'review', 'monitor'].includes(mode);
  if (nonMutatingMode && action.mutability === 'write') {
    return decision(
      controlledOutcome(level),
      'I',
      'MODE_FORBIDS_MUTATION',
      `Task mode ${mode} does not authorize repository mutation.`,
      'Report the finding, use a read-only action, or obtain an explicit change contract.'
    );
  }

  if (nonMutatingMode && action.mutability === 'unknown') {
    return decision(
      controlledOutcome(level, 'require_user_approval'),
      'I',
      'MUTABILITY_UNPROVEN',
      `The proposed action is not proven read-only under ${mode} mode.`,
      'Use a clearly read-only command or obtain an explicit change contract.'
    );
  }

  if (action.hashIntent && contract.hashPolicy !== 'allow') {
    const requiresApproval = contract.hashPolicy === 'ask';
    return decision(
      controlledOutcome(level, requiresApproval ? 'require_user_approval' : 'deny_and_explain'),
      'H',
      'HASH_NOT_AUTHORIZED',
      `The action introduces or runs hashing while the active contract is hash=${contract.hashPolicy || 'deny'}.`,
      'Use a direct alternative, or obtain explicit hash=allow authority and name the consumer, the cost it replaces, and the decision it changes.'
    );
  }

  if (action.reachability === 'unreachable') {
    return decision(
      'report_and_defer',
      'H',
      'HYPOTHETICAL_UNREACHABLE',
      'The proposed hardening has no supported reachable input or deployed state.',
      'Defer it unless project evidence establishes reachability.'
    );
  }

  if (Array.isArray(contract.allowedPaths)) {
    const affectedPaths = Array.isArray(action.affectedPaths) ? action.affectedPaths : [];
    if (['write', 'unknown'].includes(action.mutability) && affectedPaths.length === 0 && !contract.allowedPaths.includes('**')) {
      return decision(
        controlledOutcome(level, 'require_user_approval'),
        'S',
        'WRITE_PATH_UNPROVEN',
        'The action may write through a tool whose target path is not proven inside the declared file boundary.',
        'Use apply_patch or an Edit tool with visible paths, or obtain approval for an explicit broader boundary.'
      );
    }
    const outside = affectedPaths.filter((path) => !pathAllowed(path, contract.allowedPaths, action.cwd));
    if (outside.length) {
      return decision(
        controlledOutcome(level),
        'S',
        'PATH_OUTSIDE_CONTRACT',
        `The action writes outside the declared file boundary: ${outside.join(', ')}.`,
        'Keep the write inside files=..., or obtain a new explicit file boundary.'
      );
    }
  }

  if (action.dependencyIntent && contract.dependencyPolicy !== 'allow') {
    const requiresApproval = contract.dependencyPolicy === 'ask';
    return decision(
      controlledOutcome(level, requiresApproval ? 'require_user_approval' : 'deny_and_explain'),
      'S',
      'DEPENDENCY_NOT_AUTHORIZED',
      `The action adds a dependency while the active contract is deps=${contract.dependencyPolicy || 'ask'}.`,
      'Use the existing stack, or obtain explicit deps=allow authority for the named dependency.'
    );
  }

  if (action.mutability === 'delegate' && action.unboundedDelegation) {
    return decision(
      controlledOutcome(level),
      'S',
      'UNBOUNDED_DELEGATION',
      'The proposed delegation can fan out to an unbounded number of subagents, so it cannot satisfy the configured agent limits deterministically.',
      'Use an explicit bounded delegation batch, or disable the Guard for a deliberately unbounded workflow.'
    );
  }

  if (action.mutability === 'delegate' && action.duplicateActionConflict) {
    return decision(
      controlledOutcome(level),
      'S',
      'DUPLICATE_ACTION_ID',
      'The host reused an action identifier with a different delegation count, so the request cannot be charged safely.',
      'Use a unique action identifier for each delegation call.'
    );
  }

  const activeAgents = delegation.reservedUpperBound;
  if (action.mutability === 'delegate' && delegation.unresolvedReasons.length > 0
      && agentBudget < DEFAULT_AGENT_LIMIT) {
    return decision(
      controlledOutcome(level),
      'S',
      'DELEGATION_STATE_UNPROVEN',
      `Earlier permitted activity has no proven bound: ${delegation.unresolvedReasons.join(', ')}.`,
      'Wait for confirmed completion of the affected call. If the host cannot identify its completion, use a new session for a finite limit.'
    );
  }
  if (action.delegationLifecycleUnproven && agentBudget < DEFAULT_AGENT_LIMIT) {
    return decision(
      controlledOutcome(level),
      'S',
      'DELEGATION_LIFECYCLE_UNPROVEN',
      'This action can restart an existing agent, but the host does not identify each run in its completion events.',
      'Use a new delegation call so agents=N can track its completion. Messaging and resuming remain available without a finite agent limit.'
    );
  }
  if (action.mutability === 'delegate' && !action.alreadyReserved && activeAgents + delegationCount > agentBudget) {
    return decision(
      controlledOutcome(level),
      'S',
      'AGENT_BUDGET_EXHAUSTED',
      `The session allows ${agentBudget} concurrently active subagent(s), with ${activeAgents} units reserved, and this action requires ${delegationCount}.`,
      delegation.unknownResults ? 'A tool returned without proof that its child work ended. Collect a supported completion result before reusing its reserved capacity.' : 'Wait for the current delegation to complete or increase agents=N in a corrected directive.'
    );
  }

  if (action.authorization === 'unapproved_expansion') {
    return decision(
      controlledOutcome(level, 'require_user_approval'),
      'S',
      'UNAPPROVED_SCOPE_EXPANSION',
      'The action is neither requested nor established as a necessary consequence.',
      'Report or defer it, or obtain explicit approval for the expansion.'
    );
  }

  return decision('allow', null, 'WITHIN_CONTRACT', 'The action is within the active task contract.', null);
}

module.exports = { decide };
