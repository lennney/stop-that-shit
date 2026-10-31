// GENERATED FILE — DO NOT EDIT. Build with: npm run hermes:build
// Generated from the src/ module graph by scripts/build-hermes-plugin.cjs.
'use strict';

const __modules = {
"src/adapters/hermes-hooks.cjs": function(module, exports, __require) {
'use strict';

const { PROTOCOL_VERSION } = __require("src/control-protocol.cjs");
const { handleControlEvent } = __require("src/controller.cjs");
const { readState } = __require("src/state.cjs");
const {
  analyzeHermesTool,
  countHermesDelegation
} = __require("src/adapters/hermes-tool-classifier.cjs");
const { optionalIdentifier } = __require("src/adapters/lifecycle-fields.cjs");

const EVENT_KIND = {
  pre_llm_call: 'prompt.submit',
  pre_tool_call: 'action.before',
  post_tool_call: 'action.after',
  subagent_start: 'subagent.start',
  subagent_stop: 'subagent.stop',
  on_session_end: 'session.end'
};

function toControlEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = EVENT_KIND[input.hook_event_name];
  if (!kind) return null;

  const extra = input.extra && typeof input.extra === 'object' ? input.extra : {};
  const event = {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind,
    sessionId: String(input.session_id || extra.parent_session_id || ''),
    turnId: extra.turn_id || extra.parent_turn_id || input.turn_id || null,
    host: {
      family: 'hermes-agent',
      model: input.model || extra.model || null,
      permissionMode: null,
      agentId: null,
      agentType: null
    }
  };

  if (kind === 'prompt.submit') {
    event.prompt = String(extra.user_message || '');
  }

  if (kind === 'action.before') {
    const analysis = analyzeHermesTool(input.tool_name, input.tool_input, input.cwd);
    const actionId = optionalIdentifier(input.tool_call_id, extra.tool_call_id);
    if (analysis.mutability === 'delegate' && !actionId) return null;
    const action = {
      id: actionId,
      name: String(input.tool_name || 'unknown'),
      input: input.tool_input,
      ...analysis,
      delegationCount: countHermesDelegation(input.tool_name, input.tool_input),
      cwd: input.cwd,
      unboundedDelegation: false
    };
    event.action = {
      ...action
    };
  }

  if (kind === 'action.after') {
    if (input.tool_name !== 'delegate_task') return null;
    const actionId = optionalIdentifier(input.tool_call_id, extra.tool_call_id);
    if (!actionId) return null;
    event.action = { id: String(actionId) };
    event.action.lifecycle = 'unknown';
    if (input.tool_name === 'delegate_task') {
      let result = extra.result;
      if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = null; } }
      if (result && result.status === 'dispatched' && result.mode === 'background') {
        event.action.lifecycle = 'running';
        if (Array.isArray(result.subagent_ids)) {
          event.action.agentAliases = result.subagent_ids.filter(id => typeof id === 'string' && id);
        }
      } else if (result && Array.isArray(result.results) && result.results.length
          && result.results.every(entry => entry && ['completed', 'failed', 'error'].includes(entry.status))) {
        event.action.lifecycle = 'joined';
      }
    }
  }

  if (kind === 'subagent.start' || kind === 'subagent.stop') {
    // timeout/interrupted hooks can fire while a worker is still alive.
    if (kind === 'subagent.stop' && !['completed', 'failed', 'error'].includes(extra.child_status)) return null;
    if (kind === 'subagent.start') {
      const alias = optionalIdentifier(extra.child_subagent_id, input.child_subagent_id);
      if (alias) event.agentAlias = alias;
    }
    const agentId = extra.child_session_id
      || input.child_session_id
      || extra.child_subagent_id
      || input.child_subagent_id
      || null;
    const normalizedAgentId = optionalIdentifier(agentId);
    if (normalizedAgentId) event.agentId = normalizedAgentId;
  }

  return event;
}

function directiveErrorText(error) {
  return `Stop That Shit directive rejected (${error.code}): ${error.message} `
    + 'The previous contract is unchanged. Tools are paused until you submit a corrected instruction.';
}

function fromControlResult(result, kind) {
  if (!result || result.kind === 'none') return null;
  if (result.kind === 'prompt-error') return { context: directiveErrorText(result.error) };
  if (result.kind === 'context') {
    if (['subagent.start', 'subagent.stop', 'session.end'].includes(kind)) return null;
    return { context: result.text };
  }
  if (result.kind === 'deny') return { action: 'block', message: result.message };
  return null;
}

function handleHermesHook(input, options = {}) {
  const event = toControlEvent(input);
  if (!event) return null;
  // pre_llm_call can add context but cannot reject a user turn. Keep invalid
  // input from executing through the existing pre_tool_call block response.
  if (event.kind === 'action.before') {
    const error = readState(event.sessionId, options.dataDir).directiveError;
    if (error) return { action: 'block', message: directiveErrorText(error) };
  }
  const result = handleControlEvent(event, options);
  const output = fromControlResult(result, event.kind);
  if (event.kind === 'prompt.submit' && result.kind !== 'prompt-error') {
    const error = readState(event.sessionId, options.dataDir).directiveError;
    if (error) return { context: directiveErrorText(error) + (output ? `\n${output.context}` : '') };
  }
  return output;
}

module.exports = {
  fromControlResult,
  handleHermesHook,
  toControlEvent
};

},
"src/control-protocol.cjs": function(module, exports, __require) {
'use strict';

const PROTOCOL_VERSION = 2;
const EVENT_KINDS = new Set([
  'session.start',
  'prompt.submit',
  'action.before',
  'action.after',
  'subagent.start',
  'subagent.stop',
  'session.end'
]);
const MUTABILITIES = new Set(['read', 'write', 'delegate', 'control', 'unknown']);
const SHELL_ANALYSIS_REASONS = Object.freeze({
  shell_syntax_unproven: 'This shell syntax cannot be confirmed as a static read.',
  shell_command_unproven: 'This program is not a supported read-only command.',
  shell_execution_option: 'This ripgrep option can execute another program.',
  option_value_missing: 'A required command option value is missing.',
  git_arguments_unproven: 'This Git subcommand or argument form is not supported as a read.',
  native_quotes_unproven: 'Native argument passing can reinterpret these embedded quotes.',
  native_empty_arguments: 'Dropping empty native arguments exposes a different operation.',
  shell_redirection: 'This command redirects output and may write a file.',
  git_output_file: 'This Git command requests an output file.'
});

function isShellAnalysisReason(value) {
  return typeof value === 'string' && Object.hasOwn(SHELL_ANALYSIS_REASONS, value);
}

function supportsLifecycleFacts(event) {
  // The adapter must declare its own lifecycle semantics. Older adapters import
  // PROTOCOL_VERSION from the runtime, so that number alone cannot identify them.
  return event.protocolVersion === PROTOCOL_VERSION && event.lifecycleVersion === 2;
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`ControlEvent field ${field} must be a non-empty string.`);
  }
}

function assertControlEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('ControlEvent must be an object.');
  }
  if (![1, PROTOCOL_VERSION].includes(event.protocolVersion)) {
    throw new TypeError(`Unsupported ControlEvent protocolVersion: ${event.protocolVersion}.`);
  }
  if (!EVENT_KINDS.has(event.kind)) {
    throw new TypeError(`Unsupported ControlEvent kind: ${event.kind}.`);
  }
  nonEmptyString(event.sessionId, 'sessionId');

  if (event.agent !== undefined && event.agent !== null) {
    if (!event.agent || typeof event.agent !== 'object' || Array.isArray(event.agent)) {
      throw new TypeError('ControlEvent agent must be an object when provided.');
    }
    nonEmptyString(event.agent.agentId, 'agent.agentId');
    if (event.agent.agentType !== undefined && event.agent.agentType !== null
        && typeof event.agent.agentType !== 'string') {
      throw new TypeError('ControlEvent agent.agentType must be a string when provided.');
    }
  }

  if (event.kind === 'prompt.submit' && typeof event.prompt !== 'string') {
    throw new TypeError('ControlEvent prompt.submit requires a string prompt.');
  }
  if (event.kind === 'action.before') {
    if (!event.action || typeof event.action !== 'object') {
      throw new TypeError(`ControlEvent ${event.kind} requires an action object.`);
    }
    nonEmptyString(event.action.name, 'action.name');
    if (!MUTABILITIES.has(event.action.mutability)) {
      throw new TypeError(`Unsupported action mutability: ${event.action.mutability}.`);
    }
    if (event.action.analysisReason !== undefined && !isShellAnalysisReason(event.action.analysisReason)) {
      throw new TypeError('Unsupported action analysis reason.');
    }
    if (event.action.delegationTargetId !== undefined) {
      nonEmptyString(event.action.delegationTargetId, 'action.delegationTargetId');
    }
    if (event.action.mutability === 'delegate' || event.action.delegationLifecycleUnproven) nonEmptyString(event.action.id, 'action.id');
    if (
      event.action.delegationCount !== undefined
      && (!Number.isSafeInteger(event.action.delegationCount) || event.action.delegationCount < 0)
    ) {
      throw new TypeError('ControlEvent action.delegationCount must be a non-negative integer.');
    }
    if (event.action.asyncLaunched !== undefined && typeof event.action.asyncLaunched !== 'boolean') {
      throw new TypeError('ControlEvent action.asyncLaunched must be a boolean when provided.');
    }
  }
  if (event.kind === 'action.after') {
    if (!event.action || typeof event.action !== 'object') {
      throw new TypeError(`ControlEvent ${event.kind} requires an action object.`);
    }
    nonEmptyString(event.action.id, 'action.id');
    if (event.action.agentId !== undefined && event.action.agentId !== null) {
      nonEmptyString(event.action.agentId, 'action.agentId');
    }
    for (const field of ['agentAliases', 'endedAgentIds']) {
      if (event.action[field] !== undefined) {
        if (!Array.isArray(event.action[field])) throw new TypeError(`action.${field} must be an array.`);
        for (const id of event.action[field]) nonEmptyString(id, `action.${field}`);
      }
    }
    if (event.action.lifecycle !== undefined && !['running', 'joined', 'not_started', 'unknown'].includes(event.action.lifecycle)) {
      throw new TypeError('Unsupported action.lifecycle fact.');
    }
    if (event.action.completed !== undefined && typeof event.action.completed !== 'boolean') {
      throw new TypeError('ControlEvent action.completed must be a boolean when provided.');
    }
    if (event.action.asyncLaunched !== undefined && typeof event.action.asyncLaunched !== 'boolean') {
      throw new TypeError('ControlEvent action.asyncLaunched must be a boolean when provided.');
    }
  }
  if (event.kind === 'subagent.start' || event.kind === 'subagent.stop') {
    for (const field of ['agentId', 'agentAlias', 'reservationId']) {
      if (event[field] !== undefined && event[field] !== null) nonEmptyString(event[field], field);
    }
  }

  if (event.allDelegationsStopped !== undefined && typeof event.allDelegationsStopped !== 'boolean') throw new TypeError('allDelegationsStopped must be boolean.');
  if (event.sourceSessionId !== undefined) nonEmptyString(event.sourceSessionId, 'sourceSessionId');
  if (event.action && event.action.completionScope !== undefined && !['call', 'children'].includes(event.action.completionScope)) {
    throw new TypeError('Unsupported action.completionScope.');
  }
  return event;
}

module.exports = {
  SHELL_ANALYSIS_REASONS,
  isShellAnalysisReason,
  EVENT_KINDS,
  MUTABILITIES,
  PROTOCOL_VERSION,
  supportsLifecycleFacts,
  assertControlEvent
};

},
"src/controller.cjs": function(module, exports, __require) {
'use strict';

const { DEFAULT_AGENT_LIMIT, parseContractPrompt } = __require("src/contracts.cjs");
const { SHELL_ANALYSIS_REASONS, isShellAnalysisReason, assertControlEvent, supportsLifecycleFacts } = __require("src/control-protocol.cjs");
const delegationState = __require("src/delegation-state.cjs");
const { inspectDelegation, applyDelegationFact } = delegationState;
const { decide } = __require("src/decision.cjs");
const { readRuntime, recordDecision } = __require("src/runtime-audit.cjs");
const { recordAnnotation } = __require("src/runtime-annotations.cjs");
const { readState, recoveryState, updateSession, dataRoot } = __require("src/state.cjs");
const path = require('node:path');
const crypto = require('node:crypto');
const approval = __require("src/action-approval.cjs");
const approvalScope = __require("src/approval-scope.cjs");
const { buildRunnerCommand } = __require("src/runner-command.cjs");
const { bindingForRecord, createHandoff, handoffAvailable, withCoordinationLock } = __require("src/dependency-handoff.cjs");
// Keep the executable helper in the hook's statically discoverable dependency graph.
__require("src/dependency-runner.cjs");

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
      try { __require("src/dependency-handoff.cjs").discardHandoff(orphanedHandoff); } catch {}
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

},
"src/contracts.cjs": function(module, exports, __require) {
'use strict';

const MODES = new Set(['answer', 'review', 'change', 'monitor', 'open']);
const LEVELS = new Set(['watch', 'guard', 'lock', 'off']);
const HASH_POLICIES = new Set(['deny', 'ask', 'allow']);
const SCOPE_POLICIES = new Set(['deny', 'ask', 'allow']);
const DEFAULT_AGENT_LIMIT = Number.MAX_SAFE_INTEGER;

function defaultContract() {
  return {
    mode: 'unconfirmed',
    level: 'watch',
    agentBudget: DEFAULT_AGENT_LIMIT,
    hashPolicy: 'deny',
    allowedPaths: null,
    dependencyPolicy: 'ask',
    source: 'default'
  };
}

function directiveHead(prompt, matchEnd) {
  const tail = prompt.slice(matchEnd).replace(/^[ \t]+/, '');
  const boundaries = [tail.indexOf('--'), tail.search(/:(?=\s|$)/), tail.indexOf('\n')]
    .filter((index) => index >= 0);
  const end = boundaries.length ? Math.min(...boundaries) : tail.length;
  return tail.slice(0, end).trim();
}

function parseDirective(prompt) {
  // A directive starts the first non-empty line, outside quoted/code content.
  // Four spaces or a tab denote an indented code example, not an invocation.
  const mention = /^(?:[ \t]*\r?\n)* {0,3}\$(?:stop-that-shit:)?stop-that-shit(?=$|[\s,:])/i.exec(prompt);
  if (!mention) return null;

  const head = directiveHead(prompt, mention.index + mention[0].length);
  const tokens = head.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean);
  const parsed = { mentioned: true, error: null, warning: null };

  function setField(field, value, token) {
    if (Object.hasOwn(parsed, field) && JSON.stringify(parsed[field]) !== JSON.stringify(value)) {
      parsed.error = {
        code: 'CONFLICTING_DIRECTIVE', token,
        message: `Conflicting values for ${field}. Submit one value per directive field.`
      };
    } else {
      parsed[field] = value;
    }
  }

  for (const rawToken of tokens) {
    if (parsed.error) break;
    const token = rawToken.toLowerCase();
    if (MODES.has(token)) {
      setField('mode', token, rawToken);
      continue;
    }
    if (LEVELS.has(token)) {
      setField('level', token, rawToken);
      continue;
    }
    const agents = /^agents=(.*)$/i.exec(rawToken);
    if (agents) {
      const value = parseAgentLimit(agents[1]);
      if (value === null) {
        parsed.error = invalidAgentLimit(rawToken);
        break;
      }
      setField('agentBudget', value, rawToken);
      continue;
    }
    if (/^agents$/i.test(rawToken)) {
      parsed.error = {
        code: 'INVALID_AGENT_LIMIT',
        token: rawToken,
        message: `${rawToken} must be a non-negative safe integer.`
      };
      break;
    }
    if (/^(?:total-agents|concurrent-agents)(?:=|$)/i.test(rawToken)) {
      parsed.error = {
        code: 'UNSUPPORTED_AGENT_DIRECTIVE',
        token: rawToken,
        message: 'Use agents=N to set the maximum number of concurrently active subagents.'
      };
      break;
    }
    const hash = /^hash=(deny|ask|allow)$/.exec(token);
    if (hash && HASH_POLICIES.has(hash[1])) {
      setField('hashPolicy', hash[1], rawToken);
      continue;
    }
    const files = /^files=(.*)$/i.exec(rawToken);
    if (files) {
      setField('allowedPaths', files[1].split('|').map((value) => value.replace(/\\/g, '/')).filter(Boolean), rawToken);
      continue;
    }
    const dependencies = /^deps=(deny|ask|allow)$/.exec(token);
    if (dependencies && SCOPE_POLICIES.has(dependencies[1])) {
      setField('dependencyPolicy', dependencies[1], rawToken);
      continue;
    }
    parsed.error = {
      code: 'INVALID_DIRECTIVE_TOKEN', token: rawToken,
      message: 'Unknown directive field. Put task text after -- or on the next line.'
    };
  }

  return parsed;
}

function parseAgentLimit(value) {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function invalidAgentLimit(token) {
  return {
    code: 'INVALID_AGENT_LIMIT',
    token,
    message: `${token} must be a non-negative safe integer.`
  };
}

function correctionProse(prompt) {
  let fence = null;
  // Keep a separator: removing an example must not join words into a new
  // instruction, or expose a quoted "fix" as the start of the user's prompt.
  const omitted = '\uFFFC';
  return prompt.split(/\r?\n/).map((line) => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return omitted;
    }
    if (/^(?: {0,3}>| {4}|\t)/.test(line)) return omitted;
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open && (open[1][0] !== '`' || !line.slice(open[0].length).includes('`'))) {
      fence = open[1];
      return omitted;
    }
    return line;
  }).join('\n')
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, omitted)
    .replace(/"(?:\\.|[^"\\])*"|(?<![\p{L}\p{N}\\])'[\s\S]*?(?<!\\)'(?![\p{L}\p{N}])|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/gu, omitted)
    .trim();
}

function naturalCorrection(prompt, previous) {
  const text = correctionProse(prompt);

  if (/^(?:stop|stop now|停止|停下来)[.!。！\s]*$/i.test(text)) {
    return { mode: 'answer', source: 'explicit-stop' };
  }
  if (/\breview only\b|\b(?:do not|don't) (?:edit|change|fix) (?:anything|the (?:repo|repository|files?|code))\b|只审查|只看不改|不要修改(?:任何|代码|文件)/i.test(text)) {
    return { mode: 'review', source: 'natural-explicit' };
  }
  if (/\banswer only\b|只回答/i.test(text)) {
    return { mode: 'answer', source: 'natural-explicit' };
  }
  // A standalone observation instruction changes authority. An object such as
  // "只观察实际定时轮次" limits what to inspect, not what the task may change.
  if (/\bmonitor only\b/i.test(text)
      || /(?:^|[\n，,。.!！；;：:])[ \t]*(?:(?:请|继续|这次|本次|现在|接下来|先)[ \t]*)*只(?:监控|观察)(?:[ \t]*(?:即可|就好|就行|一下))?[ \t]*(?=$|[\n，,。.!！；;])/u.test(text)) {
    return { mode: 'monitor', source: 'natural-explicit' };
  }

  const wasNonMutating = ['answer', 'review', 'monitor'].includes(previous.mode);
  const explicitChange = /^(?:please\s+)?(?:fix|implement|change|apply|patch)\b|^(?:请)?(?:修复|修改|实现|应用补丁)|^把.+(?:修复|修改|改掉)/i.test(text);
  if (wasNonMutating && explicitChange) {
    return { mode: 'change', source: 'natural-explicit' };
  }

  return null;
}

function unarmedDirectiveWarning(prompt) {
  // Report an unquoted standalone directive without treating it as authority.
  // Host-generated prefixes and user introductions cannot be distinguished
  // from this text alone, so neither is removed to make a directive eligible.
  const prose = correctionProse(prompt);
  if (!/^ {0,3}\$stop-that-shit(?=$|[\s,:])/im.test(prose)) return null;
  return {
    code: 'DIRECTIVE_NOT_ARMED',
    message: 'DIRECTIVE_NOT_ARMED: a Stop That Shit directive was not applied because it does not start the first non-empty line of the received prompt. Send the directive first in a separate message and check $stop-that-shit status before continuing.'
  };
}

function validAgentBudget(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeContract(previousContract) {
  const supplied = previousContract && typeof previousContract === 'object' ? previousContract : {};
  const previous = { ...defaultContract(), ...supplied };
  const suppliedAgentBudget = validAgentBudget(supplied.agentBudget);
  const concurrentAgentBudget = validAgentBudget(supplied.concurrentAgentBudget);
  const totalAgentBudget = validAgentBudget(supplied.totalAgentBudget);
  previous.agentBudget = suppliedAgentBudget
    ?? (concurrentAgentBudget !== null && concurrentAgentBudget !== DEFAULT_AGENT_LIMIT
      ? concurrentAgentBudget
      : totalAgentBudget !== null && totalAgentBudget !== DEFAULT_AGENT_LIMIT
        ? totalAgentBudget
        : DEFAULT_AGENT_LIMIT);
  delete previous.totalAgentBudget;
  delete previous.concurrentAgentBudget;
  delete previous.agentsUsed;
  return previous;
}

function parseContractPrompt(prompt, previousContract = defaultContract()) {
  const previous = normalizeContract(previousContract);
  const text = String(prompt || '');
  const directive = parseDirective(text);
  const correction = naturalCorrection(text, previous);
  const next = { ...previous };
  let changed = false;

  if (directive) {
    if (directive.error) {
      return {
        contract: previous,
        changed: false,
        directive: true,
        correction: Boolean(correction),
        warning: null,
        error: directive.error
      };
    }
    if (directive.mode && directive.mode !== next.mode) {
      next.mode = directive.mode;
      changed = true;
    }
    if (directive.level && directive.level !== next.level) {
      next.level = directive.level;
      changed = true;
    }
    if (Number.isInteger(directive.agentBudget) && directive.agentBudget !== next.agentBudget) {
      next.agentBudget = directive.agentBudget;
      changed = true;
    }
    if (directive.hashPolicy && directive.hashPolicy !== next.hashPolicy) {
      next.hashPolicy = directive.hashPolicy;
      changed = true;
    }
    if (Array.isArray(directive.allowedPaths)) {
      next.allowedPaths = directive.allowedPaths;
      changed = true;
    }
    if (directive.dependencyPolicy && directive.dependencyPolicy !== next.dependencyPolicy) {
      next.dependencyPolicy = directive.dependencyPolicy;
      changed = true;
    }
    if (directive.mode && !directive.level && next.level === 'watch') {
      next.level = 'guard';
      changed = true;
    }
    if (directive.level === 'off') {
      next.level = 'off';
    }
    next.source = 'directive';
  } else if (correction) {
    if (correction.mode !== next.mode) {
      next.mode = correction.mode;
      changed = true;
    }
    if (next.level === 'watch') {
      next.level = 'guard';
      changed = true;
    }
    next.source = correction.source;
  }

  if (next.mode === 'unconfirmed' && next.level !== 'off') {
    next.level = 'watch';
  }

  return {
    contract: next,
    changed,
    directive: Boolean(directive),
    correction: Boolean(correction),
    warning: directive ? directive.warning : unarmedDirectiveWarning(text),
    error: null
  };
}

module.exports = {
  HASH_POLICIES,
  SCOPE_POLICIES,
  LEVELS,
  MODES,
  DEFAULT_AGENT_LIMIT,
  defaultContract,
  normalizeContract,
  parseContractPrompt
};

},
"src/delegation-state.cjs": function(module, exports, __require) {
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
  const accepted = normalizedActionId
    ? { ...acceptedActions(state), [normalizedActionId]: count }
    : { ...acceptedActions(state) };
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
  return {
    reservedUpperBound: activeDelegationCount(state),
    unresolvedReasons: [...new Set(Object.values(state && state.unresolved || {}))],
    unknownResults: Object.values(reservationsOf(state)).filter(value => value.resultUnknown).length,
    duplicateActionId: acceptedCount !== null
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
    // Watch/off may permit another execution with the same host identity.
    // Its terminal events cannot distinguish the executions from each other.
    if (acceptedActionCount(state, actionId) !== null) return {
      ...state, unresolved: { ...state.unresolved, [actionId]: 'reused_action_id' }
    };
    const id = `reservation:${actionId}`;
    let next = reserveDelegation(state, id, actionId, fact.count);
    next = { ...next, reservations: { ...next.reservations,
      [id]: { ...next.reservations[id], completionScope: fact.completionScope || 'children' } } };
    if (fact.uncertainty) next = { ...next, unresolved: { ...next.unresolved, [actionId]: fact.uncertainty } };
    return next;
  }
  if (fact.kind === 'duplicate_rejected') {
    if (!reservationId) return state;
    return { ...state, reservations: { ...state.reservations,
      [reservationId]: { ...state.reservations[reservationId], notStartedAmbiguous: true } } };
  }
  if (fact.kind === 'joined' || fact.kind === 'not_started') {
    if (state.unresolved?.[actionId] === 'reused_action_id') return state;
    if (!reservationId && !Object.prototype.hasOwnProperty.call(state.unresolved || {}, actionId)) return state;
    // A late denial cannot contradict an already observed execution.
    const reservation = reservationsOf(state)[reservationId];
    if (fact.kind === 'not_started' && reservation
        && (reservation.notStartedAmbiguous || reservation.observedRunning || reservation.agentIds.length)) return state;
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

},
"src/decision.cjs": function(module, exports, __require) {
'use strict';

const nodePath = require('node:path');
const { DEFAULT_AGENT_LIMIT } = __require("src/contracts.cjs");
const { inspectDelegation } = __require("src/delegation-state.cjs");
const { SHELL_ANALYSIS_REASONS, isShellAnalysisReason } = __require("src/control-protocol.cjs");

function analysisExplanation(action) {
  return isShellAnalysisReason(action.analysisReason)
    ? ` ${SHELL_ANALYSIS_REASONS[action.analysisReason]}` : '';
}

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

  if (state.storageError) {
    const lockDamaged = state.storageError.code === 'STS_LOCK_DAMAGED';
    return action.mutability === 'read' || action.mutability === 'control' && !action.delegationLifecycleUnproven
      ? decision('allow', null, 'RECOVERY_READ_ONLY', 'Read-only recovery remains available.', null)
      : decision('deny_and_explain', 'I', lockDamaged ? 'STS_LOCK_DAMAGED' : 'STATE_DAMAGED', state.storageError.message,
        lockDamaged ? 'Follow the legacy lock recovery steps in INSTALL.md. Keep saved contracts and delegation records.'
          : 'Restore the saved state from a known-good backup or start a new host session. Do not clear unresolved delegation records.');
  }

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
      'Submit a corrected directive for the reported field before delegating.'
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
      `Task mode ${mode} does not authorize repository mutation.${analysisExplanation(action)}`,
      'Report the finding, use a read-only action, or obtain an explicit change contract.'
    );
  }

  if (nonMutatingMode && action.mutability === 'unknown') {
    return decision(
      controlledOutcome(level, 'require_user_approval'),
      'I',
      'MUTABILITY_UNPROVEN',
      `The proposed action is not proven read-only under ${mode} mode.${analysisExplanation(action)}`,
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

  if (action.mutability === 'delegate' && action.duplicateActionId) {
    return decision(
      controlledOutcome(level),
      'S',
      'DUPLICATE_ACTION_ID',
      'The host reused an already accepted action identifier. Another execution cannot share the original reservation or completion events.',
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
  if (action.mutability === 'delegate' && activeAgents + delegationCount > agentBudget) {
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

},
"src/runtime-audit.cjs": function(module, exports, __require) {
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const packageJson = __require("package.json");
const { PROTOCOL_VERSION, isShellAnalysisReason } = __require("src/control-protocol.cjs");
const { inspectDelegation } = __require("src/delegation-state.cjs");
const { readAnnotations } = __require("src/runtime-annotations.cjs");
const { appendJsonl, scanJsonl, runtimeRoot } = __require("src/runtime-storage.cjs");
const { sessionKey } = __require("src/state.cjs");

function controlState(contract) {
  if (contract.level === 'off') return 'off';
  return contract.level === 'watch' ? 'observing' : 'armed';
}

function eventPath(sessionId, options) {
  return path.join(runtimeRoot(options), `${sessionKey(sessionId)}.jsonl`);
}

function recordDecision(facts, options = {}) {
  const contract = facts && facts.contract || {};
  const delegation = facts && facts.delegation || {};
  const state = controlState(contract);
  if (state === 'off') return null;

  const action = facts.action || {};
  const decision = facts.decision || {};
  const activity = inspectDelegation(delegation);
  const event = {
    schemaVersion: 1,
    eventId: `evt_${crypto.randomUUID()}`,
    occurredAt: (options.now ? options.now() : new Date()).toISOString(),
    sessionKey: sessionKey(facts.sessionId),
    policyRevision: {
      pluginVersion: packageJson.version,
      controlVersion: PROTOCOL_VERSION
    },
    controlState: state,
    action: {
      toolName: String(action.name || 'unknown'),
      mutability: String(action.mutability || 'unknown'),
      ...(isShellAnalysisReason(action.analysisReason) ? { analysisReason: action.analysisReason } : {}),
      delegationCount: Number.isInteger(action.delegationCount) ? action.delegationCount : 0,
      pathCount: Array.isArray(action.affectedPaths) ? action.affectedPaths.length : 0,
      hashIntent: Boolean(action.hashIntent),
      dependencyIntent: Boolean(action.dependencyIntent),
      unboundedDelegation: Boolean(action.unboundedDelegation)
    },
    contract: {
      mode: String(contract.mode || 'unconfirmed'),
      level: String(contract.level || 'watch'),
      agentBudget: Number.isSafeInteger(contract.agentBudget) ? contract.agentBudget : Number.MAX_SAFE_INTEGER,
      reservedUpperBound: activity.reservedUpperBound,
      countUnproven: activity.unresolvedReasons.length > 0,
      hashPolicy: String(contract.hashPolicy || 'deny'),
      dependencyPolicy: String(contract.dependencyPolicy || 'ask'),
      allowedPathCount: Array.isArray(contract.allowedPaths) ? contract.allowedPaths.length : 0
    },
    ...(facts.approval ? { approval: facts.approval } : {}),
    decision: {
      policyOutcome: String(decision.outcome || 'allow'),
      family: decision.family || null,
      reasonCode: String(decision.reasonCode || 'WITHIN_CONTRACT'),
      responseOutcome: String(facts.responseOutcome || 'none'),
      hostEffect: 'unobserved'
    }
  };

  try {
    appendJsonl(eventPath(facts.sessionId, options), event);
    return event;
  } catch {
    return null;
  }
}

function eventFiles(query, options) {
  const root = runtimeRoot(options);
  if (query.sessionId) return [eventPath(query.sessionId, options)];
  if (query.sessionKey) return [path.join(root, `${query.sessionKey}.jsonl`)];
  try {
    return fs.readdirSync(root).filter((name) => name.endsWith('.jsonl') && name !== 'annotations.jsonl')
      .sort().map((name) => path.join(root, name));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function summarize(events, annotations, damagedRecords) {
  const latestLabels = new Map();
  for (const annotation of annotations) latestLabels.set(annotation.eventId, annotation.label);
  const labeledEvents = events.map((event) => ({ ...event, label: latestLabels.get(event.eventId) || null }));
  const summary = {
    checkedActions: labeledEvents.length,
    contextResponses: 0,
    permissionDenyResponses: 0,
    reasons: {},
    labels: { correct: 0, incorrect: 0, inconclusive: 0 },
    damagedRecords
  };
  for (const event of labeledEvents) {
    if (event.decision.responseOutcome === 'context_returned') summary.contextResponses += 1;
    if (event.decision.responseOutcome === 'permission_deny_returned') summary.permissionDenyResponses += 1;
    if (event.decision.responseOutcome === 'execution_denial_returned') {
      summary.executionDenialResponses = (summary.executionDenialResponses || 0) + 1;
    }
    summary.reasons[event.decision.reasonCode] = (summary.reasons[event.decision.reasonCode] || 0) + 1;
    if (event.label) summary.labels[event.label] += 1;
  }
  return { events: labeledEvents, summary };
}

function isRuntimeEvent(event) {
  return event && event.schemaVersion === 1
    && typeof event.eventId === 'string' && /^evt_[0-9a-f-]+$/i.test(event.eventId)
    && typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt))
    && ['off', 'observing', 'armed'].includes(event.controlState)
    && event.action && typeof event.action.toolName === 'string' && typeof event.action.mutability === 'string'
    && event.contract && typeof event.contract.mode === 'string'
    && event.decision && typeof event.decision.policyOutcome === 'string'
    && typeof event.decision.reasonCode === 'string' && /^[A-Z][A-Z_0-9]*$/.test(event.decision.reasonCode)
    && typeof event.decision.responseOutcome === 'string';
}

function readRuntime(query = {}, options = {}) {
  let events = [];
  let damagedRecords = 0;
  for (const file of eventFiles(query, options)) {
    const parsed = scanJsonl(file, event => {
      if (!isRuntimeEvent(event)) {
        damagedRecords += 1;
        return;
      }
      // Retain only selected events, while still counting damage in the whole log.
      if (query.limit !== 0 && (!query.eventId || event.eventId === query.eventId)) events.push(event);
    });
    damagedRecords += parsed.damaged;
  }
  // V8's stable sort preserves append order for equal timestamps within a log.
  events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  if (Number.isInteger(query.limit) && query.limit >= 0) events = events.slice(-query.limit);

  const eventIds = new Set(events.map((event) => event.eventId));
  const annotationResult = readAnnotations(options, eventIds);
  damagedRecords += annotationResult.damaged;
  const annotations = annotationResult.records;
  const result = summarize(events, annotations, damagedRecords);
  return { schemaVersion: 1, ...result, annotations };
}

module.exports = { readRuntime, recordDecision };

},
"package.json": function(module, exports, __require) {
module.exports = {
  "name": "stop-that-shit",
  "version": "0.2.5",
  "private": true,
  "description": "Keep agent work bounded and reduce defensive wording in Codex, Claude Code, OpenCode, Hermes Agent CLI, Pi, and Oh My Pi",
  "keywords": [
    "pi-package"
  ],
  "license": "MIT",
  "main": "./opencode/stop-that-shit.mjs",
  "bin": {
    "sts": "./scripts/sts.cjs"
  },
  "exports": {
    ".": "./opencode/stop-that-shit.mjs",
    "./server": "./opencode/stop-that-shit.mjs"
  },
  "files": [
    "server.mjs",
    "opencode/",
    "pi/",
    "omp/",
    "src/",
    "hooks/",
    ".hermes-plugin/",
    "skills/",
    "scripts/sts.cjs",
    "scripts/case-bundle-lib.cjs",
    "scripts/generated/case-bundle-v1-validator.cjs",
    "INSTALL.md",
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "README_CN.md",
    "README_EN.md",
    "README_KO.md"
  ],
  "pi": {
    "extensions": [
      "./pi/stop-that-shit.ts"
    ],
    "skills": [
      "./skills/stop-that-shit",
      "./skills/stss"
    ]
  },
  "scripts": {
    "schema:build": "node scripts/build-case-bundle-validator.cjs",
    "schema:check": "node scripts/build-case-bundle-validator.cjs --check",
    "pretest": "npm run schema:check",
    "hermes:build": "node scripts/build-hermes-plugin.cjs",
    "hermes:check": "node scripts/build-hermes-plugin.cjs --check",
    "test": "node scripts/test.cjs",
    "check": "npm test && npm run eval && npm run release:check",
    "sts": "node scripts/sts.cjs",
    "eval": "node scripts/evaluate-cases.cjs",
    "eval:selftest": "node --test test/case-bundle.test.cjs test/paired-eval.test.cjs",
    "eval:paired": "node scripts/run-paired-eval.cjs",
    "eval:routing": "node scripts/run-paired-eval.cjs --routing --runs 1",
    "eval:host-smoke": "node scripts/run-paired-eval.cjs --host-smoke --runs 1",
    "release:check": "npm run schema:check && npm run codex:check && node scripts/release-check.cjs",
    "release:build": "node scripts/build-release.cjs",
    "test:omp": "node --test test/omp-adapter.test.cjs test/omp-extension.test.cjs test/omp-package.test.cjs",
    "test:hosts": "node scripts/test-hosts.cjs",
    "codex:build": "node scripts/build-codex-plugin.cjs",
    "codex:check": "node scripts/build-codex-plugin.cjs --check"
  },
  "engines": {
    "node": ">=18",
    "opencode": ">=1.18.18 <2 || >=2.0.18 <3"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": {
      "optional": true
    }
  },
  "devDependencies": {
    "ajv": "^8.20.0"
  },
  "dependencies": {
    "@opencode/schema": "2.1.3",
    "effect": "4.0.0-rc.112"
  }
};
},
"src/runtime-annotations.cjs": function(module, exports, __require) {
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { appendJsonl, scanJsonl, runtimeRoot } = __require("src/runtime-storage.cjs");

const LABELS = new Set(['correct', 'incorrect', 'inconclusive']);

function annotationsPath(options = {}) {
  return path.join(runtimeRoot(options), 'annotations.jsonl');
}

function recordAnnotation(eventId, label, options = {}) {
  if (typeof eventId !== 'string' || !/^evt_[0-9a-f-]+$/i.test(eventId)) {
    throw new TypeError('annotation requires a valid event ID');
  }
  if (!LABELS.has(label)) {
    throw new TypeError(`unsupported annotation label: ${label}`);
  }
  const annotation = {
    schemaVersion: 1,
    annotationId: `ann_${crypto.randomUUID()}`,
    occurredAt: (options.now ? options.now() : new Date()).toISOString(),
    eventId,
    label
  };
  try {
    appendJsonl(annotationsPath(options), annotation);
    return annotation;
  } catch {
    return null;
  }
}

function isAnnotation(record) {
  return record && record.schemaVersion === 1
    && typeof record.eventId === 'string' && /^evt_[0-9a-f-]+$/i.test(record.eventId)
    && typeof record.occurredAt === 'string' && Number.isFinite(Date.parse(record.occurredAt))
    && LABELS.has(record.label);
}

function readAnnotations(options = {}, eventIds) {
  const records = [];
  let damaged = 0;
  const parsed = scanJsonl(annotationsPath(options), record => {
    if (!isAnnotation(record)) damaged += 1;
    else if (!eventIds || eventIds.has(record.eventId)) records.push(record);
  });
  return { records, damaged: damaged + parsed.damaged };
}

module.exports = { LABELS, readAnnotations, recordAnnotation };

},
"src/runtime-storage.cjs": function(module, exports, __require) {
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { dataRoot } = __require("src/state.cjs");

function runtimeRoot(options = {}) {
  const root = options.dataDir || process.env.STS_RUNTIME_DATA || dataRoot();
  return path.join(root, 'runtime');
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Isolate this record from an interrupted prior append without rewriting the
  // damaged evidence or racing another writer's tail check. Readers skip blanks.
  fs.appendFileSync(file, `\n${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function scanJsonl(file, onRecord) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { damaged: 0 };
    throw error;
  }

  let damaged = 0;
  function visitLine(line) {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      damaged += 1;
      return;
    }
    // Consumer failures are not malformed JSON and must reach the caller.
    onRecord(record);
  }

  try {
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      pending += bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
      let start = 0;
      let end;
      while ((end = pending.indexOf('\n', start)) !== -1) {
        visitLine(pending.slice(start, end));
        start = end + 1;
      }
      pending = pending.slice(start);
    } while (bytesRead);
    visitLine(pending);
  } finally {
    fs.closeSync(descriptor);
  }
  return { damaged };
}

function readJsonl(file) {
  const records = [];
  const { damaged } = scanJsonl(file, record => records.push(record));
  return { records, damaged };
}

module.exports = { appendJsonl, readJsonl, scanJsonl, runtimeRoot };

},
"src/state.cjs": function(module, exports, __require) {
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decodeState, freshState, recoveryState } = __require("src/state-schema.cjs");

const LOCK_STALE_MS = 10000;

function dataRoot(override) {
  return override || process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'stop-that-shit-dev');
}

function sessionKey(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId || 'unknown')).digest('hex').slice(0, 24);
}

function statePath(sessionId, override) {
  return path.join(dataRoot(override), 'sessions', `${sessionKey(sessionId)}.json`);
}

function readState(sessionId, override) {
  const file = statePath(sessionId, override);
  // Ordinary tool checks do not acquire the session lock. They must still
  // see a failed legacy lock migration instead of trusting stale authority.
  try {
    const lock = `${file}.lock`;
    const stat = fs.statSync(lock, { throwIfNoEntry: false });
    if (stat?.isFile() && Date.now() - stat.mtimeMs > LOCK_STALE_MS) legacyLockOwner(lock);
  } catch (error) {
    if (error.code === 'STS_LOCK_DAMAGED') return recoveryState({ code: error.code, message: error.message });
    // A completed migration may remove the old file or replace it with a directory.
    if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Reads may run without the session lock. Normalize in memory only;
    // the next locked mutation persists the current schema and latest ledger.
    return decodeState(parsed);
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
  // Do not replace an atomic rename with a partial overwrite on Windows.
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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

function ownerHasExited(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function legacyLockOwner(file) {
  const match = /^(\d+):/.exec(fs.readFileSync(file, 'utf8'));
  const pid = match && Number(match[1]);
  if (Number.isSafeInteger(pid) && pid > 0) return pid;
  const error = new Error(`The legacy session lock "${path.basename(file)}" has no valid owner. `
    + 'Read-only recovery is active; the lock and saved state are preserved. '
    + 'Start a new host session and submit a new contract, or stop every host process using this data directory '
    + 'before moving only this lock file aside. Keep the saved state and delegation records. '
    + 'See INSTALL.md#recover-a-damaged-legacy-session-lock.');
  error.name = 'STS_LOCK_DAMAGED';
  error.code = 'STS_LOCK_DAMAGED';
  throw error;
}

function removeEmptyLock(directory) {
  // Remove only an empty container. A contender may already have published
  // its own nonempty lock directory at this path.
  try { fs.rmdirSync(directory); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

function removeLockOwner(directory, owner) {
  try { fs.unlinkSync(path.join(directory, owner)); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw error;
  }
  removeEmptyLock(directory);
}

function reclaimSessionLock(file, staleMs) {
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs <= staleMs) return;
    if (stat.isDirectory()) {
      const owners = fs.readdirSync(file);
      if (owners.length === 0) {
        removeEmptyLock(file);
      } else {
        // Interrupted contenders can leave more than one marker. Reclaim each
        // confirmed exited owner by its unique name, retaining live owners.
        for (const owner of owners) {
          const match = /^(\d+)-[a-f0-9-]{36}$/.exec(owner);
          if (match && ownerHasExited(Number(match[1]))) removeLockOwner(file, owner);
        }
      }
    } else {
      // Previous releases used a file containing "pid:uuid timestamp".
      // A replacement directory cannot be removed by unlinkSync.
      if (ownerHasExited(legacyLockOwner(file))) fs.unlinkSync(file);
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return;
    if (error.code === 'EPERM' && fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) return;
    throw error;
  }
}

function acquireSessionLock(sessionId, override, options = {}) {
  const file = lockPath(sessionId, override);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : LOCK_STALE_MS;
  const started = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = `${process.pid}-${crypto.randomUUID()}`;
  while (true) {
    let created = false;
    try { fs.mkdirSync(file, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (created) {
      let acquired = false;
      try {
        fs.writeFileSync(path.join(file, owner), '', { flag: 'wx', mode: 0o600 });
        // If this process paused after mkdir, recovery may have replaced the
        // empty directory. Only the sole marker owner may enter. Winners keep
        // their marker until release, so a delayed initializer cannot also win.
        const owners = fs.readdirSync(file);
        acquired = owners.length === 1 && owners[0] === owner;
        if (acquired) return () => removeLockOwner(file, owner);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      } finally {
        if (!acquired) {
          removeLockOwner(file, owner);
          removeEmptyLock(file);
        }
      }
    }
    reclaimSessionLock(file, staleMs);
    if (Date.now() - started >= timeoutMs) {
      const timeout = new Error(`Timed out waiting for Stop That Shit session lock: ${sessionKey(sessionId)}`);
      timeout.code = 'STS_LOCK_TIMEOUT';
      throw timeout;
    }
    sleepSync(10);
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
  let release;
  try {
    release = acquireSessionLock(sessionId, override);
  } catch (error) {
    if (error.code !== 'STS_LOCK_DAMAGED') throw error;
    return update(recoveryState({ code: error.code, message: error.message }));
  }
  try {
    const state = readState(sessionId, override);
    const damaged = Boolean(state.storageError);
    const result = update(state);
    if (!damaged) writeState(sessionId, state, override);
    return result;
  } finally {
    release();
  }
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

},
"src/state-schema.cjs": function(module, exports, __require) {
'use strict';

const {
  defaultContract, normalizeContract, MODES, LEVELS, HASH_POLICIES, SCOPE_POLICIES
} = __require("src/contracts.cjs");

const CURRENT_SCHEMA_VERSION = 4;

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
    actionApproval: null,
    expiredApprovalEventId: null,
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
  let acceptedActions = source.acceptedActions && typeof source.acceptedActions === 'object'
    ? Object.fromEntries(Object.entries(source.acceptedActions)
      .filter(([actionId, count]) => typeof actionId === 'string' && actionId
        && Number.isSafeInteger(count) && count >= 0))
    : {};
  for (const reservation of Object.values(reservations)) {
    if (!reservation.actionId || Object.prototype.hasOwnProperty.call(acceptedActions, reservation.actionId)) continue;
    acceptedActions = { ...acceptedActions,
      [reservation.actionId]: reservation.pendingCount + reservation.agentIds.length };
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
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const legacyContract = source.contract && typeof source.contract === 'object' ? source.contract : {};
  const contract = normalizeContract(legacyContract);
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
    actionApproval: __require("src/action-approval.cjs").live(source.actionApproval) ? source.actionApproval : null,
    expiredApprovalEventId: !__require("src/action-approval.cjs").live(source.actionApproval)
      && /^evt_[0-9a-f-]{36}$/.test(source.actionApproval?.eventId || '') ? source.actionApproval.eventId
      : /^evt_[0-9a-f-]{36}$/.test(source.expiredApprovalEventId || '') ? source.expiredApprovalEventId : null,
    directiveWarning,
    directiveError,
    lastPromptContext: migrated ? null : source.lastPromptContext ?? null
  };
}

function validStoredContract(contract, schemaVersion) {
  const checks = {
    mode: value => value === 'unconfirmed' || MODES.has(value),
    level: value => LEVELS.has(value),
    agentBudget: value => Number.isSafeInteger(value) && value >= 0,
    hashPolicy: value => HASH_POLICIES.has(value),
    dependencyPolicy: value => SCOPE_POLICIES.has(value),
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

function decodeState(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || parsed.schemaVersion !== undefined && (!Number.isSafeInteger(parsed.schemaVersion)
        || parsed.schemaVersion < 1 || parsed.schemaVersion > CURRENT_SCHEMA_VERSION)
      || !parsed.contract || typeof parsed.contract !== 'object' || Array.isArray(parsed.contract)
      || !validStoredContract(parsed.contract, parsed.schemaVersion)
      || parsed.schemaVersion === CURRENT_SCHEMA_VERSION && !validStoredDelegation(parsed.delegation)) {
    throw new SyntaxError('Invalid control state structure');
  }
  return normalizeState(parsed);
}

module.exports = { decodeState, freshState, recoveryState };

},
"src/action-approval.cjs": function(module, exports, __require) {
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { directDependencyArguments } = __require("src/shell-analysis.cjs");
const { resolveManager } = __require("src/dependency-manager.cjs");
const { validMetadata } = __require("src/dependency-handoff.cjs");
const { decide } = __require("src/decision.cjs");
const { inspectDelegation } = __require("src/delegation-state.cjs");

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const PERMIT_TTL_MS = 10 * 60 * 1000;
const YES = 'Allow this operation once';
const NO = 'Deny this operation';
const PROPOSAL_PREFIX = 'Allow this controlled child operation once';
const SYNC_HEADER = 'Approval';
const YES_DESCRIPTION = 'Authorize this operation once.';
const NO_DESCRIPTION = 'Do not authorize this operation.';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(event) {
  const action = event.action;
  if (!action || !['Bash', 'exec_command', 'shell_command'].includes(action.name)
      || !action.id || Buffer.byteLength(action.id, 'utf8') > 256
      || !action.cwd || !action.input || typeof action.input.command !== 'string') return null;
  if (!directDependencyArguments(action.input.command) || /[\r\n]/.test(action.input.command)) return null;
  const bound = { session: event.sessionId, tool: action.name, input: action.input, cwd: action.cwd };
  if (event.agent?.agentId) bound.agentId = event.agent.agentId;
  const canonicalBound = stable(bound);
  return crypto.createHash('sha256').update(JSON.stringify(canonicalBound)).digest('hex');
}

function newPending(event, eventId, now = Date.now(), scope = {}) {
  const actionDigest = digest(event);
  if (!actionDigest || !eventId) return null;
  const argv = directDependencyArguments(event.action.input.command);
  // Do not place likely credentials or arbitrary environment fields in a user-visible question.
  if (Object.keys(event.action.input).some(key => key !== 'command')
      || argv.some(value => /(?:https?:|password|token|secret|api[_-]?key|authorization)/i.test(value))) return null;
  const manager = resolveManager(argv[0]);
  if (!manager) return null;
  const proposalExpires = now + PROPOSAL_TTL_MS;
  const questionPrefix = `${PROPOSAL_PREFIX}. Reply by ${new Date(proposalExpires).toISOString()}; if allowed, run once within 10 minutes after your reply: ${JSON.stringify(argv)} using ${JSON.stringify(manager.launchPath || manager.entry.path)} (${eventId}) in directory: `;
  if (Buffer.byteLength(questionPrefix, 'utf8') > 8192) return null;
  const record = { digest: actionDigest, eventId, questionPrefix, argv, manager,
    deniedActionId: event.action.id, expires: proposalExpires, proposalExpires, status: 'pending' };
  record.proposedAction = {
    mutability: event.action.mutability || 'unknown',
    analysisReason: event.action.analysisReason || null,
    hashIntent: Boolean(event.action.hashIntent),
    reachability: event.action.reachability || null,
    authorization: event.action.authorization || null,
    affectedPaths: Array.isArray(event.action.affectedPaths) ? event.action.affectedPaths.slice(0, 128) : [],
    cwd: event.action.cwd,
    unboundedDelegation: Boolean(event.action.unboundedDelegation),
    delegationLifecycleUnproven: Boolean(event.action.delegationLifecycleUnproven)
  };
  if (scope.agentId) {
    if (typeof scope.agentId !== 'string' || !scope.agentId.trim() || Buffer.byteLength(scope.agentId, 'utf8') > 4096
        || !/^[a-f0-9]{64}$/.test(scope.policyDigest || '')) return null;
    record.scopeAgentId = scope.agentId;
    record.policyDigest = scope.policyDigest;
  }
  return record;
}

function live(record, now = Date.now()) {
  return record && typeof record === 'object'
    && /^[a-f0-9]{64}$/.test(record.digest || '')
    && /^evt_[0-9a-f-]{36}$/.test(record.eventId || '')
    && typeof record.questionPrefix === 'string' && Buffer.byteLength(record.questionPrefix, 'utf8') <= 8192
    && Array.isArray(record.argv) && record.argv.every(arg => typeof arg === 'string')
    && record.manager && ['node', 'native'].includes(record.manager.kind)
    && record.manager.entry && typeof record.manager.entry.path === 'string'
    && (record.manager.kind !== 'node' || record.manager.executable && typeof record.manager.executable.path === 'string')
    && (record.status === 'pending' || typeof record.question === 'string' && Buffer.byteLength(record.question, 'utf8') <= 8192)
    && (record.status === 'issued' ? validDecisionAction(record.approvedAction)
      : record.proposedAction === undefined || validDecisionAction(record.proposedAction))
    && typeof record.deniedActionId === 'string' && record.deniedActionId.length > 0
    && (record.status === 'pending' || typeof record.questionId === 'string'
      && typeof record.questionCallId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(record.questionCallId))
    && (record.questionToolName === undefined || ['request_user_input_async', 'request_user_input'].includes(record.questionToolName))
    && (record.questionToolName !== 'request_user_input' || typeof record.syncQuestionId === 'string'
      && /^[A-Za-z0-9_-]{1,256}$/.test(record.syncQuestionId)
      && /^[a-f0-9]{64}$/.test(record.syncQuestionDigest || '')
      && typeof record.syncRegistrationCwd === 'string' && path.isAbsolute(record.syncRegistrationCwd))
    && Number.isSafeInteger(record.proposalExpires) && Number.isSafeInteger(record.expires)
    && (record.scopeAgentId === undefined || typeof record.scopeAgentId === 'string'
      && record.scopeAgentId.trim() && Buffer.byteLength(record.scopeAgentId, 'utf8') <= 4096
      && /^[a-f0-9]{64}$/.test(record.policyDigest || ''))
    && (['pending', 'question'].includes(record.status) ? record.proposalExpires : record.expires) > now
    && ['pending', 'question', 'approved', 'issued', 'consumed'].includes(record.status)
    && (record.status !== 'issued' || validMetadata(record.handoff));
}

function validDecisionAction(action) {
  return action && typeof action === 'object' && !Array.isArray(action)
    && ['read', 'write', 'delegate', 'control', 'unknown'].includes(action.mutability)
    && (action.analysisReason === undefined || action.analysisReason === null || typeof action.analysisReason === 'string')
    && typeof action.hashIntent === 'boolean'
    && (action.reachability === undefined || action.reachability === null || ['reachable', 'unreachable'].includes(action.reachability))
    && (action.authorization === undefined || action.authorization === null || typeof action.authorization === 'string')
    && Array.isArray(action.affectedPaths) && action.affectedPaths.length <= 128
    && action.affectedPaths.every(value => typeof value === 'string' && value.length <= 8192)
    && typeof action.cwd === 'string' && path.isAbsolute(action.cwd)
    && (action.unboundedDelegation === undefined || typeof action.unboundedDelegation === 'boolean')
    && (action.delegationLifecycleUnproven === undefined || typeof action.delegationLifecycleUnproven === 'boolean');
}

function proposalStillAllowed(record, contract, state = {}) {
  if (!live(record) || contract?.mode !== 'change' || contract?.level !== 'guard'
      || contract?.dependencyPolicy !== 'ask') return false;
  const saved = record.status === 'issued' ? record.approvedAction : record.proposedAction;
  if (!validDecisionAction(saved)) return saved === undefined;
  const action = { ...saved, cwd: record.targetCwd || saved.cwd, dependencyIntent: false };
  try {
    const result = decide({ contract, action, state, delegation: inspectDelegation(state.delegation) });
    return result.outcome === 'allow';
  } catch { return false; }
}

function isProposalQuestion(action, record) {
  const questions = action.input?.questions;
  return Array.isArray(questions) && questions.some(question => {
    const text = action.name === 'request_user_input' ? question?.question : question?.title;
    return typeof text === 'string' && (text.startsWith(PROPOSAL_PREFIX)
      || record && typeof record.eventId === 'string' && text.includes(record.eventId));
  });
}

function isSyncOptions(options) {
  return Array.isArray(options) && options.length === 2
    && options.every((option, index) => option && typeof option === 'object' && !Array.isArray(option)
      && Object.keys(option).length === 2 && Object.hasOwn(option, 'label') && Object.hasOwn(option, 'description')
      && option.label === (index === 0 ? YES : NO)
      && option.description === (index === 0 ? YES_DESCRIPTION : NO_DESCRIPTION));
}

function isSyncQuestion(question) {
  return question && typeof question === 'object' && !Array.isArray(question)
    && typeof question.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(question.id)
    && question.header === SYNC_HEADER && typeof question.question === 'string'
    && Buffer.byteLength(question.question, 'utf8') <= 8192 && isSyncOptions(question.options)
    && Object.keys(question).sort().join(',') === 'header,id,options,question';
}

function syncQuestionDigest(question) {
  if (!isSyncQuestion(question)) return null;
  const canonical = {
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options.map(option => ({ label: option.label, description: option.description }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function registerQuestion(record, action) {
  if (!live(record) || record.status !== 'pending' || !action.id
      || !/^[A-Za-z0-9_-]{1,256}$/.test(action.id)
      || !['request_user_input_async', 'request_user_input'].includes(action.name)) return false;
  const questions = action.input?.questions;
  if (!Array.isArray(questions) || questions.length !== 1 || Object.keys(action.input).length !== 1) return false;
  const question = questions[0];
  let text;
  if (action.name === 'request_user_input_async') {
    if (typeof question?.title !== 'string'
        || JSON.stringify(question?.options) !== JSON.stringify([YES, NO])
        || Object.keys(question).some(key => !['title', 'options'].includes(key))) return false;
    text = question.title;
  } else {
    if (!isSyncQuestion(question)) return false;
    text = question.question;
  }
  if (!text.startsWith(record.questionPrefix) || !text.endsWith('?')) return false;
  const requested = text.slice(record.questionPrefix.length, -1);
  if (!path.isAbsolute(requested) || /[\x00-\x1f\x7f]/.test(requested)) return false;
  let actual;
  let registrationCwd = null;
  try {
    actual = fs.realpathSync(requested);
    if (!fs.statSync(actual).isDirectory()) return false;
    if (action.name === 'request_user_input') {
      if (typeof action.cwd !== 'string' || !path.isAbsolute(action.cwd)) return false;
      registrationCwd = fs.realpathSync(action.cwd);
      if (!fs.statSync(registrationCwd).isDirectory()) return false;
    }
  } catch { return false; }
  if (Buffer.byteLength(text, 'utf8') > 8192) return false;
  record.question = text;
  record.requestedCwd = requested;
  record.targetCwd = actual;
  record.questionCallId = action.id;
  record.questionToolName = action.name;
  record.questionId = action.name === 'request_user_input_async'
    ? JSON.stringify(['request_user_input_async', action.id, 0])
    : JSON.stringify(['request_user_input', action.id, question.id]);
  if (action.name === 'request_user_input') {
    record.syncQuestionId = question.id;
    record.syncQuestionDigest = syncQuestionDigest(question);
    record.syncRegistrationCwd = registrationCwd;
  }
  record.status = 'question';
  return true;
}

function hostQuestionText(question) {
  let used = 0;
  let result = '';
  for (const char of question) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > 512) break;
    used += size;
    result += char;
  }
  return result.replace(/[\r\n]/g, ' ');
}

function acceptReply(record, text, now = Date.now()) {
  if (record?.questionToolName === 'request_user_input') return null;
  const match = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[1]); } catch { return null; }
  if (!Array.isArray(data)) return null;
  const related = data.some(item => item && typeof item === 'object' && !Array.isArray(item)
    && (typeof item.question === 'string' && item.question.startsWith(PROPOSAL_PREFIX)
      || record && item.questionItemId === record.questionId));
  if (!related) return null;
  if (!live(record, now) || record.status !== 'question' || typeof record.questionId !== 'string') return { status: 'unavailable' };
  if (data.length > 32 || data.some(item => !item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'answer,question,questionItemId'
      || !['questionItemId', 'question', 'answer'].every(key => typeof item[key] === 'string'))) return { status: 'mismatch' };
  const matches = data.filter(item => item.questionItemId === record.questionId);
  if (matches.length !== 1 || data.some(item => item.questionItemId !== record.questionId && item.question.startsWith(PROPOSAL_PREFIX))) return { status: 'mismatch' };
  const item = matches[0];
  if (item.question !== record.question && item.question !== hostQuestionText(record.question)) return { status: 'mismatch' };
  if (item.answer === YES) {
    record.status = 'approved';
    record.expires = now + PERMIT_TTL_MS;
    return { status: 'approved', eventId: record.eventId, targetCwd: record.targetCwd };
  }
  if (item.answer === NO) {
    record.status = 'consumed';
    return { status: 'denied', eventId: record.eventId };
  }
  return { status: 'mismatch' };
}

function nativeQuestionMatches(record, action, now = Date.now()) {
  if (!live(record, now) || record.status !== 'question'
      || record.questionToolName !== 'request_user_input' || action?.name !== 'request_user_input'
      || action.id !== record.questionCallId || action.questionId !== record.syncQuestionId
      || action.questionDigest !== record.syncQuestionDigest
      || typeof action.cwd !== 'string' || !path.isAbsolute(action.cwd)) return false;
  let cwd;
  try { cwd = fs.realpathSync(action?.cwd); } catch { return false; }
  return cwd === record.syncRegistrationCwd;
}

function nativeAnswerMatches(record, action, now = Date.now()) {
  return [YES, NO].includes(action?.answer) && nativeQuestionMatches(record, action, now);
}

function acceptNativeAnswer(record, action, now = Date.now()) {
  if (!nativeAnswerMatches(record, action, now)) return null;
  if (action.answer === YES) {
    record.status = 'approved';
    record.expires = now + PERMIT_TTL_MS;
    return { status: 'approved', eventId: record.eventId, targetCwd: record.targetCwd };
  }
  record.status = 'consumed';
  return { status: 'denied', eventId: record.eventId };
}

module.exports = { YES, NO, SYNC_HEADER, digest, newPending, live, proposalStillAllowed, isProposalQuestion, isSyncQuestion, syncQuestionDigest, registerQuestion, acceptReply, nativeQuestionMatches, nativeAnswerMatches, acceptNativeAnswer, hostQuestionText };

},
"src/shell-analysis.cjs": function(module, exports, __require) {
'use strict';

const HASH_COMMAND = /\b(?:Get-FileHash|md5sum|sha(?:1|224|256|384|512)sum|shasum|b2sum)\b|\bcertutil\b[^\r\n]*\s-hashfile\b|\bopenssl\s+dgst\b/i;
const DEPENDENCY_COMMAND = /\b(?:npm|pnpm|yarn)\s+(?:add|install)\b|\bpip(?:3)?\s+install\b|\bcargo\s+add\b|\bdotnet\s+add\b[^\r\n]*\bpackage\b|\bgo\s+get\b|\bcomposer\s+require\b|\bbundle\s+add\b/i;

function classifyGitBranchArguments(args) {
  let listing = false, positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positional ||= i + 1 < args.length; break; }
    if (!arg.startsWith('-')) { positional = true; continue; }
    if (/^(?:-[a-zA-Z]*[dDmMcCf][a-zA-Z]*|--(?:delete|move|copy|force|edit-description|set-upstream-to|unset-upstream|track|no-track|create-reflog)(?:=.*)?)$/.test(arg)) return 'write';
    if (arg === '--list' || /^-[alrv]+$/.test(arg)) {
      listing ||= arg === '--list' || arg.includes('l');
      continue;
    }
    if (/^--(?:contains|no-contains|merged|no-merged)(?:=.*)?$/.test(arg)) {
      listing = true;
      if (!arg.includes('=') && args[i + 1] && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (/^--(?:points-at|format|sort)(?:=.*)?$/.test(arg)) {
      listing ||= arg === '--points-at' || arg.startsWith('--points-at=');
      if (!arg.includes('=')) {
        if (i + 1 === args.length) return 'unknown';
        i++;
      }
      continue;
    }
    if (/^--(?:show-current|all|remotes|verbose|no-color|column|no-column|ignore-case|omit-empty|no-abbrev)$/.test(arg)
        || /^--(?:color=(?:always|never|auto)|abbrev(?:=\d+)?|column=.+)$/.test(arg)) continue;
    // Negation and abbreviations can cancel --list or select a mutation.
    return 'unknown';
  }
  return positional && !listing ? 'unknown' : 'read';
}

const READ_POWERSHELL_COMMANDS = new Set([
  'get-content', 'get-childitem', 'get-item', 'test-path', 'resolve-path',
  'select-string', 'select-object', 'measure-object', 'compare-object', 'where-object'
]);
const READ_SHELL_COMMANDS = new Set([
  ...READ_POWERSHELL_COMMANDS,
  'rg', 'grep', 'findstr', 'cat', 'ls', 'dir', 'pwd', 'head', 'tail', 'wc', 'type'
]);
const WRITE_SHELL_COMMANDS = new Set([
  'remove-item', 'move-item', 'copy-item', 'set-content', 'add-content', 'out-file',
  'new-item', 'rm', 'del', 'erase', 'rmdir', 'mv', 'cp', 'touch', 'mkdir', 'tee', 'apply_patch'
]);

// Analyze only static words, literal quotes and simple command chains. The
// hook does not expose a shell AST. Expansions, script blocks and ambiguous
// escapes stay unknown instead of being interpreted as Bash or PowerShell.
function staticShellCommands(text) {
  const commands = [];
  let args = [], word = '', inWord = false, quote = null, separator = null;
  let nativeQuotes = false;
  const finishWord = () => {
    if (inWord) args.push(word);
    word = ''; inWord = false;
  };
  const finishCommand = () => {
    commands.push({ args, nativeQuotes });
    args = []; nativeQuotes = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    // PowerShell recognizes these quotes; Bash treats them as ordinary text.
    // They are literal only inside a quote of the opposite kind.
    const smartQuote = /[\u2018-\u201b]/.test(char) ? "'"
      : /[\u201c-\u201e]/.test(char) ? '"' : null;
    if (smartQuote && (!quote || quote === smartQuote)) return null;
    if (quote) {
      // Legacy PowerShell native argv can split embedded double quotes back
      // into options. Cmdlets receive the literal argument directly.
      if (quote === "'" && char === '"' || quote === '"' && char === '"' && next === '"') nativeQuotes = true;
      if (char === quote) { quote = null; continue; }
      if (quote === '"' && (char === '$' || char === '`'
          || char === '\\' && /["$`\\\r\n]/.test(next || ''))) return null;
      word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; inWord = true; continue; }
    if (/[ \t]/.test(char)) { finishWord(); continue; }
    if (char === '>') return { redirected: true };
    if (/[$`{}()<@%*?\[\]#]/.test(char)) return null;
    // Bash removes even an escape before an ordinary letter (e.g. --out\put).
    // Without a shell identity, do not interpret an unquoted backslash.
    if (char === '\\') return null;
    if (char === '\r' || char === '\n' || char === ';' || char === '|' || char === '&') {
      finishWord();
      // PowerShell also accepts a standalone CR as a command separator.
      const operator = char === '\r' ? '\n'
        : (char === '&' || char === '|') && next === char ? char + text[++i] : char;
      if (operator === '&') return null;
      if (args.length) finishCommand();
      else if (operator === '\n') continue;
      else return null;
      separator = operator;
      continue;
    }
    if (/\s/.test(char)) return null;
    word += char; inWord = true;
  }
  if (quote) return null;
  finishWord();
  if (args.length) finishCommand();
  else if (['&&', '||', '|'].includes(separator)) return null;
  return commands.length ? { commands } : null;
}

// Consume ripgrep option values before interpreting -- or executable options.
// Otherwise a pattern named -- can hide a later --hostname-bin, or an option
// name used as a literal pattern can be mistaken for an executable option.
const RIPGREP_VALUE_OPTIONS = new Set([
  '--regexp', '--file', '--pre-glob', '--dfa-size-limit', '--encoding', '--engine',
  '--max-count', '--regex-size-limit', '--threads', '--glob', '--iglob',
  '--ignore-file', '--max-depth', '--max-filesize', '--type', '--type-not',
  '--type-add', '--type-clear', '--after-context', '--before-context', '--color',
  '--colors', '--context', '--context-separator', '--field-context-separator',
  '--field-match-separator', '--hyperlink-format', '--max-columns',
  '--path-separator', '--replace', '--sort', '--sortr', '--generate'
]);

function classifyRipgrepArguments(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (/^--(?:pre|hostname-bin)(?:=|$)/.test(arg)) return shellClassification('unknown', 'shell_execution_option');
    let consumesValue = RIPGREP_VALUE_OPTIONS.has(arg);
    if (/^-[^-]/.test(arg)) {
      // A value can be attached to a short option, including in a flag cluster.
      const valueFlag = /[efEmjgdtTABCMr]/.exec(arg.slice(1));
      consumesValue = Boolean(valueFlag && valueFlag.index === arg.length - 2);
    }
    if (consumesValue && ++i === args.length) return shellClassification('unknown', 'option_value_missing');
  }
  return shellClassification('read');
}

function shellClassification(mutability, analysisReason) {
  return { mutability, ...(analysisReason ? { analysisReason } : {}) };
}

function combineClassifications(classifications) {
  const kinds = classifications.map(result => result.mutability);
  const mutability = kinds.includes('write') ? 'write'
    : kinds.every(kind => kind === 'read') ? 'read' : 'unknown';
  const decisive = classifications.find(result => result.mutability === mutability);
  return shellClassification(mutability, decisive?.analysisReason);
}

function classifyStaticCommand({ args: [program, ...args], nativeQuotes }) {
  const name = String(program || '').toLowerCase();
  if (WRITE_SHELL_COMMANDS.has(name)) return shellClassification('write');
  const cmdlet = READ_POWERSHELL_COMMANDS.has(name);
  if (nativeQuotes && !cmdlet) return shellClassification('unknown', 'native_quotes_unproven');
  const classifications = [classifyCommandArguments(name, [...args])];
  // Legacy PowerShell drops empty native argv entries. A read must remain a
  // read in both interpretations; cmdlets receive their arguments directly.
  if (!cmdlet && args.includes('')) classifications.push(classifyCommandArguments(name, args.filter(arg => arg !== '')));
  const result = combineClassifications(classifications);
  if (classifications.some(entry => entry.mutability !== result.mutability)) result.analysisReason = 'native_empty_arguments';
  return result;
}

// A one-shot dependency approval may only bind one statically parsed direct invocation.
function directDependencyArguments(command, allowWrapper = true) {
  if (typeof command !== 'string') return null;
  const parsed = staticShellCommands(command.trim());
  if (!parsed || parsed.redirected || parsed.commands.length !== 1 || parsed.commands[0].nativeQuotes) return null;
  const [program, verb, ...args] = parsed.commands[0].args;
  // For an unambiguous PowerShell wrapper, authorize only the extracted
  // direct operation as a new controlled child, never execute the wrapper.
  if (allowWrapper && /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(String(program || ''))) {
    const parts = [verb, ...args];
    let index = 0;
    while (index < parts.length && /^-(?:nologo|noprofile|noninteractive)$/i.test(parts[index])) index++;
    if (!/^-command$/i.test(parts[index] || '') || parts.length !== index + 2) return null;
    return directDependencyArguments(parts[index + 1], false);
  }
  const name = String(program || '').toLowerCase(), operation = String(verb || '').toLowerCase();
  let recognized = false;
  if (['npm', 'pnpm', 'yarn'].includes(name)) recognized = ['install', 'add'].includes(operation);
  if (['pip', 'pip3'].includes(name)) recognized = operation === 'install';
  if (['cargo', 'bundle'].includes(name)) recognized = operation === 'add';
  if (name === 'composer') recognized = operation === 'require';
  if (name === 'go') recognized = operation === 'get';
  if (name === 'dotnet') recognized = operation === 'add' && args.some(value => value.toLowerCase() === 'package');
  return recognized ? parsed.commands[0].args : null;
}

function isDirectDependencyCommand(command) {
  return directDependencyArguments(command) !== null;
}

function analyzeShell(command) {
  const text = String(command || '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  const analysis = staticShellCommands(text);
  if (!analysis || analysis.redirected) return {
    ...shellClassification(analysis?.redirected ? 'write' : 'unknown', analysis?.redirected ? 'shell_redirection' : 'shell_syntax_unproven'),
    hashIntent: HASH_COMMAND.test(text), dependencyIntent: DEPENDENCY_COMMAND.test(text)
  };
  const commands = analysis.commands.map(command => ({
    ...classifyStaticCommand(command), text: command.args.join(' ')
  }));
  // Proven reads treat their arguments as data. Keep the existing intent checks
  // for writes and unproven programs, independently for each command in a chain.
  return {
    ...combineClassifications(commands),
    hashIntent: commands.some(command => command.mutability !== 'read' && HASH_COMMAND.test(command.text)),
    dependencyIntent: commands.some(command => command.mutability !== 'read' && DEPENDENCY_COMMAND.test(command.text))
  };
}

// Required values consume the following argument, even when it is --. Optional
// values must be attached with =. Unknown options cannot establish a read.
const GIT_QUERY_VALUE_OPTIONS = new Set([
  '--word-diff-regex', '--src-prefix', '--dst-prefix', '--line-prefix',
  '--output-indicator-new', '--output-indicator-old', '--output-indicator-context',
  '--diff-algorithm', '--anchored', '--ignore-matching-lines', '--diff-filter',
  '--stat-width', '--stat-name-width', '--stat-graph-width', '--stat-count',
  '--inter-hunk-context', '--rotate-to', '--skip-to', '--find-object'
]);
const GIT_QUERY_FLAGS = new Set([
  '--short', '--branch', '--show-stash', '--no-index', '--numstat', '--shortstat',
  '--name-only', '--name-status', '--check', '--summary', '--patch', '--no-patch',
  '--raw', '--binary', '--cached', '--staged', '--exit-code', '--quiet',
  '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-all-space',
  '--ignore-space-change', '--ignore-space-at-eol', '--ignore-cr-at-eol',
  '--ignore-blank-lines', '--patience', '--histogram', '--minimal',
  '--oneline', '--all', '--reverse', '--first-parent', '--no-merges', '--merges',
  '--graph', '--no-decorate', '--topo-order', '--date-order', '--no-renames',
  '--pickaxe-all', '--pickaxe-regex', '--no-prefix', '--default-prefix',
  '--show-toplevel', '--show-prefix', '--show-cdup', '--git-dir', '--git-common-dir',
  '--is-inside-work-tree', '--is-bare-repository', '--verify', '--symbolic-full-name'
]);
const GIT_QUERY_OPTIONAL_VALUES = new Set([
  '--stat', '--color', '--word-diff', '--color-words', '--relative', '--unified',
  '--abbrev', '--short', '--abbrev-ref', '--porcelain', '--untracked-files', '--ignored',
  '--find-renames', '--find-copies', '--break-rewrites', '--decorate', '--pretty'
]);
const GIT_QUERY_ATTACHED_ONLY = new Set([
  '--format', '--date', '--since', '--until', '--before', '--after', '--author',
  '--committer', '--grep', '--max-count', '--skip', '--diff-merges', '--encoding'
]);

function classifyGitQueryArguments(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (!arg.startsWith('-')) continue;
    if (/^--output(?:=|$)/.test(arg)) return shellClassification('write', 'git_output_file');
    const name = arg.split('=', 1)[0];
    if (GIT_QUERY_VALUE_OPTIONS.has(name)) {
      if (arg === name && ++i === args.length) return shellClassification('unknown', 'option_value_missing');
      continue;
    }
    if (GIT_QUERY_FLAGS.has(arg) || GIT_QUERY_OPTIONAL_VALUES.has(name)
        || arg.includes('=') && GIT_QUERY_ATTACHED_ONLY.has(name)) continue;
    if (/^-[SGOIn]$/.test(arg)) {
      if (++i === args.length) return shellClassification('unknown', 'option_value_missing');
      continue;
    }
    if (/^-[SGOI].+/.test(arg) || /^-n\d+$/.test(arg) || /^-\d+$/.test(arg)
        || /^-[pwsbz]+$/.test(arg) || /^-[UMCB](?:\d+%?)?$/.test(arg)
        || /^-u(?:no|normal|all)?$/.test(arg)) continue;
    return shellClassification('unknown', 'git_arguments_unproven');
  }
  return shellClassification('read');
}

function classifyCommandArguments(name, args) {
  if (name === 'git') {
    // Only these global options preserve the supported command interpretation.
    while (args.length) {
      if (args[0] === '--no-pager' || args[0] === '--literal-pathspecs') args.shift();
      else if (args[0] === '-C' && args.length > 1) args.splice(0, 2);
      else break;
    }
    const subcommand = args.shift();
    if (['add', 'commit', 'push', 'merge', 'rebase', 'checkout', 'switch', 'reset', 'restore', 'clean', 'tag'].includes(subcommand)) return shellClassification('write');
    if (subcommand === 'branch') {
      const mutability = classifyGitBranchArguments(args);
      return shellClassification(mutability, mutability === 'unknown' ? 'git_arguments_unproven' : undefined);
    }
    if (['status', 'diff', 'log', 'show', 'rev-parse'].includes(subcommand)) return classifyGitQueryArguments(args);
    return shellClassification('unknown', 'git_arguments_unproven');
  }
  if (['npm', 'pnpm', 'yarn'].includes(name) && ['add', 'install', 'remove', 'uninstall', 'publish'].includes(args[0])) return shellClassification('write');
  if (['pip', 'pip3'].includes(name) && args[0] === 'install') return shellClassification('write');
  if (name === 'gh' && /^(?:pr (?:create|merge|close)|issue (?:create|close)|release create)$/.test(args.slice(0, 2).join(' '))) return shellClassification('write');
  if (name === 'rg') return classifyRipgrepArguments(args);
  if (READ_SHELL_COMMANDS.has(name)) return shellClassification('read');
  if (['node', 'python', 'python3', 'py'].includes(name) && args.length === 1 && args[0] === '--version') return shellClassification('read');
  return shellClassification('unknown', 'shell_command_unproven');
}

function classifyShell(command) {
  return analyzeShell(command).mutability;
}

// Some installed hook payloads lack command but carry intent text in a legacy
// field. Keep their mutability unproven while retaining hash/dependency facts.
function analyzeShellInput(toolInput) {
  const command = toolInput && toolInput.command;
  const text = typeof toolInput === 'string' ? toolInput
    : toolInput && typeof toolInput === 'object'
      ? String(toolInput.command || toolInput.patch || toolInput.content || toolInput.new_string || '') : '';
  const analysis = analyzeShell(command);
  if (text !== String(command || '')) {
    const intents = analyzeShell(text);
    analysis.hashIntent = intents.hashIntent;
    analysis.dependencyIntent = intents.dependencyIntent;
  }
  return analysis;
}

module.exports = { analyzeShell, analyzeShellInput, classifyShell, isDirectDependencyCommand, directDependencyArguments };

},
"src/dependency-manager.cjs": function(module, exports, __require) {
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function fingerprint(file) {
  const real = fs.realpathSync(file);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error('Package manager entry is not a file');
  return { path: real, size: stat.size, mtimeMs: stat.mtimeMs,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex') };
}

function resolveManager(name) {
  const search = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const lower = String(name).toLowerCase();
  for (const directory of search) {
    const candidates = [];
    if (lower === 'pnpm') candidates.push(path.join(directory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'));
    if (lower === 'npm') candidates.push(path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return { kind: 'node', entry: fingerprint(candidate), executable: fingerprint(process.execPath) };
    }
    // A POSIX shim may be a symlink to the manager's JS entry. Windows cmd/ps1
    // shims cannot be executed safely with shell:false and are not accepted.
    const launchPath = path.join(directory, process.platform === 'win32' ? `${lower}.exe` : lower);
    if (!fs.existsSync(launchPath)) continue;
    const entry = fingerprint(launchPath);
    if (process.platform !== 'win32' && /(?:pnpm\.cjs|npm-cli\.js)$/i.test(entry.path)) {
      return { kind: 'node', entry, executable: fingerprint(process.execPath) };
    }
    if (process.platform !== 'win32' && !(fs.statSync(launchPath).mode & 0o111)) continue;
    return { kind: 'native', entry, launchPath: path.resolve(launchPath) };
  }
  return null;
}

function unchanged(expected) {
  try { return JSON.stringify(fingerprint(expected.path)) === JSON.stringify(expected); }
  catch { return false; }
}

module.exports = { fingerprint, resolveManager, unchanged };

},
"src/dependency-handoff.cjs": function(module, exports, __require) {
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createdHandoffs = new Set();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function bindingPayload(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || typeof binding.sessionId !== 'string' || !binding.sessionId
      || !/^evt_[0-9a-f-]{36}$/.test(binding.eventId || '')
      || !/^[a-f0-9]{64}$/.test(binding.ticket || '')
      || !/^[a-f0-9]{64}$/.test(binding.actionDigest || '')
      || binding.agentId !== undefined && binding.agentId !== null
        && (typeof binding.agentId !== 'string' || !binding.agentId.trim() || Buffer.byteLength(binding.agentId, 'utf8') > 4096)
      || binding.policyDigest !== undefined && binding.policyDigest !== null && !/^[a-f0-9]{64}$/.test(binding.policyDigest)
      || typeof binding.targetCwd !== 'string' || !path.isAbsolute(binding.targetCwd)
      || !Array.isArray(binding.argv) || !binding.argv.every(value => typeof value === 'string')
      || !binding.manager || typeof binding.manager !== 'object' || Array.isArray(binding.manager)) {
    throw new Error('Invalid one-time handoff binding');
  }
  const payload = {
    version: 1,
    sessionId: binding.sessionId,
    eventId: binding.eventId,
    ticket: binding.ticket,
    actionDigest: binding.actionDigest,
    argv: binding.argv,
    targetCwd: binding.targetCwd,
    manager: binding.manager
  };
  if (binding.agentId) payload.agentId = binding.agentId;
  if (binding.policyDigest) payload.policyDigest = binding.policyDigest;
  return Buffer.from(JSON.stringify(canonical(payload)), 'utf8');
}

function fileIdentity(stat) {
  if (!stat || !stat.isFile() || typeof stat.nlink !== 'bigint' || stat.nlink !== 1n
      || typeof stat.ino !== 'bigint' || stat.ino === 0n
      || typeof stat.dev !== 'bigint' || typeof stat.birthtimeNs !== 'bigint') return null;
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() };
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function statHasIdentity(stat, identity) {
  return stat && typeof stat.dev === 'bigint' && typeof stat.ino === 'bigint'
    && typeof stat.birthtimeNs === 'bigint'
    && stat.dev.toString() === identity.dev && stat.ino.toString() === identity.ino
    && stat.birthtimeNs.toString() === identity.birthtimeNs;
}

function canonicalPath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function validMetadata(handoff) {
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)
      || handoff.version !== 1 || typeof handoff.path !== 'string' || !path.isAbsolute(handoff.path)
      || typeof handoff.tempRoot !== 'string' || !path.isAbsolute(handoff.tempRoot)
      || !/^[a-f0-9]{64}$/.test(handoff.sha256 || '')
      || !handoff.identity || typeof handoff.identity !== 'object' || Array.isArray(handoff.identity)
      || !['dev', 'ino', 'birthtimeNs'].every(key => typeof handoff.identity[key] === 'string' && /^\d+$/.test(handoff.identity[key]))) return false;
  const root = path.resolve(handoff.tempRoot);
  const file = path.resolve(handoff.path);
  let expectedRoot;
  try { expectedRoot = path.join(fs.realpathSync(os.tmpdir()), 'stop-that-shit-handoffs'); }
  catch { return false; }
  return canonicalPath(root) === canonicalPath(expectedRoot)
    && canonicalPath(path.dirname(file)) === canonicalPath(root)
    && /^\.sts-dependency-[a-f0-9]{64}\.handoff$/.test(path.basename(file));
}

function systemTempRoot() {
  const root = fs.realpathSync(os.tmpdir());
  if (!fs.statSync(root).isDirectory()) throw new Error('One-time handoff temp root is unavailable');
  return root;
}

function handoffTempRoot() {
  const parent = systemTempRoot();
  const candidate = path.join(parent, 'stop-that-shit-handoffs');
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(candidate);
  if (canonicalPath(path.dirname(root)) !== canonicalPath(parent)
      || path.basename(root) !== 'stop-that-shit-handoffs'
      || !fs.statSync(root).isDirectory()) throw new Error('One-time handoff temp directory is not canonical');
  return root;
}

function cleanExpiredHandoffs(root, now = Date.now()) {
  const cutoff = now - 60 * 60 * 1000;
  for (const name of fs.readdirSync(root)) {
    if (!/^\.sts-dependency-[a-f0-9]{64}\.(?:handoff|claim|discard)$/.test(name)) continue;
    const file = path.join(root, name);
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || Number(stat.mtimeMs) >= cutoff) continue;
      fs.unlinkSync(file);
    } catch {}
  }
}

function readHandle(fd) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (stat.size > 65536n) throw new Error('One-time handoff contents are oversized');
  const bytes = Buffer.alloc(Number(stat.size));
  const bytesRead = fs.readSync(fd, bytes, 0, bytes.length, 0);
  if (BigInt(bytesRead) !== stat.size) throw new Error('One-time handoff contents changed while reading');
  return bytes;
}

function createHandoff(binding) {
  const bytes = bindingPayload(binding);
  const tempRoot = handoffTempRoot();
  cleanExpiredHandoffs(tempRoot);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const file = path.join(tempRoot, `.sts-dependency-${crypto.randomBytes(32).toString('hex')}.handoff`);
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(file, { bigint: true });
      const identity = fileIdentity(opened);
      if (!identity || !sameIdentity(identity, fileIdentity(named))) throw new Error('One-time handoff file identity is unavailable');
      const handoff = { version: 1, path: file, tempRoot, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), identity };
      createdHandoffs.add(file);
      return handoff;
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      try { fs.unlinkSync(file); } catch {}
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  throw new Error('Could not allocate a unique one-time handoff file');
}

function handoffAvailable(handoff, binding) {
  if (!validMetadata(handoff)) return false;
  let fd;
  try {
    if (canonicalPath(handoffTempRoot()) !== canonicalPath(handoff.tempRoot)) return false;
    const expected = bindingPayload(binding);
    if (crypto.createHash('sha256').update(expected).digest('hex') !== handoff.sha256) return false;
    fd = fs.openSync(handoff.path, 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(fileIdentity(stat), handoff.identity)) return false;
    const named = fs.lstatSync(handoff.path, { bigint: true });
    return !named.isSymbolicLink() && sameIdentity(fileIdentity(named), handoff.identity)
      && readHandle(fd).equals(expected);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function consumeHandoff(handoff, binding) {
  if (!validMetadata(handoff) || canonicalPath(handoffTempRoot()) !== canonicalPath(handoff.tempRoot)) {
    throw new Error('One-time handoff is unavailable or invalid');
  }
  const expected = bindingPayload(binding);
  if (crypto.createHash('sha256').update(expected).digest('hex') !== handoff.sha256) {
    throw new Error('One-time handoff binding digest mismatch');
  }
  let fd;
  let claimedPath;
  try {
    const named = fs.lstatSync(handoff.path, { bigint: true });
    if (named.isSymbolicLink() || !sameIdentity(fileIdentity(named), handoff.identity)) throw new Error('One-time handoff path identity changed');
    // rename is the atomic winner election. Only its winner opens the claimed
    // path, so losing contenders do not keep delete-pending handles on Windows.
    claimedPath = path.join(handoff.tempRoot, `.sts-dependency-${crypto.randomBytes(32).toString('hex')}.claim`);
    fs.renameSync(handoff.path, claimedPath);
    const claimed = fs.lstatSync(claimedPath, { bigint: true });
    if (claimed.isSymbolicLink() || !sameIdentity(fileIdentity(claimed), handoff.identity)) {
      throw new Error('Claimed handoff path identity changed');
    }
    fd = fs.openSync(claimedPath, 'r');
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(fileIdentity(opened), handoff.identity)) throw new Error('Claimed handoff identity changed');
    const bytes = readHandle(fd);
    if (!bytes.equals(expected) || crypto.createHash('sha256').update(bytes).digest('hex') !== handoff.sha256) {
      throw new Error('One-time handoff contents changed');
    }
    try {
      fs.lstatSync(handoff.path);
      throw new Error('One-time handoff source path was replaced during claim');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.unlinkSync(claimedPath);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!statHasIdentity(after, handoff.identity) || after.nlink !== 0n) {
      throw new Error('One-time handoff was not atomically unlinked');
    }
    fs.closeSync(fd);
    fd = undefined;
    for (const file of [handoff.path, claimedPath]) try {
      fs.lstatSync(file);
      throw new Error('One-time handoff path was replaced during consumption');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    createdHandoffs.delete(handoff.path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('One-time handoff is already consumed or unavailable');
    throw error;
  } finally {
    if (claimedPath) {
      try {
        const stat = fs.lstatSync(claimedPath, { bigint: true });
        if (!stat.isSymbolicLink() && statHasIdentity(stat, handoff.identity)) fs.unlinkSync(claimedPath);
      } catch {}
    }
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function discardHandoff(handoff) {
  if (!validMetadata(handoff)) return false;
  let fd;
  let claimedPath;
  try {
    fd = fs.openSync(handoff.path, 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(fileIdentity(stat), handoff.identity)) return false;
    const bytes = readHandle(fd);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== handoff.sha256) return false;
    claimedPath = path.join(handoff.tempRoot, `.sts-dependency-${crypto.randomBytes(32).toString('hex')}.discard`);
    fs.renameSync(handoff.path, claimedPath);
    const moved = fs.lstatSync(claimedPath, { bigint: true });
    if (moved.isSymbolicLink() || !sameIdentity(fileIdentity(moved), handoff.identity)) return false;
    fs.unlinkSync(claimedPath);
    const discarded = fs.fstatSync(fd, { bigint: true }).nlink === 0n;
    if (discarded) createdHandoffs.delete(handoff.path);
    return discarded;
  } catch {
    return false;
  } finally {
    if (fd !== undefined && claimedPath) {
      try {
        const stat = fs.lstatSync(claimedPath, { bigint: true });
        if (!stat.isSymbolicLink() && statHasIdentity(stat, handoff.identity)) fs.unlinkSync(claimedPath);
      } catch {}
    }
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function bindingForRecord(sessionId, record, ticket = record?.ticket) {
  if (!record || typeof record !== 'object') throw new Error('Approval record is unavailable');
  return { sessionId, agentId: record.scopeAgentId || null, policyDigest: record.policyDigest || null,
    eventId: record.eventId, ticket, actionDigest: record.digest,
    argv: record.argv, targetCwd: record.targetCwd, manager: record.manager };
}

function withCoordinationLock(sessionId, dataDir, callback) {
  const { dataRoot, withSessionLock } = __require("src/state.cjs");
  const root = systemTempRoot();
  const requestedRoot = path.resolve(dataRoot(dataDir));
  let existing = requestedRoot;
  const missing = [];
  let realRoot;
  while (!realRoot) {
    try { realRoot = fs.realpathSync(existing); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const canonicalDataRoot = path.resolve(realRoot, ...missing);
  const scope = crypto.createHash('sha256').update(`${canonicalDataRoot}\0${String(sessionId)}`).digest('hex');
  return withSessionLock(`dependency-${scope}`, path.join(root, 'stop-that-shit-coordination'), callback);
}

function cleanupCreatedHandoffs() {
  for (const file of createdHandoffs) {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isSymbolicLink() && stat.isFile()) fs.unlinkSync(file);
    } catch {}
  }
  createdHandoffs.clear();
}

module.exports = { bindingForRecord, createHandoff, consumeHandoff, discardHandoff, handoffAvailable,
  validMetadata, withCoordinationLock, cleanupCreatedHandoffs };

},
"src/approval-scope.cjs": function(module, exports, __require) {
'use strict';

const path = require('node:path');
const stateStore = __require("src/state.cjs");
const contracts = __require("src/contracts.cjs");

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
  const { withCoordinationLock } = __require("src/dependency-handoff.cjs");
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

},
"src/runner-command.cjs": function(module, exports, __require) {
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsJobGuardPrelude() {
  const guardPath = Buffer.from(path.join(__dirname, 'windows-job-guard.cs'), 'utf8').toString('base64');
  return [
    `$jobPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${guardPath}'))`,
    '$jobReady = $false',
    'try { $jobSource = [IO.File]::ReadAllText($jobPath); Add-Type -TypeDefinition $jobSource -ErrorAction Stop | Out-Null; $jobReady = [StssRunnerJob]::AttachCurrentProcess() } catch { $jobReady = $false }',
    'if (-not $jobReady) { [Console]::Error.WriteLine("Stop That Shit: Windows process-tree containment is unavailable."); exit 1 }'
  ].join('; ');
}

function isShellNeutralWindowsPath(value) {
  return /^[A-Za-z]:\\[A-Za-z0-9_.~\\-]+$/.test(String(value || ''));
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).replace(/\\+$/, '').toLowerCase()
    === path.win32.normalize(right).replace(/\\+$/, '').toLowerCase();
}

function getWindowsShortPath(powerShellPath) {
  const encodedPath = Buffer.from(powerShellPath, 'utf16le').toString('base64');
  const source = [
    "$native = 'using System; using System.Text; using System.Runtime.InteropServices; public static class StssPath { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint capacity); }'",
    'Add-Type -TypeDefinition $native',
    `$longPath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    '$buffer = New-Object System.Text.StringBuilder 32768',
    '$length = [StssPath]::GetShortPathName($longPath, $buffer, [uint32]$buffer.Capacity)',
    'if ($length -eq 0 -or $length -ge $buffer.Capacity) { exit 5 }',
    '[Console]::Out.Write($buffer.ToString())'
  ].join('; ');
  const result = spawnSync(powerShellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], {
    encoding: 'utf8', windowsHide: true, timeout: 5000, shell: false
  });
  if (result.error || result.status !== 0) {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because Windows did not provide a usable short path.');
  }
  return String(result.stdout || '').trim();
}

function resolveWindowsPowerShell({ systemRoot = process.env.SystemRoot || process.env.WINDIR, fsApi = fs, shortPath = getWindowsShortPath } = {}) {
  if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because SystemRoot is not an absolute Windows path.');
  }
  let canonicalRoot;
  let canonicalPowerShell;
  try {
    canonicalRoot = fsApi.realpathSync(systemRoot);
    const candidate = path.win32.join(canonicalRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    canonicalPowerShell = fsApi.realpathSync(candidate);
    if (!fsApi.statSync(canonicalPowerShell).isFile()) throw new Error('not a file');
  } catch {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because the system PowerShell executable could not be verified under SystemRoot.');
  }
  const relative = path.win32.relative(canonicalRoot, canonicalPowerShell);
  if (!relative || relative === '..' || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because the PowerShell executable resolves outside SystemRoot.');
  }

  if (isShellNeutralWindowsPath(canonicalPowerShell)) return canonicalPowerShell;

  let short;
  try { short = shortPath(canonicalPowerShell); }
  catch { short = null; }
  if (!isShellNeutralWindowsPath(short)) {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because the system PowerShell path contains shell-sensitive characters and no usable short path exists.');
  }
  try {
    if (!sameWindowsPath(fsApi.realpathSync(short), canonicalPowerShell)) throw new Error('different file');
  } catch {
    throw new Error('A safe CMD/PowerShell launcher path is unavailable because the short path could not be verified as the system PowerShell executable.');
  }
  return short;
}

function buildRunnerCommand({ executable, runnerPath, sessionId, dataDir, ticket, agentId, platform = process.platform, windowsPowerShellPath } = {}) {
  const bootstrap = "require(Buffer.from(process.argv[1],'base64').toString('utf8')).run(Buffer.from(process.argv[2],'base64').toString('utf8'),Buffer.from(process.argv[3],'base64').toString('utf8'),process.argv[4],Buffer.from(process.argv[5]||'','base64').toString('utf8'))";
  const args = [executable, '-e', bootstrap, encode(runnerPath), encode(sessionId), encode(dataDir), ticket, encode(agentId || '')];

  if (platform === 'win32') {
    const script = `${windowsJobGuardPrelude()}; & ${args.map(quotePowerShell).join(' ')}; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`;
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    // The absolute system path is either shell-neutral itself or a verified
    // 8.3 alias. No executable from PATH launches the approved runner.
    const powershell = windowsPowerShellPath || resolveWindowsPowerShell();
    if (!isShellNeutralWindowsPath(powershell)) throw new Error('A safe CMD/PowerShell launcher path is unavailable.');
    return `${powershell} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`;
  }

  return args.map(quotePosix).join(' ');
}

module.exports = { buildRunnerCommand, isShellNeutralWindowsPath, resolveWindowsPowerShell };

},
"src/dependency-runner.cjs": function(module, exports, __require) {
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { readState } = __require("src/state.cjs");
const { live, proposalStillAllowed } = __require("src/action-approval.cjs");
const { bindingForRecord, consumeHandoff, withCoordinationLock } = __require("src/dependency-handoff.cjs");
const { unchanged } = __require("src/dependency-manager.cjs");
const { decide } = __require("src/decision.cjs");
const { inspectDelegation } = __require("src/delegation-state.cjs");
const approvalScope = __require("src/approval-scope.cjs");

function claim(sessionId, dataDir, ticket, agentId = '') {
  return withCoordinationLock(sessionId, dataDir, () => {
    let state;
    let contract;
    if (agentId) {
      const store = __require("src/state.cjs");
      const contracts = __require("src/contracts.cjs");
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

},
"src/adapters/hermes-tool-classifier.cjs": function(module, exports, __require) {
'use strict';

const { manifestEditDependencyIntent, manifestDependencyIntent, patchDependencyIntent } = __require("src/manifest-dependencies.cjs");

const nodePath = require('node:path');
const { analyzeShellInput, classifyShell } = __require("src/shell-analysis.cjs");
const { detectDependencyIntent: detectCodexDependencyIntent } = __require("src/adapters/codex-tool-classifier.cjs");
const { detectHashIntent: detectToolHashIntent } = __require("src/hash-intent.cjs");

const READ_TOOLS = new Set([
  'read_file',
  'search_files',
  'web_search',
  'web_extract',
  'vision_analyze'
]);
const WRITE_TOOLS = new Set(['write_file', 'patch']);
const DELEGATE_TOOLS = new Set(['delegate_task']);
const CONTROL_TOOLS = new Set(['clarify', 'todo']);
const DELEGATE_CONTROL_ACTIONS = new Set(['list', 'steer', 'stop']);

function isHermesDelegationControl(toolName, toolInput) {
  const action = toolInput && typeof toolInput === 'object' ? toolInput.action : null;
  return toolName === 'delegate_task'
    && DELEGATE_CONTROL_ACTIONS.has(String(action || '').toLowerCase());
}

function countHermesDelegation(toolName, toolInput) {
  if (toolName !== 'delegate_task' || isHermesDelegationControl(toolName, toolInput)) return 0;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  let tasks = input.tasks;
  // Match Hermes' task-list normalization: recover only JSON arrays; an empty
  // array falls back to goal. Invalid strings are rejected before any spawn.
  if (typeof tasks === 'string') {
    try { tasks = JSON.parse(tasks); } catch { return 0; }
    if (!Array.isArray(tasks)) return 0;
  }
  if (Array.isArray(tasks) && tasks.length) return tasks.length;
  if (typeof input.goal === 'string' && input.goal.trim()) return 1;
  return 0;
}

function classifyHermesTool(toolName, toolInput) {
  const name = String(toolName || '');
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (isHermesDelegationControl(name, toolInput)) return 'control';
  if (DELEGATE_TOOLS.has(name)) return 'delegate';
  if (CONTROL_TOOLS.has(name)) return 'control';
  if (name === 'terminal') return classifyShell(toolInput && toolInput.command);
  return 'unknown';
}

function isWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function normalizePath(value, cwd) {
  const raw = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return '';

  const base = String(cwd || '');
  if (isWindowsAbsolute(raw)) {
    const relative = isWindowsAbsolute(base) ? nodePath.win32.relative(base, raw) : raw;
    return relative.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  let normalized = raw.replace(/\\/g, '/');
  if (base && nodePath.posix.isAbsolute(normalized)) {
    normalized = nodePath.posix.relative(base.replace(/\\/g, '/'), normalized);
  }
  return normalized.replace(/^\.\//, '');
}

function extractAffectedPaths(toolName, toolInput, cwd) {
  const name = String(toolName || '');
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};

  if (name === 'write_file') {
    const target = normalizePath(input.path, cwd);
    return target ? [target] : [];
  }
  if (name !== 'patch') return [];

  const mode = input.mode || 'replace';
  if (mode === 'replace') {
    const target = normalizePath(input.path, cwd);
    return target ? [target] : [];
  }
  if (mode !== 'patch') return [];

  const paths = [];
  for (const line of String(input.patch || '').split(/\r?\n/)) {
    const file = /^\*\*\*\s*(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/.exec(line);
    if (file) {
      paths.push(normalizePath(file[1], cwd));
      continue;
    }
    const move = /^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+?)\s*$/.exec(line);
    if (move) paths.push(normalizePath(move[1], cwd), normalizePath(move[2], cwd));
  }
  return [...new Set(paths.filter(Boolean))];
}

function codexIntentInput(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (toolName !== 'patch' || (input.mode || 'replace') === 'patch') return input;
  return { path: input.path, content: input.new_string };
}

function codexToolName(toolName, toolInput) {
  if (toolName === 'terminal') return 'exec_command';
  if (toolName === 'patch') return (toolInput && toolInput.mode || 'replace') === 'patch' ? 'apply_patch' : 'Write';
  if (toolName === 'write_file') return 'Write';
  return String(toolName || '');
}

function detectDependencyIntent(toolName, toolInput) {
  if (toolName === 'terminal') return analyzeShellInput(codexIntentInput(toolName, toolInput)).dependencyIntent;
  const name = codexToolName(toolName, toolInput);
  const input = codexIntentInput(toolName, toolInput);
  if (toolName === 'patch' && name === 'Write') return manifestEditDependencyIntent(input.path, toolInput.old_string, input.content);
  if (name === 'Write') return manifestDependencyIntent(input.path, input.content);
  if (name === 'apply_patch') return patchDependencyIntent(input.patch);
  return detectCodexDependencyIntent(name, input);
}

function detectHashIntent(toolName, toolInput) {
  if (toolName === 'terminal') return analyzeShellInput(codexIntentInput(toolName, toolInput)).hashIntent;
  return detectToolHashIntent(codexToolName(toolName, toolInput), codexIntentInput(toolName, toolInput));
}

function analyzeHermesTool(toolName, toolInput, cwd) {
  const analysis = toolName === 'terminal'
    ? analyzeShellInput(codexIntentInput(toolName, toolInput))
    : {
      mutability: classifyHermesTool(toolName, toolInput),
      hashIntent: detectHashIntent(toolName, toolInput),
      dependencyIntent: detectDependencyIntent(toolName, toolInput)
    };
  return { ...analysis, affectedPaths: extractAffectedPaths(toolName, toolInput, cwd) };
}

module.exports = {
  analyzeHermesTool,
  classifyHermesTool,
  countHermesDelegation,
  extractAffectedPaths,
  detectDependencyIntent,
  detectHashIntent,
  isHermesDelegationControl
};

},
"src/manifest-dependencies.cjs": function(module, exports, __require) {
'use strict';

const MANIFEST = /(?:^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|composer\.json|Gemfile)$/i;
const FIELD = /["']?(?:dependencies|devDependencies|optionalDependencies|peerDependencies|require|require-dev)["']?\s*[:=]/i;
const REQUIREMENT = /^\s*[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[^\]\r\n]+\])?\s*(?:(?:===|==|~=|!=|<=|>=|<|>|@)\s*\S+)?(?:\s*;.*)?\s*$/;

function sectionKey(section) {
  // Bare TOML keys may also be quoted or padded around their separators.
  return section.trim().replace(/(^|\.)\s*(?:([\w-]+)|"([\w-]+)"|'([\w-]+)')\s*(?=\.|$)/g,
    (_, dot, bare, double, single) => dot + (bare ?? double ?? single));
}

function dependencySection(filePath, section) {
  const file = String(filePath || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  return file === 'cargo.toml'
    ? /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)(?:\.|$)/.test(section)
    : file === 'pyproject.toml' && /(?:^|\.)(?:dependencies|dev-dependencies|optional-dependencies)(?:\.|$)/.test(section);
}

function jsonDeclarations(filePath, content, fragment) {
  if (!/(?:^|\/)(?:package|composer)\.json$/i.test(String(filePath || '').replace(/\\/g, '/'))) return null;
  let manifest;
  try { manifest = JSON.parse(String(content)); } catch { return null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'require', 'require-dev'];
  // Native edits can supply only a dependency map, without its enclosing field.
  // Keep the existing version hints, comparing entries so removals can continue.
  if (fragment && !fields.some(field => Object.hasOwn(manifest, field))) {
    return Object.entries(manifest)
      .filter(([, version]) => typeof version === 'string' && /(?:==|>=|~=|\^\d)/.test(version))
      .map(entry => JSON.stringify(entry));
  }
  const declarations = [];
  for (const field of fields) {
    const entries = manifest[field];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [name, version] of Object.entries(entries)) declarations.push(JSON.stringify([field, name, version]));
  }
  return declarations;
}

function fragmentHeader(content) {
  const lines = String(content || '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  const header = lines.length === 1 ? /^\[([^\]]+)\](?:\s*#.*)?$/.exec(lines[0]) : null;
  return header ? sectionKey(header[1]) : null;
}

// Resolve declaration roles before comparing old and new fragments. A line
// moved out of metadata becomes a dependency even when its text stays the same.
// These are syntax hints from the supplied tool input, not a full manifest diff.
function dependencyLines(filePath, content, fragment = false) {
  const match = MANIFEST.exec(String(filePath || '').replace(/\\/g, '/'));
  if (!match) return [];
  const json = jsonDeclarations(filePath, content, fragment);
  if (json) return json;
  const file = match[1].toLowerCase();
  let section = '';
  let dependencyBlock = false;
  const declarations = [];
  for (const text of String(content || '').split(/\r?\n/)) {
    const line = text.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) section = sectionKey(header[1]);
    let declaration = false;
    if (file.startsWith('requirements')) {
      declaration = REQUIREMENT.test(line.replace(/\s+#.*$/, ''));
    } else if (file === 'cargo.toml') {
      declaration = dependencySection(filePath, section)
        && /^[\w-]+\s*=\s*(?:["']|\{)/.test(line);
    } else if (file === 'go.mod') {
      declaration = /^(?:require\s+)?[A-Za-z0-9_.\/-]+\s+v\d/.test(line);
    } else if (file === 'gemfile') {
      declaration = /^gem\s+["']/.test(line);
    } else {
      const field = FIELD.test(line);
      declaration = field || (dependencyBlock && /^["'][^"']+["']/.test(line));
      if (file === 'pyproject.toml') {
        declaration ||= dependencySection(filePath, section)
          && /^[\w"'-]+\s*=/.test(line);
      }
      if (field) dependencyBlock = /[\[{]/.test(line) && !/[\]}]\s*,?\s*$/.test(line);
      else if (/^[\]}]/.test(line) || header) dependencyBlock = false;
    }
    // Preserve version hints for native fragments that omit their section.
    if (fragment && !section && /(?:==|>=|~=|\^\d)/.test(line)) declaration = true;
    if (declaration) declarations.push(JSON.stringify([section, line.replace(/,\s*$/, '')]));
  }
  return declarations;
}

function manifestDependencyIntent(filePath, content) {
  return dependencyLines(filePath, content).length > 0;
}

function manifestEditDependencyIntent(filePath, oldText, newText, oldPath = filePath) {
  // A header-only edit can reclassify entries outside the supplied fragment.
  // Merely appending an empty table, or moving dependencies back to metadata,
  // does not introduce a dependency declaration.
  const oldHeader = fragmentHeader(oldText);
  const newHeader = fragmentHeader(newText);
  if (oldHeader && newHeader && (oldHeader !== newHeader || !dependencySection(oldPath, oldHeader))
      && dependencySection(filePath, newHeader)) return true;
  const remaining = new Map();
  for (const key of dependencyLines(oldPath, oldText, true)) {
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  for (const key of dependencyLines(filePath, newText, true)) {
    const count = remaining.get(key) || 0;
    if (!count) return true;
    remaining.set(key, count - 1);
  }
  return false;
}

function patchDependencyIntent(patch) {
  let filePath = '';
  let oldPath = '';
  let before = [];
  let after = [];
  const addedDependency = () => manifestEditDependencyIntent(filePath, before.join('\n'), after.join('\n'), oldPath);
  for (const line of String(patch || '').split(/\r?\n/)) {
    const move = /^\*\*\*\s*Move to:\s*(.+?)\s*$/.exec(line);
    if (move) {
      filePath = move[1];
      continue;
    }
    const header = /^\*\*\*\s*(?:Add|Update)\s+File:\s*(.+?)\s*$/.exec(line);
    if (header || /^\*\*\*/.test(line)) {
      if (addedDependency()) return true;
      filePath = header ? header[1] : '';
      oldPath = filePath;
      before = []; after = [];
    } else if (line.startsWith('@@')) {
      // Separate hunks have no guaranteed intervening section context.
      if (addedDependency()) return true;
      before = []; after = [];
      if (line.slice(2).trim()) { before.push(line.slice(2).trim()); after.push(line.slice(2).trim()); }
    } else {
      if (/^[- ]/.test(line)) before.push(line.slice(1));
      if (/^[+ ]/.test(line)) after.push(line.slice(1));
    }
  }
  return addedDependency();
}

module.exports = { manifestDependencyIntent, manifestEditDependencyIntent, patchDependencyIntent };

},
"src/adapters/codex-tool-classifier.cjs": function(module, exports, __require) {
'use strict';

const nodePath = require('node:path');
const { analyzeShell, analyzeShellInput, classifyShell } = __require("src/shell-analysis.cjs");
const { patchDependencyIntent } = __require("src/manifest-dependencies.cjs");
const { detectHashIntent } = __require("src/hash-intent.cjs");

const WRITE_NAME = /(?:^|__|_)(?:add|append|apply|archive|close|commit|copy|create|delete|deploy|edit|install|merge|move|patch|post|publish|push|remove|rename|send|set|submit|update|upload|write)(?:$|__|_)/i;
const READ_NAME = /(?:^|__|_)(?:cat|check|diff|fetch|find|get|inspect|list|load|open|read|review|search|show|status|view)(?:$|__|_)/i;
const CONTROL_TOOLS = new Set(['update_plan', 'request_user_input', 'request_user_input_async', 'wait', 'wait_agent', 'interrupt_agent', 'close_agent']);
// Match the host's known flattened namespaces exactly; do not strip arbitrary
// prefixes from MCP or third-party tool names.
const CODEX_TOOL_NAMES = new Map([
  ...['send_input', 'resume_agent', 'wait_agent', 'close_agent']
    .map(name => [`multi_agent_v1${name}`, name]),
  ...['spawn_agent', 'followup_task', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent']
    .map(name => [`collaboration${name}`, name])
]);

function inputText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  return String(toolInput.command || toolInput.patch || toolInput.content || toolInput.new_string || '');
}

function normalizePath(value, cwd) {
  let normalized = String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  if (cwd && nodePath.isAbsolute(normalized)) {
    normalized = nodePath.relative(String(cwd), normalized).replace(/\\/g, '/');
  }
  return normalized.replace(/^\.\//, '');
}

function extractAffectedPaths(toolName, toolInput, cwd) {
  const name = String(toolName || '');
  if (name === 'Edit' || name === 'Write') {
    const filePath = normalizePath(toolInput && (toolInput.file_path || toolInput.path), cwd);
    return filePath ? [filePath] : [];
  }
  if (name !== 'apply_patch') return [];

  const paths = [];
  for (const line of inputText(toolInput).split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line)
      || /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
    if (match) paths.push(normalizePath(match[1], cwd));
  }
  return [...new Set(paths.filter(Boolean))];
}

function detectDependencyIntent(toolName, toolInput) {
  const name = String(toolName || '');
  const text = inputText(toolInput);
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return analyzeShell(text).dependencyIntent;
  }
  if (name === 'apply_patch') return patchDependencyIntent(text);
  return false;
}

function canonicalCodexToolName(toolName) {
  const name = String(toolName || '');
  return CODEX_TOOL_NAMES.get(name) || name;
}

function classifyCodexTool(toolName, toolInput) {
  const name = canonicalCodexToolName(toolName);
  if (name === 'apply_patch' || name === 'Edit' || name === 'Write') return 'write';
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return classifyShell(toolInput && toolInput.command);
  }
  if (name === 'Agent' || name === 'spawn_agent') return 'delegate';
  if (name === 'mcp__codex_app__wait_threads') return 'read';
  if (CONTROL_TOOLS.has(name)) return 'control';
  if (WRITE_NAME.test(name)) return 'write';
  if (READ_NAME.test(name)) return 'read';
  return 'unknown';
}

function analyzeCodexTool(toolName, toolInput, cwd) {
  const name = canonicalCodexToolName(toolName);
  let analysis;
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    analysis = analyzeShellInput(toolInput);
  } else {
    analysis = {
      mutability: classifyCodexTool(name, toolInput),
      hashIntent: detectHashIntent(name, toolInput),
      dependencyIntent: detectDependencyIntent(name, toolInput)
    };
  }
  return { ...analysis, affectedPaths: extractAffectedPaths(name, toolInput, cwd) };
}

module.exports = { analyzeCodexTool, analyzeShell, canonicalCodexToolName, classifyCodexTool, classifyShell, detectDependencyIntent, detectHashIntent, extractAffectedPaths };

},
"src/hash-intent.cjs": function(module, exports, __require) {
'use strict';

const { analyzeShell } = __require("src/shell-analysis.cjs");

const CODE_PATH = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|php|rb|c|cc|cpp|h|hpp)$/i;
const HASH_API = /\b(?:createHash|createHmac)\s*\(|\bcrypto\.subtle\.digest\s*\(|\bhashlib\.(?:md5|sha1|sha224|sha256|sha384|sha512|blake2[bs])\s*\(|\bMessageDigest\.getInstance\s*\(|\bDigestUtils\.[A-Za-z0-9_]+\s*\(|\bsha(?:1|256|512)\.(?:New|Sum\w*)\s*\(|\b(?:bcrypt|argon2)\.hash\s*\(|\bpassword_hash\s*\(|\bPasswordHasher\s*\(/i;

function containsHashApi(text) {
  return HASH_API.test(String(text || ''));
}

function fileHashIntent(filePath, content) {
  return CODE_PATH.test(String(filePath || '')) && containsHashApi(content);
}

function patchHashIntent(patch) {
  const added = String(patch || '').split(/\r?\n/)
    .filter((line) => /^\+(?!\+\+)/.test(line)).join('\n');
  return containsHashApi(added);
}

// Preserve the original tool-input API for callers using these common shapes.
// Native adapters can pass file content or patches directly to the helpers.
function detectHashIntent(toolName, toolInput) {
  const name = String(toolName || '');
  const text = typeof toolInput === 'string' ? toolInput
    : toolInput && typeof toolInput === 'object'
      ? String(toolInput.command || toolInput.patch || toolInput.content || toolInput.new_string || '')
      : '';
  if (!text) return false;
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return analyzeShell(text).hashIntent;
  }
  if (name === 'apply_patch') return patchHashIntent(text);
  if (name === 'Edit' || name === 'Write') {
    return fileHashIntent(toolInput && (toolInput.file_path || toolInput.path), text);
  }
  return false;
}

module.exports = { containsHashApi, fileHashIntent, patchHashIntent, detectHashIntent };

},
"src/adapters/lifecycle-fields.cjs": function(module, exports, __require) {
'use strict';

const ASYNC_FIELDS = [
  'async_launched',
  'asyncLaunched',
  'run_in_background',
  'runInBackground',
  'background'
];

function readAsyncLaunched(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of ASYNC_FIELDS) {
      if (typeof source[field] === 'boolean') return source[field];
    }
  }
  return null;
}

function optionalIdentifier(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null;
}

module.exports = { optionalIdentifier, readAsyncLaunched };

}
};
__modules["package.json"] = function(module) { module.exports = {
  "name": "stop-that-shit",
  "version": "0.2.5",
  "private": true,
  "description": "Keep agent work bounded and reduce defensive wording in Codex, Claude Code, OpenCode, Hermes Agent CLI, Pi, and Oh My Pi",
  "keywords": [
    "pi-package"
  ],
  "license": "MIT",
  "main": "./opencode/stop-that-shit.mjs",
  "bin": {
    "sts": "./scripts/sts.cjs"
  },
  "exports": {
    ".": "./opencode/stop-that-shit.mjs",
    "./server": "./opencode/stop-that-shit.mjs"
  },
  "files": [
    "server.mjs",
    "opencode/",
    "pi/",
    "omp/",
    "src/",
    "hooks/",
    ".hermes-plugin/",
    "skills/",
    "scripts/sts.cjs",
    "scripts/case-bundle-lib.cjs",
    "scripts/generated/case-bundle-v1-validator.cjs",
    "INSTALL.md",
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "README_CN.md",
    "README_EN.md",
    "README_KO.md"
  ],
  "pi": {
    "extensions": [
      "./pi/stop-that-shit.ts"
    ],
    "skills": [
      "./skills/stop-that-shit",
      "./skills/stss"
    ]
  },
  "scripts": {
    "schema:build": "node scripts/build-case-bundle-validator.cjs",
    "schema:check": "node scripts/build-case-bundle-validator.cjs --check",
    "pretest": "npm run schema:check",
    "hermes:build": "node scripts/build-hermes-plugin.cjs",
    "hermes:check": "node scripts/build-hermes-plugin.cjs --check",
    "test": "node scripts/test.cjs",
    "check": "npm test && npm run eval && npm run release:check",
    "sts": "node scripts/sts.cjs",
    "eval": "node scripts/evaluate-cases.cjs",
    "eval:selftest": "node --test test/case-bundle.test.cjs test/paired-eval.test.cjs",
    "eval:paired": "node scripts/run-paired-eval.cjs",
    "eval:routing": "node scripts/run-paired-eval.cjs --routing --runs 1",
    "eval:host-smoke": "node scripts/run-paired-eval.cjs --host-smoke --runs 1",
    "release:check": "npm run schema:check && npm run codex:check && node scripts/release-check.cjs",
    "release:build": "node scripts/build-release.cjs",
    "test:omp": "node --test test/omp-adapter.test.cjs test/omp-extension.test.cjs test/omp-package.test.cjs",
    "test:hosts": "node scripts/test-hosts.cjs",
    "codex:build": "node scripts/build-codex-plugin.cjs",
    "codex:check": "node scripts/build-codex-plugin.cjs --check"
  },
  "engines": {
    "node": ">=18",
    "opencode": ">=1.18.18 <2 || >=2.0.18 <3"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": {
      "optional": true
    }
  },
  "devDependencies": {
    "ajv": "^8.20.0"
  },
  "dependencies": {
    "@opencode/schema": "2.1.3",
    "effect": "4.0.0-rc.112"
  }
}; };
const __cache = new Map();
function __require(id) {
  if (__cache.has(id)) return __cache.get(id).exports;
  const module = { exports: {} };
  __cache.set(id, module);
  if (!__modules[id]) throw new Error('Bundled module not found: ' + id);
  __modules[id](module, module.exports, __require);
  return module.exports;
}

function __readStdin(maxWaitMs = 1500) {
  return new Promise((resolve) => {
    let settled = false; let body = '';
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(body); };
    const timer = setTimeout(finish, maxWaitMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}
function __dataDir() {
  const hermesHome = process.env.HERMES_HOME || require('node:path').join(process.env.HOME || '', '.hermes');
  return require('node:path').join(hermesHome, 'stop-that-shit');
}
(async () => {
  try {
    const raw = await __readStdin();
    if (!raw.trim()) return;
    const output = __require("src/adapters/hermes-hooks.cjs").handleHermesHook(JSON.parse(raw), { dataDir: __dataDir() });
    if (output) process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) {
    const errorName = error && error.name ? error.name : 'HookError';
    process.stderr.write('Stop That Shit Hermes hook failed open: ' + errorName + '\n');
  }
})();
