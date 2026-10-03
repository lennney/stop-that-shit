'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decodeState, freshState, recoveryState } = require('./state-schema.cjs');

function dataRoot(override) {
  return override || process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'stop-that-shit-dev');
}

function sessionKey(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId || 'unknown')).digest('hex').slice(0, 24);
}

function statePath(sessionId, override) {
  return path.join(dataRoot(override), 'sessions', `${sessionKey(sessionId)}.json`);
}

function readState(sessionId, override) {
  const file = statePath(sessionId, override);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Reads may run without the session lock. Normalize in memory only;
    // the next locked mutation persists the current schema and latest ledger.
    return decodeState(parsed);
  } catch (error) {
    if (error && error.code === 'ENOENT') return freshState();
    if (error && error.name === 'SyntaxError') {
      return recoveryState();
    }
    throw error;
  }
}

function writeState(sessionId, state, override) {
  const file = statePath(sessionId, override);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  // Do not replace an atomic rename with a partial overwrite on Windows.
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // Concurrent readers can briefly prevent replacement on Windows. Keep the
    // same atomic rename and session lock; never fall back to partial overwrite.
    const started = Date.now();
    while (true) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM' || Date.now() - started >= 100) throw error;
        sleepSync(10);
      }
    }
  }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}


function lockPath(sessionId, override) {
  return `${statePath(sessionId, override)}.lock`;
}

function sleepSync(milliseconds) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, milliseconds);
}

function ownerHasExited(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function removeEmptyLock(directory) {
  // Remove only an empty container. A contender may already have published
  // its own nonempty lock directory at this path.
  try { fs.rmdirSync(directory); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

function removeLockOwner(directory, owner) {
  try { fs.unlinkSync(path.join(directory, owner)); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw error;
  }
  removeEmptyLock(directory);
}

function reclaimSessionLock(file, staleMs) {
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs <= staleMs) return;
    if (stat.isDirectory()) {
      const owners = fs.readdirSync(file);
      if (owners.length === 0) {
        removeEmptyLock(file);
      } else {
        // Interrupted contenders can leave more than one marker. Reclaim each
        // confirmed exited owner by its unique name, retaining live owners.
        for (const owner of owners) {
          const match = /^(\d+)-[a-f0-9-]{36}$/.exec(owner);
          if (match && ownerHasExited(Number(match[1]))) removeLockOwner(file, owner);
        }
      }
    } else {
      // Previous releases used a file containing "pid:uuid timestamp".
      // A replacement directory cannot be removed by unlinkSync.
      const match = /^(\d+):/.exec(fs.readFileSync(file, 'utf8'));
      if (match && ownerHasExited(Number(match[1]))) fs.unlinkSync(file);
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return;
    if (error.code === 'EPERM' && fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) return;
    throw error;
  }
}

function acquireSessionLock(sessionId, override, options = {}) {
  const file = lockPath(sessionId, override);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 10000;
  const started = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = `${process.pid}-${crypto.randomUUID()}`;
  while (true) {
    let created = false;
    try { fs.mkdirSync(file, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (created) {
      let acquired = false;
      try {
        fs.writeFileSync(path.join(file, owner), '', { flag: 'wx', mode: 0o600 });
        // If this process paused after mkdir, recovery may have replaced the
        // empty directory. Only the sole marker owner may enter. Winners keep
        // their marker until release, so a delayed initializer cannot also win.
        const owners = fs.readdirSync(file);
        acquired = owners.length === 1 && owners[0] === owner;
        if (acquired) return () => removeLockOwner(file, owner);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      } finally {
        if (!acquired) {
          removeLockOwner(file, owner);
          removeEmptyLock(file);
        }
      }
    }
    reclaimSessionLock(file, staleMs);
    if (Date.now() - started >= timeoutMs) {
      const timeout = new Error(`Timed out waiting for Stop That Shit session lock: ${sessionKey(sessionId)}`);
      timeout.code = 'STS_LOCK_TIMEOUT';
      throw timeout;
    }
    sleepSync(10);
  }
}

function withSessionLock(sessionId, override, fn, options) {
  const release = acquireSessionLock(sessionId, override, options);
  try {
    return fn();
  } finally {
    release();
  }
}

function updateSession(sessionId, override, update) {
  return withSessionLock(sessionId, override, () => {
    const state = readState(sessionId, override);
    const damaged = Boolean(state.storageError);
    const result = update(state);
    if (!damaged) writeState(sessionId, state, override);
    return result;
  });
}

module.exports = {
  updateSession,
  acquireSessionLock,
  dataRoot,
  freshState,
  recoveryState,
  readState,
  sessionKey,
  statePath,
  withSessionLock,
  writeState
};
