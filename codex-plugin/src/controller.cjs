'use strict';

const { DEFAULT_AGENT_LIMIT, parseContractPrompt } = require('./contracts.cjs');
const { SHELL_ANALYSIS_REASONS, isShellAnalysisReason, assertControlEvent, supportsLifecycleFacts } = require('./control-protocol.cjs');
const delegationState = require('./delegation-state.cjs');
const { inspectDelegation, applyDelegationFact } = delegationState;
const { decide } = require('./decision.cjs');
const { readRuntime, recordDecision } = require('./runtime-audit.cjs');
const { recordAnnotation } = require('./runtime-annotations.cjs');
const { readState, recoveryState, updateSession, dataRoot } = require('./state.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const approval = require('./action-approval.cjs');
const approvalScope = require('./approval-scope.cjs');
const { buildRunnerCommand } = require('./runner-command.cjs');
const { bindingForRecord, createHandoff, handoffAvailable, withCoordinationLock } = require('./dependency-handoff.cjs');
// Keep the executable helper in the hook's statically discoverable dependency graph.
require('./dependency-runner.cjs');

function none() {
  return { kind: 'none' };
}

function targetIsActive(state, agentId) {
  // PR109 adds authoritative target resolution. Without that API, retain the
  // existing conservative lifecycle decision instead of guessing from names.
  return typeof delegationState.isActiveAgent === 'function'
    && delegationState.isActiveAgent(state, agentId);
}

function context(text) {
  return { kind: 'context', text };
}

function coordinatedUpdate(event, options, update) {
  // The runner shares this temp-root lock while claiming its one-time handoff.
  // Hook writers take it before the private ledger lock so policy changes and
  // runner claims have a single ordering without making the runner write private state.
  return withCoordinationLock(event.sessionId, options.dataDir,
    () => updateSession(event.sessionId, options.dataDir, update));
}

function contractFields(contract, summary) {
  const limit = Number.isSafeInteger(contract.agentBudget) && contract.agentBudget >= 0 ? contract.agentBudget : DEFAULT_AGENT_LIMIT;
  return `mode=${contract.mode}; agents=${summary.reservedUpperBound}/${limit} reserved${summary.unresolvedReasons.length ? '; count unproven' : ''}; hash=${contract.hashPolicy || 'deny'}; deps=${contract.dependencyPolicy || 'ask'}; files=${Array.isArray(contract.allowedPaths) ? contract.allowedPaths.join('|') : 'unbounded'}.`;
}

function contractContext(contract, delegation = {}, phase = 'active', directiveWarning = null, storageError = null) {
  if (contract.source === 'recovery' && storageError) return `${storageError.code}: ${storageError.message}`;
  if (contract.source === 'recovery') return 'STATE_DAMAGED: the saved contract is unavailable. Read-only recovery is active. Restore a known-good backup or start a new host session; the damaged file is preserved.';
  if (typeof delegation === 'string') {
    phase = delegation;
    delegation = {};
  }
  if (contract.level === 'off') {
    return [
      directiveWarning && directiveWarning.message ? `Warning: ${directiveWarning.message}` : null,
      'Stop That Shit is disabled for this session. No plugin decision is being enforced.'
    ].filter(Boolean).join(' ');
  }
  if (contract.mode === 'unconfirmed') {
    return [
      directiveWarning && directiveWarning.message ? `Warning: ${directiveWarning.message}` : null,
      'Stop That Shit is in watch-only mode because no task mode is confirmed.',
      'Use $stop-that-shit review for read-only work, or change for implementation. The default fast path relies on the Stop Ladder and does not claim a full machine contract.',
      'Do not claim that mutations are being blocked until a mode is confirmed.'
    ].filter(Boolean).join(' ');
  }

  return [
    directiveWarning && directiveWarning.message ? `Warning: ${directiveWarning.message}` : null,
    `Stop That Shit (${phase}): ${contractFields(contract, inspectDelegation(delegation))}`,
    'Stop Ladder: Is it requested? Is it necessary? What reachable evidence proves that? Would omission fail the current acceptance?',
    'Report real findings even when implementation is not authorized.',
    'Before expanding scope, name reachable evidence, failure if omitted, and the fact that changes the next action.',
    'Harness interception coverage is a guardrail, not a security boundary.'
  ].filter(Boolean).join(' ');
}

const FAMILY_NAMES = { I: 'INTENT', H: 'HASH', S: 'SCOPE', T: 'THRASH' };

function activeControlState(contract) {
  if (contract.level === 'off') return 'OFF';
  return contract.level === 'watch' ? 'OBSERVING' : 'ARMED';
}

function decisionMessage(result, contract, event, responseOutcome, analysisReason) {
  const observing = responseOutcome === 'context_returned';
  const executionDenial = responseOutcome === 'execution_denial_returned';
  const lines = [
    `${observing ? 'WATCH' : 'STOP'} / ${FAMILY_NAMES[result.family] || result.family || 'CONTROL'}`,
    observing
      ? 'Guard returned context; it did not deny the action.'
      : executionDenial ? 'Guard returned a pre-execution denial.' : 'Guard returned permission deny.',
    `Reason: ${result.reasonCode}`,
    ...(result.explanation ? [`Detail: ${result.explanation}`] : []),
    `Code: ${result.family}/${result.reasonCode}`,
    `State: ${activeControlState(contract)} / ${contract.mode}`
  ];
  if (event) lines.push(`Event: ${event.eventId}`);
  if (result.nextStep) lines.push(`Next: ${result.nextStep}`);
  return lines.join('\n');
}

function runtimeCommand(prompt) {
  const match = /^(?:[ \t]*\r?\n)* {0,3}\$(?:stop-that-shit:)?stop-that-shit[ \t]+(status|runtime(?:[ \t]+all)?|explain[ \t]+(evt_[0-9a-f-]+)|label[ \t]+(evt_[0-9a-f-]+)[ \t]+(correct|incorrect|inconclusive))[ \t]*(?:\r?\n[ \t]*)*$/i.exec(prompt);
  if (!match) return null;
  const words = match[1].toLowerCase().split(/\s+/);
  return { name: words[0], all: words[1] === 'all', eventId: match[2] || match[3] || null, label: match[4] || null };
}

function runtimeSummaryText(runtime) {
  const { summary } = runtime;
  const labels = summary.labels;
  const lines = [
    'Stop That Shit runtime (host effect remains unobserved)',
    `Checked actions: ${summary.checkedActions}`,
    `Context responses: ${summary.contextResponses}`,
    `Permission-deny responses: ${summary.permissionDenyResponses}`
  ];
  if (summary.executionDenialResponses) {
    lines.push(`Execution-denial responses: ${summary.executionDenialResponses}`);
  }
  lines.push(
    `Labels: correct=${labels.correct}; incorrect=${labels.incorrect}; inconclusive=${labels.inconclusive}`,
    `Damaged records ignored: ${summary.damagedRecords}`
  );
  return lines.join('\n');
}

function handleRuntimeCommand(command, event, state, options) {
  if (command.name === 'status') {
    const summary = inspectDelegation(state.delegation);
    return context([
      'Stop That Shit status',
      `State: ${activeControlState(state.contract)} / ${state.contract.mode}`,
      contractFields(state.contract, summary),
      `Authority source: ${state.contract.source || 'unconfirmed'}`,
      ...(state.storageError ? [`${state.storageError.code}: ${state.storageError.message}`] : []),
      ...(state.directiveError ? [`Directive error: ${state.directiveError.code}: ${state.directiveError.message}`] : []),
      ...(summary.unresolvedReasons.length
        ? [`Unresolved activity: ${summary.unresolvedReasons.join(', ')}. A confirmed completion or a new host session is required; do not reset the ledger.`] : []),
      'Host effect: unobserved',
      'Use runtime for checked-action and Guard-response counts.'
    ].join('\n'));
  }
  if (command.name === 'runtime') {
    const query = command.all ? {} : { sessionId: event.sessionId };
    return context(runtimeSummaryText(readRuntime(query, options)));
  }
  const runtime = readRuntime({ eventId: command.eventId }, options);
  if (runtime.events.length === 0) return context(`Stop That Shit runtime event not found: ${command.eventId}`);
  if (command.name === 'label') {
    const annotation = recordAnnotation(command.eventId, command.label, options);
    return context(annotation
      ? `Stop That Shit label recorded: ${command.eventId} = ${command.label}`
      : `Stop That Shit could not record label for ${command.eventId}.`);
  }
  const found = runtime.events[0];
  return context([
    `Stop That Shit event ${found.eventId}`,
    `State: ${found.controlState.toUpperCase()} / ${found.contract.mode}`,
    `Action: ${found.action.toolName} (${found.action.mutability}); paths=${found.action.pathCount}`,
    ...(isShellAnalysisReason(found.action.analysisReason)
      ? [`Analysis: ${SHELL_ANALYSIS_REASONS[found.action.analysisReason]}`] : []),
    `Decision: ${found.decision.policyOutcome} / ${found.decision.reasonCode}`,
    `Response: ${found.decision.responseOutcome}`,
    `Host effect: ${found.decision.hostEffect}`,
    `Label: ${found.label || 'unlabeled'}`
  ].join('\n'));
}

function handlePrompt(event, state) {
  if (state.storageError) return context(`${state.storageError.code}: ${state.storageError.message}`);
  const previousContract = state.scope?.child ? state.childContract : state.contract;
  const parsed = parseContractPrompt(event.prompt, previousContract);
  if (parsed.error) {
    state.directiveError = parsed.error;
    state.directiveWarning = null;
    state.lastPromptContext = null;
    return { kind: 'prompt-error', error: parsed.error, message: parsed.error.message };
  }
  if (state.scope?.child) {
    if (parsed.directive || parsed.correction) state.childContract = parsed.contract;
    state.contract = approvalScope.effectiveChildContract(state.parentContract, state.childContract);
  } else state.contract = parsed.contract;
  let reply;
  const replyEnvelope = /^\s*<send_user_message_question_reply>[\s\S]*<\/send_user_message_question_reply>\s*$/.test(event.prompt);
  if (replyEnvelope && state.scope?.child && state.actionApproval
      && state.actionApproval.scopeAgentId !== state.scope.agentId) {
    reply = { status: 'unavailable' };
  } else if (replyEnvelope && state.actionApproval
      && !approval.proposalStillAllowed(state.actionApproval, state.contract, state)) {
    state.actionApproval.status = 'consumed';
    reply = { status: 'unavailable' };
  } else reply = approval.acceptReply(state.actionApproval, event.prompt);
  if (state.contract.mode !== 'change' || state.contract.dependencyPolicy !== 'ask' || state.contract.level !== 'guard') {
    state.actionApproval = null;
    if (reply) reply.status = 'unavailable';
  }
  if (parsed.directive || parsed.correction) state.directiveError = null;
  if (parsed.directive || parsed.correction) state.directiveWarning = parsed.directive ? parsed.warning : null;
  const promptContext = contractContext(state.contract, state.delegation, 'active', parsed.warning || state.directiveWarning, state.storageError);
  const repeatedContext = state.lastPromptContext === promptContext;
  state.lastPromptContext = promptContext;
  if (reply) {
    const acknowledgment = reply.status === 'approved'
      ? `One-time approval is available for ${reply.eventId} in ${reply.targetCwd}. Retry the same operation; session deps=ask remains unchanged.`
      : reply.status === 'denied'
        ? `One-time approval for ${reply.eventId} was denied. No operation was authorized; session deps=ask remains unchanged.`
        : 'No one-time approval was accepted: the question is unavailable, expired or does not match. The dependency policy is unchanged.';
    return context(`${promptContext}\n${acknowledgment}`);
  }
  if (parsed.warning) return { ...context(promptContext), warning: parsed.warning };
  return repeatedContext ? none() : context(promptContext);
}

function handleScopedPrompt(event, options) {
  const scope = approvalScope.resolve(event, options);
  if (!scope.available) {
    // A child prompt must never rewrite the parent contract when this runtime
    // lacks the host's real child-state API. Contract changes fail closed;
    // ordinary child conversation remains read-only.
    const parent = readState(event.sessionId, options.dataDir);
    const parsed = parseContractPrompt(event.prompt, parent.contract);
    if (parsed.error) return { kind: 'prompt-error', error: parsed.error, message: parsed.error.message };
    if (parsed.directive || parsed.correction || /<send_user_message_question_reply>/.test(event.prompt)) {
      return { kind: 'prompt-error', error: { code: 'CHILD_SCOPE_UNAVAILABLE' },
        message: 'Stop That Shit: child-scoped policy and approval state are unavailable; no parent state was changed.' };
    }
    return none();
  }
  try {
    return approvalScope.update(event, options, state => handlePrompt(event, state));
  } catch {
    return { kind: 'prompt-error', error: { code: 'CHILD_SCOPE_UNAVAILABLE' },
      message: 'Stop That Shit: child-scoped policy state is unavailable; no parent state was changed.' };
  }
}

function handleApprovalAction(event, options) {
  const scope = approvalScope.resolve(event, options);
  if (scope.child && !scope.available) {
    return { kind: 'deny', message: 'Stop That Shit: child-scoped approval state is unavailable; action denied.' };
  }
  let orphanedHandoff = null;
  try {
    const mutate = state => {
    if (state.storageError) return { kind: 'deny', message: state.storageError.message };
    const summary = inspectDelegation(state.delegation, { id: event.action.id });
    const action = { ...event.action, duplicateActionId: summary.duplicateActionId };
    let result = decide({ contract: state.contract, action, delegation: summary, state });
    let usedApproval = null;
    let rewrittenCommand = null;
    const record = state.actionApproval;
    if (approval.live(record) && record.status === 'issued'
        && !handoffAvailable(record.handoff, bindingForRecord(event.sessionId, record))) {
      record.status = 'consumed';
      delete record.ticket;
      delete record.handoff;
    }
    if (result.reasonCode === 'DEPENDENCY_NOT_AUTHORIZED' && state.contract.dependencyPolicy === 'ask'
        && state.contract.mode === 'change' && state.contract.level === 'guard' && approval.live(record)
        && ['approved', 'issued'].includes(record.status) && event.action.id !== record.deniedActionId
        && approval.digest(event) === record.digest
        && (scope.child ? record.scopeAgentId === scope.agentId : record.scopeAgentId === undefined)
        && approval.proposalStillAllowed(record, state.contract, state)) {
      const remaining = decide({ contract: state.contract, action: { ...action, dependencyIntent: false }, delegation: summary, state });
      if (remaining.outcome === 'allow') {
        const ticket = record.status === 'issued' ? record.ticket : crypto.randomBytes(32).toString('hex');
        try {
          rewrittenCommand = buildRunnerCommand({
            executable: process.execPath,
            runnerPath: path.join(__dirname, 'dependency-runner.cjs'),
            sessionId: event.sessionId,
            dataDir: dataRoot(options.dataDir),
            ticket,
            agentId: scope.child ? scope.agentId : null
          });
          const handoff = record.status === 'issued' ? record.handoff
            : createHandoff(bindingForRecord(event.sessionId, record, ticket));
          if (record.status !== 'issued') orphanedHandoff = handoff;
          else if (!handoffAvailable(handoff, bindingForRecord(event.sessionId, record))) {
            throw new Error('The issued one-time handoff is unavailable; it cannot be recreated.');
          }
          record.status = 'issued';
          record.handoff = handoff;
          record.approvedAction = {
            mutability: action.mutability,
            analysisReason: action.analysisReason,
            hashIntent: Boolean(action.hashIntent),
            reachability: action.reachability,
            authorization: action.authorization,
            affectedPaths: action.affectedPaths,
            cwd: record.targetCwd,
            unboundedDelegation: Boolean(action.unboundedDelegation),
            delegationLifecycleUnproven: Boolean(action.delegationLifecycleUnproven)
          };
          record.issuedActionId = event.action.id;
          record.ticket = ticket;
          usedApproval = { eventId: record.eventId, questionCallId: record.questionCallId, consumed: false };
          result = remaining;
        } catch (error) {
          result = {
            outcome: 'deny_and_explain', family: 'S', reasonCode: 'APPROVED_LAUNCHER_UNAVAILABLE',
            explanation: error.message,
            nextStep: 'The one-time approval remains unused. Retry after restoring a verifiable system PowerShell launcher path.'
          };
        }
      }
    }
    if (result.outcome === 'allow' && ['request_user_input_async', 'request_user_input'].includes(event.action.name)
        && approval.isProposalQuestion(event.action, record || { eventId: state.expiredApprovalEventId })) {
      let registered = false;
      const sameScope = scope.child ? record?.scopeAgentId === scope.agentId : record?.scopeAgentId === undefined;
      if (sameScope && approval.proposalStillAllowed(record, state.contract, state)) {
        const candidate = JSON.parse(JSON.stringify(record));
        registered = approval.registerQuestion(candidate, event.action)
          && approval.proposalStillAllowed(candidate, state.contract, state);
        if (registered) Object.assign(record, candidate);
      }
      if (!registered) {
        result = { outcome: 'deny_and_explain', family: 'S', reasonCode: 'APPROVAL_QUESTION_INVALID',
          explanation: 'The approval question is expired, already registered, no longer allowed by the current contract, or does not match the pending operation and an existing absolute directory.',
          nextStep: 'Request a fresh approval for the specific operation; do not display an unbound card.' };
      }
    }
    const denied = ['deny_and_explain', 'require_user_approval'].includes(result.outcome);
    const responseOutcome = denied ? options.denialResponseOutcome || 'permission_deny_returned'
      : result.outcome === 'report_and_defer' ? 'context_returned' : 'none';
    const auditEvent = recordDecision({ sessionId: event.sessionId, agent: event.agent,
      action: event.action, contract: state.contract,
      delegation: state.delegation, decision: result, responseOutcome, approval: usedApproval }, options);
    let message;
    if (denied && result.reasonCode === 'DEPENDENCY_NOT_AUTHORIZED' && state.contract.dependencyPolicy === 'ask'
        && state.contract.mode === 'change' && state.contract.level === 'guard') {
      let pending = null;
      if (!approval.live(record) || record.status === 'consumed') {
        pending = approval.newPending(event, auditEvent && auditEvent.eventId, Date.now(), {
          agentId: scope.child ? scope.agentId : null,
          policyDigest: scope.child ? approvalScope.policyDigest(state.contract) : null
        });
        if (pending) { state.actionApproval = pending; state.expiredApprovalEventId = null; }
      } else if (record.status === 'pending' && approval.digest(event) === record.digest) {
        pending = record;
      }
      const nextStep = pending
        ? 'Submit the exact approval card below with the target directory. After an affirmative reply, retry this operation; the session remains deps=ask.'
        : approval.live(record) && record.status !== 'consumed'
          ? 'An approval is already bound to another action or is awaiting execution. Use the matching operation; the session remains deps=ask.'
          : 'A single direct static dependency command or supported PowerShell wrapper can be proposed as a controlled child and still requires a card. For diagnostic text use a supported literal write or file edit; do not execute an install.';
      message = decisionMessage({ ...result, nextStep }, state.contract, auditEvent, responseOutcome, event.action.analysisReason);
      if (pending) message += `\nApproval question: ${pending.questionPrefix}<absolute canonical directory>?\nApproval options: ${approval.YES} | ${approval.NO}`;
      else if (!approval.live(record) || record.status === 'consumed') message += '\nOne-time approval is unavailable for this operation or no safe package manager entry was found.';
    } else {
      message = decisionMessage(result, state.contract, auditEvent, responseOutcome, event.action.analysisReason);
    }
    if (denied) return { kind: 'deny', decision: result, eventId: auditEvent && auditEvent.eventId, message };
    if (rewrittenCommand) return { kind: 'rewrite', command: rewrittenCommand };
    return responseOutcome === 'context_returned' ? context(message) : none();
    };
    const result = scope.child
      ? approvalScope.update(event, options, mutate)
      : withCoordinationLock(event.sessionId, options.dataDir, () => updateSession(event.sessionId, options.dataDir, mutate));
    orphanedHandoff = null;
    return result;
  } catch {
    // A failed private state commit must not leave a reusable orphan capability.
    if (orphanedHandoff) {
      try { require('./dependency-handoff.cjs').discardHandoff(orphanedHandoff); } catch {}
    }
    // A failed ledger lock or write cannot turn a guarded action into a fail-open call.
    return { kind: 'deny', message: 'Stop That Shit: approval state unavailable; action denied.' };
  }
}

function handleBeforeAction(event, options) {
  if (!options.recoveryError && event.host?.family === 'codex'
      && (event.action.name === 'request_user_input_async' || event.action.dependencyIntent)) {
    const scope = approvalScope.resolve(event, options);
    if (event.action.dependencyIntent && scope.child && !scope.available) {
      // Without PR109's child-state APIs, retain the original generic decision
      // path. It may report a watch/default observation or deny deps=ask, but
      // must never inspect or mutate a parent's one-time approval record.
    } else if (event.action.name === 'request_user_input_async' && scope.child && !scope.available) {
      let snapshot = null;
      try { snapshot = readState(event.sessionId, options.dataDir); } catch {}
      const record = snapshot && (snapshot.actionApproval || { eventId: snapshot.expiredApprovalEventId });
      if (approval.isProposalQuestion(event.action, record) || approval.isProposalQuestion(event.action, null)) {
        return handleApprovalAction(event, options);
      }
      // An ordinary async clarification stays on the existing read-only path
      // when this standalone runtime has no child ledger.
    } else return handleApprovalAction(event, options);
  }
  if (!options.recoveryError && event.host?.family === 'codex' && event.action.name === 'request_user_input') {
    let snapshot = null;
    try { snapshot = event.agent ? approvalScope.read(event, options) : readState(event.sessionId, options.dataDir); } catch {}
    const record = snapshot && (snapshot.actionApproval || { eventId: snapshot.expiredApprovalEventId });
    if (approval.isProposalQuestion(event.action, record) || approval.isProposalQuestion(event.action, null)) {
      return handleApprovalAction(event, options);
    }
  }
  const legacyDelegationProtocol = !supportsLifecycleFacts(event)
    && ['delegate', 'control', 'unknown'].includes(event.action.mutability);
  const changesDelegation = event.action.mutability === 'delegate'
    || event.action.delegationLifecycleUnproven || legacyDelegationProtocol;
  const delegationCount = event.action.mutability === 'delegate'
    ? (Number.isInteger(event.action.delegationCount) ? event.action.delegationCount : 1)
    : 0;
  const evaluate = (state) => {
    const delegationLifecycleUnproven = Boolean(event.action.delegationLifecycleUnproven)
      && !(event.action.delegationTargetId && targetIsActive(state.delegation, event.action.delegationTargetId));
    const actionChangesDelegation = event.action.mutability === 'delegate'
      || delegationLifecycleUnproven || legacyDelegationProtocol;
    const action = {
      mutability: event.action.mutability,
      analysisReason: event.action.analysisReason,
      legacyDelegationProtocol,
      delegationCount,
      hashIntent: Boolean(event.action.hashIntent),
      reachability: event.action.reachability,
      authorization: event.action.authorization,
      affectedPaths: event.action.affectedPaths,
      cwd: event.action.cwd,
      dependencyIntent: Boolean(event.action.dependencyIntent),
      unboundedDelegation: Boolean(event.action.unboundedDelegation),
      delegationLifecycleUnproven
    };
    const summary = inspectDelegation(state.delegation, { id: event.action.id });
    action.duplicateActionId = summary.duplicateActionId;
    const result = decide({ contract: state.contract, action, delegation: summary, state });
    if (actionChangesDelegation && ['allow', 'report_and_defer'].includes(result.outcome)) {
      state.delegation = applyDelegationFact(state.delegation, {
        kind: 'accepted', id: event.action.id || 'legacy:unidentified', count: delegationCount,
        completionScope: event.action.completionScope,
        uncertainty: legacyDelegationProtocol ? 'legacy_protocol'
          : action.unboundedDelegation ? 'unbounded_execution'
          : action.delegationLifecycleUnproven ? 'unversioned_resume' : null
      });
    } else if (actionChangesDelegation && summary.duplicateActionId) {
      // A later not-started event may describe this rejected attempt, not the
      // original pending execution that still owns the reservation.
      state.delegation = applyDelegationFact(state.delegation, { kind: 'duplicate_rejected', id: event.action.id });
    }
    return { state, result };
  };

  // Separate host processes can issue independent agent launches close together.
  // Serialize delegation reservations across Hook processes. Prompt updates
  // and completion handlers use the same lock; pure reads stay unlocked.
  let evaluated;
  if (options.recoveryError) evaluated = evaluate(recoveryState(options.recoveryError));
  else if (event.agent) {
    const scoped = approvalScope.resolve(event, options);
    if (!scoped.available) {
      // Keep the standalone PR120 behavior for non-approval child tools when
      // PR109's scoped-state APIs are absent. Preserve PR120's shared
      // delegation budget and serialize reservations, but don't write a child
      // contract or approval record into the parent ledger.
      evaluated = changesDelegation
        ? coordinatedUpdate(event, options, evaluate)
        : evaluate(readState(event.sessionId, options.dataDir));
    } else if (changesDelegation) evaluated = approvalScope.update(event, options, evaluate);
    else {
      const state = approvalScope.read(event, options);
      if (state.storageError) return { kind: 'deny', message: 'Stop That Shit: child-scoped policy state is unavailable; action denied.' };
      evaluated = evaluate(state);
    }
  } else if (changesDelegation) evaluated = coordinatedUpdate(event, options, evaluate);
  else evaluated = evaluate(readState(event.sessionId, options.dataDir));
  const { state, result } = evaluated;

  const denied = result.outcome === 'deny_and_explain' || result.outcome === 'require_user_approval';
  const responseOutcome = denied
    ? options.denialResponseOutcome || 'permission_deny_returned'
    : result.outcome === 'report_and_defer' ? 'context_returned' : 'none';
  const auditEvent = recordDecision({
    sessionId: event.sessionId,
    agent: event.agent,
    action: { ...event.action, delegationCount },
    contract: state.contract,
    delegation: state.delegation,
    decision: result,
    responseOutcome
  }, options);

  if (denied) {
    return { kind: 'deny', decision: result, eventId: auditEvent && auditEvent.eventId, message: decisionMessage(result, state.contract, auditEvent, responseOutcome, event.action.analysisReason) };
  }
  if (responseOutcome === 'context_returned') {
    return context(decisionMessage(result, state.contract, auditEvent, responseOutcome, event.action.analysisReason));
  }
  return none();
}

function handleAfterAction(event, options) {
  if (event.action?.name === 'request_user_input') {
    if (event.host?.family !== 'codex') return none();
    const scope = approvalScope.resolve(event, options);
    if (scope.child && !scope.available) return none();
    try {
      const snapshot = scope.child ? approvalScope.read(event, options) : readState(event.sessionId, options.dataDir);
      const scopeMatches = record => scope.child
        ? record?.scopeAgentId === scope.agentId
        : record?.scopeAgentId === undefined;
      if (event.action.unanswered === true) {
        if (snapshot.storageError || !scopeMatches(snapshot.actionApproval)
            || !approval.nativeQuestionMatches(snapshot.actionApproval, event.action)) return none();
        const update = (state) => {
          if (!state.storageError && scopeMatches(state.actionApproval)
              && approval.nativeQuestionMatches(state.actionApproval, event.action)) {
            state.actionApproval = null;
          }
          return none();
        };
        return scope.child ? approvalScope.update(event, options, update)
          : coordinatedUpdate(event, options, update);
      }
      if (snapshot.storageError || !scopeMatches(snapshot.actionApproval)
          || !approval.proposalStillAllowed(snapshot.actionApproval, snapshot.contract, snapshot)
          || !approval.nativeAnswerMatches(snapshot.actionApproval, event.action)) return none();
      const update = (state) => {
        if (!state.storageError && scopeMatches(state.actionApproval)
            && approval.proposalStillAllowed(state.actionApproval, state.contract, state)) {
          approval.acceptNativeAnswer(state.actionApproval, event.action);
        }
        return none();
      };
      return scope.child ? approvalScope.update(event, options, update)
        : coordinatedUpdate(event, options, update);
    } catch {
      // An unavailable approval ledger leaves the proposal unapproved.
      return none();
    }
  }
  if (!supportsLifecycleFacts(event)) return none();
  const update = (state) => {
    // Only a declared facts adapter may report binding or completion. A false
    // async flag can be a request parameter and never proves children joined.
    const kind = event.action.lifecycle || (event.action.completed === true ? 'joined'
      : event.action.asyncLaunched === true ? 'running' : 'unknown');
    state.delegation = applyDelegationFact(state.delegation, {
      kind, id: event.action.id, agentId: event.action.agentId, agentAliases: event.action.agentAliases
    });
    for (const agentId of event.action.endedAgentIds || []) {
      state.delegation = applyDelegationFact(state.delegation, { kind: 'child_stopped', agentId });
    }
    return none();
  };
  const scope = approvalScope.resolve(event, options);
  if (scope.child && scope.available) return approvalScope.update(event, options, update);
  return coordinatedUpdate(event, options, update);
}

function handleLifecycleContext(event, options) {
  // An older adapter may borrow the current protocol number but still map stop
  // attempts to terminal events. Its facts cannot mutate the current ledger.
  if (!supportsLifecycleFacts(event) && event.kind !== 'session.start') return none();
  const update = (state) => {
    const fact = event.kind === 'subagent.start'
      ? { kind: 'child_started', agentId: event.agentId, agentAlias: event.agentAlias, reservationId: event.reservationId }
      : event.kind === 'subagent.stop' ? { kind: 'child_stopped', agentId: event.agentId }
      : { kind: event.allDelegationsStopped === true ? 'all_stopped' : 'unknown' };
    state.delegation = applyDelegationFact(state.delegation, fact);
    return context(contractContext(state.contract, state.delegation, 'active', state.directiveWarning, state.storageError));
  };
  // Ordinary session end carries no completion fact. Keep its context response
  // without waiting for another writer or rewriting state during shutdown.
  const readOnly = event.kind === 'session.start'
    || event.kind === 'session.end' && event.allDelegationsStopped !== true;
  return readOnly ? update(readState(event.sessionId, options.dataDir))
    : coordinatedUpdate(event, options, update);
}

function handleControlEvent(rawEvent, options = {}) {
  let event = assertControlEvent(rawEvent);
  if (event.action && event.action.id && event.sourceSessionId && event.sourceSessionId !== event.sessionId) {
    event = { ...event, action: { ...event.action, id: JSON.stringify([event.sourceSessionId, event.action.id]) } };
  }
  switch (event.kind) {
    case 'prompt.submit': {
      const command = runtimeCommand(event.prompt);
      if (command) {
        const scope = approvalScope.resolve(event, options);
        const state = scope.child && scope.available
          ? approvalScope.read(event, options) : readState(event.sessionId, options.dataDir);
        return handleRuntimeCommand(command, event, state, options);
      }
      return event.agent
          ? handleScopedPrompt(event, options)
          : coordinatedUpdate(event, options, state => handlePrompt(event, state));
    }
    case 'action.before':
      return handleBeforeAction(event, options);
    case 'action.after':
      return handleAfterAction(event, options);
    case 'session.start':
    case 'subagent.start':
    case 'subagent.stop':
    case 'session.end':
      return handleLifecycleContext(event, options);
    default:
      return none();
  }
}

module.exports = { contractContext, handleControlEvent, runtimeCommand };
