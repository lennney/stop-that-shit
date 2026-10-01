'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { appendJsonl, readJsonl, runtimeRoot } = require('./runtime-storage.cjs');

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

function readAnnotations(options = {}) {
  const parsed = readJsonl(annotationsPath(options));
  const records = parsed.records.filter(record => record && record.schemaVersion === 1
    && typeof record.eventId === 'string' && /^evt_[0-9a-f-]+$/i.test(record.eventId)
    && typeof record.occurredAt === 'string' && Number.isFinite(Date.parse(record.occurredAt))
    && LABELS.has(record.label));
  return { records, damaged: parsed.damaged + parsed.records.length - records.length };
}

module.exports = { LABELS, readAnnotations, recordAnnotation };
