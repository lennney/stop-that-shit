'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const {
  classifyOpenCodeTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths
} = require('./opencode-tool-classifier.cjs');

function promptText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part && part.type === 'text' && !part.synthetic && !part.ignored)
    .map((part) => String(part.text || ''))
    .filter(Boolean)
    .join('\n');
}

function hostMetadata(input) {
  const model = input && input.model;
  return {
    family: 'opencode',
    agent: input && input.agent || null,
    model: model && model.providerID && model.modelID ? `${model.providerID}/${model.modelID}` : null,
    messageId: input && input.messageID || null
  };
}

function toPromptEvent(input, output, context = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'prompt.submit',
    sessionId: String(context.controlSessionID || input && input.sessionID || ''),
    prompt: promptText(output && output.parts),
    host: hostMetadata(input)
  };
}

function toActionEvent(input, output, context = {}) {
  const toolName = String(input && input.tool || 'unknown');
  const args = output && output.args;
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'action.before',
    sessionId: String(context.controlSessionID || input && input.sessionID || ''),
    host: hostMetadata(input),
    action: {
      id: input && input.callID || null,
      name: toolName,
      input: args,
      mutability: classifyOpenCodeTool(toolName, args),
      affectedPaths: extractAffectedPaths(toolName, args, context.directory),
      cwd: context.directory,
      dependencyIntent: detectDependencyIntent(toolName, args),
      hashIntent: detectHashIntent(toolName, args)
    }
  };
}

function controllerOptions(options) {
  return { ...options, denialResponseOutcome: 'execution_denial_returned' };
}

function handleOpenCodeMessage(input, output, context = {}, options = {}) {
  return handleControlEvent(toPromptEvent(input, output, context), controllerOptions(options));
}

function handleOpenCodeTool(input, output, context = {}, options = {}) {
  return handleControlEvent(toActionEvent(input, output, context), controllerOptions(options));
}

module.exports = {
  handleOpenCodeMessage,
  handleOpenCodeTool,
  promptText,
  toActionEvent,
  toPromptEvent
};
