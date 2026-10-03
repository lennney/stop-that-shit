import { createRequire } from 'node:module';
import { Effect, Semaphore, Stream } from 'effect';
import { Tool } from '@opencode/schema/tool';
import { directiveErrorText, mentionsDirective, resolveDataDir } from './runtime.mjs';

const require = createRequire(import.meta.url);
const { handleOpenCodeMessage, handleOpenCodeSessionEnd, toSubagentStopEvent } = require('../src/adapters/opencode-hooks.cjs');
const { toV2ActionEvent, toV2ActionAfterEvent } = require('../src/adapters/opencode-v2-hooks.cjs');
const { contractContext, handleControlEvent, runtimeCommand } = require('../src/controller.cjs');
const { readState, updateSession } = require('../src/state.cjs');

export const openCodeV2Effect = (ctx) => Effect.gen(function* () {
  const dataDir = resolveDataDir(ctx.options);
  const gates = new Map();
  const roots = new Map();
  const pendingContext = new Map();
  const callKey = (event) => JSON.stringify([event.sessionID, event.messageID, event.id, event.tool]);

  const resolveSession = (sessionID) => Effect.gen(function* () {
    const session = yield* ctx.session.get({ sessionID });
    let root = session;
    const seen = new Set();
    while (root.parentID) {
      if (seen.has(root.id)) return yield* Effect.die(new Error('OpenCode session ancestry contains a cycle'));
      seen.add(root.id);
      root = yield* ctx.session.get({ sessionID: root.parentID });
    }
    roots.set(session.id, root.id);
    return { session, root };
  });

  const prepare = (sessionID, consumeReply = false) => Effect.gen(function* () {
    const initial = yield* resolveSession(sessionID);
    if (!gates.has(initial.root.id)) gates.set(initial.root.id, Semaphore.makeUnsafe(1));
    return yield* Semaphore.withPermit(gates.get(initial.root.id))(Effect.gen(function* () {
      // Permission and location may change while a prior hook holds the permit.
      const { session, root } = yield* resolveSession(sessionID);
      const key = `prompts:${root.id}`;
      const handled = new Set((yield* ctx.storage.get(key)) ?? []);
      const history = yield* ctx.session.context({ sessionID: root.id });
      // context contains delivered messages; prompt hooks also see queued or
      // rejected submissions, which must not change the active contract.
      const users = history.filter((message) => message.type === 'user');
      // IDs identify messages, not delivery order. A queued message can arrive
      // after newer IDs, including after compaction removes earlier context.
      const fresh = users.filter((message) => !handled.has(message.id));
      for (const message of fresh) {
        const response = handleOpenCodeMessage(
          { sessionID: root.id, messageID: message.id, agent: root.agent,
            model: root.model && { providerID: root.model.providerID, modelID: root.model.id } },
          { parts: [{ type: 'text', text: message.text }] },
          { directory: root.location.directory }, { dataDir },
        );
        if (runtimeCommand(message.text) && response?.kind === 'context') {
          yield* ctx.storage.set(`reply:${root.id}`, response.text);
        }
        const state = readState(root.id, dataDir);
        if (message === users.at(-1) && root.agent && !mentionsDirective(message.text)
            && state.contract.mode === 'review' && !state.directiveError) {
          const agent = yield* ctx.agent.get({ agentID: root.agent, location: { directory: root.location.directory } });
          const permissions = [...agent.data.permissions, ...(root.permissions ?? [])];
          const edit = permissions.filter((rule) => ['*', 'edit'].includes(rule.action) && rule.resource === '*').at(-1);
          if (edit && edit.effect !== 'deny') {
            updateSession(root.id, dataDir, (latest) => {
              if (latest.contract.mode === 'review' && !latest.directiveError) latest.contract = { ...latest.contract, mode: 'change', source: 'host' };
            });
          }
        }
        handled.add(message.id);
        yield* ctx.storage.set(key, [...handled]);
      }
      let reply;
      if (consumeReply && sessionID === root.id) {
        reply = yield* ctx.storage.get(`reply:${root.id}`);
        if (reply !== undefined) yield* ctx.storage.remove(`reply:${root.id}`);
      }
      return { session, root, reply, state: readState(root.id, dataDir) };
    }));
  });

  yield* ctx.session.hook('context', (event) => Effect.gen(function* () {
    const current = yield* prepare(event.sessionID, true);
    const text = [current.reply, contractContext(current.state.contract, current.state.delegation,
      'active', current.state.directiveWarning, current.state.storageError)].filter(Boolean).join('\n');
    event.system.push({ type: 'text', text: `Stop That Shit context:\n${current.state.directiveError
      ? directiveErrorText(current.state.directiveError) + '\n' : ''}${text}` });
  }));

  yield* ctx.tool.hook('execute.before', (event) => Effect.gen(function* () {
    const current = yield* prepare(event.sessionID);
    if (current.state.directiveError) return yield* Effect.fail(new Tool.Error({ message: directiveErrorText(current.state.directiveError) }));
    const result = handleControlEvent(toV2ActionEvent(event,
      { controlSessionID: current.root.id, directory: current.session.location.directory }),
    { dataDir, denialResponseOutcome: 'execution_denial_returned' });
    if (result.kind === 'deny') return yield* Effect.fail(new Tool.Error({ message: result.message }));
    if (result.kind === 'context') {
      if (pendingContext.size >= 100) pendingContext.delete(pendingContext.keys().next().value);
      pendingContext.set(callKey(event), result.text);
    }
  }));

  yield* ctx.tool.hook('execute.after', (event) => Effect.gen(function* () {
    const { session, root } = yield* resolveSession(event.sessionID);
    const completion = toV2ActionAfterEvent(event,
      { controlSessionID: root.id, directory: session.location.directory });
    if (completion) handleControlEvent(completion, { dataDir });
    const text = pendingContext.get(callKey(event));
    pendingContext.delete(callKey(event));
    if (text && event.status === 'completed') {
      const content = event.result.content;
      const block = `<stop_that_shit_context>\n${text}\n</stop_that_shit_context>`;
      event.result = { ...event.result, content: Array.isArray(content)
        ? [...content, { type: 'text', text: block }] : [content, block].filter(Boolean).join('\n\n') };
    }
  }));

  const onEvent = (event) => Effect.gen(function* () {
    const sessionID = event.data?.sessionID;
    if (!sessionID) return;
    if (event.type === 'session.deleted') {
      if (roots.get(sessionID) === sessionID) handleOpenCodeSessionEnd({ sessionID }, {}, { dataDir });
      yield* ctx.storage.remove(`prompts:${sessionID}`);
      yield* ctx.storage.remove(`reply:${sessionID}`);
      gates.delete(sessionID);
      roots.delete(sessionID);
      return;
    }
    const completed = ['session.execution.succeeded', 'session.execution.failed'].includes(event.type)
      || event.type === 'session.execution.interrupted' && event.data.reason === 'user';
    // Shutdown and superseding work can resume the same child. Neither proves
    // completion, and ordinary idle/status notifications carry no such proof.
    if (!completed) return;
    const { root } = yield* resolveSession(sessionID);
    if (root.id === sessionID) return;
    handleControlEvent(toSubagentStopEvent({ id: sessionID }, { controlSessionID: root.id }), { dataDir });
  });
  yield* Stream.runForEach(ctx.event.subscribe(), (event) => onEvent(event).pipe(
    Effect.catchCause(() => Effect.logWarning('Stop That Shit could not reconcile an OpenCode lifecycle event')),
  )).pipe(Effect.forkScoped({ startImmediately: true }));
  yield* Effect.addFinalizer(() => Effect.sync(() => { roots.clear(); gates.clear(); pendingContext.clear(); }));
});
