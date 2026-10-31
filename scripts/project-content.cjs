'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateContent, validateRelease } = require('../project-content/validate.cjs');
const root = path.resolve(__dirname, '..');
const content = validateContent(JSON.parse(fs.readFileSync(path.join(root, 'project-content/stable.json'), 'utf8')));
validateRelease(content, JSON.parse(fs.readFileSync(path.join(root, 'project-content/release-proof.json'), 'utf8')));
const start = '<!-- sts:stable-summary:start -->';
const end = '<!-- sts:stable-summary:end -->';
const hosts = content.hosts.map(host => host.name).join(' · ');
let stale = false;
for (const [locale, file] of [['zh', 'README.md'], ['en', 'README_EN.md'], ['ko', 'README_KO.md']]) {
  const target = path.join(root, file);
  const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  const label = { zh: '正式版', en: 'Stable release', ko: '안정 릴리스' }[locale];
  const block = `${start}\n  <strong>${label} ${content.release.version}</strong> — ${content.locales[locale].shortDescription}<br>\n  ${hosts}<br>\n${end}`;
  if (!source.includes(start) || !source.includes(end)) throw new Error(`Missing summary markers in ${file}`);
  let updated = source.slice(0, source.indexOf(start)) + block + source.slice(source.indexOf(end) + end.length);
  if (locale === 'ko') {
    const ladderStart = '<!-- sts:stable-ladder:start -->';
    const ladderEnd = '<!-- sts:stable-ladder:end -->';
    if (!updated.includes(ladderStart) || !updated.includes(ladderEnd)) throw new Error(`Missing ladder markers in ${file}`);
    const ladder = content.locales.ko.ladder;
    const rendered = `${ladderStart}\n**Skill** — ${ladder.description}\n\n${ladder.questions.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n${ladderEnd}`;
    updated = updated.slice(0, updated.indexOf(ladderStart)) + rendered + updated.slice(updated.indexOf(ladderEnd) + ladderEnd.length);
  }
  if (source === updated) continue;
  if (process.argv.includes('--write')) fs.writeFileSync(target, updated);
  else { console.error(`${file} is stale; run npm run content:build`); stale = true; }
}
if (stale) process.exitCode = 1;
else console.log(`PASS reviewed project content and README summaries (${content.release.tag})`);
