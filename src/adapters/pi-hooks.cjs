'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { parseContractPrompt } = require('../contracts.cjs');
const { handleControlEvent } = require('../controller.cjs');
const { readState } = require('../state.cjs');
const {
  classifyPiTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths,
  piDelegationShape
} = require('./pi-tool-classifier.cjs');
const { optionalIdentifier, readAsyncLaunched } = require('./lifecycle-fields.cjs');

function normalizePiPrompt(text) {
  return String(text || '').replace(/\/skill:stop-that-shit\b/gi, '$stop-that-shit');
}

function hostMetadata(context = {}) {
  const model = context.model;
  return {
    family: 'pi',
    mode: context.mode || null,
    hasUI: Boolean(context.hasUI),
    model: model && model.provider && model.id ? `${model.provider}/${model.id}` : null
  };
}

function toPromptEvent(input, context = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind: 'prompt.submit',
    sessionId: String(context.sessionId || ''),
    prompt: normalizePiPrompt(input && input.text),
    host: hostMetadata(context)
  };
}

function toActionEvent(input, context = {}) {
  const toolName = String(input && input.toolName || 'unknown');
  const toolInput = input && input.input;
  const delegation = piDelegationShape(toolName, toolInput);
  const mutability = classifyPiTool(toolName, toolInput);
  const actionId = optionalIdentifier(input && input.toolCallId, input && input.tool_call_id);
  if (mutability === 'delegate' && !actionId) return null;
  const action = {
    id: actionId,
    name: toolName,
    input: toolInput,
    mutability,
    affectedPaths: extractAffectedPaths(toolName, toolInput, context.cwd),
    cwd: context.cwd,
    dependencyIntent: detectDependencyIntent(toolName, toolInput),
    hashIntent: detectHashIntent(toolName, toolInput),
    delegationCount: delegation.count,
    completionScope: 'call',
    unboundedDelegation: delegation.unbounded
  };
  return {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind: 'action.before',
    sessionId: String(context.sessionId || ''),
    host: hostMetadata(context),
    action
  };
}

function toActionAfterEvent(input, context = {}) {
  const actionId = optionalIdentifier(input && input.toolCallId, input && input.tool_call_id);
  if (!actionId) return null;
  const action = { id: actionId };
  const asyncLaunched = readAsyncLaunched(input, input && input.details);
  action.lifecycle = asyncLaunched === true ? 'running' : 'unknown';
  // The supported official subagent tool joins its children before returning.
  // Keep explicitly asynchronous custom variants reserved.
  if (input.type === 'tool_result' && input.toolName === 'subagent'
      && Array.isArray(input.content) && typeof input.isError === 'boolean'
      && ['single', 'parallel', 'chain'].includes(input.details && input.details.mode)
      && Array.isArray(input.details.results)
      && asyncLaunched !== true) {
    action.lifecycle = 'joined';
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind: 'action.after',
    sessionId: String(context.sessionId || ''),
    host: hostMetadata(context),
    action
  };
}

function toSessionEndEvent(input, context = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    lifecycleVersion: 2,
    kind: 'session.end',
    sessionId: String(context.sessionId || input && input.sessionId || ''),
    host: hostMetadata(context)
  };
}

function controllerOptions(options) {
  return { ...options, denialResponseOutcome: 'execution_denial_returned' };
}

function handlePiPrompt(input, context = {}, options = {}) {
  return handleControlEvent(toPromptEvent(input, context), controllerOptions(options));
}

function handlePiTool(input, context = {}, options = {}) {
  const event = toActionEvent(input, context);
  return event ? handleControlEvent(event, controllerOptions(options)) : { kind: 'none' };
}

function handlePiToolAfter(input, context = {}, options = {}) {
  const event = toActionAfterEvent(input, context);
  return event ? handleControlEvent(event, controllerOptions(options)) : { kind: 'none' };
}

function handlePiSessionEnd(input, context = {}, options = {}) {
  return handleControlEvent(toSessionEndEvent(input, context), controllerOptions(options));
}

function isPiControlInput(text, context = {}, options = {}) {
  const prompt = normalizePiPrompt(text);
  if (/\$stop-that-shit\b/i.test(prompt)) return true;
  const state = readState(String(context.sessionId || ''), options.dataDir);
  const parsed = parseContractPrompt(prompt, state.contract);
  return parsed.changed || parsed.correction;
}

module.exports = {
  handlePiPrompt,
  handlePiTool,
  handlePiToolAfter,
  handlePiSessionEnd,
  isPiControlInput,
  normalizePiPrompt,
  toActionAfterEvent,
  toActionEvent,
  toSessionEndEvent,
  toPromptEvent
};
