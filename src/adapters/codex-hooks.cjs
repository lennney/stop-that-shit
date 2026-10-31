'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const { analyzeCodexTool, canonicalCodexToolName } = require('./codex-tool-classifier.cjs');
const { optionalIdentifier } = require('./lifecycle-fields.cjs');
const { YES, NO, syncQuestionDigest } = require('../action-approval.cjs');

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

function agentIdentity(input) {
  const agentId = optionalIdentifier(input.agent_id, input.agentId);
  if (!agentId) return null;
  return { agentId, agentType: typeof input.agent_type === 'string' ? input.agent_type : null };
}

function delegationTargetId(toolName, toolInput) {
  if (toolName !== 'send_input' || !toolInput || typeof toolInput !== 'object') return null;
  return optionalIdentifier(toolInput.target, toolInput.id, toolInput.agent_id, toolInput.agentId);
}

function toControlEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = EVENT_KIND[input.hook_event_name];
  if (!kind) return null;
  const toolName = canonicalCodexToolName(input.tool_name);
  const agent = agentIdentity(input);
  const delegationTarget = delegationTargetId(toolName, input.tool_input);

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
  if (agent) event.agent = agent;

  if (kind === 'prompt.submit') event.prompt = String(input.prompt || '');
  if (kind === 'action.after') {
    // Delegation results and an exact registered native approval answer can
    // change state. Ordinary tool output must not acquire a writer lock.
    const actionId = toolName === 'request_user_input'
      ? optionalIdentifier(input.tool_use_id)
      : optionalIdentifier(input.tool_use_id, input.tool_call_id);
    if (!actionId) return null;
    if (toolName === 'request_user_input') {
      const response = parsedResponse(input.tool_response);
      const questions = input.tool_input?.questions;
      if (!response || Object.keys(response).length !== 1 || !Object.hasOwn(response, 'answers')
          || !response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)
          || !Array.isArray(questions) || questions.length !== 1) return null;
      const questionDigest = syncQuestionDigest(questions[0]);
      if (!questionDigest) return null;
      const questionId = questions[0].id;
      const answers = response.answers;
      if (Object.keys(answers).length === 0 && Object.keys(response).length === 1
          && Object.keys(input.tool_input).length === 1 && Object.hasOwn(input.tool_input, 'questions')) {
        event.action = { id: actionId, name: toolName, questionId, questionDigest, unanswered: true, cwd: input.cwd };
        return event;
      }
      if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, questionId)) return null;
      const answer = answers[questionId];
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)
          || Object.keys(answer).length !== 1 || !Object.hasOwn(answer, 'answers')
          || !Array.isArray(answer.answers) || answer.answers.length !== 1
          || ![YES, NO].includes(answer.answers[0])) return null;
      event.action = { id: actionId, name: toolName, questionId, questionDigest, answer: answer.answers[0], cwd: input.cwd };
      return event;
    }
    if (!['spawn_agent', 'Agent', 'wait_agent'].includes(toolName)) return null;
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
    const actionId = toolName === 'request_user_input'
      ? optionalIdentifier(input.tool_use_id)
      : optionalIdentifier(input.tool_use_id, input.tool_call_id);
    if (analysis.mutability === 'delegate' && !actionId) return null;
    event.action = {
      id: actionId,
      name: String(input.tool_name || 'unknown'),
      input: input.tool_input,
      ...analysis,
      cwd: input.cwd
    };
    if (delegationTarget) event.action.delegationTargetId = delegationTarget;
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
    const output = contextOutput(hookEventName, result.text);
    if (result.warning) output.systemMessage = result.warning.message;
    return output;
  }
  if (result.kind === 'rewrite') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: result.command } } };
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
