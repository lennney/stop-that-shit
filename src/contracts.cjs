'use strict';

const MODES = new Set(['answer', 'review', 'change', 'monitor', 'open']);
const LEVELS = new Set(['watch', 'guard', 'lock', 'off']);
const HASH_POLICIES = new Set(['deny', 'ask', 'allow']);
const SCOPE_POLICIES = new Set(['deny', 'ask', 'allow']);

function defaultContract() {
  return {
    mode: 'unconfirmed',
    level: 'watch',
    agentBudget: 0,
    agentsUsed: 0,
    hashPolicy: 'deny',
    allowedPaths: null,
    dependencyPolicy: 'ask',
    source: 'default'
  };
}

function directiveHead(prompt, matchEnd) {
  const tail = prompt.slice(matchEnd).trimStart();
  const boundaries = [tail.indexOf('--'), tail.search(/:(?=\s|$)/), tail.indexOf('\n')]
    .filter((index) => index >= 0);
  const end = boundaries.length ? Math.min(...boundaries) : Math.min(tail.length, 80);
  return tail.slice(0, end).trim();
}

function parseDirective(prompt) {
  const mention = /\$stop-that-shit\b/i.exec(prompt);
  if (!mention) return null;

  const head = directiveHead(prompt, mention.index + mention[0].length);
  const tokens = head.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean);
  const parsed = { mentioned: true };

  for (const rawToken of tokens) {
    const token = rawToken.toLowerCase();
    if (MODES.has(token)) parsed.mode = token;
    if (LEVELS.has(token)) parsed.level = token;
    const agents = /^agents=(\d+)$/.exec(token);
    if (agents) parsed.agentBudget = Math.min(Number(agents[1]), 8);
    const hash = /^hash=(deny|ask|allow)$/.exec(token);
    if (hash && HASH_POLICIES.has(hash[1])) parsed.hashPolicy = hash[1];
    const files = /^files=(.*)$/i.exec(rawToken);
    if (files) parsed.allowedPaths = files[1].split('|').map((value) => value.replace(/\\/g, '/')).filter(Boolean);
    const dependencies = /^deps=(deny|ask|allow)$/.exec(token);
    if (dependencies && SCOPE_POLICIES.has(dependencies[1])) parsed.dependencyPolicy = dependencies[1];
  }

  return parsed;
}

function naturalCorrection(prompt, previous) {
  const text = prompt.trim();

  if (/^(?:stop|stop now|停止|停下来)[.!。！\s]*$/i.test(text)) {
    return { mode: 'answer', source: 'explicit-stop' };
  }
  if (/\breview only\b|\b(?:do not|don't) (?:edit|change|fix) (?:anything|the (?:repo|repository|files?|code))\b|只审查|只看不改|不要修改(?:任何|代码|文件)/i.test(text)) {
    return { mode: 'review', source: 'natural-explicit' };
  }
  if (/\banswer only\b|只回答/i.test(text)) {
    return { mode: 'answer', source: 'natural-explicit' };
  }
  if (/\bmonitor only\b|只监控|只观察/i.test(text)) {
    return { mode: 'monitor', source: 'natural-explicit' };
  }

  const wasNonMutating = ['answer', 'review', 'monitor'].includes(previous.mode);
  const explicitChange = /^(?:please\s+)?(?:fix|implement|change|apply|patch)\b|^(?:请)?(?:修复|修改|实现|应用补丁)|^把.+(?:修复|修改|改掉)/i.test(text);
  if (wasNonMutating && explicitChange) {
    return { mode: 'change', source: 'natural-explicit' };
  }

  return null;
}

function parseContractPrompt(prompt, previousContract = defaultContract()) {
  const previous = { ...defaultContract(), ...previousContract };
  const directive = parseDirective(String(prompt || ''));
  const correction = naturalCorrection(String(prompt || ''), previous);
  const next = { ...previous };
  let changed = false;

  if (directive) {
    if (directive.mode && directive.mode !== next.mode) {
      next.mode = directive.mode;
      next.agentsUsed = 0;
      changed = true;
    }
    if (directive.level && directive.level !== next.level) {
      next.level = directive.level;
      changed = true;
    }
    if (Number.isInteger(directive.agentBudget) && directive.agentBudget !== next.agentBudget) {
      next.agentBudget = directive.agentBudget;
      next.agentsUsed = 0;
      changed = true;
    }
    if (directive.hashPolicy && directive.hashPolicy !== next.hashPolicy) {
      next.hashPolicy = directive.hashPolicy;
      changed = true;
    }
    if (Array.isArray(directive.allowedPaths)) {
      next.allowedPaths = directive.allowedPaths;
      changed = true;
    }
    if (directive.dependencyPolicy && directive.dependencyPolicy !== next.dependencyPolicy) {
      next.dependencyPolicy = directive.dependencyPolicy;
      changed = true;
    }
    if (directive.mode && !directive.level && next.level === 'watch') {
      next.level = 'guard';
      changed = true;
    }
    if (directive.level === 'off') {
      next.level = 'off';
    }
    next.source = 'directive';
  } else if (correction) {
    if (correction.mode !== next.mode) {
      next.mode = correction.mode;
      next.agentsUsed = 0;
      changed = true;
    }
    if (next.level === 'watch') {
      next.level = 'guard';
      changed = true;
    }
    next.source = correction.source;
  }

  if (next.mode === 'unconfirmed' && next.level !== 'off') {
    next.level = 'watch';
  }

  return { contract: next, changed, directive: Boolean(directive), correction: Boolean(correction) };
}

module.exports = {
  HASH_POLICIES,
  SCOPE_POLICIES,
  LEVELS,
  MODES,
  defaultContract,
  parseContractPrompt
};
