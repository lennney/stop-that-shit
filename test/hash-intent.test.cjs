'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const codex = require('../src/adapters/codex-tool-classifier.cjs');
const claude = require('../src/adapters/claude-tool-classifier.cjs');
const hermes = require('../src/adapters/hermes-tool-classifier.cjs');
const opencode = require('../src/adapters/opencode-tool-classifier.cjs');
const pi = require('../src/adapters/pi-tool-classifier.cjs');
const omp = require('../src/adapters/omp-tool-classifier.cjs');

const writes = {
  codex: (path, content) => codex.analyzeCodexTool('Write', { file_path: path, content }),
  claude: (path, content) => claude.analyzeClaudeTool('Write', { file_path: path, content }),
  hermes: (path, content) => hermes.analyzeHermesTool('write_file', { path, content }),
  opencode: (path, content) => opencode.analyzeOpenCodeTool('write', { filePath: path, content }),
  pi: (path, content) => pi.analyzePiTool('write', { path, content }),
  omp: (path, content) => omp.classifyOmpAction('write', { path, content })
};

const hashCalls = [
  'createHash("sha256")', 'createHmac("sha256", key)', 'crypto.subtle.digest("SHA-256", data)',
  'hashlib.sha256(data)', 'MessageDigest.getInstance("SHA-256")', 'DigestUtils.sha256Hex(data)',
  'sha256.Sum256(data)', 'bcrypt.hash(password)', 'argon2.hash(password)',
  'password_hash(password, algorithm)', 'PasswordHasher()'
];

for (const content of hashCalls) {
  test(`source hash intent agrees across host writes: ${content}`, () => {
    for (const [host, analyze] of Object.entries(writes)) {
      assert.equal(analyze('src/sample.cjs', content).hashIntent, true, host);
      assert.equal(analyze('docs/example.md', content).hashIntent, false, host);
      assert.equal(analyze('src/sample.cjs', 'module.exports = value;').hashIntent, false, host);
    }
  });
}

test('patch hash intent distinguishes added code from removed or context lines', () => {
  const patches = {
    codex: patch => codex.analyzeCodexTool('apply_patch', { patch }),
    hermes: patch => hermes.analyzeHermesTool('patch', { mode: 'patch', patch }),
    opencode: patchText => opencode.analyzeOpenCodeTool('apply_patch', { patchText })
  };
  for (const [host, analyze] of Object.entries(patches)) {
    for (const [line, expected] of [
      ['+createHash("sha256")', true], ['-createHash("sha256")', false],
      [' createHash("sha256")', false], ['+++createHash("sha256")', false]
    ]) {
      assert.equal(analyze(`*** Update File: src/sample.cjs\n${line}`).hashIntent, expected, host);
    }
  }
});

test('host-specific edit fields and notebook behavior retain their meaning', () => {
  const code = 'createHash("sha256")';
  assert.equal(codex.detectHashIntent('Edit', { file_path: 'a.js', new_string: code }), true);
  assert.equal(codex.detectHashIntent('Write', { file_path: 'a.js', content: 'plain', new_string: code }), false);
  assert.equal(claude.detectHashIntent('NotebookEdit', { new_source: code }), true);
  assert.equal(claude.detectHashIntent('NotebookEdit', { content: 'plain', new_source: code }), false);
  assert.equal(hermes.detectHashIntent('patch', { path: 'a.js', old_string: 'plain', new_string: code }), true);
  assert.equal(opencode.detectHashIntent('edit', { filePath: 'a.js', newString: code }), true);
  assert.equal(pi.detectHashIntent('edit', { path: 'a.js', edits: [{ newText: 'plain' }, { newText: code }] }), true);
  const anchored = `*** Edit File: a.js\n*** Find\nplain\n*** Replace\n${code}`;
  assert.equal(omp.classifyOmpAction('edit', { input: anchored }).hashIntent, true);
  assert.equal(omp.classifyOmpAction('edit', { input: anchored.replace('a.js', 'a.md') }).hashIntent, false);
});
