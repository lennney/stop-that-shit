'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { appendJsonl, scanJsonl, runtimeRoot } = require('./runtime-storage.cjs');

const LABELS = new Set(['correct', 'incorrect', 'inconclusive']);

function annotationsPath(options = {}) {
  return path.join(runtimeRoot(options), 'annotations.jsonl');
}

function recordAnnotation(eventId, label, options = {}) {
  if (typeof eventId !== 'string' || !/^evt_[0-9a-f-]+$/i.test(eventId)) {
    throw new TypeError('annotation requires a valid event ID');
  }
  if (!LABELS.has(label)) {
    throw new TypeError(`unsupported annotation label: ${label}`);
  }
  const annotation = {
    schemaVersion: 1,
    annotationId: `ann_${crypto.randomUUID()}`,
    occurredAt: (options.now ? options.now() : new Date()).toISOString(),
    eventId,
    label
  };
  try {
    appendJsonl(annotationsPath(options), annotation);
    return annotation;
  } catch {
    return null;
  }
}

function isAnnotation(record) {
  return record && record.schemaVersion === 1
    && typeof record.eventId === 'string' && /^evt_[0-9a-f-]+$/i.test(record.eventId)
    && typeof record.occurredAt === 'string' && Number.isFinite(Date.parse(record.occurredAt))
    && LABELS.has(record.label);
}

function readAnnotations(options = {}, eventIds) {
  const records = [];
  let damaged = 0;
  const parsed = scanJsonl(annotationsPath(options), record => {
    if (!isAnnotation(record)) damaged += 1;
    else if (!eventIds || eventIds.has(record.eventId)) records.push(record);
  });
  return { records, damaged: damaged + parsed.damaged };
}

module.exports = { LABELS, readAnnotations, recordAnnotation };
