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
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'action.before',
    sessionId: String(context.sessionId || ''),
    host: hostMetadata(context),
    action: {
      id: input && input.toolCallId || null,
      name: toolName,
      input: toolInput,
      mutability: classifyPiTool(toolName, toolInput),
      affectedPaths: extractAffectedPaths(toolName, toolInput, context.cwd),
      dependencyIntent: detectDependencyIntent(toolName, toolInput),
      hashIntent: detectHashIntent(toolName, toolInput),
      delegationCount: delegation.count,
      unboundedDelegation: delegation.unbounded
    }
  };
}

function controllerOptions(options) {
  return { ...options, denialResponseOutcome: 'execution_denial_returned' };
}

function handlePiPrompt(input, context = {}, options = {}) {
  return handleControlEvent(toPromptEvent(input, context), controllerOptions(options));
}

function handlePiTool(input, context = {}, options = {}) {
  return handleControlEvent(toActionEvent(input, context), controllerOptions(options));
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
  isPiControlInput,
  normalizePiPrompt,
  toActionEvent,
  toPromptEvent
};
