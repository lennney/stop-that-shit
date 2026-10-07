'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const { analyzeDshTool, isUnboundedDelegation } = require('./dsh-tool-classifier.cjs');
const { optionalIdentifier, readAsyncLaunched } = require('./lifecycle-fields.cjs');

// DeepSeek Harness is an event-emitter plugin host rather than a hook-file
// host, so this adapter is called directly from listeners instead of reading a
// `hooks.json`.
//
// It does NOT accept the native event payloads. The harness hands a listener the
// host object itself: `session/created` receives a `Session`, `agent/pre-step`
// receives `{ agent, messages, turn, step, signal }`, and `tools/pre-execute`
// receives a `ToolExecution`. Those shapes carry no `session`, `prompt`, or
// `exec` field, so passing one straight through yields no event at all.
//
// A consuming plugin normalizes first and calls this adapter with the
// normalized payload documented below. `fromNativeEvent` performs exactly that
// transformation and is the supported bridge; `toControlEvent` accepts only its
// output. A plugin that already has the normalized shape may call
// `handleDshHook` directly.

const EVENT_KIND = {
  'session/created': 'session.start',
  'session/disposed': 'session.end',
  'agent/pre-step': 'prompt.submit',
  'tools/pre-execute': 'action.before',
  'tools/post-execute': 'action.after',
  'subagent/start': 'subagent.start',
  'subagent/end': 'subagent.stop'
};

// A user-role message is only human input when its source says so. The harness
// types the user source as `{ kind: 'user' }` and lets every other producer
// (a hook, a bridged Codex config, a system-prompt section) put its own kind on
// a `role: 'user'` message. Flattening those together would let injected
// context parse a `$stop-that-shit` directive and arm a contract no human asked
// for, so only verified user text carries task authority.
function isVerifiedUserMessage(message) {
  return Boolean(message && message.source && message.source.kind === 'user');
}

// `agent/pre-step` carries admitted messages rather than a prompt string.
function messageText(messages, options) {
  const userOnly = !options || options.userOnly !== false;
  if (typeof messages === 'string') return messages;
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((message) => !userOnly || isVerifiedUserMessage(message))
    .map((message) => {
      if (typeof message === 'string') return message;
      const content = message && message.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join(' ');
    })
    .join('\n');
}

function nativeSessionId(native) {
  const session = native && (native.session || native);
  return String((session && session.id) || (native && native.sessionId) || '');
}

// The session id a tool execution belongs to. The harness exposes the session
// through the calling agent rather than on the execution itself.
function nativeToolSessionId(exec) {
  const agent = exec && exec.agent;
  const session = agent && agent.session;
  return String((session && (session.id || session.sessionId)) || '');
}

function hasParentSession(exec) {
  const session = exec && exec.agent && exec.agent.session;
  const header = session && session.header;
  return Boolean(header && header.parentSession);
}

// A delegated call runs in its own session, so keying it by the caller's own id
// would read an unconfirmed contract and admit work nobody authorized.
//
// The header names only the IMMEDIATE parent, so a grandchild's parentSession
// points at the child, not the root. There is no way to reach the root from the
// session object alone, and one hop is not enough: the intermediate child never
// holds a contract, because a delegated prompt is not translated. So when a
// parent session is present the root must come from the caller as
// `context.rootSessionId`, and its absence is unverifiable rather than safe.
function rootSessionKey(exec, context) {
  const supplied = String((context && context.rootSessionId) || '');
  if (supplied) return { id: supplied };
  if (hasParentSession(exec)) return null;
  return { id: nativeToolSessionId(exec) };
}

// The workspace the session runs in. `ToolExecution` carries no `cwd`; the
// harness reads it from the session header, and without it an absolute path
// cannot be normalized against the declared file boundary.
function nativeSessionCwd(exec) {
  const session = exec && exec.agent && exec.agent.session;
  const header = session && session.header;
  return header && typeof header.cwd === 'string' ? header.cwd : undefined;
}

/**
 * Normalize one native DSH event into the payload this adapter accepts.
 *
 * Returns null for an unmapped point, so a caller can pass every listener
 * through the same bridge without pre-filtering.
 *
 * `context` carries what the native signature cannot deliver in one argument:
 *   - `tools/post-execute` receives `(exec, result, next)`, so the result is a
 *     separate listener argument. Pass it as `context.result`.
 *   - `subagent/start` and `subagent/end` receive a run info that carries the
 *     CHILD id but no parent session. Pass the parent as `context.sessionId`,
 *     or the fact would be filed against the child and never reach the parent
 *     contract.
 */
function fromNativeEvent(hookPoint, native, context) {
  if (!Object.prototype.hasOwnProperty.call(EVENT_KIND, hookPoint)) return null;
  const extra = context || {};

  if (hookPoint === 'agent/pre-step') {
    const payload = native || {};
    const session = payload.agent && payload.agent.session;
    // A delegated child must never grant task authority: the parent already
    // holds the contract governing the delegation, and a directive arriving in
    // a child session would arm an unconfirmed contract that its tool calls are
    // then checked against. The child's text still reaches the model; it simply
    // is not offered to the contract parser.
    if (session && session.header && session.header.parentSession) return null;
    return {
      session: { id: nativeSessionId({ session }) },
      // Only verified user text may arm a contract; producer-sourced messages
      // are retained for the model but carry no task authority.
      prompt: messageText(payload.messages, { userOnly: true }),
      turnId: payload.turn
    };
  }

  if (hookPoint === 'tools/pre-execute') {
    const exec = native || {};
    const key = rootSessionKey(exec, extra);
    return {
      session: key || { id: '' },
      // A delegated call whose root cannot be verified is refused rather than
      // silently keyed by the child.
      requiresVerifiedRoot: key === null,
      exec: { name: exec.name, arguments: exec.arguments, callId: exec.callId },
      cwd: exec.cwd !== undefined ? exec.cwd : nativeSessionCwd(exec)
    };
  }

  if (hookPoint === 'tools/post-execute') {
    // The waterfall hands (exec, result, next). `result` is not a property of
    // the execution, so it must arrive separately.
    const exec = (native && native.exec) || native || {};
    const key = rootSessionKey(exec, extra);
    return {
      session: key || { id: '' },
      requiresVerifiedRoot: key === null,
      exec: { callId: exec.callId },
      result: extra.result !== undefined ? extra.result : (native && native.result)
    };
  }

  if (hookPoint === 'subagent/start' || hookPoint === 'subagent/end') {
    // The run info is flat: { runId, provider, id, local }. `id` is the child.
    // The parent session is not on it and must be supplied by the caller.
    //
    // `runId` is the only correlator the harness provides for pairing a start
    // with its end, and the child `id` repeats across runs of the same agent.
    // It is carried on the normalized payload so a future consumer never has
    // to fall back to arrival order. `ControlEvent` has no field for it, so it
    // does not reach the event today: the adapter emits no completion facts and
    // capacity stays reserved.
    const info = native || {};
    const parent = String(extra.sessionId || (extra.session && extra.session.id) || '');
    const payload = {
      session: { id: parent },
      agentId: optionalIdentifier(info.id, info.agentId) || undefined
    };
    const runId = optionalIdentifier(info.runId);
    if (runId) payload.runId = runId;
    return payload;
  }

  // Session lifecycle points already receive the Session.
  const session = native || {};
  return { session: { id: session.id || session.sessionId } };
}

function dshSessionId(payload) {
  const session = payload && payload.session;
  return String((session && session.id) || (payload && payload.sessionId) || '');
}

function dshTurnId(payload) {
  // The harness counts turns numerically, and `optionalIdentifier` accepts only
  // non-blank strings, so a number would silently become null.
  const raw = payload && payload.turnId !== undefined ? payload.turnId : payload && payload.turn;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return optionalIdentifier(raw);
}

// The harness reports the caller agent on a tool execution. Subagent-scoped
// children inherit the parent session identity unless the host supplies its
// own, which keeps one contract per session instead of one per agent.
function dshHost(payload, event) {
  return {
    family: 'deepseek-harness',
    model: (payload && payload.model) || null,
    permissionMode: (payload && payload.permissionMode) || null,
    agentId: (payload && payload.agentId) || null,
    agentType: (payload && payload.agentType) || (payload && payload.agent && payload.agent.type) || null,
    turnId: event.turnId
  };
}

function toolName(payload) {
  const exec = payload && payload.exec;
  return String((exec && exec.name) || (payload && payload.toolName) || '');
}

function toolInput(payload) {
  const exec = payload && payload.exec;
  if (exec && exec.arguments !== undefined) return exec.arguments;
  return payload && payload.toolInput;
}

function toolCallId(payload) {
  const exec = payload && payload.exec;
  return optionalIdentifier(exec && exec.callId, payload && payload.callId, payload && payload.toolCallId);
}

// `tools/post-execute` delivers the settled outcome rather than a status
// string. A denied or cancelled call never reached the tool body, so it reports
// `not_started`. A blocked result and a thrown error both mean the body ran but
// produced no usable outcome, so they stay `unknown` rather than claiming the
// action finished. The harness reports no child completion for a delegated
// call, so an accepted call is `unknown` too; only an explicit asynchronous
// launch proves the call is still `running`.
function resultLifecycle(payload) {
  const result = payload && payload.result;
  if (!result || typeof result !== 'object') return 'unknown';

  if (result.kind === 'deny' || result.kind === 'cancel') return 'not_started';

  if (readAsyncLaunched(result) === true) return 'running';
  return 'unknown';
}

function responseAgentId(payload) {
  const result = payload && payload.result;
  if (!result || typeof result !== 'object') return null;
  const value = result.value;
  if (!value || typeof value !== 'object') return null;
  return optionalIdentifier(value.agentId, value.agent_id, value.target, value.name);
}

function toControlEvent(hookPoint, payload) {
  const kind = EVENT_KIND[hookPoint];
  if (!kind) return null;

  const event = {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind,
    sessionId: dshSessionId(payload),
    turnId: dshTurnId(payload),
    host: dshHost(payload, { turnId: dshTurnId(payload) })
  };

  if (!event.sessionId) return null;

  if (kind === 'prompt.submit') {
    event.prompt = String((payload && payload.prompt) || (payload && payload.content) || '');
  }

  if (kind === 'subagent.start' || kind === 'subagent.stop') {
    event.agentId = optionalIdentifier(
      payload && payload.agentId,
      payload && payload.child && payload.child.id,
      payload && payload.agent && payload.agent.id
    );
    return event;
  }

  if (kind === 'action.before') {
    const name = toolName(payload);
    const analysis = analyzeDshTool(name, toolInput(payload), payload && payload.cwd);
    const actionId = toolCallId(payload);
    if (analysis.mutability === 'delegate' && !actionId) return null;
    event.action = {
      id: actionId,
      name: name || 'unknown',
      input: toolInput(payload),
      ...analysis,
      cwd: payload && payload.cwd,
      unboundedDelegation: isUnboundedDelegation(name)
    };
    // The harness `send_message` tool can wake a teammate that already stopped.
    // `subagent/end` carries no run identity that separates that new run from a
    // delayed report about the previous one.
    if (name === 'send_message') event.action.delegationLifecycleUnproven = true;
    return event;
  }

  if (kind === 'action.after') {
    const actionId = toolCallId(payload);
    if (!actionId) return null;
    event.action = { id: actionId };
    const agentId = responseAgentId(payload);
    if (agentId) event.action.agentId = agentId;
    event.action.lifecycle = resultLifecycle(payload);
    return event;
  }

  return event;
}

// The returned object is an INTERMEDIATE adapter result, not a harness
// waterfall decision. None of the three shapes is a `PreToolDecision` or a
// `PreStepDecision`, and returning one directly is a defect: a bare
// `{ kind: 'context' }` returned from `agent/pre-step` leaves `messages`
// undefined, which the agent loop reads.
//
// The consuming plugin owns the translation:
//
//   tools/pre-execute
//     null                  -> return next() unchanged
//     { kind: 'deny' }      -> return it as the PreToolDecision
//     { kind: 'context' }   -> await next(), then attach the text through the
//                              plugin's own channel; the tool gate has no
//                              context field
//
//   agent/pre-step
//     null                  -> return next() unchanged
//     { kind: 'reject' }    -> return `{ kind: 'reject' }`; the reason must be
//                              surfaced by the plugin, the loop drops it
//     { kind: 'context' }   -> await next(), then fold the text into the
//                              returned `messages`, or deliver it another way
//
// `applyDshDecision` implements that translation for the two pre-dispatch
// points so a plugin does not have to re-derive it.
function fromControlResult(hookPoint, result) {
  if (!result || result.kind === 'none') return null;

  if (result.kind === 'prompt-error') {
    return hookPoint === 'agent/pre-step'
      ? { kind: 'reject', reason: result.message }
      : { kind: 'deny', reason: result.message };
  }

  if (result.kind === 'context') {
    // Post-dispatch points have no way to fold text back into the settled
    // result without replacing tool output, so context is not offered there.
    if (['tools/post-execute', 'subagent/end', 'session/disposed'].includes(hookPoint)) return null;
    return { kind: 'context', text: result.text };
  }

  if (result.kind === 'deny') {
    return { kind: 'deny', reason: result.message };
  }

  return null;
}

function handleDshHook(hookPoint, payload, options = {}) {
  // Fail closed: a delegated call whose root session the caller did not supply
  // cannot be checked against any real contract, so it is refused with a reason
  // that names the missing field.
  if (payload && payload.requiresVerifiedRoot === true) {
    return {
      kind: 'deny',
      reason: 'Delegated tool call has no verified root session. '
        + 'Pass context.rootSessionId from the parent session; the session header '
        + 'names only the immediate parent, so one hop is not enough to reach the root.'
    };
  }
  const event = toControlEvent(hookPoint, payload);
  if (!event) return null;
  const result = handleControlEvent(event, options);
  return fromControlResult(hookPoint, result);
}

/**
 * Translate an intermediate adapter result into a native harness decision.
 *
 * `next` is the waterfall's delegate and MUST be called exactly once, except
 * when this function returns a blocking decision. `onContext` receives context
 * text and may return a replacement message list for `agent/pre-step`.
 */
async function applyDshDecision(hookPoint, result, next, onContext) {
  if (!result) return next();

  if (result.kind === 'deny') {
    // A `deny` is only a valid PreToolDecision. Handing one to the pre-step
    // waterfall would be an invalid PreStepDecision, so it degrades to a
    // rejection and the reason is surfaced through the context sink.
    if (hookPoint === 'agent/pre-step') {
      if (typeof onContext === 'function') await onContext({ kind: 'reason', text: result.reason });
      return { kind: 'reject' };
    }
    return { kind: 'deny', reason: result.reason };
  }

  if (result.kind === 'reject') {
    // PreStepDecision has no reason field; the plugin surfaces it separately.
    if (typeof onContext === 'function') await onContext({ kind: 'reason', text: result.reason });
    return { kind: 'reject' };
  }

  if (result.kind === 'context') {
    const downstream = await next();
    if (typeof onContext !== 'function') return downstream;
    // The sink may deliver the text through its own channel and return nothing.
    // A downstream denial or rejection must survive that, so anything other
    // than an explicit replacement keeps the native decision the loop produced.
    const replacement = await onContext({ kind: 'context', text: result.text, downstream });
    return replacement === undefined ? downstream : replacement;
  }

  return next();
}

module.exports = {
  EVENT_KIND,
  applyDshDecision,
  fromControlResult,
  fromNativeEvent,
  handleDshHook,
  messageText,
  resultLifecycle,
  toControlEvent
};
