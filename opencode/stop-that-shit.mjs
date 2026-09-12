import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  handleOpenCodeMessage,
  handleOpenCodeSessionEnd,
  handleOpenCodeTool,
  handleOpenCodeToolAfter,
  promptText,
  toSubagentStartEvent,
  toSubagentStopEvent
} = require('../src/adapters/opencode-hooks.cjs');
const { contractContext, handleControlEvent } = require('../src/controller.cjs');
const { parseContractPrompt } = require('../src/contracts.cjs');
const { readState, updateSession } = require('../src/state.cjs');

const CONTEXT_PREFIX = 'Stop That Shit context:';
const MAX_PROCESSED_MESSAGES = 1024;

// Mirror the contract parser exactly: a message is a directive whenever the
// parser would take the directive branch, including mid-text mentions such as
// the quoted prompts produced by `opencode run`.
function isDirective(text) {
  return Boolean(parseContractPrompt(String(text || '')).directive);
}

function fallbackDataDir() {
  const root = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(root, 'opencode', 'stop-that-shit');
}

function resolveDataDir(options) {
  if (typeof options.dataDir === 'string' && options.dataDir) return options.dataDir;
  return fallbackDataDir();
}

function appendToolContext(output, text) {
  if (!text || !output) return;
  const block = `<stop_that_shit_context>\n${text}\n</stop_that_shit_context>`;
  output.output = output.output ? `${output.output}\n\n${block}` : block;
}

export const StopThatShitPlugin = async ({ client, directory }, options = {}) => {
  const dataDir = resolveDataDir(options);
  const roots = new Map();
  const processedMessages = new Map();
  const pending = new Map();
  const lastInjected = new Map();
  const pendingContext = new Map();
  let editCapabilities = null;

  async function logFailure(phase, error) {
    try {
      await client.app.log({
        body: {
          service: 'stop-that-shit',
          level: 'error',
          message: `OpenCode adapter failed open during ${phase}`,
          extra: { error: error instanceof Error ? error.message : String(error) }
        }
      });
    } catch {}
  }

  function rememberSession(info) {
    if (!info || !info.id) return;
    if (info.parentID && !roots.has(info.parentID)) return;
    const root = info.parentID ? roots.get(info.parentID) : info.id;
    roots.set(info.id, root);
  }

  function isRootSession(info) {
    if (!info || !info.id) return false;
    const root = roots.get(info.id);
    return root === info.id || (!root && !info.parentID);
  }

  function isCompletedSession(info) {
    const status = info && info.status;
    const value = typeof status === 'string' ? status : status && (status.type || status.status);
    return ['completed', 'complete', 'failed', 'error', 'cancelled', 'canceled', 'stopped'].includes(String(value || '').toLowerCase());
  }

  async function handleChildLifecycle(info, kind) {
    const childID = info && (info.id || info.sessionID);
    if (!childID) return;
    let root = roots.get(childID) || (info.parentID && roots.get(info.parentID));
    if (!root) {
      const resolved = await resolveRoot(childID, 'child completion');
      if (!resolved.certain) return;
      root = resolved.sessionID;
    }
    if (!root || root === childID) return;
    const event = kind === 'start'
      ? toSubagentStartEvent({ ...info, id: childID, sessionID: root }, { controlSessionID: root })
      : toSubagentStopEvent({ ...info, id: childID, sessionID: root }, { controlSessionID: root });
    if (!event || (kind === 'start' && !event.reservationId)) return;
    handleControlEvent(event, { dataDir });
  }

  function forgetSession(info) {
    if (!info || !info.id) return;
    if (isRootSession(info)) {
      for (const [id, root] of roots) {
        if (id === info.id || root === info.id) roots.delete(id);
      }
    }
    pending.delete(info.id);
    lastInjected.delete(info.id);
  }

  async function rootSession(sessionID) {
    if (roots.has(sessionID)) return roots.get(sessionID);
    const visited = [];
    let current = sessionID;
    for (let depth = 0; depth < 32; depth += 1) {
      visited.push(current);
      const response = await client.session.get({ path: { id: current } });
      const info = response && response.data;
      if (!info || !info.parentID) break;
      if (roots.has(info.parentID)) {
        current = roots.get(info.parentID);
        break;
      }
      current = info.parentID;
    }
    for (const id of visited) roots.set(id, current);
    roots.set(current, current);
    return current;
  }

  async function resolveRoot(sessionID, phase) {
    try {
      return { sessionID: await rootSession(sessionID), certain: true };
    } catch (error) {
      await logFailure(phase, error);
      return { sessionID, certain: false };
    }
  }

  function enqueueSession(sessionID, task) {
    const previous = pending.get(sessionID) || Promise.resolve();
    const next = previous
      .then(task)
      .catch(async (error) => { await logFailure('message processing', error); });
    pending.set(sessionID, next);
    next.then(() => {
      if (pending.get(sessionID) === next) pending.delete(sessionID);
    }, () => {
      if (pending.get(sessionID) === next) pending.delete(sessionID);
    });
    return next;
  }

  function queueContext(key, text) {
    if (pendingContext.size >= 100) {
      const oldest = pendingContext.keys().next().value;
      clearTimeout(pendingContext.get(oldest).timer);
      pendingContext.delete(oldest);
    }
    const timer = setTimeout(() => pendingContext.delete(key), 10 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    pendingContext.set(key, { text, timer });
  }

  function rememberProcessed(messageID) {
    if (processedMessages.size >= MAX_PROCESSED_MESSAGES) {
      processedMessages.delete(processedMessages.keys().next().value);
    }
    processedMessages.set(messageID, true);
  }

  async function fetchMessage(sessionID, messageID, fallbackPart) {
    try {
      const response = await client.session.message({ path: { id: sessionID, messageID } });
      const data = response && response.data;
      if (data && data.info && Array.isArray(data.parts) && data.parts.length) return data;
    } catch (error) {
      await logFailure('message fetch', error);
    }
    return { info: null, parts: fallbackPart ? [fallbackPart] : [] };
  }

  async function injectContext(sessionID, info, text) {
    if (!text || lastInjected.get(sessionID) === text) return;
    const model = info && info.model && info.model.providerID && info.model.modelID
      ? { providerID: info.model.providerID, modelID: info.model.modelID }
      : undefined;
    const body = {
      noReply: true,
      parts: [{ type: 'text', text: `${CONTEXT_PREFIX}\n${text}`, synthetic: true }]
    };
    if (info && info.agent) body.agent = info.agent;
    if (model) body.model = model;
    try {
      await client.session.prompt({ path: { id: sessionID }, body });
      lastInjected.set(sessionID, text);
    } catch (error) {
      await logFailure('context injection', error);
    }
  }

  async function agentEditCapabilities() {
    if (editCapabilities) return editCapabilities;
    try {
      const response = await client.app.agents();
      const map = new Map();
      for (const agent of (response && response.data) || []) {
        if (!agent || !agent.name) continue;
        const permission = agent.permission || {};
        map.set(agent.name, permission.edit !== 'deny');
      }
      editCapabilities = map;
    } catch (error) {
      await logFailure('agent list', error);
      editCapabilities = new Map();
    }
    return editCapabilities;
  }

  async function agentAllowsEdits(agentName) {
    const capabilities = await agentEditCapabilities();
    // Unknown agents fail open; the host permission layer still applies.
    if (!capabilities.has(agentName)) return true;
    return capabilities.get(agentName);
  }

  // An explicit host mode switch is authorization: when a root-session user
  // message that is not a $stop-that-shit directive arrives under an
  // edit-capable agent while the contract is review, advance the contract to
  // change so the host's build mode and the guard no longer deadlock.
  async function advanceReviewOnEditableAgent(controlSessionID, info) {
    if (readState(controlSessionID, dataDir).contract.mode !== 'review') return false;
    const agentName = info && info.agent;
    if (!agentName || !(await agentAllowsEdits(agentName))) return false;
    return updateSession(controlSessionID, dataDir, (state) => {
      if (state.contract.mode !== 'review') return false;
      state.contract = { ...state.contract, mode: 'change', source: 'host' };
      return true;
    });
  }

  async function processUserText(sessionID, info, text) {
    const resolved = await resolveRoot(sessionID, 'session resolution');
    const controlSessionID = resolved.sessionID;
    const isControlSession = resolved.certain && sessionID === controlSessionID;
    let result = null;
    if (isControlSession) {
      const input = {
        sessionID: controlSessionID,
        agent: info && info.agent,
        model: info && info.model,
        messageID: info && info.id
      };
      const output = { message: info || {}, parts: [{ type: 'text', text }] };
      result = handleOpenCodeMessage(input, output, { controlSessionID, directory }, { dataDir });
      if (!isDirective(text) && await advanceReviewOnEditableAgent(controlSessionID, info)) {
        result = null;
      }
    }
    const state = readState(controlSessionID, dataDir);
    const active = contractContext(state.contract, state.delegation);
    const contextText = result && result.kind === 'context' ? result.text : active;
    await injectContext(controlSessionID, info, contextText);
  }

  async function handlePartUpdated(part) {
    if (!part || part.type !== 'text' || part.synthetic || part.ignored) return;
    if (!part.sessionID || !part.messageID) return;
    if (processedMessages.has(part.messageID)) return;
    rememberProcessed(part.messageID);
    await enqueueSession(part.sessionID, async () => {
      const message = await fetchMessage(part.sessionID, part.messageID, part);
      const info = message.info;
      if (!info || info.role !== 'user') return;
      const text = promptText(message.parts);
      if (!text) return;
      await processUserText(part.sessionID, info, text);
    });
  }

  return {
    event: async ({ event }) => {
      const properties = event && event.properties || {};
      const type = event && event.type;
      if (type === 'session.created' || type === 'session.updated') {
        rememberSession(properties.info);
        if (type === 'session.created') await handleChildLifecycle(properties.info, 'start');
        if (type === 'session.updated' && isCompletedSession(properties.info)) {
          await handleChildLifecycle(properties.info, 'stop');
        }
      } else if (type === 'session.idle') {
        await handleChildLifecycle({ sessionID: properties.sessionID }, 'stop');
      } else if (type === 'session.status' && properties.status && properties.status.type === 'idle') {
        await handleChildLifecycle({ sessionID: properties.sessionID }, 'stop');
      } else if (type === 'session.deleted') {
        if (isRootSession(properties.info)) {
          const sessionID = roots.get(properties.info && properties.info.id) || properties.info.id;
          try {
            handleOpenCodeSessionEnd(
              { sessionID },
              { controlSessionID: sessionID, directory },
              { dataDir }
            );
          } catch (error) {
            await logFailure('session end', error);
          }
        }
        forgetSession(properties.info);
      } else if (type === 'message.part.updated') {
        await handlePartUpdated(properties.part);
      }
    },

    'tool.execute.before': async (input, output) => {
      const resolved = await resolveRoot(input.sessionID, 'session resolution');
      const controlSessionID = resolved.sessionID;
      const prior = pending.get(controlSessionID) || pending.get(input.sessionID);
      if (prior) await prior;
      let result;
      try {
        result = handleOpenCodeTool(input, output, { controlSessionID, directory }, { dataDir });
      } catch (error) {
        await logFailure('tool.execute.before', error);
        return;
      }

      if (result.kind === 'context') queueContext(`${input.sessionID}:${input.callID}`, result.text);
      if (result.kind === 'deny') throw new Error(result.message);
    },

    'tool.execute.after': async (input, output) => {
      if (input && input.sessionID && (input.callID || input.callId)) {
        const resolved = await resolveRoot(input.sessionID, 'session resolution');
        try {
          handleOpenCodeToolAfter(
            input,
            output,
            { controlSessionID: resolved.sessionID, directory },
            { dataDir }
          );
        } catch (error) {
          await logFailure('tool.execute.after', error);
        }
      }
      const key = `${input.sessionID}:${input.callID}`;
      const pendingEntry = pendingContext.get(key);
      pendingContext.delete(key);
      if (pendingEntry) clearTimeout(pendingEntry.timer);
      appendToolContext(output, pendingEntry && pendingEntry.text);
    }
  };
};
