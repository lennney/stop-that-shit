'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const {
  analyzeClaudeTool,
  isUnboundedDelegation
} = require('./claude-tool-classifier.cjs');
const { optionalIdentifier } = require('./lifecycle-fields.cjs');

const EVENT_KIND = {
  SessionStart: 'session.start',
  UserPromptSubmit: 'prompt.submit',
  UserPromptExpansion: 'prompt.submit',
  PreToolUse: 'action.before',
  PostToolUse: 'action.after',
  PostToolUseFailure: 'action.after',
  PermissionDenied: 'action.after',
  SubagentStart: 'subagent.start',
  SessionEnd: 'session.end'
};

function isStopThatShitExpansion(input) {
  if (!input || input.hook_event_name !== 'UserPromptExpansion') return false;
  if (input.expansion_type && input.expansion_type !== 'slash_command') return false;
  const name = String(input.command_name || '');
  return /^(?:stop-that-shit:)?stop-that-shit$/i.test(name);
}

function expansionDirective(input) {
  const args = String(input.command_args || '').replace(/^[ \t]+/, '');
  return `$stop-that-shit${args ? ` ${args}` : ''}`;
}

function slashDirective(prompt) {
  const text = String(prompt || '');
  const match = /^(?:[ \t]*\r?\n)* {0,3}\/(?:stop-that-shit:)?stop-that-shit(?=$|[\s,:])/i.exec(text);
  if (!match) return null;
  return `$stop-that-shit${text.slice(match[0].length)}`;
}


function claudeResponseAgentId(input) {
  const response = input && input.tool_response;
  return optionalIdentifier(response && response.agentId, response && response.agent_id);
}

function toControlEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = EVENT_KIND[input.hook_event_name];
  if (!kind) return null;
  if (input.hook_event_name === 'UserPromptExpansion' && !isStopThatShitExpansion(input)) return null;

  const event = {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind,
    sessionId: String(input.session_id || ''),
    turnId: input.prompt_id || input.turn_id || null,
    host: {
      family: 'claude-code',
      model: input.model || null,
      permissionMode: input.permission_mode || null,
      agentId: input.agent_id || null,
      agentType: input.agent_type || null
    }
  };

  if (kind === 'prompt.submit') {
    event.prompt = input.hook_event_name === 'UserPromptExpansion'
      ? expansionDirective(input)
      // Hosts without the UserPromptExpansion event still route a direct
      // /stop-that-shit... invocation through UserPromptSubmit; treat the
      // slash form as the same directive so the Guard arms before tool use.
      : slashDirective(input.prompt) || String(input.prompt || '');
  }

  if (kind === 'action.after') {
    const actionId = optionalIdentifier(input.tool_use_id, input.tool_call_id);
    if (!actionId) return null;
    event.action = {
      id: actionId
    };
    const agentId = claudeResponseAgentId(input);
    if (agentId) event.action.agentId = agentId;
    const status = input.tool_response && input.tool_response.status;
    event.action.lifecycle = input.hook_event_name === 'PermissionDenied' ? 'not_started'
      : input.hook_event_name === 'PostToolUseFailure' ? 'unknown'
      : status === 'completed' ? 'joined' : status === 'async_launched' ? 'running' : 'unknown';
  }

  if (kind === 'action.before') {
    const analysis = analyzeClaudeTool(input.tool_name, input.tool_input, input.cwd);
    const actionId = optionalIdentifier(input.tool_use_id, input.tool_call_id);
    if (analysis.mutability === 'delegate' && !actionId) return null;
    event.action = {
      id: actionId,
      name: String(input.tool_name || 'unknown'),
      input: input.tool_input,
      ...analysis,
      cwd: input.cwd,
      unboundedDelegation: isUnboundedDelegation(input.tool_name)
    };
    // SendMessage can wake a stopped agent. SubagentStop has no run ID to
    // distinguish that run's completion from a delayed previous stop.
    if (input.tool_name === 'SendMessage') event.action.delegationLifecycleUnproven = true;
  }

  // Stop hooks run before other hooks may request continuation, so they do
  // not prove quiescence. Background calls remain reserved without joined evidence.
  if (kind === 'subagent.start') {
    event.agentId = optionalIdentifier(input.agent_id, input.agentId);
  }

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
  if (!result || result.kind === 'none') return null;

  if (result.kind === 'prompt-error') {
    return {
      decision: 'block',
      reason: result.message
    };
  }

  if (result.kind === 'context') {
    if (['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'SubagentStop', 'SessionEnd'].includes(hookEventName)) return null;
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

function handleClaudeHook(input, options = {}) {
  const event = toControlEvent(input);
  if (!event) return null;
  const result = handleControlEvent(event, options);
  return fromControlResult(input.hook_event_name, result);
}

module.exports = {
  expansionDirective,
  fromControlResult,
  handleClaudeHook,
  isStopThatShitExpansion,
  slashDirective,
  toControlEvent
};
