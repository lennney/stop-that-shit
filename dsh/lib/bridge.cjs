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
 * All tool calls are keyed by the ROOT session of the calling session. The
 * bridge walks the live session store's parent chain, so a delegated child
 * (root → child → grandchild) is checked against the root contract, which is
 * the requirement the P1 review fix implements.
 *
 * Without a contract armed by an explicit prompt directive, every decision is
 * a pass and the bridge costs nothing the model can see.
 */

const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const {
  applyDshDecision,
  fromNativeEvent,
  handleDshHook,
  resolveRootLineage
} = require('../../src/adapters/dsh-hooks.cjs');

/** Source tag carried by every message this bridge folds into a decision. */
const SOURCE = { kind: 'stop-that-shit' };

function plugin(ctx, config = {}) {
  const dataDir = typeof config.dataDir === 'string' && config.dataDir.trim()
    ? config.dataDir.trim()
    : path.join(os.homedir(), '.dsh', 'stop-that-shit');

  const options = { dataDir };

  // ---- Session lookup: walks parent lineage from the live store ----

  function getSessionById(sessionId) {
    const sessions = ctx.sessions;
    if (!sessions || typeof sessions.get !== 'function') return null;
    let session;
    try {
      session = sessions.get(sessionId);
    } catch {
      return null;
    }
    if (!session) return null;
    return { id: session.id, header: session.header };
  }

  /**
   * Root session id for a tool call. Follows the full parent chain (the
   * header only names the IMMEDIATE parent, so child → root must be walked
   * explicitly, and a grandchild needs two walks). Returns null when the
   * chain cannot reach an unparented session: the adapter then refuses the
   * call instead of trusting an intermediate child as authority.
   */
  const rootOf = (sessionId) => resolveRootLineage(sessionId, getSessionById);

  function gateContext(exec) {
    const sessionId = exec && exec.agent && exec.agent.session
      ? String(exec.agent.session.id || '')
      : '';
    return {
      rootSessionId: rootOf(sessionId) || undefined,
      resolveRootSession: rootOf
    };
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
    const normalized = fromNativeEvent('agent/pre-step', payload);
    // A delegated child prompt is not translated at all: the parent already
    // holds the contract governing the delegation.
    if (!normalized) return next();
    const result = handleDshHook('agent/pre-step', normalized, options);
    if (!result) return next();
    return applyDshDecision('agent/pre-step', result, next, preStepSink);
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const payload = fromNativeEvent('tools/pre-execute', exec, gateContext(exec));
    if (!payload) return next();
    const result = handleDshHook('tools/pre-execute', payload, options);
    return applyDshDecision('tools/pre-execute', result, next);
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const payload = fromNativeEvent('tools/post-execute', exec, Object.assign(
      { result },
      gateContext(exec)
    ));
    if (payload) handleDshHook('tools/post-execute', payload, options);
    return next();
  });

  // Subagent lifecycle: run info is flat { runId, provider, id, local } and the
  // parent must be resolved from the live session store via the CHILD id.
  function parentOfChild(childId) {
    const session = getSessionById(childId);
    const header = session && session.header;
    return header && header.parentSession ? String(header.parentSession) : undefined;
  }

  ctx.on('subagent/start', (info) => {
    const payload = fromNativeEvent('subagent/start', info, { sessionId: parentOfChild(info && info.id) });
    if (payload) handleDshHook('subagent/start', payload, options);
  });

  ctx.on('subagent/end', (info) => {
    const payload = fromNativeEvent('subagent/end', info, { sessionId: parentOfChild(info && info.id) });
    if (payload) handleDshHook('subagent/end', payload, options);
  });
}

const bridgeExports = {
  name: 'stop-that-shit',
  inject: ['sessions'],
  apply: plugin
};
module.exports = bridgeExports;
module.exports.default = bridgeExports;
