'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sessionKey } = require('../state.cjs');
const { handleControlEvent } = require('../controller.cjs');
const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleOmpPrompt, handleOmpTool, handleOmpToolAfter, handleOmpLifecycle, PARENT_LINK_ERROR } = require('./omp-hooks.cjs');
const { isPiControlInput } = require('./pi-hooks.cjs');

// OMP initializes ordinary children in the same module graph. Record authority
// before persistence: its event bus logs listener I/O errors and keeps going.
const parents = new Map();

function registerOmpExtension(pi, options) {
  const calls = new Map();
  const watch = new Map();
  const promptContext = new Map();
  function feedback(ctx, content, customType = 'stop-that-shit-error') {
    try {
      pi.sendMessage({ customType, content, display: true }, { triggerTurn: false });
    } catch {
      try {
        if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(content, 'warning');
        else process.stderr.write('STS_ADAPTER_FAILURE: OMP Guard feedback requires attention.\n');
      } catch {}
    }
  }
  function linkFile(file) {
    return path.join(options.dataDir, 'omp-parents', `${sessionKey(path.resolve(file))}.json`);
  }
  function context(ctx) {
    const sessionId = ctx.sessionManager.getSessionId();
    const file = ctx.sessionManager.getSessionFile();
    let rootSessionId = sessionId;
    let parentLinkDamaged = false;
    if (file) {
      const key = linkFile(file);
      if (parents.has(key)) rootSessionId = parents.get(key);
      else {
        try {
          const saved = JSON.parse(fs.readFileSync(key, 'utf8'));
          if (typeof saved?.rootSessionId !== 'string' || !saved.rootSessionId.trim()) parentLinkDamaged = true;
          else rootSessionId = saved.rootSessionId;
        } catch (error) { if (error.code !== 'ENOENT') parentLinkDamaged = true; }
      }
    }
    return { sessionId, rootSessionId, parentLinkDamaged, cwd: ctx.cwd, mode: ctx.mode, hasUI: ctx.hasUI };
  }
  pi.registerFlag('sts-contract', { type: 'string', description: 'Root STS contract, e.g. review agents=0 -- inspect' });
  // OMP 18.4.4 emits input in its interactive controller, not its RPC/SDK
  // prompt path. Native commands run before a model turn on both surfaces.
  pi.registerCommand('sts', {
    description: 'Set or inspect the root Stop That Shit contract: /sts review -- inspect',
    handler(args, ctx) {
      const current = context(ctx);
      if (current.parentLinkDamaged) return feedback(ctx, PARENT_LINK_ERROR);
      if (current.sessionId !== current.rootSessionId) {
        return feedback(ctx, 'Stop That Shit child commands cannot change root authority.');
      }
      if (!ctx.isIdle()) return feedback(ctx, 'Submit /sts again after OMP is idle.');
      promptContext.delete(current.sessionId);
      const result = handleOmpPrompt({ text: `$stop-that-shit ${args}` }, current, options);
      if (result.kind === 'prompt-error') feedback(ctx, `Stop That Shit directive rejected (${result.error.code}): ${result.message}`);
      if (result.kind === 'context') feedback(ctx, result.text, 'stop-that-shit-context');
    }
  });
  pi.on('session_start', (_event, ctx) => {
    const current = context(ctx);
    const flag = pi.getFlag('sts-contract');
    if (flag && current.sessionId === current.rootSessionId) {
      const result = handleOmpPrompt({ text: `$stop-that-shit ${flag}` }, current, options);
      if (result.kind === 'prompt-error') feedback(ctx, result.message);
    }
  });
  pi.on('input', (event, ctx) => {
    const current = context(ctx);
    if (['interactive', 'rpc'].includes(event.source) && current.sessionId === current.rootSessionId) {
      if (current.parentLinkDamaged) {
        feedback(ctx, PARENT_LINK_ERROR);
        return { handled: true };
      }
      if (!ctx.isIdle()) {
        if (!isPiControlInput(event.text, { sessionId: current.rootSessionId }, options)) return {};
        feedback(ctx, 'Stop That Shit contract changes are not applied mid-turn. Submit the instruction again after OMP is idle.');
        return { handled: true };
      }
      promptContext.delete(current.sessionId);
      const result = handleOmpPrompt(event, current, options);
      if (result.kind === 'prompt-error') {
        feedback(ctx, `Stop That Shit directive rejected (${result.error.code}): ${result.message} The previous contract is unchanged.`);
        return { handled: true };
      }
      if (result.kind === 'context') promptContext.set(current.sessionId, result.text);
    }
    return {};
  });
  pi.on('before_agent_start', (_event, ctx) => {
    const current = context(ctx);
    if (current.parentLinkDamaged) return {
      message: { customType: 'stop-that-shit-context', content: PARENT_LINK_ERROR, display: false }
    };
    const pending = promptContext.get(current.sessionId);
    promptContext.delete(current.sessionId);
    if (pending) return { message: { customType: 'stop-that-shit-context', content: pending, display: false } };
    const result = handleControlEvent({ protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
      kind: 'session.start', sessionId: current.rootSessionId }, options);
    if (result.kind === 'context') return {
      message: { customType: 'stop-that-shit-context', content: result.text, display: false }
    };
  });
  pi.on('tool_call', (event, ctx) => {
    const current = context(ctx);
    const result = handleOmpTool(event, current, options);
    if (result.kind === 'deny') return { block: true, reason: result.message };
    if (event.toolName === 'task') calls.set(event.toolCallId, current);
    if (result.kind === 'context') watch.set(event.toolCallId, result.text);
  });
  pi.events.on('task:subagent:lifecycle', event => {
    const current = calls.get(event.parentToolCallId);
    if (!current) return;
    if (event.sessionFile) parents.set(linkFile(event.sessionFile), current.rootSessionId);
    handleOmpLifecycle(event, current, options);
    if (event.sessionFile) {
      const file = linkFile(event.sessionFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ rootSessionId: current.rootSessionId }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
  });
  pi.on('tool_result', (event, ctx) => {
    handleOmpToolAfter(event, context(ctx), options);
    const text = watch.get(event.toolCallId);
    watch.delete(event.toolCallId);
    if (text) return { content: [...event.content, { type: 'text', text }] };
  });
  pi.on('tool_approval_resolved', event => {
    const current = calls.get(event.toolCallId);
    if (event.approved !== false || event.toolName !== 'task' || !current || event.sessionId !== current.sessionId) return;
    handleControlEvent({ protocolVersion: PROTOCOL_VERSION, lifecycleVersion: 2,
      kind: 'action.after', sessionId: current.rootSessionId, sourceSessionId: current.sessionId,
      action: { id: event.toolCallId, lifecycle: 'not_started' } }, options);
  });
}

module.exports = { registerOmpExtension };
