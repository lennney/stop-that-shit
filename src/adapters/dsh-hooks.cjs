'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const { analyzeDshTool, isUnboundedDelegation } = require('./dsh-tool-classifier.cjs');
const { optionalIdentifier, readAsyncLaunched } = require('./lifecycle-fields.cjs');

// DeepSeek Harness is an event-emitter plugin host rather than a hook-file
// host, so this adapter is called directly from listeners instead of reading a
// `hooks.json`. The caller names the DSH extension point and passes the
// payload that point exposes.

const EVENT_KIND = {
  'session/created': 'session.start',
  'session/disposed': 'session.end',
  'agent/pre-step': 'prompt.submit',
  'tools/pre-execute': 'action.before',
  'tools/post-execute': 'action.after',
  'subagent/start': 'subagent.start',
  'subagent/end': 'subagent.stop'
};

function dshSessionId(payload) {
  const session = payload && payload.session;
  return String((session && session.id) || (payload && payload.sessionId) || '');
}

function dshTurnId(payload) {
  return optionalIdentifier(payload && payload.turnId, payload && payload.turn);
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

// A denial returned to `tools/pre-execute` is a typed decision, not an exit
// code. Context is attached to the downstream turn through the harness's own
// waterfall decision rather than a host-specific output block.
function fromControlResult(hookPoint, result) {
  if (!result || result.kind === 'none') return null;

  if (result.kind === 'prompt-error') {
    return { kind: 'deny', reason: result.message };
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
  const event = toControlEvent(hookPoint, payload);
  if (!event) return null;
  const result = handleControlEvent(event, options);
  return fromControlResult(hookPoint, result);
}

module.exports = {
  EVENT_KIND,
  fromControlResult,
  handleDshHook,
  resultLifecycle,
  toControlEvent
};
