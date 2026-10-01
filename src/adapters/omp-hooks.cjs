'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const { normalizePiPrompt } = require('./pi-hooks.cjs');
const { classifyOmpAction } = require('./omp-tool-classifier.cjs');

const PARENT_LINK_ERROR = 'PARENT_LINK_DAMAGED: the saved parent session link cannot be read. Read-only recovery is active. Restore the link from a known-good backup or start a new root session. The damaged file is preserved.';

function eventBase(kind, context) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind,
    sessionId: context.rootSessionId || context.sessionId,
    sourceSessionId: context.sessionId,
    host: { family: 'omp', mode: context.mode || null, hasUI: Boolean(context.hasUI) }
  };
}

function handleOmpPrompt(input, context, options = {}) {
  if (context.parentLinkDamaged) return {
    kind: 'prompt-error', error: { code: 'PARENT_LINK_DAMAGED' }, message: PARENT_LINK_ERROR
  };
  if (context.rootSessionId && context.rootSessionId !== context.sessionId) return { kind: 'none' };
  return handleControlEvent({
    ...eventBase('prompt.submit', context), prompt: normalizePiPrompt(input.text)
  }, options);
}

function handleOmpTool(input, context, options = {}) {
  const name = input.toolName;
  const params = input.input || {};
  const analysis = classifyOmpAction(name, params, context.cwd);
  return handleControlEvent({
    ...eventBase('action.before', context),
    action: {
      id: input.toolCallId, name, input: params,
      ...analysis, cwd: context.cwd
    }
  }, { ...options, denialResponseOutcome: 'execution_denial_returned',
    ...(context.parentLinkDamaged ? { recoveryError: { code: 'PARENT_LINK_DAMAGED', message: PARENT_LINK_ERROR } } : {}) });
}

function handleOmpToolAfter(input, context, options = {}) {
  if (context.parentLinkDamaged) return { kind: 'none' };
  if (input.toolName !== 'task' || !input.toolCallId) return { kind: 'none' };
  const results = input.details?.results;
  const joined = input.type === 'tool_result' && Array.isArray(input.content)
    && typeof input.isError === 'boolean' && Array.isArray(results)
    && !input.details.async && !results.some(result => !result || result.aborted === true);
  return handleControlEvent({ ...eventBase('action.after', context),
    action: { id: input.toolCallId, lifecycle: joined ? 'joined' : 'unknown' }
  }, options);
}

function handleOmpLifecycle(input, context, options = {}) {
  if (!input.id || !input.parentToolCallId || !['started', 'completed', 'failed', 'aborted'].includes(input.status)) return { kind: 'none' };
  // An agent can wake again. Qualify its identity with the originating call so
  // a late completion from an earlier call cannot release a new reservation.
  const agentId = JSON.stringify([context.sessionId, input.parentToolCallId, input.id]);
  handleControlEvent({ ...eventBase('action.after', context),
    action: { id: input.parentToolCallId, lifecycle: 'running', agentId }
  }, options);
  if (!['completed', 'failed'].includes(input.status)) return { kind: 'none' };
  return handleControlEvent({ ...eventBase('subagent.stop', context), agentId }, options);
}

module.exports = { handleOmpPrompt, handleOmpTool, handleOmpToolAfter, handleOmpLifecycle, PARENT_LINK_ERROR };
