'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createdHandoffs = new Set();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function bindingPayload(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || typeof binding.sessionId !== 'string' || !binding.sessionId
      || !/^evt_[0-9a-f-]{36}$/.test(binding.eventId || '')
      || !/^[a-f0-9]{64}$/.test(binding.ticket || '')
      || !/^[a-f0-9]{64}$/.test(binding.actionDigest || '')
      || binding.agentId !== undefined && binding.agentId !== null
        && (typeof binding.agentId !== 'string' || !binding.agentId.trim() || Buffer.byteLength(binding.agentId, 'utf8') > 4096)
      || binding.policyDigest !== undefined && binding.policyDigest !== null && !/^[a-f0-9]{64}$/.test(binding.policyDigest)
      || typeof binding.targetCwd !== 'string' || !path.isAbsolute(binding.targetCwd)
      || !Array.isArray(binding.argv) || !binding.argv.every(value => typeof value === 'string')
      || !binding.manager || typeof binding.manager !== 'object' || Array.isArray(binding.manager)) {
    throw new Error('Invalid one-time handoff binding');
  }
  const payload = {
    version: 1,
    sessionId: binding.sessionId,
    eventId: binding.eventId,
    ticket: binding.ticket,
    actionDigest: binding.actionDigest,
    argv: binding.argv,
    targetCwd: binding.targetCwd,
    manager: binding.manager
  };
  if (binding.agentId) payload.agentId = binding.agentId;
  if (binding.policyDigest) payload.policyDigest = binding.policyDigest;
  return Buffer.from(JSON.stringify(canonical(payload)), 'utf8');
}

function fileIdentity(stat) {
  if (!stat || !stat.isFile() || typeof stat.nlink !== 'bigint' || stat.nlink !== 1n
      || typeof stat.ino !== 'bigint' || stat.ino === 0n
      || typeof stat.dev !== 'bigint' || typeof stat.birthtimeNs !== 'bigint') return null;
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() };
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function statHasIdentity(stat, identity) {
  return stat && typeof stat.dev === 'bigint' && typeof stat.ino === 'bigint'
    && typeof stat.birthtimeNs === 'bigint'
    && stat.dev.toString() === identity.dev && stat.ino.toString() === identity.ino
    && stat.birthtimeNs.toString() === identity.birthtimeNs;
}

function canonicalPath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function validMetadata(handoff) {
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)
      || handoff.version !== 1 || typeof handoff.path !== 'string' || !path.isAbsolute(handoff.path)
      || typeof handoff.tempRoot !== 'string' || !path.isAbsolute(handoff.tempRoot)
      || !/^[a-f0-9]{64}$/.test(handoff.sha256 || '')
      || !handoff.identity || typeof handoff.identity !== 'object' || Array.isArray(handoff.identity)
      || !['dev', 'ino', 'birthtimeNs'].every(key => typeof handoff.identity[key] === 'string' && /^\d+$/.test(handoff.identity[key]))) return false;
  const root = path.resolve(handoff.tempRoot);
  const file = path.resolve(handoff.path);
  let expectedRoot;
  try { expectedRoot = path.join(fs.realpathSync(os.tmpdir()), 'stop-that-shit-handoffs'); }
  catch { return false; }
  return canonicalPath(root) === canonicalPath(expectedRoot)
    && canonicalPath(path.dirname(file)) === canonicalPath(root)
    && /^\.sts-dependency-[a-f0-9]{64}\.handoff$/.test(path.basename(file));
}

function systemTempRoot() {
  const root = fs.realpathSync(os.tmpdir());
  if (!fs.statSync(root).isDirectory()) throw new Error('One-time handoff temp root is unavailable');
  return root;
}

function handoffTempRoot() {
  const parent = systemTempRoot();
  const candidate = path.join(parent, 'stop-that-shit-handoffs');
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(candidate);
  if (canonicalPath(path.dirname(root)) !== canonicalPath(parent)
      || path.basename(root) !== 'stop-that-shit-handoffs'
      || !fs.statSync(root).isDirectory()) throw new Error('One-time handoff temp directory is not canonical');
  return root;
}

function cleanExpiredHandoffs(root, now = Date.now()) {
  const cutoff = now - 60 * 60 * 1000;
  for (const name of fs.readdirSync(root)) {
    if (!/^\.sts-dependency-[a-f0-9]{64}\.(?:handoff|claim|discard)$/.test(name)) continue;
    const file = path.join(root, name);
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || Number(stat.mtimeMs) >= cutoff) continue;
      fs.unlinkSync(file);
    } catch {}
  }
}

function readHandle(fd) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (stat.size > 65536n) throw new Error('One-time handoff contents are oversized');
  const bytes = Buffer.alloc(Number(stat.size));
  const bytesRead = fs.readSync(fd, bytes, 0, bytes.length, 0);
  if (BigInt(bytesRead) !== stat.size) throw new Error('One-time handoff contents changed while reading');
  return bytes;
}

function createHandoff(binding) {
  const bytes = bindingPayload(binding);
  const tempRoot = handoffTempRoot();
  cleanExpiredHandoffs(tempRoot);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const file = path.join(tempRoot, `.sts-dependency-${crypto.randomBytes(32).toString('hex')}.handoff`);
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(file, { bigint: true });
      const identity = fileIdentity(opened);
      if (!identity || !sameIdentity(identity, fileIdentity(named))) throw new Error('One-time handoff file identity is unavailable');
      const handoff = { version: 1, path: file, tempRoot, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), identity };
      createdHandoffs.add(file);
      return handoff;
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      try { fs.unlinkSync(file); } catch {}
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  throw new Error('Could not allocate a unique one-time handoff file');
}

function handoffAvailable(handoff, binding) {
  if (!validMetadata(handoff)) return false;
  let fd;
  try {
    if (canonicalPath(handoffTempRoot()) !== canonicalPath(handoff.tempRoot)) return false;
    const expected = bindingPayload(binding);
    if (crypto.createHash('sha256').update(expected).digest('hex') !== handoff.sha256) return false;
    fd = fs.openSync(handoff.path, 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(fileIdentity(stat), handoff.identity)) return false;
    const named = fs.lstatSync(handoff.path, { bigint: true });
    return !named.isSymbolicLink() && sameIdentity(fileIdentity(named), handoff.identity)
      && readHandle(fd).equals(expected);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function consumeHandoff(handoff, binding) {
  if (!validMetadata(handoff) || canonicalPath(handoffTempRoot()) !== canonicalPath(handoff.tempRoot)) {
    throw new Error('One-time handoff is unavailable or invalid');
  }
  const expected = bindingPayload(binding);
  if (crypto.createHash('sha256').update(expected).digest('hex') !== handoff.sha256) {
    throw new Error('One-time handoff binding digest mismatch');
  }
  let fd;
  let claimedPath;
  try {
    const named = fs.lstatSync(handoff.path, { bigint: true });
    if (named.isSymbolicLink() || !sameIdentity(fileIdentity(named), handoff.identity)) throw new Error('One-time handoff path identity changed');
    // rename is the atomic winner election. Only its winner opens the claimed
    // path, so losing contenders do not keep delete-pending handles on Windows.
    claimedPath = path.join(handoff.tempRoot, `.sts-dependency-${crypto.randomBytes(32).toString('hex')}.claim`);
    fs.renameSync(handoff.path, claimedPath);
    const claimed = fs.lstatSync(claimedPath, { bigint: true });
    if (claimed.isSymbolicLink() || !sameIdentity(fileIdentity(claimed), handoff.identity)) {
      throw new Error('Claimed handoff path identity changed');
    }
    fd = fs.openSync(claimedPath, 'r');
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(fileIdentity(opened), handoff.identity)) throw new Error('Claimed handoff identity changed');
    const bytes = readHandle(fd);
    if (!bytes.equals(expected) || crypto.createHash('sha256').update(bytes).digest('hex') !== handoff.sha256) {
      throw new Error('One-time handoff contents changed');
    }
    try {
      fs.lstatSync(handoff.path);
      throw new Error('One-time handoff source path was replaced during claim');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.unlinkSync(claimedPath);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!statHasIdentity(after, handoff.identity) || after.nlink !== 0n) {
      throw new Error('One-time handoff was not atomically unlinked');
    }
    fs.closeSync(fd);
    fd = undefined;
    for (const file of [handoff.path, claimedPath]) try {
      fs.lstatSync(file);
      throw new Error('One-time handoff path was replaced during consumption');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    createdHandoffs.delete(handoff.path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('One-time handoff is already consumed or unavailable');
    throw error;
  } finally {
    if (claimedPath) {
      try {
        const stat = fs.lstatSync(claimedPath, { bigint: true });
        if (!stat.isSymbolicLink() && statHasIdentity(stat, handoff.identity)) fs.unlinkSync(claimedPath);
      } catch {}
    }
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function discardHandoff(handoff) {
  if (!validMetadata(handoff)) return false;
  let fd;
  let claimedPath;
  try {
    fd = fs.openSync(handoff.path, 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(fileIdentity(stat), handoff.identity)) return false;
    const bytes = readHandle(fd);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== handoff.sha256) return false;
    claimedPath = path.join(handoff.tempRoot, `.sts-dependency-${crypto.randomBytes(32).toString('hex')}.discard`);
    fs.renameSync(handoff.path, claimedPath);
    const moved = fs.lstatSync(claimedPath, { bigint: true });
    if (moved.isSymbolicLink() || !sameIdentity(fileIdentity(moved), handoff.identity)) return false;
    fs.unlinkSync(claimedPath);
    const discarded = fs.fstatSync(fd, { bigint: true }).nlink === 0n;
    if (discarded) createdHandoffs.delete(handoff.path);
    return discarded;
  } catch {
    return false;
  } finally {
    if (fd !== undefined && claimedPath) {
      try {
        const stat = fs.lstatSync(claimedPath, { bigint: true });
        if (!stat.isSymbolicLink() && statHasIdentity(stat, handoff.identity)) fs.unlinkSync(claimedPath);
      } catch {}
    }
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function bindingForRecord(sessionId, record, ticket = record?.ticket) {
  if (!record || typeof record !== 'object') throw new Error('Approval record is unavailable');
  return { sessionId, agentId: record.scopeAgentId || null, policyDigest: record.policyDigest || null,
    eventId: record.eventId, ticket, actionDigest: record.digest,
    argv: record.argv, targetCwd: record.targetCwd, manager: record.manager };
}

function withCoordinationLock(sessionId, dataDir, callback) {
  const { dataRoot, withSessionLock } = require('./state.cjs');
  const root = systemTempRoot();
  const requestedRoot = path.resolve(dataRoot(dataDir));
  let existing = requestedRoot;
  const missing = [];
  let realRoot;
  while (!realRoot) {
    try { realRoot = fs.realpathSync(existing); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const canonicalDataRoot = path.resolve(realRoot, ...missing);
  const scope = crypto.createHash('sha256').update(`${canonicalDataRoot}\0${String(sessionId)}`).digest('hex');
  return withSessionLock(`dependency-${scope}`, path.join(root, 'stop-that-shit-coordination'), callback);
}

function cleanupCreatedHandoffs() {
  for (const file of createdHandoffs) {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isSymbolicLink() && stat.isFile()) fs.unlinkSync(file);
    } catch {}
  }
  createdHandoffs.clear();
}

module.exports = { bindingForRecord, createHandoff, consumeHandoff, discardHandoff, handoffAvailable,
  validMetadata, withCoordinationLock, cleanupCreatedHandoffs };
