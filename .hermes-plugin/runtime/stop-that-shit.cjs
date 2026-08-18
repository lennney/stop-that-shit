// GENERATED FILE — DO NOT EDIT. Build with: npm run hermes:build
// Generated from the src/ module graph by scripts/build-hermes-plugin.cjs.
'use strict';

const __modules = {
"src/adapters/hermes-hooks.cjs": function(module, exports, __require) {
'use strict';

const { PROTOCOL_VERSION } = __require("src/control-protocol.cjs");
const { handleControlEvent } = __require("src/controller.cjs");
const {
  classifyHermesTool,
  countHermesDelegation,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths
} = __require("src/adapters/hermes-tool-classifier.cjs");

const EVENT_KIND = {
  pre_llm_call: 'prompt.submit',
  pre_tool_call: 'action.before'
};

function toControlEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = EVENT_KIND[input.hook_event_name];
  if (!kind) return null;

  const extra = input.extra && typeof input.extra === 'object' ? input.extra : {};
  const event = {
    protocolVersion: PROTOCOL_VERSION,
    kind,
    sessionId: String(input.session_id || ''),
    turnId: extra.turn_id || input.turn_id || null,
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
    event.action = {
      id: input.tool_call_id || extra.tool_call_id || null,
      name: String(input.tool_name || 'unknown'),
      input: input.tool_input,
      mutability: classifyHermesTool(input.tool_name, input.tool_input),
      delegationCount: countHermesDelegation(input.tool_name, input.tool_input),
      hashIntent: detectHashIntent(input.tool_name, input.tool_input),
      dependencyIntent: detectDependencyIntent(input.tool_name, input.tool_input),
      affectedPaths: extractAffectedPaths(input.tool_name, input.tool_input, input.cwd),
      unboundedDelegation: false
    };
  }

  return event;
}

function fromControlResult(result) {
  if (!result || result.kind === 'none') return null;
  if (result.kind === 'context') return { context: result.text };
  if (result.kind === 'deny') return { action: 'block', message: result.message };
  return null;
}

function handleHermesHook(input, options = {}) {
  const event = toControlEvent(input);
  if (!event) return null;
  return fromControlResult(handleControlEvent(event, options));
}

module.exports = {
  fromControlResult,
  handleHermesHook,
  toControlEvent
};

},
"src/control-protocol.cjs": function(module, exports, __require) {
'use strict';

const PROTOCOL_VERSION = 1;
const EVENT_KINDS = new Set([
  'session.start',
  'prompt.submit',
  'action.before',
  'subagent.start'
]);
const MUTABILITIES = new Set(['read', 'write', 'delegate', 'control', 'unknown']);

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`ControlEvent field ${field} must be a non-empty string.`);
  }
}

function assertControlEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('ControlEvent must be an object.');
  }
  if (event.protocolVersion !== PROTOCOL_VERSION) {
    throw new TypeError(`Unsupported ControlEvent protocolVersion: ${event.protocolVersion}.`);
  }
  if (!EVENT_KINDS.has(event.kind)) {
    throw new TypeError(`Unsupported ControlEvent kind: ${event.kind}.`);
  }
  nonEmptyString(event.sessionId, 'sessionId');

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
    if (
      event.action.delegationCount !== undefined
      && (!Number.isInteger(event.action.delegationCount) || event.action.delegationCount < 0)
    ) {
      throw new TypeError('ControlEvent action.delegationCount must be a non-negative integer.');
    }
  }

  return event;
}

module.exports = {
  EVENT_KINDS,
  MUTABILITIES,
  PROTOCOL_VERSION,
  assertControlEvent
};

},
"src/controller.cjs": function(module, exports, __require) {
'use strict';

const { parseContractPrompt } = __require("src/contracts.cjs");
const { assertControlEvent } = __require("src/control-protocol.cjs");
const { decide } = __require("src/decision.cjs");
const { readRuntime, recordDecision } = __require("src/runtime-audit.cjs");
const { recordAnnotation } = __require("src/runtime-annotations.cjs");
const { readState, withSessionLock, writeState } = __require("src/state.cjs");

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

},
"src/contracts.cjs": function(module, exports, __require) {
'use strict';

const MODES = new Set(['answer', 'review', 'change', 'monitor', 'open']);
const LEVELS = new Set(['watch', 'guard', 'lock', 'off']);
const HASH_POLICIES = new Set(['deny', 'ask', 'allow']);
const SCOPE_POLICIES = new Set(['deny', 'ask', 'allow']);

function defaultContract() {
  return {
    mode: 'unconfirmed',
    level: 'watch',
    agentBudget: 0,
    agentsUsed: 0,
    hashPolicy: 'deny',
    allowedPaths: null,
    dependencyPolicy: 'ask',
    source: 'default'
  };
}

function directiveHead(prompt, matchEnd) {
  const tail = prompt.slice(matchEnd).trimStart();
  const boundaries = [tail.indexOf('--'), tail.indexOf(':'), tail.indexOf('\n')]
    .filter((index) => index >= 0);
  const end = boundaries.length ? Math.min(...boundaries) : Math.min(tail.length, 80);
  return tail.slice(0, end).trim();
}

function parseDirective(prompt) {
  const mention = /\$stop-that-shit\b/i.exec(prompt);
  if (!mention) return null;

  const head = directiveHead(prompt, mention.index + mention[0].length);
  const tokens = head.split(/[\s,]+/).map((token) => token.trim().toLowerCase()).filter(Boolean);
  const parsed = { mentioned: true };

  for (const token of tokens) {
    if (MODES.has(token)) parsed.mode = token;
    if (LEVELS.has(token)) parsed.level = token;
    const agents = /^agents=(\d+)$/.exec(token);
    if (agents) parsed.agentBudget = Math.min(Number(agents[1]), 8);
    const hash = /^hash=(deny|ask|allow)$/.exec(token);
    if (hash && HASH_POLICIES.has(hash[1])) parsed.hashPolicy = hash[1];
    const files = /^files=(.+)$/.exec(token);
    if (files) parsed.allowedPaths = files[1].split('|').map((value) => value.replace(/\\/g, '/')).filter(Boolean);
    const dependencies = /^deps=(deny|ask|allow)$/.exec(token);
    if (dependencies && SCOPE_POLICIES.has(dependencies[1])) parsed.dependencyPolicy = dependencies[1];
  }

  return parsed;
}

function naturalCorrection(prompt, previous) {
  const text = prompt.trim();

  if (/^(?:stop|stop now|停止|停下来)[.!。！\s]*$/i.test(text)) {
    return { mode: 'answer', source: 'explicit-stop' };
  }
  if (/\breview only\b|\b(?:do not|don't) (?:edit|change|fix) (?:anything|the (?:repo|repository|files?|code))\b|只审查|只看不改|不要修改(?:任何|代码|文件)/i.test(text)) {
    return { mode: 'review', source: 'natural-explicit' };
  }
  if (/\banswer only\b|只回答/i.test(text)) {
    return { mode: 'answer', source: 'natural-explicit' };
  }
  if (/\bmonitor only\b|只监控|只观察/i.test(text)) {
    return { mode: 'monitor', source: 'natural-explicit' };
  }

  const wasNonMutating = ['answer', 'review', 'monitor'].includes(previous.mode);
  const explicitChange = /^(?:please\s+)?(?:fix|implement|change|apply|patch)\b|^(?:请)?(?:修复|修改|实现|应用补丁)|^把.+(?:修复|修改|改掉)/i.test(text);
  if (wasNonMutating && explicitChange) {
    return { mode: 'change', source: 'natural-explicit' };
  }

  return null;
}

function parseContractPrompt(prompt, previousContract = defaultContract()) {
  const previous = { ...defaultContract(), ...previousContract };
  const directive = parseDirective(String(prompt || ''));
  const correction = naturalCorrection(String(prompt || ''), previous);
  const next = { ...previous };
  let changed = false;

  if (directive) {
    if (directive.mode && directive.mode !== next.mode) {
      next.mode = directive.mode;
      next.agentsUsed = 0;
      changed = true;
    }
    if (directive.level && directive.level !== next.level) {
      next.level = directive.level;
      changed = true;
    }
    if (Number.isInteger(directive.agentBudget) && directive.agentBudget !== next.agentBudget) {
      next.agentBudget = directive.agentBudget;
      next.agentsUsed = 0;
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
      next.agentsUsed = 0;
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

  return { contract: next, changed, directive: Boolean(directive), correction: Boolean(correction) };
}

module.exports = {
  HASH_POLICIES,
  SCOPE_POLICIES,
  LEVELS,
  MODES,
  defaultContract,
  parseContractPrompt
};

},
"src/decision.cjs": function(module, exports, __require) {
'use strict';

function decision(outcome, family, reasonCode, explanation, nextStep) {
  return { outcome, family, reasonCode, explanation, nextStep };
}

function controlledOutcome(level, guarded = 'deny_and_explain') {
  return level === 'watch' ? 'report_and_defer' : guarded;
}

function pathAllowed(path, allowedPaths) {
  return allowedPaths.some((allowed) => {
    if (allowed === '**') return true;
    if (allowed.endsWith('/**')) return path === allowed.slice(0, -3) || path.startsWith(allowed.slice(0, -2));
    return path === allowed;
  });
}

function decide({ contract, action, state = {} }) {
  const mode = contract.mode || 'unconfirmed';
  const level = contract.level || 'watch';

  if (level === 'off' || mode === 'unconfirmed') {
    return decision('allow', null, 'CONTROL_INACTIVE', 'No confirmed enforcing contract is active.', null);
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

  if (Array.isArray(contract.allowedPaths) && Array.isArray(action.affectedPaths)) {
    if (action.mutability === 'write' && action.affectedPaths.length === 0 && !contract.allowedPaths.includes('**')) {
      return decision(
        controlledOutcome(level, 'require_user_approval'),
        'S',
        'WRITE_PATH_UNPROVEN',
        'The action writes through a tool whose target path is not proven inside the declared file boundary.',
        'Use apply_patch or an Edit tool with visible paths, or obtain approval for an explicit broader boundary.'
      );
    }
    const outside = action.affectedPaths.filter((path) => !pathAllowed(path, contract.allowedPaths));
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
      'The proposed delegation can fan out to an unbounded number of subagents, so it cannot satisfy agents=N deterministically.',
      'Use explicit Agent calls within agents=N, or disable the Guard for a deliberately unbounded workflow.'
    );
  }

  const delegationCount = action.mutability === 'delegate'
    ? (Number.isInteger(action.delegationCount) ? action.delegationCount : 1)
    : 0;
  if (action.mutability === 'delegate' && contract.agentsUsed + delegationCount > contract.agentBudget) {
    return decision(
      controlledOutcome(level),
      'S',
      'AGENT_BUDGET_EXHAUSTED',
      `The active contract allows ${contract.agentBudget} subagent(s), with ${contract.agentsUsed} already used, and this action requires ${delegationCount}.`,
      'Continue locally or obtain an explicit agents=N contract.'
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
const { PROTOCOL_VERSION } = __require("src/control-protocol.cjs");
const { readAnnotations } = __require("src/runtime-annotations.cjs");
const { appendJsonl, readJsonl, runtimeRoot } = __require("src/runtime-storage.cjs");
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
  const state = controlState(contract);
  if (state === 'off') return null;

  const action = facts.action || {};
  const decision = facts.decision || {};
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
      delegationCount: Number.isInteger(action.delegationCount) ? action.delegationCount : 0,
      pathCount: Array.isArray(action.affectedPaths) ? action.affectedPaths.length : 0,
      hashIntent: Boolean(action.hashIntent),
      dependencyIntent: Boolean(action.dependencyIntent),
      unboundedDelegation: Boolean(action.unboundedDelegation)
    },
    contract: {
      mode: String(contract.mode || 'unconfirmed'),
      level: String(contract.level || 'watch'),
      agentBudget: Number.isInteger(contract.agentBudget) ? contract.agentBudget : 0,
      agentsUsed: Number.isInteger(contract.agentsUsed) ? contract.agentsUsed : 0,
      hashPolicy: String(contract.hashPolicy || 'deny'),
      dependencyPolicy: String(contract.dependencyPolicy || 'ask'),
      allowedPathCount: Array.isArray(contract.allowedPaths) ? contract.allowedPaths.length : 0
    },
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

function readRuntime(query = {}, options = {}) {
  let events = [];
  let damagedRecords = 0;
  for (const file of eventFiles(query, options)) {
    const parsed = readJsonl(file);
    events.push(...parsed.records);
    damagedRecords += parsed.damaged;
  }
  // V8's stable sort preserves append order for equal timestamps within a log.
  events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  if (query.eventId) events = events.filter((event) => event.eventId === query.eventId);
  if (Number.isInteger(query.limit) && query.limit >= 0) events = events.slice(-query.limit);

  const annotationResult = readAnnotations(options);
  damagedRecords += annotationResult.damaged;
  const eventIds = new Set(events.map((event) => event.eventId));
  const annotations = annotationResult.records.filter((annotation) => eventIds.has(annotation.eventId));
  const result = summarize(events, annotations, damagedRecords);
  return { schemaVersion: 1, ...result, annotations };
}

module.exports = { readRuntime, recordDecision };

},
"package.json": function(module, exports, __require) {
module.exports = {
  "name": "stop-that-shit",
  "version": "0.0.3",
  "private": true,
  "description": "Stop unneeded scope, subagents, dependencies, and hashes in Codex, Claude Code, and OpenCode tasks",
  "license": "MIT",
  "main": "./opencode/stop-that-shit.mjs",
  "exports": {
    ".": "./opencode/stop-that-shit.mjs",
    "./server": "./opencode/stop-that-shit.mjs"
  },
  "files": [
    "opencode/",
    "src/",
    "hooks/",
    ".hermes-plugin/",
    "skills/",
    "INSTALL.md",
    "LICENSE",
    "PRIVACY.md",
    "README.md"
  ],
  "scripts": {
    "schema:build": "node scripts/build-case-bundle-validator.cjs",
    "schema:check": "node scripts/build-case-bundle-validator.cjs --check",
    "pretest": "npm run schema:check",
    "hermes:build": "node scripts/build-hermes-plugin.cjs",
    "hermes:check": "node scripts/build-hermes-plugin.cjs --check",
    "test": "node --test test/case-bundle.test.cjs test/claude-adapter.test.cjs test/claude-plugin.test.cjs test/contracts.test.cjs test/control-protocol.test.cjs test/decision.test.cjs test/hermes-adapter.test.cjs test/hermes-hook.test.cjs test/hermes-plugin-package.test.cjs test/hooks.test.cjs test/opencode-adapter.test.cjs test/opencode-plugin.test.cjs test/opencode-smoke.test.cjs test/paired-eval.test.cjs test/plugin.test.cjs test/runtime-audit.test.cjs test/sts-cli.test.cjs",
    "sts": "node scripts/sts.cjs",
    "eval": "node scripts/evaluate-cases.cjs",
    "eval:paired": "node scripts/run-paired-eval.cjs",
    "release:check": "npm run schema:check && node scripts/release-check.cjs",
    "release:build": "node scripts/build-release.cjs"
  },
  "engines": {
    "node": ">=18",
    "opencode": ">=1.18.18"
  },
  "devDependencies": {
    "ajv": "^8.20.0"
  }
};
},
"src/runtime-annotations.cjs": function(module, exports, __require) {
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { appendJsonl, readJsonl, runtimeRoot } = __require("src/runtime-storage.cjs");

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

function readAnnotations(options = {}) {
  return readJsonl(annotationsPath(options));
}

module.exports = { LABELS, readAnnotations, recordAnnotation };

},
"src/runtime-storage.cjs": function(module, exports, __require) {
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dataRoot } = __require("src/state.cjs");

function runtimeRoot(options = {}) {
  const root = options.dataDir || process.env.STS_RUNTIME_DATA || dataRoot();
  return path.join(root, 'runtime');
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { records: [], damaged: 0 };
    throw error;
  }

  const records = [];
  let damaged = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      damaged += 1;
    }
  }
  return { records, damaged };
}

module.exports = { appendJsonl, readJsonl, runtimeRoot };

},
"src/state.cjs": function(module, exports, __require) {
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultContract } = __require("src/contracts.cjs");

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
    schemaVersion: 1,
    contract: defaultContract(),
    lastPromptContext: null
  };
}

function readState(sessionId, override) {
  const file = statePath(sessionId, override);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...freshState(),
      ...parsed,
      contract: { ...defaultContract(), ...(parsed.contract || {}) }
    };
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.name === 'SyntaxError')) return freshState();
    throw error;
  }
}

function writeState(sessionId, state, override) {
  const file = statePath(sessionId, override);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    fs.copyFileSync(temporary, file);
    fs.unlinkSync(temporary);
  }
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

module.exports = {
  acquireSessionLock,
  dataRoot,
  freshState,
  readState,
  sessionKey,
  statePath,
  withSessionLock,
  writeState
};

},
"src/adapters/hermes-tool-classifier.cjs": function(module, exports, __require) {
'use strict';

const nodePath = require('node:path');
const {
  classifyShell,
  detectDependencyIntent: detectCodexDependencyIntent,
  detectHashIntent: detectCodexHashIntent
} = __require("src/adapters/codex-tool-classifier.cjs");

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
  if (Array.isArray(input.tasks)) return input.tasks.length;
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

const HERMES_MANIFEST = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|composer\.json|Gemfile)$/i;
const JSON_DEPENDENCY_FIELD = /["']?(?:dependencies|devDependencies|optionalDependencies|require)["']?\s*[:=]/i;
const REQUIREMENT_DECLARATION = /^\s*[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[^\]\r\n]+\])?\s*(?:(?:===|==|~=|!=|<=|>=|<|>|\^)\s*\S+)?(?:\s*;.*)?$/;
const CARGO_ASSIGNMENT = /^\s*[A-Za-z0-9][A-Za-z0-9_-]*\s*=\s*(?:["']|\{)/;
const GO_REQUIRE_DECLARATION = /^\s*(?:require\s+\S+\s+v\d|[A-Za-z0-9_.\/-]+\s+v\d)/m;
const GEM_DECLARATION = /^\s*gem\s+["']/;

function isCargoDependencySection(section) {
  return /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)(?:\.|$)/.test(section);
}

function detectHermesManifestDependency(filePath, content) {
  const normalizedPath = String(filePath || '').trim().replace(/\\/g, '/');
  const text = String(content || '');
  if (!HERMES_MANIFEST.test(normalizedPath)) return false;

  if (/(?:^|\/)(?:package\.json|pyproject\.toml|composer\.json)$/i.test(normalizedPath)) {
    return JSON_DEPENDENCY_FIELD.test(text);
  }
  if (/(?:^|\/)requirements[^/]*\.txt$/i.test(normalizedPath)) {
    return text.split(/\r?\n/).some((line) => REQUIREMENT_DECLARATION.test(line));
  }
  if (/(?:^|\/)Cargo\.toml$/i.test(normalizedPath)) {
    let dependencySection = false;
    for (const line of text.split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) dependencySection = isCargoDependencySection(header[1]);
      if (dependencySection && CARGO_ASSIGNMENT.test(line)) return true;
    }
    return false;
  }
  if (/(?:^|\/)go\.mod$/i.test(normalizedPath)) return GO_REQUIRE_DECLARATION.test(text);
  if (/(?:^|\/)Gemfile$/i.test(normalizedPath)) return GEM_DECLARATION.test(text);
  return false;
}

function hermesPatchSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const header = /^\*\*\*\s*(?:Add|Update)\s+File:\s*(.+?)\s*$/.exec(line);
    if (header) {
      current = { path: header[1], content: [] };
      sections.push(current);
      continue;
    }
    if (/^\*\*\*/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (/^\+(?!\+\+)/.test(line) || /^ /.test(line)) current.content.push(line.slice(1));
  }
  return sections;
}

function detectDependencyIntent(toolName, toolInput) {
  const name = codexToolName(toolName, toolInput);
  const input = codexIntentInput(toolName, toolInput);
  if (name === 'Write') {
    return detectHermesManifestDependency(input.path, input.content);
  }
  if (name === 'apply_patch') {
    const sections = hermesPatchSections(input.patch);
    if (sections.some((section) => detectHermesManifestDependency(section.path, section.content.join('\n')))) return true;
    const normalizedPatch = String(input.patch || '').replace(/^\*\*\*(?=(?:Add|Update|Delete)\s+File:)/gm, '*** ');
    return detectCodexDependencyIntent(name, { ...input, patch: normalizedPatch });
  }
  return detectCodexDependencyIntent(name, input);
}

function detectHashIntent(toolName, toolInput) {
  return detectCodexHashIntent(codexToolName(toolName, toolInput), codexIntentInput(toolName, toolInput));
}

module.exports = {
  classifyHermesTool,
  countHermesDelegation,
  extractAffectedPaths,
  detectDependencyIntent,
  detectHashIntent,
  isHermesDelegationControl
};

},
"src/adapters/codex-tool-classifier.cjs": function(module, exports, __require) {
'use strict';

const nodePath = require('node:path');

const WRITE_NAME = /(?:^|__|_)(?:add|append|apply|archive|close|commit|copy|create|delete|deploy|edit|install|merge|move|patch|post|publish|push|remove|rename|send|set|submit|update|upload|write)(?:$|__|_)/i;
const READ_NAME = /(?:^|__|_)(?:cat|check|diff|fetch|find|get|inspect|list|load|open|read|review|search|show|status|view)(?:$|__|_)/i;
const CONTROL_TOOLS = new Set(['update_plan', 'request_user_input', 'wait', 'wait_agent']);
const CODE_PATH = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|php|rb|c|cc|cpp|h|hpp)$/i;
const HASH_COMMAND = /\b(?:Get-FileHash|md5sum|sha(?:1|224|256|384|512)sum|shasum|b2sum)\b|\bcertutil\b[^\r\n]*\s-hashfile\b|\bopenssl\s+dgst\b/i;
const HASH_API = /\b(?:createHash|createHmac)\s*\(|\bcrypto\.subtle\.digest\s*\(|\bhashlib\.(?:md5|sha1|sha224|sha256|sha384|sha512|blake2[bs])\s*\(|\bMessageDigest\.getInstance\s*\(|\bDigestUtils\.[A-Za-z0-9_]+\s*\(|\bsha(?:1|256|512)\.(?:New|Sum\w*)\s*\(|\b(?:bcrypt|argon2)\.hash\s*\(|\bpassword_hash\s*\(|\bPasswordHasher\s*\(/i;
const DEPENDENCY_COMMAND = /\b(?:npm|pnpm|yarn)\s+(?:add|install)\b|\bpip(?:3)?\s+install\b|\bcargo\s+add\b|\bdotnet\s+add\b[^\r\n]*\bpackage\b|\bgo\s+get\b|\bcomposer\s+require\b|\bbundle\s+add\b/i;

function inputText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  return String(toolInput.command || toolInput.patch || toolInput.content || toolInput.new_string || '');
}

function detectHashIntent(toolName, toolInput) {
  const name = String(toolName || '');
  const text = inputText(toolInput);
  if (!text) return false;

  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return HASH_COMMAND.test(text);
  }

  if (name === 'apply_patch') {
    const added = text.split(/\r?\n/).filter((line) => /^\+(?!\+\+)/.test(line)).join('\n');
    return HASH_API.test(added);
  }

  if (name === 'Edit' || name === 'Write') {
    const filePath = String(toolInput && (toolInput.file_path || toolInput.path) || '');
    return CODE_PATH.test(filePath) && HASH_API.test(text);
  }

  return false;
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

function addedLinesByPatchedFile(text) {
  const sections = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const header = /^\*\*\* (?:Add|Update) File:\s*(.+?)\s*$/.exec(line);
    if (header) {
      current = { path: normalizePath(header[1]), added: [] };
      sections.push(current);
      continue;
    }
    if (/^\*\*\*/.test(line)) {
      current = null;
      continue;
    }
    if (current && /^\+(?!\+\+)/.test(line)) current.added.push(line);
  }
  return sections;
}

function detectDependencyIntent(toolName, toolInput) {
  const name = String(toolName || '');
  const text = inputText(toolInput);
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return DEPENDENCY_COMMAND.test(text);
  }
  if (name === 'apply_patch') {
    const manifest = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|composer\.json|Gemfile)$/i;
    const dependencyDeclaration = /["']?(?:dependencies|devDependencies|optionalDependencies)["']?\s*[:=]|^[+]\s*[^#\s][^\r\n]*(?:==|>=|~=|\^\d)/mi;
    return addedLinesByPatchedFile(text).some((section) => (
      manifest.test(section.path) && dependencyDeclaration.test(section.added.join('\n'))
    ));
  }
  return false;
}

function classifyShell(command) {
  const text = String(command || '').trim();
  if (!text) return 'unknown';

  const writePattern = /\b(?:Remove-Item|Move-Item|Copy-Item|Set-Content|Add-Content|Out-File|New-Item|rm|del|erase|rmdir|mv|cp|touch|mkdir|tee|apply_patch)\b|\bgit\s+(?:add|commit|push|merge|rebase|checkout|switch|reset|clean|tag)\b|\b(?:npm|pnpm|yarn)\s+(?:add|install|remove|uninstall|publish)\b|\bpip\s+install\b|\bgh\s+(?:pr\s+(?:create|merge|close)|issue\s+(?:create|close)|release\s+create)\b/i;
  const redirection = /(^|[^<])>{1,2}\s*[^&]/;
  if (writePattern.test(text) || redirection.test(text)) return 'write';

  const dynamicProgram = /\b(?:node|python|python3|py|ruby|perl)\s+(?!-{1,2}version\b)(?:-e|-c|[^-\s][^\s]*)/i;
  if (dynamicProgram.test(text)) return 'unknown';

  const readPattern = /\b(?:Get-Content|Get-ChildItem|Get-Item|Test-Path|Resolve-Path|Select-String|Measure-Object|Compare-Object|Where-Object|ForEach-Object|rg|grep|findstr|cat|ls|dir|pwd|head|tail|wc|type)\b|\bgit\s+(?:status|diff|log|show|rev-parse|branch)\b|\b(?:node|python|python3|py)\s+--version\b/i;
  return readPattern.test(text) ? 'read' : 'unknown';
}

function classifyCodexTool(toolName, toolInput) {
  const name = String(toolName || '');
  if (name === 'apply_patch' || name === 'Edit' || name === 'Write') return 'write';
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return classifyShell(toolInput && toolInput.command);
  }
  if (name === 'Agent' || name === 'spawn_agent') return 'delegate';
  if (CONTROL_TOOLS.has(name)) return 'control';
  if (WRITE_NAME.test(name)) return 'write';
  if (READ_NAME.test(name)) return 'read';
  return 'unknown';
}

module.exports = { classifyCodexTool, classifyShell, detectDependencyIntent, detectHashIntent, extractAffectedPaths };

}
};
__modules["package.json"] = function(module) { module.exports = {
  "name": "stop-that-shit",
  "version": "0.0.3",
  "private": true,
  "description": "Stop unneeded scope, subagents, dependencies, and hashes in Codex, Claude Code, and OpenCode tasks",
  "license": "MIT",
  "main": "./opencode/stop-that-shit.mjs",
  "exports": {
    ".": "./opencode/stop-that-shit.mjs",
    "./server": "./opencode/stop-that-shit.mjs"
  },
  "files": [
    "opencode/",
    "src/",
    "hooks/",
    ".hermes-plugin/",
    "skills/",
    "INSTALL.md",
    "LICENSE",
    "PRIVACY.md",
    "README.md"
  ],
  "scripts": {
    "schema:build": "node scripts/build-case-bundle-validator.cjs",
    "schema:check": "node scripts/build-case-bundle-validator.cjs --check",
    "pretest": "npm run schema:check",
    "hermes:build": "node scripts/build-hermes-plugin.cjs",
    "hermes:check": "node scripts/build-hermes-plugin.cjs --check",
    "test": "node --test test/case-bundle.test.cjs test/claude-adapter.test.cjs test/claude-plugin.test.cjs test/contracts.test.cjs test/control-protocol.test.cjs test/decision.test.cjs test/hermes-adapter.test.cjs test/hermes-hook.test.cjs test/hermes-plugin-package.test.cjs test/hooks.test.cjs test/opencode-adapter.test.cjs test/opencode-plugin.test.cjs test/opencode-smoke.test.cjs test/paired-eval.test.cjs test/plugin.test.cjs test/runtime-audit.test.cjs test/sts-cli.test.cjs",
    "sts": "node scripts/sts.cjs",
    "eval": "node scripts/evaluate-cases.cjs",
    "eval:paired": "node scripts/run-paired-eval.cjs",
    "release:check": "npm run schema:check && node scripts/release-check.cjs",
    "release:build": "node scripts/build-release.cjs"
  },
  "engines": {
    "node": ">=18",
    "opencode": ">=1.18.18"
  },
  "devDependencies": {
    "ajv": "^8.20.0"
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
