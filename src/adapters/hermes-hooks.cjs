'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const {
  classifyHermesTool,
  countHermesDelegation,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths
} = require('./hermes-tool-classifier.cjs');
const { optionalIdentifier } = require('./lifecycle-fields.cjs');

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
    const mutability = classifyHermesTool(input.tool_name, input.tool_input);
    const actionId = optionalIdentifier(input.tool_call_id, extra.tool_call_id);
    if (mutability === 'delegate' && !actionId) return null;
    const action = {
      id: actionId,
      name: String(input.tool_name || 'unknown'),
      input: input.tool_input,
      mutability,
      delegationCount: countHermesDelegation(input.tool_name, input.tool_input),
      hashIntent: detectHashIntent(input.tool_name, input.tool_input),
      dependencyIntent: detectDependencyIntent(input.tool_name, input.tool_input),
      affectedPaths: extractAffectedPaths(input.tool_name, input.tool_input, input.cwd),
      cwd: input.cwd,
      unboundedDelegation: false
    };
    event.action = {
      ...action
    };
  }

  if (kind === 'action.after') {
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

function fromControlResult(result, kind) {
  if (!result || result.kind === 'none') return null;
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
  return fromControlResult(handleControlEvent(event, options), event.kind);
}

module.exports = {
  fromControlResult,
  handleHermesHook,
  toControlEvent
};
