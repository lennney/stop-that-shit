'use strict';

/**
 * stop-that-shit-dsh — the Cordis bridge plugin that puts the Stop That Shit
 * DSH adapter (`src/adapters/dsh-hooks.cjs`) onto the live DeepSeek Harness
 * event surface.
 *
 * Registered listeners and their translation:
 *
 *   session/created    -> session.start      (emit, observes only)
 *   session/disposed   -> session.end        (emit, observes only)
 *   agent/pre-step     -> prompt.submit      (waterfall; can reject a step)
 *   tools/pre-execute  -> action.before      (waterfall; can deny a call)
 *   tools/post-execute -> action.after       (waterfall; observes only)
 *   subagent/start     -> subagent.start     (emit, observes only)
 *   subagent/end       -> subagent.stop      (emit, observes only)
 *
 * DSH owns live delegation identity and the session's working directory.
 */

const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const {
  applyDshDecision,
  fromNativeEvent,
  handleDshHook
} = require('../../src/adapters/dsh-hooks.cjs');

/** Source tag carried by every message this bridge folds into a decision. */
const SOURCE = { kind: 'stop-that-shit' };

function plugin(ctx, config = {}) {
  const dataDir = typeof config.dataDir === 'string' && config.dataDir.trim()
    ? config.dataDir.trim()
    : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'stop-that-shit');

  const options = { dataDir };

  function rootSession(agent) {
    try {
      return ctx.subagents.rootOf(agent).session;
    } catch (error) {
      if (error?.code === 'UNAUTHORIZED') return null;
      throw error;
    }
  }

  // ---- message helpers ----

  function contextMessage(text) {
    return Object.freeze({
      id: randomUUID(),
      role: 'user',
      source: SOURCE,
      content: [{ type: 'text', text: String(text) }]
    });
  }

  /**
   * Context sink for the pre-step waterfall.
   *
   * `context` (acknowledgment text the contract parser produced) becomes an
   * additional user-role message appended after the downstream batch, so the
   * model sees what the contract absorbed. A downstream rejection survives:
   * the replacement is withheld and the rejection stands.
   *
   * `reason` (why a step was rejected) is surfaced through the console here;
   * a replacement after a rejection would re-enter the step, so none is
   * returned and the decision stays `{ kind: 'reject' }`.
   */
  function preStepSink({ kind, text, downstream }) {
    if (kind === 'reason') {
      console.warn('[stop-that-shit] step rejected:', String(text));
      return undefined;
    }
    if (!downstream || downstream.kind === 'reject' || !Array.isArray(downstream.messages)) {
      return undefined;
    }
    const extra = contextMessage(text);
    return Object.assign({}, downstream, { messages: downstream.messages.concat(extra) });
  }

  // ---- listeners ----

  ctx.on('session/created', (session) => {
    const payload = fromNativeEvent('session/created', session);
    if (payload) handleDshHook('session/created', payload, options);
  });

  ctx.on('session/disposed', (session) => {
    const payload = fromNativeEvent('session/disposed', session);
    if (payload) handleDshHook('session/disposed', payload, options);
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const root = rootSession(payload.agent);
    const normalized = fromNativeEvent('agent/pre-step', payload, { rootSessionId: root?.id ?? null });
    if (!normalized) return next();
    const result = handleDshHook('agent/pre-step', normalized, options);
    if (!result) return next();
    return applyDshDecision('agent/pre-step', result, next, preStepSink);
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.agent) return next();
    const root = rootSession(exec.agent);
    const payload = fromNativeEvent('tools/pre-execute', exec, {
      rootSessionId: root?.id ?? null,
      contractCwd: root?.header.cwd,
      cwd: ctx.workingDirectory.get(exec.agent.session)
    });
    if (!payload) return next();
    const result = handleDshHook('tools/pre-execute', payload, options);
    return applyDshDecision('tools/pre-execute', result, next);
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (!exec.agent) return next();
    const root = rootSession(exec.agent);
    if (root) {
      const payload = fromNativeEvent('tools/post-execute', exec, { result, rootSessionId: root.id });
      handleDshHook('tools/post-execute', payload, options);
    }
    return next();
  });

  ctx.on('subagent/start', (info) => {
    const payload = fromNativeEvent('subagent/start', info);
    if (payload) handleDshHook('subagent/start', payload, options);
  });

  ctx.on('subagent/end', (info) => {
    const payload = fromNativeEvent('subagent/end', info);
    if (payload) handleDshHook('subagent/end', payload, options);
  });
}

const bridgeExports = {
  name: 'stop-that-shit',
  inject: ['subagents', 'workingDirectory'],
  apply: plugin
};
module.exports = bridgeExports;
module.exports.default = bridgeExports;
