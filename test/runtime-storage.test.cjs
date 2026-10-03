'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readJsonl, scanJsonl } = require('../src/runtime-storage.cjs');

function logFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-jsonl-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'events.jsonl');
}

test('JSONL reads preserve values, line endings, blank lines, and damage counts', t => {
  const file = logFile(t);
  assert.deepEqual(readJsonl(file), { records: [], damaged: 0 });
  fs.writeFileSync(file, '\r\n  \t\n{"id":1}\r\nnull\nfalse\n42\n["value"]\n{broken}\n{"id":2}');
  assert.deepEqual(readJsonl(file), {
    records: [{ id: 1 }, null, false, 42, ['value'], { id: 2 }], damaged: 1
  });
  fs.writeFileSync(file, '');
  assert.deepEqual(readJsonl(file), { records: [], damaged: 0 });
});

test('JSONL reads retain long records and UTF-8 characters across read boundaries', t => {
  const file = logFile(t);
  // The first multibyte character starts at byte 65535, across a 64 KiB read.
  const first = { text: 'x'.repeat(65535 - Buffer.byteLength('{"text":"')) + '中文😀' };
  const second = { text: 'long '.repeat(60000) };
  fs.writeFileSync(file, `${JSON.stringify(first)}\r\n${JSON.stringify(second)}\n{unfinished`);
  assert.deepEqual(readJsonl(file), { records: [first, second], damaged: 1 });
});

test('JSONL scanning closes the file and propagates consumer failures', t => {
  const file = logFile(t);
  fs.writeFileSync(file, '{"id":1}\n{broken}\n{"id":2}\n');
  const records = [];
  assert.deepEqual(scanJsonl(file, record => records.push(record)), { damaged: 1 });
  assert.deepEqual(records, [{ id: 1 }, { id: 2 }]);

  const close = t.mock.method(fs, 'closeSync');
  const failure = new SyntaxError('consumer failure');
  assert.throws(() => scanJsonl(file, () => { throw failure; }), error => error === failure);
  assert.equal(close.mock.callCount(), 1);
});

test('JSONL scanning closes the file on read errors without treating them as log damage', t => {
  const file = logFile(t);
  fs.writeFileSync(file, '{"id":1}\n');
  const close = t.mock.method(fs, 'closeSync');
  const failure = Object.assign(new Error('read failure'), { code: 'EIO' });
  t.mock.method(fs, 'readSync', () => { throw failure; });
  assert.throws(() => scanJsonl(file, () => assert.fail('no record was read')), error => error === failure);
  assert.equal(close.mock.callCount(), 1);
});
