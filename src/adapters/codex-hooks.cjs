'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const { analyzeCodexTool, canonicalCodexToolName } = require('./codex-tool-classifier.cjs');
const { optionalIdentifier } = require('./lifecycle-fields.cjs');

const EVENT_KIND = {
  SessionStart: 'session.start',
  UserPromptSubmit: 'prompt.submit',
  PreToolUse: 'action.before',
  PostToolUse: 'action.after',
  SessionEnd: 'session.end'
};

function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

function parsedResponse(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function toControlEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = EVENT_KIND[input.hook_event_name];
  if (!kind) return null;
  const toolName = canonicalCodexToolName(input.tool_name);

  const event = {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind,
    sessionId: String(input.session_id || ''),
    turnId: input.turn_id || null,
    host: {
      family: 'codex',
      model: input.model || null,
      permissionMode: input.permission_mode || null
    }
  };

  if (kind === 'prompt.submit') event.prompt = String(input.prompt || '');
  if (kind === 'action.after') {
    // Only delegation results can change this adapter's ledger. Ordinary tool
    // output must not acquire a writer lock just to rewrite unchanged state.
    if (!['spawn_agent', 'Agent', 'wait_agent'].includes(toolName)) return null;
    const actionId = optionalIdentifier(input.tool_use_id, input.tool_call_id);
    if (!actionId) return null;
    event.action = { id: actionId, lifecycle: 'unknown' };
    const response = parsedResponse(input.tool_response);
    if (toolName === 'spawn_agent' && response && uuid(response.agent_id)) {
      event.action.lifecycle = 'running';
      event.action.agentId = response.agent_id;
    }
    // wait results name requested targets, which may also be path aliases.
    // Only UUID targets can be correlated without an authoritative alias map.
    if (toolName === 'wait_agent' && response && response.timed_out === false
        && response.status && typeof response.status === 'object') {
      const targets = Array.isArray(input.tool_input?.targets) ? input.tool_input.targets : [];
      const ended = Object.entries(response.status).filter(([id, status]) =>
        uuid(id) && targets.includes(id) && (status === 'shutdown'
          || status && typeof status === 'object' && !Array.isArray(status)
            && Object.keys(status).length === 1 && Object.hasOwn(status, 'completed')
            && (status.completed === null || typeof status.completed === 'string'))
      ).map(([id]) => id);
      if (ended.length) event.action.endedAgentIds = ended;
    }
    if (toolName === 'wait_agent' && !event.action.endedAgentIds) return null;
    // close_agent exposes previous_status, not shutdown acknowledgement.
    // Errored can originate from an Error event before the turn terminates.

  }
  if (kind === 'action.before') {
    const analysis = analyzeCodexTool(input.tool_name, input.tool_input, input.cwd);
    const actionId = optionalIdentifier(input.tool_use_id, input.tool_call_id);
    if (analysis.mutability === 'delegate' && !actionId) return null;
    event.action = {
      id: actionId,
      name: String(input.tool_name || 'unknown'),
      input: input.tool_input,
      ...analysis,
      cwd: input.cwd
    };
    if (['send_input', 'resume_agent', 'followup_task'].includes(toolName)) {
      event.action.delegationLifecycleUnproven = true;
    }
  }
  // SubagentStop is a stop attempt that other hooks may continue.
  // Its routing fields do not prove terminal execution.

  return event;
}

function contextOutput(hookEventName, text) {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: text
    }
  };
}

function fromControlResult(hookEventName, result) {
  if (!result || result.kind === 'none') {
    return null;
  }
  if (result.kind === 'prompt-error') {
    return {
      decision: 'block',
      reason: result.message
    };
  }
  if (result.kind === 'context') {
    if (['PostToolUse', 'SubagentStop', 'SessionEnd'].includes(hookEventName)) return null;
    return contextOutput(hookEventName, result.text);
  }
  if (result.kind === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.message
      }
    };
  }
  return null;
}

function handleCodexHook(input, options = {}) {
  const event = toControlEvent(input);
  if (!event) return null;
  const result = handleControlEvent(event, options);
  return fromControlResult(input.hook_event_name, result);
}

module.exports = {
  fromControlResult,
  handleCodexHook,
  toControlEvent
};
