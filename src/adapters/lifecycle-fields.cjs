'use strict';

const ASYNC_FIELDS = [
  'async_launched',
  'asyncLaunched',
  'run_in_background',
  'runInBackground',
  'background'
];

function readAsyncLaunched(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of ASYNC_FIELDS) {
      if (typeof source[field] === 'boolean') return source[field];
    }
  }
  return null;
}

function optionalIdentifier(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || null;
}

module.exports = { optionalIdentifier, readAsyncLaunched };
