'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decide } = require('../src/decision.cjs');
const adapters = {
  claude: (path, content) => require('../src/adapters/claude-tool-classifier.cjs').analyzeClaudeTool('Write', { file_path: path, content }),
  opencode: (path, content) => require('../src/adapters/opencode-tool-classifier.cjs').analyzeOpenCodeTool('write', { filePath: path, content }),
  hermes: (path, content) => require('../src/adapters/hermes-tool-classifier.cjs').analyzeHermesTool('write_file', { path, content }),
  pi: (path, content) => require('../src/adapters/pi-tool-classifier.cjs').analyzePiTool('write', { path, content })
};
const edits = {
  claude: (path, oldText, newText) => require('../src/adapters/claude-tool-classifier.cjs').detectDependencyIntent('Edit', { file_path: path, old_string: oldText, new_string: newText }),
  opencode: (path, oldText, newText) => require('../src/adapters/opencode-tool-classifier.cjs').detectDependencyIntent('edit', { filePath: path, oldString: oldText, newString: newText }),
  hermes: (path, oldText, newText) => require('../src/adapters/hermes-tool-classifier.cjs').detectDependencyIntent('patch', { path, old_string: oldText, new_string: newText }),
  pi: (path, oldText, newText) => require('../src/adapters/pi-tool-classifier.cjs').detectDependencyIntent('edit', { path, oldText, newText })
};

for (const [host, edit] of Object.entries(edits)) {
  test(`${host}: equivalent Cargo table spelling does not introduce dependencies`, () => {
    for (const suffix of ['', '\nversion = "1"']) {
      const old = '[dependencies.serde]' + suffix;
      for (const header of ['[ dependencies . serde ]', '["dependencies"."serde"]', "['dependencies'.'serde']"]) {
        assert.equal(edit('Cargo.toml', old, header + suffix), false, header);
      }
      assert.equal(edit('Cargo.toml', old, '["dependencies"."regex"]' + suffix), true);
    }
  });
  test(`${host}: Cargo dependency table identities survive fragment comparison`, () => {
    const oldHeader = '[dependencies.serde]';
    const newHeader = '[dependencies.regex]';
    for (const suffix of ['', '\nversion = "1"']) {
      const dependencyIntent = edit('Cargo.toml', oldHeader + suffix, newHeader + suffix);
      assert.equal(dependencyIntent, true, 'changing the dependency name introduces a package');
      const action = { mutability: 'write', dependencyIntent };
      assert.equal(decide({ contract: { mode: 'change', level: 'guard', dependencyPolicy: 'deny' }, action }).reasonCode, 'DEPENDENCY_NOT_AUTHORIZED');
      assert.equal(decide({ contract: { mode: 'change', level: 'guard', dependencyPolicy: 'allow' }, action }).outcome, 'allow');
      assert.equal(edit('Cargo.toml', oldHeader + suffix, oldHeader + suffix), false);
      assert.equal(edit('Cargo.toml', oldHeader + suffix, ''), false);
    }
  });
  test(`${host}: dependency section promotion is detected while metadata edits and removals continue`, () => {
    for (const [file, metadata, dependencies, entry] of [
      ['pyproject.toml', '[tool.private-metadata]', '[tool.poetry.dependencies]', 'requests = "2.32.0"'],
      ['Cargo.toml', '[package.metadata]', '[dependencies]', 'serde = "1"']
    ]) {
      const old = `${metadata}\n${entry}\n${dependencies}\n`;
      const moved = `${metadata}\n${dependencies}\n${entry}\n`;
      assert.equal(edit(file, old, moved), true);
      assert.equal(edit(file, metadata, dependencies), true);
      assert.equal(edit(file, `${metadata} # packages`, `${dependencies} # packages`), true);
      assert.equal(edit(file, `${metadata}\n# packages`, `${dependencies}\n# packages`), true);
      assert.equal(edit(file, moved, old), false);
      assert.equal(edit(file, moved, `${moved}# comment`), false);
      assert.equal(edit(file, '', dependencies), false, 'an empty dependency table adds no package');
    }
  });
  test(`${host}: deleting the last JSON dependency preserves the remaining declaration`, () => {
    for (const [file, field] of [['package.json', 'dependencies'], ['composer.json', 'require']]) {
      const old = { [field]: { a: '1', b: '2' } }, next = { [field]: { a: '1' } };
      for (const indent of [undefined, 2]) {
        assert.equal(edit(file, JSON.stringify(old, null, indent), JSON.stringify(next, null, indent)), false);
        assert.equal(edit(file, JSON.stringify(next, null, indent), JSON.stringify(old, null, indent)), true);
      }
      assert.equal(edit(file, `"${field}": {\n  "a": "1",\n  "b": "2"\n}`, `"${field}": {\n  "a": "1"\n}`), false);
    }
  });
  test(`${host}: JSON value fragments retain version hints without blocking removals`, () => {
    for (const file of ['package.json', 'composer.json']) {
      const before = JSON.stringify({ a: '^1' });
      const after = JSON.stringify({ a: '^1', b: '^2' });
      assert.equal(edit(file, before, after), true);
      assert.equal(edit(file, after, before), false);
      assert.equal(edit(file, after, after), false);
      assert.equal(edit(file, '{"dependencies":{"a":"^1"}}', '{"dependencies":{}}'), false);
    }
  });
  test(`${host}: replacements preserve context while ignoring unchanged and removed dependencies`, () => {
    assert.equal(edit('requirements.txt', 'requests\nurllib3', 'requests'), false);
    assert.equal(edit('requirements.txt', 'requests', 'requests\nurllib3'), true);
    for (const [file, line] of [['package.json', '"demo": "^1.0.0"'], ['pyproject.toml', '"requests>=2"'], ['Cargo.toml', 'serde = "^1"']]) {
      assert.equal(edit(file, '', line), true, file);
      assert.equal(edit(file, line, ''), false, file);
      assert.equal(edit(file, line, line), false, file);
    }
  });
}

for (const [host, analyze] of Object.entries(adapters)) {
  test(`${host}: manifest declarations and nearest metadata/comment cases agree`, () => {
    for (const [path, bad, good] of [
      ['requirements.txt', 'requests\n', '# requests\n'],
      ['Cargo.toml', '[dependencies]\nserde = "1"\n', '[package]\nname = "demo"\n'],
      ['go.mod', 'require example.org/demo v1.0.0\n', 'module example.org/demo\ngo 1.23\n'],
      ['composer.json', '{"require":{"vendor/demo":"1"}}', '{"name":"vendor/demo"}'],
      ['Gemfile', 'gem "rake"', '# gem "rake"']
    ]) {
      assert.equal(analyze(path, bad).dependencyIntent, true, `${host}: ${path} addition`);
      assert.equal(analyze(path, good).dependencyIntent, false, `${host}: ${path} metadata`);
      const contract = { mode: 'change', level: 'guard', dependencyPolicy: 'deny' };
      assert.equal(decide({ contract, action: analyze(path, bad) }).outcome, 'deny_and_explain');
      assert.equal(decide({ contract, action: analyze(path, good) }).outcome, 'allow');
      assert.equal(decide({ contract: { ...contract, dependencyPolicy: 'allow' }, action: analyze(path, bad) }).outcome, 'allow');
    }
  });
}

for (const host of ['codex', 'opencode', 'hermes']) {
  test(`${host}: a patch rename compares declarations at both file paths`, () => {
    const classifier = require(`../src/adapters/${host}-tool-classifier.cjs`);
    const detect = (source, target) => {
      const patch = `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${target}\n@@\n {"dependencies":{"demo":"1"}}\n*** End Patch`;
      return classifier.detectDependencyIntent(host === 'hermes' ? 'patch' : 'apply_patch', host === 'hermes' ? { mode: 'patch', patch } : host === 'opencode' ? { patchText: patch } : { patch });
    };
    assert.equal(detect('manifest.txt', 'package.json'), true);
    assert.equal(detect('package.json', 'manifest.txt'), false);
    assert.equal(detect('package.json', 'config/package.json'), false);
  });
  test(`${host}: moving a manifest keeps dependency additions visible`, () => {
    const classifier = require(`../src/adapters/${host}-tool-classifier.cjs`);
    const detect = (body) => {
      const patch = `*** Begin Patch\n*** Update File: package.json\n*** Move to: config/package.json\n@@\n {\n${body}\n }\n*** End Patch`;
      return classifier.detectDependencyIntent(host === 'hermes' ? 'patch' : 'apply_patch', host === 'hermes' ? { mode: 'patch', patch } : host === 'opencode' ? { patchText: patch } : { patch });
    };
    const dependencyIntent = detect('+"dependencies": {"demo":"1"}');
    assert.equal(dependencyIntent, true);
    const contract = { mode: 'change', level: 'guard', dependencyPolicy: 'deny' };
    assert.equal(decide({ contract, action: { mutability: 'write', dependencyIntent } }).reasonCode, 'DEPENDENCY_NOT_AUTHORIZED');
    assert.equal(decide({ contract: { ...contract, dependencyPolicy: 'allow' }, action: { mutability: 'write', dependencyIntent } }).outcome, 'allow');
    assert.equal(detect(' "dependencies": {"demo":"1"}'), false, 'a move with unchanged dependencies can continue');
    assert.equal(detect('-"dependencies": {"demo":"1"}'), false, 'removing dependencies during a move can continue');
  });
  test(`${host}: patch context identifies declarations without treating unchanged dependencies as additions`, () => {
    const classifier = require(`../src/adapters/${host}-tool-classifier.cjs`);
    const detect = (body) => {
      const patch = `*** Begin Patch\n*** Update File: Cargo.toml\n@@\n [dependencies]\n serde = "1"\n${body}\n*** End Patch`;
      return classifier.detectDependencyIntent(host === 'hermes' ? 'patch' : 'apply_patch', host === 'hermes' ? { mode: 'patch', patch } : host === 'opencode' ? { patchText: patch } : { patch });
    };
    assert.equal(detect('+tokio = "1"'), true);
    assert.equal(detect('+# comment only'), false);
    assert.equal(detect('-tokio = "1"'), false);
  });
  test(`${host}: patches detect a promoted dependency section`, () => {
    const classifier = require(`../src/adapters/${host}-tool-classifier.cjs`);
    const detect = (oldHeader, newHeader) => {
      const patch = `*** Begin Patch\n*** Update File: Cargo.toml\n@@\n-${oldHeader}\n+${newHeader}\n serde = "1"\n*** End Patch`;
      return classifier.detectDependencyIntent(host === 'hermes' ? 'patch' : 'apply_patch', host === 'hermes' ? { mode: 'patch', patch } : host === 'opencode' ? { patchText: patch } : { patch });
    };
    assert.equal(detect('[package.metadata]', '[dependencies]'), true);
    assert.equal(detect('[dependencies]', '[package.metadata]'), false);
  });
}
