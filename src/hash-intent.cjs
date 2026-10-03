'use strict';

const { analyzeShell } = require('./shell-analysis.cjs');

const CODE_PATH = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|php|rb|c|cc|cpp|h|hpp)$/i;
const HASH_API = /\b(?:createHash|createHmac)\s*\(|\bcrypto\.subtle\.digest\s*\(|\bhashlib\.(?:md5|sha1|sha224|sha256|sha384|sha512|blake2[bs])\s*\(|\bMessageDigest\.getInstance\s*\(|\bDigestUtils\.[A-Za-z0-9_]+\s*\(|\bsha(?:1|256|512)\.(?:New|Sum\w*)\s*\(|\b(?:bcrypt|argon2)\.hash\s*\(|\bpassword_hash\s*\(|\bPasswordHasher\s*\(/i;

function containsHashApi(text) {
  return HASH_API.test(String(text || ''));
}

function fileHashIntent(filePath, content) {
  return CODE_PATH.test(String(filePath || '')) && containsHashApi(content);
}

function patchHashIntent(patch) {
  const added = String(patch || '').split(/\r?\n/)
    .filter((line) => /^\+(?!\+\+)/.test(line)).join('\n');
  return containsHashApi(added);
}

// Preserve the original tool-input API for callers using these common shapes.
// Native adapters can pass file content or patches directly to the helpers.
function detectHashIntent(toolName, toolInput) {
  const name = String(toolName || '');
  const text = typeof toolInput === 'string' ? toolInput
    : toolInput && typeof toolInput === 'object'
      ? String(toolInput.command || toolInput.patch || toolInput.content || toolInput.new_string || '')
      : '';
  if (!text) return false;
  if (name === 'Bash' || name === 'exec_command' || name === 'shell_command') {
    return analyzeShell(text).hashIntent;
  }
  if (name === 'apply_patch') return patchHashIntent(text);
  if (name === 'Edit' || name === 'Write') {
    return fileHashIntent(toolInput && (toolInput.file_path || toolInput.path), text);
  }
  return false;
}

module.exports = { containsHashApi, fileHashIntent, patchHashIntent, detectHashIntent };
