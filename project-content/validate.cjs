'use strict';

const assert = require('node:assert/strict');
const locales = ['zh', 'en', 'ko'];
const text = (value, label) => assert.ok(typeof value === 'string' && value.trim(), `${label} must be nonempty text`);

function validateContent(content) {
  assert.equal(content.schemaVersion, 1, 'Unsupported STS content schema');
  assert.equal(content.id, 'stop-that-shit');
  assert.equal(content.repositoryUrl, 'https://github.com/lennney/stop-that-shit');
  assert.match(content.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(Date.parse(content.reviewedAt)), 'Invalid review date');
  assert.match(content.release.version, /^\d+\.\d+\.\d+$/, 'Use a stable release version');
  assert.ok([content.release.version, `v${content.release.version}`].includes(content.release.tag), 'Tag must match the stable version');
  assert.match(content.release.commit, /^[a-f0-9]{40}$/, 'Pin the released commit');
  assert.ok(Number.isFinite(Date.parse(content.release.publishedAt)), 'Invalid publication date');
  assert.ok(Array.isArray(content.evidence) && content.evidence.includes('INSTALL.md') && content.evidence.includes('EVIDENCE.md'));
  assert.ok(content.evidence.every(path => typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..')));
  assert.ok(Array.isArray(content.hosts) && content.hosts.length > 0);
  assert.equal(new Set(content.hosts.map(host => host.id)).size, content.hosts.length, 'Duplicate Host IDs');
  for (const host of content.hosts) {
    assert.match(host.id, /^[a-z][a-z-]*$/);
    text(host.name, 'Host name');
    text(host.adapter, 'Host adapter');
  }
  assert.deepEqual(Object.keys(content.locales).sort(), [...locales].sort(), 'Require all supported content languages');
  for (const locale of locales) {
    const copy = content.locales[locale];
    for (const field of ['shortDescription', 'description', 'metaTitle', 'metaDescription', 'tagline', 'requirements', 'hostsTitle', 'stss', 'guardCaption', 'limitations', 'installationDescription', 'installationNote']) text(copy[field], `${locale}.${field}`);
    assert.ok(copy.hostsTitle.includes('{count}'), 'Derive the Host count');
    for (const field of ['title', 'description', 'decision']) text(copy.ladder[field], `${locale}.ladder.${field}`);
    assert.ok(Array.isArray(copy.ladder.questions) && copy.ladder.questions.length > 0);
    copy.ladder.questions.forEach(value => text(value, 'Stop Ladder step'));
    assert.ok(Array.isArray(copy.faq));
    if (locale !== 'ko') assert.ok(copy.faq.length > 0, `${locale} FAQ is required`);
    for (const item of copy.faq) {
      text(item.question, 'FAQ question');
      assert.ok(['start', 'boundaries', 'source'].includes(item.group));
      assert.equal(Boolean(item.answer) + Boolean(item.answerKey), 1, 'FAQ needs one answer or answerKey');
      if (item.answerKey) assert.ok(['description', 'stss', 'limitations'].includes(item.answerKey));
      else text(item.answer, 'FAQ answer');
    }
  }
  return content;
}

function validateRelease(content, proof) {
  assert.equal(proof.draft, false, 'Do not publish a draft release');
  assert.equal(proof.prerelease, false, 'Do not publish a prerelease as stable');
  assert.equal(proof.tag_name, content.release.tag, 'Content does not describe the latest stable release');
  assert.equal(proof.commit, content.release.commit, 'The released commit differs from the reviewed baseline');
  assert.equal(proof.published_at, content.release.publishedAt, 'Release publication date differs');
  assert.equal(proof.html_url, `${content.repositoryUrl}/releases/tag/${content.release.tag}`);
}

module.exports = { validateContent, validateRelease };
