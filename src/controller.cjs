'use strict';

const { parseContractPrompt } = require('./contracts.cjs');
const { assertControlEvent } = require('./control-protocol.cjs');
const { decide } = require('./decision.cjs');
const { readRuntime, recordDecision } = require('./runtime-audit.cjs');
const { recordAnnotation } = require('./runtime-annotations.cjs');
const { readState, withSessionLock, writeState } = require('./state.cjs');

function none() {
  return { kind: 'none' };
}

function context(text) {
  return { kind: 'context', text };
}

function contractContext(contract, phase = 'active') {
  if (contract.level === 'off') {
    return 'Stop That Shit is disabled for this session. No plugin decision is being enforced.';
  }
  if (contract.mode === 'unconfirmed') {
    return [
      'Stop That Shit is in watch-only mode because no task mode is confirmed.',
      'Use $stop-that-shit review for read-only work, or change for implementation. The default fast path relies on the Stop Ladder and does not claim a full machine contract.',
      'Do not claim that mutations are being blocked until a mode is confirmed.'
    ].join(' ');
  }

  return [
    `Stop That Shit (${phase}): mode=${contract.mode}; agents=${contract.agentsUsed}/${contract.agentBudget}; hash=${contract.hashPolicy || 'deny'}; deps=${contract.dependencyPolicy || 'ask'}; files=${Array.isArray(contract.allowedPaths) ? contract.allowedPaths.join('|') : 'unbounded'}.`,
    'Stop Ladder: Is it requested? Is it necessary? What reachable evidence proves that? Would omission fail the current acceptance?',
    'Report real findings even when implementation is not authorized.',
    'Before expanding scope, name reachable evidence, failure if omitted, and the fact that changes the next action.',
    'Harness interception coverage is a guardrail, not a security boundary.'
  ].join(' ');
}

const FAMILY_NAMES = { I: 'INTENT', H: 'HASH', S: 'SCOPE', T: 'THRASH' };

function activeControlState(contract) {
  if (contract.level === 'off') return 'OFF';
  return contract.level === 'watch' ? 'OBSERVING' : 'ARMED';
}

function decisionMessage(result, contract, event, responseOutcome) {
  const observing = responseOutcome === 'context_returned';
  const executionDenial = responseOutcome === 'execution_denial_returned';
  const lines = [
    `${observing ? 'WATCH' : 'STOP'} / ${FAMILY_NAMES[result.family] || result.family || 'CONTROL'}`,
    observing
      ? 'Guard returned context; it did not deny the action.'
      : executionDenial ? 'Guard returned a pre-execution denial.' : 'Guard returned permission deny.',
    `Reason: ${result.reasonCode}`,
    `Code: ${result.family}/${result.reasonCode}`,
    `State: ${activeControlState(contract)} / ${contract.mode}`
  ];
  if (event) lines.push(`Event: ${event.eventId}`);
  if (result.nextStep) lines.push(`Next: ${result.nextStep}`);
  return lines.join('\n');
}

function runtimeCommand(prompt) {
  const match = /^\s*\$stop-that-shit\s+(status|runtime(?:\s+all)?|explain\s+(evt_[0-9a-f-]+)|label\s+(evt_[0-9a-f-]+)\s+(correct|incorrect|inconclusive))\s*$/i.exec(prompt);
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
    return context([
      'Stop That Shit status',
      `State: ${activeControlState(state.contract)} / ${state.contract.mode}`,
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
    `Decision: ${found.decision.policyOutcome} / ${found.decision.reasonCode}`,
    `Response: ${found.decision.responseOutcome}`,
    `Host effect: ${found.decision.hostEffect}`,
    `Label: ${found.label || 'unlabeled'}`
  ].join('\n'));
}

function handlePrompt(event, options) {
  const state = readState(event.sessionId, options.dataDir);
  const command = runtimeCommand(event.prompt);
  if (command) return handleRuntimeCommand(command, event, state, options);
  const parsed = parseContractPrompt(event.prompt, state.contract);
  state.contract = parsed.contract;
  const promptContext = contractContext(state.contract);
  const repeatedContext = state.lastPromptContext === promptContext;
  state.lastPromptContext = promptContext;
  writeState(event.sessionId, state, options.dataDir);
  return repeatedContext ? none() : context(promptContext);
}

function handleBeforeAction(event, options) {
  const evaluate = () => {
    const state = readState(event.sessionId, options.dataDir);
    const delegationCount = event.action.mutability === 'delegate'
      ? (Number.isInteger(event.action.delegationCount) ? event.action.delegationCount : 1)
      : 0;
    const action = {
      mutability: event.action.mutability,
      delegationCount,
      hashIntent: Boolean(event.action.hashIntent),
      reachability: event.action.reachability,
      authorization: event.action.authorization,
      affectedPaths: event.action.affectedPaths,
      dependencyIntent: Boolean(event.action.dependencyIntent),
      unboundedDelegation: Boolean(event.action.unboundedDelegation)
    };
    const result = decide({ contract: state.contract, action, state });

    if (event.action.mutability === 'delegate' && result.outcome === 'allow') {
      state.contract.agentsUsed += delegationCount;
      writeState(event.sessionId, state, options.dataDir);
    }
    return { state, result };
  };

  // Separate host processes can issue independent agent launches close together.
  // Serialize only delegation reservations so agents=N remains a real budget
  // across separate Hook processes without adding locks to the common fast path.
  const { state, result } = event.action.mutability === 'delegate'
    ? withSessionLock(event.sessionId, options.dataDir, evaluate)
    : evaluate();

  const denied = result.outcome === 'deny_and_explain' || result.outcome === 'require_user_approval';
  const responseOutcome = denied
    ? options.denialResponseOutcome || 'permission_deny_returned'
    : result.outcome === 'report_and_defer' ? 'context_returned' : 'none';
  const auditEvent = recordDecision({
    sessionId: event.sessionId,
    action: event.action,
    contract: state.contract,
    decision: result,
    responseOutcome
  }, options);

  if (denied) {
    return { kind: 'deny', decision: result, eventId: auditEvent && auditEvent.eventId, message: decisionMessage(result, state.contract, auditEvent, responseOutcome) };
  }
  if (responseOutcome === 'context_returned') {
    return context(decisionMessage(result, state.contract, auditEvent, responseOutcome));
  }
  return none();
}

function handleLifecycleContext(event, options) {
  const state = readState(event.sessionId, options.dataDir);
  return context(contractContext(state.contract));
}

function handleControlEvent(rawEvent, options = {}) {
  const event = assertControlEvent(rawEvent);
  switch (event.kind) {
    case 'prompt.submit':
      return handlePrompt(event, options);
    case 'action.before':
      return handleBeforeAction(event, options);
    case 'session.start':
    case 'subagent.start':
      return handleLifecycleContext(event, options);
    default:
      return none();
  }
}

module.exports = { contractContext, handleControlEvent };
