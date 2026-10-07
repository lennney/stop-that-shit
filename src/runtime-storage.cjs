'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { dataRoot } = require('./state.cjs');

function runtimeRoot(options = {}) {
  const root = options.dataDir || process.env.STS_RUNTIME_DATA || dataRoot();
  return path.join(root, 'runtime');
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function scanJsonl(file, onRecord) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { damaged: 0 };
    throw error;
  }

  let damaged = 0;
  function visitLine(line) {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      damaged += 1;
      return;
    }
    // Consumer failures are not malformed JSON and must reach the caller.
    onRecord(record);
  }

  try {
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      pending += bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
      let start = 0;
      let end;
      while ((end = pending.indexOf('\n', start)) !== -1) {
        visitLine(pending.slice(start, end));
        start = end + 1;
      }
      pending = pending.slice(start);
    } while (bytesRead);
    visitLine(pending);
  } finally {
    fs.closeSync(descriptor);
  }
  return { damaged };
}

function readJsonl(file) {
  const records = [];
  const { damaged } = scanJsonl(file, record => records.push(record));
  return { records, damaged };
}

module.exports = { appendJsonl, readJsonl, scanJsonl, runtimeRoot };
