'use strict';

const {
  handlePiPrompt,
  handlePiTool,
  isPiControlInput
} = require('./pi-hooks.cjs');

const MAX_PENDING_TOOL_CONTEXTS = 1024;

function registerPiExtension(pi, options = {}) {
  const pendingPromptContext = new Map();
  const pendingToolContext = new Map();

  function sessionContext(ctx) {
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      model: ctx.model
    };
  }

  function notify(ctx, message, level = 'warning') {
    if (ctx && ctx.hasUI && ctx.ui && typeof ctx.ui.notify === 'function') {
      ctx.ui.notify(message, level);
    }
  }

  function toolContextKey(event, ctx) {
    return `${ctx.sessionManager.getSessionId()}:${event.toolCallId}`;
  }

  pi.on('input', (event, ctx) => {
    if (event.source === 'extension') return { action: 'continue' };
    try {
      const context = sessionContext(ctx);
      if (event.streamingBehavior) {
        if (!isPiControlInput(event.text, context, options)) return { action: 'continue' };
        notify(ctx, 'Stop That Shit contract changes are not applied mid-turn. Submit the instruction again after Pi is idle.');
        return { action: 'handled' };
      }

      pendingPromptContext.delete(context.sessionId);
      const result = handlePiPrompt(event, context, options);
      if (result && result.kind === 'context') {
        pendingPromptContext.set(context.sessionId, result.text);
      }
      return { action: 'continue' };
    } catch {
      notify(ctx, 'Stop That Shit failed open while processing input.');
      return { action: 'continue' };
    }
  });

  pi.on('before_agent_start', (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const text = pendingPromptContext.get(sessionId);
      pendingPromptContext.delete(sessionId);
      if (!text) return;
      return {
        message: {
          customType: 'stop-that-shit-context',
          content: text,
          display: false
        }
      };
    } catch {
      notify(ctx, 'Stop That Shit failed open while injecting context.');
    }
  });

  pi.on('tool_call', (event, ctx) => {
    try {
      const result = handlePiTool(event, sessionContext(ctx), options);
      if (!result || result.kind === 'none') return;
      if (result.kind === 'deny') {
        return { block: true, reason: result.message };
      }
      if (result.kind === 'context') {
        if (pendingToolContext.size >= MAX_PENDING_TOOL_CONTEXTS) {
          pendingToolContext.delete(pendingToolContext.keys().next().value);
        }
        pendingToolContext.set(toolContextKey(event, ctx), result.text);
      }
    } catch {
      notify(ctx, 'Stop That Shit failed open while checking a tool call.');
    }
  });

  pi.on('tool_result', (event, ctx) => {
    try {
      const key = toolContextKey(event, ctx);
      const text = pendingToolContext.get(key);
      pendingToolContext.delete(key);
      if (!text) return;
      return {
        content: [
          ...event.content,
          { type: 'text', text: `<stop_that_shit_context>\n${text}\n</stop_that_shit_context>` }
        ]
      };
    } catch {
      notify(ctx, 'Stop That Shit failed open while returning watch context.');
    }
  });
}

module.exports = { registerPiExtension };
