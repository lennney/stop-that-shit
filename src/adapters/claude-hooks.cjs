'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const {
  classifyClaudeTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  isUnboundedDelegation
} = require('./claude-tool-classifier.cjs');

const EVENT_KIND = {
  SessionStart: 'session.start',
  UserPromptSubmit: 'prompt.submit',
  UserPromptExpansion: 'prompt.submit',
  PreToolUse: 'action.before',
  SubagentStart: 'subagent.start'
};

function isStopThatShitExpansion(input) {
  if (!input || input.hook_event_name !== 'UserPromptExpansion') return false;
  if (input.expansion_type && input.expansion_type !== 'slash_command') return false;
  const name = String(input.command_name || '');
  return /^(?:stop-that-shit:)?stop-that-shit$/i.test(name);
}

function expansionDirective(input) {
  const args = String(input.command_args || '').trim();
  return `$stop-that-shit${args ? ` ${args}` : ''}`;
}

function slashDirective(prompt) {
  const text = String(prompt || '').trim();
  const match = /^\/(?:stop-that-shit:)?stop-that-shit(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return null;
  const args = (match[1] || '').trim();
  return `$stop-that-shit${args ? ` ${args}` : ''}`;
}

function toControlEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = EVENT_KIND[input.hook_event_name];
  if (!kind) return null;
  if (input.hook_event_name === 'UserPromptExpansion' && !isStopThatShitExpansion(input)) return null;

  const event = {
    protocolVersion: PROTOCOL_VERSION,
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

  if (kind === 'action.before') {
    event.action = {
      id: input.tool_use_id || null,
      name: String(input.tool_name || 'unknown'),
      input: input.tool_input,
      mutability: classifyClaudeTool(input.tool_name, input.tool_input),
      hashIntent: detectHashIntent(input.tool_name, input.tool_input),
      dependencyIntent: detectDependencyIntent(input.tool_name, input.tool_input, input.cwd),
      affectedPaths: extractAffectedPaths(input.tool_name, input.tool_input, input.cwd),
      cwd: input.cwd,
      unboundedDelegation: isUnboundedDelegation(input.tool_name)
    };
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

  if (result.kind === 'context') {
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
