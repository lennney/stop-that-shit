'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { directDependencyArguments } = require('./shell-analysis.cjs');
const { resolveManager } = require('./dependency-manager.cjs');
const { validMetadata } = require('./dependency-handoff.cjs');
const { decide } = require('./decision.cjs');
const { inspectDelegation } = require('./delegation-state.cjs');

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const PERMIT_TTL_MS = 10 * 60 * 1000;
const YES = 'Allow this operation once';
const NO = 'Deny this operation';
const PROPOSAL_PREFIX = 'Allow this controlled child operation once';
const SYNC_HEADER = 'Approval';
const YES_DESCRIPTION = 'Authorize this operation once.';
const NO_DESCRIPTION = 'Do not authorize this operation.';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(event) {
  const action = event.action;
  if (!action || !['Bash', 'exec_command', 'shell_command'].includes(action.name)
      || !action.id || Buffer.byteLength(action.id, 'utf8') > 256
      || !action.cwd || !action.input || typeof action.input.command !== 'string') return null;
  if (!directDependencyArguments(action.input.command) || /[\r\n]/.test(action.input.command)) return null;
  const bound = { session: event.sessionId, tool: action.name, input: action.input, cwd: action.cwd };
  if (event.agent?.agentId) bound.agentId = event.agent.agentId;
  const canonicalBound = stable(bound);
  return crypto.createHash('sha256').update(JSON.stringify(canonicalBound)).digest('hex');
}

function newPending(event, eventId, now = Date.now(), scope = {}) {
  const actionDigest = digest(event);
  if (!actionDigest || !eventId) return null;
  const argv = directDependencyArguments(event.action.input.command);
  // Do not place likely credentials or arbitrary environment fields in a user-visible question.
  if (Object.keys(event.action.input).some(key => key !== 'command')
      || argv.some(value => /(?:https?:|password|token|secret|api[_-]?key|authorization)/i.test(value))) return null;
  const manager = resolveManager(argv[0]);
  if (!manager) return null;
  const proposalExpires = now + PROPOSAL_TTL_MS;
  const questionPrefix = `${PROPOSAL_PREFIX}. Reply by ${new Date(proposalExpires).toISOString()}; if allowed, run once within 10 minutes after your reply: ${JSON.stringify(argv)} using ${JSON.stringify(manager.launchPath || manager.entry.path)} (${eventId}) in directory: `;
  if (Buffer.byteLength(questionPrefix, 'utf8') > 8192) return null;
  const record = { digest: actionDigest, eventId, questionPrefix, argv, manager,
    deniedActionId: event.action.id, expires: proposalExpires, proposalExpires, status: 'pending' };
  record.proposedAction = {
    mutability: event.action.mutability || 'unknown',
    analysisReason: event.action.analysisReason || null,
    hashIntent: Boolean(event.action.hashIntent),
    reachability: event.action.reachability || null,
    authorization: event.action.authorization || null,
    affectedPaths: Array.isArray(event.action.affectedPaths) ? event.action.affectedPaths.slice(0, 128) : [],
    cwd: event.action.cwd,
    unboundedDelegation: Boolean(event.action.unboundedDelegation),
    delegationLifecycleUnproven: Boolean(event.action.delegationLifecycleUnproven)
  };
  if (scope.agentId) {
    if (typeof scope.agentId !== 'string' || !scope.agentId.trim() || Buffer.byteLength(scope.agentId, 'utf8') > 4096
        || !/^[a-f0-9]{64}$/.test(scope.policyDigest || '')) return null;
    record.scopeAgentId = scope.agentId;
    record.policyDigest = scope.policyDigest;
  }
  return record;
}

function live(record, now = Date.now()) {
  return record && typeof record === 'object'
    && /^[a-f0-9]{64}$/.test(record.digest || '')
    && /^evt_[0-9a-f-]{36}$/.test(record.eventId || '')
    && typeof record.questionPrefix === 'string' && Buffer.byteLength(record.questionPrefix, 'utf8') <= 8192
    && Array.isArray(record.argv) && record.argv.every(arg => typeof arg === 'string')
    && record.manager && ['node', 'native'].includes(record.manager.kind)
    && record.manager.entry && typeof record.manager.entry.path === 'string'
    && (record.manager.kind !== 'node' || record.manager.executable && typeof record.manager.executable.path === 'string')
    && (record.status === 'pending' || typeof record.question === 'string' && Buffer.byteLength(record.question, 'utf8') <= 8192)
    && (record.status === 'issued' ? validDecisionAction(record.approvedAction)
      : record.proposedAction === undefined || validDecisionAction(record.proposedAction))
    && typeof record.deniedActionId === 'string' && record.deniedActionId.length > 0
    && (record.status === 'pending' || typeof record.questionId === 'string'
      && typeof record.questionCallId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(record.questionCallId))
    && (record.questionToolName === undefined || ['request_user_input_async', 'request_user_input'].includes(record.questionToolName))
    && (record.questionToolName !== 'request_user_input' || typeof record.syncQuestionId === 'string'
      && /^[A-Za-z0-9_-]{1,256}$/.test(record.syncQuestionId)
      && /^[a-f0-9]{64}$/.test(record.syncQuestionDigest || '')
      && typeof record.syncRegistrationCwd === 'string' && path.isAbsolute(record.syncRegistrationCwd))
    && Number.isSafeInteger(record.proposalExpires) && Number.isSafeInteger(record.expires)
    && (record.scopeAgentId === undefined || typeof record.scopeAgentId === 'string'
      && record.scopeAgentId.trim() && Buffer.byteLength(record.scopeAgentId, 'utf8') <= 4096
      && /^[a-f0-9]{64}$/.test(record.policyDigest || ''))
    && (['pending', 'question'].includes(record.status) ? record.proposalExpires : record.expires) > now
    && ['pending', 'question', 'approved', 'issued', 'consumed'].includes(record.status)
    && (record.status !== 'issued' || validMetadata(record.handoff));
}

function validDecisionAction(action) {
  return action && typeof action === 'object' && !Array.isArray(action)
    && ['read', 'write', 'delegate', 'control', 'unknown'].includes(action.mutability)
    && (action.analysisReason === undefined || action.analysisReason === null || typeof action.analysisReason === 'string')
    && typeof action.hashIntent === 'boolean'
    && (action.reachability === undefined || action.reachability === null || ['reachable', 'unreachable'].includes(action.reachability))
    && (action.authorization === undefined || action.authorization === null || typeof action.authorization === 'string')
    && Array.isArray(action.affectedPaths) && action.affectedPaths.length <= 128
    && action.affectedPaths.every(value => typeof value === 'string' && value.length <= 8192)
    && typeof action.cwd === 'string' && path.isAbsolute(action.cwd)
    && (action.unboundedDelegation === undefined || typeof action.unboundedDelegation === 'boolean')
    && (action.delegationLifecycleUnproven === undefined || typeof action.delegationLifecycleUnproven === 'boolean');
}

function proposalStillAllowed(record, contract, state = {}) {
  if (!live(record) || contract?.mode !== 'change' || contract?.level !== 'guard'
      || contract?.dependencyPolicy !== 'ask') return false;
  const saved = record.status === 'issued' ? record.approvedAction : record.proposedAction;
  if (!validDecisionAction(saved)) return saved === undefined;
  const action = { ...saved, cwd: record.targetCwd || saved.cwd, dependencyIntent: false };
  try {
    const result = decide({ contract, action, state, delegation: inspectDelegation(state.delegation) });
    return result.outcome === 'allow';
  } catch { return false; }
}

function isProposalQuestion(action, record) {
  const questions = action.input?.questions;
  return Array.isArray(questions) && questions.some(question => {
    const text = action.name === 'request_user_input' ? question?.question : question?.title;
    return typeof text === 'string' && (text.startsWith(PROPOSAL_PREFIX)
      || record && typeof record.eventId === 'string' && text.includes(record.eventId));
  });
}

function isSyncOptions(options) {
  return Array.isArray(options) && options.length === 2
    && options.every((option, index) => option && typeof option === 'object' && !Array.isArray(option)
      && Object.keys(option).length === 2 && Object.hasOwn(option, 'label') && Object.hasOwn(option, 'description')
      && option.label === (index === 0 ? YES : NO)
      && option.description === (index === 0 ? YES_DESCRIPTION : NO_DESCRIPTION));
}

function isSyncQuestion(question) {
  return question && typeof question === 'object' && !Array.isArray(question)
    && typeof question.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(question.id)
    && question.header === SYNC_HEADER && typeof question.question === 'string'
    && Buffer.byteLength(question.question, 'utf8') <= 8192 && isSyncOptions(question.options)
    && Object.keys(question).sort().join(',') === 'header,id,options,question';
}

function syncQuestionDigest(question) {
  if (!isSyncQuestion(question)) return null;
  const canonical = {
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options.map(option => ({ label: option.label, description: option.description }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function registerQuestion(record, action) {
  if (!live(record) || record.status !== 'pending' || !action.id
      || !/^[A-Za-z0-9_-]{1,256}$/.test(action.id)
      || !['request_user_input_async', 'request_user_input'].includes(action.name)) return false;
  const questions = action.input?.questions;
  if (!Array.isArray(questions) || questions.length !== 1 || Object.keys(action.input).length !== 1) return false;
  const question = questions[0];
  let text;
  if (action.name === 'request_user_input_async') {
    if (typeof question?.title !== 'string'
        || JSON.stringify(question?.options) !== JSON.stringify([YES, NO])
        || Object.keys(question).some(key => !['title', 'options'].includes(key))) return false;
    text = question.title;
  } else {
    if (!isSyncQuestion(question)) return false;
    text = question.question;
  }
  if (!text.startsWith(record.questionPrefix) || !text.endsWith('?')) return false;
  const requested = text.slice(record.questionPrefix.length, -1);
  if (!path.isAbsolute(requested) || /[\x00-\x1f\x7f]/.test(requested)) return false;
  let actual;
  let registrationCwd = null;
  try {
    actual = fs.realpathSync(requested);
    if (!fs.statSync(actual).isDirectory()) return false;
    if (action.name === 'request_user_input') {
      if (typeof action.cwd !== 'string' || !path.isAbsolute(action.cwd)) return false;
      registrationCwd = fs.realpathSync(action.cwd);
      if (!fs.statSync(registrationCwd).isDirectory()) return false;
    }
  } catch { return false; }
  if (Buffer.byteLength(text, 'utf8') > 8192) return false;
  record.question = text;
  record.requestedCwd = requested;
  record.targetCwd = actual;
  record.questionCallId = action.id;
  record.questionToolName = action.name;
  record.questionId = action.name === 'request_user_input_async'
    ? JSON.stringify(['request_user_input_async', action.id, 0])
    : JSON.stringify(['request_user_input', action.id, question.id]);
  if (action.name === 'request_user_input') {
    record.syncQuestionId = question.id;
    record.syncQuestionDigest = syncQuestionDigest(question);
    record.syncRegistrationCwd = registrationCwd;
  }
  record.status = 'question';
  return true;
}

function hostQuestionText(question) {
  let used = 0;
  let result = '';
  for (const char of question) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > 512) break;
    used += size;
    result += char;
  }
  return result.replace(/[\r\n]/g, ' ');
}

function acceptReply(record, text, now = Date.now()) {
  if (record?.questionToolName === 'request_user_input') return null;
  const match = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[1]); } catch { return null; }
  if (!Array.isArray(data)) return null;
  const related = data.some(item => item && typeof item === 'object' && !Array.isArray(item)
    && (typeof item.question === 'string' && item.question.startsWith(PROPOSAL_PREFIX)
      || record && item.questionItemId === record.questionId));
  if (!related) return null;
  if (!live(record, now) || record.status !== 'question' || typeof record.questionId !== 'string') return { status: 'unavailable' };
  if (data.length > 32 || data.some(item => !item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'answer,question,questionItemId'
      || !['questionItemId', 'question', 'answer'].every(key => typeof item[key] === 'string'))) return { status: 'mismatch' };
  const matches = data.filter(item => item.questionItemId === record.questionId);
  if (matches.length !== 1 || data.some(item => item.questionItemId !== record.questionId && item.question.startsWith(PROPOSAL_PREFIX))) return { status: 'mismatch' };
  const item = matches[0];
  if (item.question !== record.question && item.question !== hostQuestionText(record.question)) return { status: 'mismatch' };
  if (item.answer === YES) {
    record.status = 'approved';
    record.expires = now + PERMIT_TTL_MS;
    return { status: 'approved', eventId: record.eventId, targetCwd: record.targetCwd };
  }
  if (item.answer === NO) {
    record.status = 'consumed';
    return { status: 'denied', eventId: record.eventId };
  }
  return { status: 'mismatch' };
}

function nativeQuestionMatches(record, action, now = Date.now()) {
  if (!live(record, now) || record.status !== 'question'
      || record.questionToolName !== 'request_user_input' || action?.name !== 'request_user_input'
      || action.id !== record.questionCallId || action.questionId !== record.syncQuestionId
      || action.questionDigest !== record.syncQuestionDigest
      || typeof action.cwd !== 'string' || !path.isAbsolute(action.cwd)) return false;
  let cwd;
  try { cwd = fs.realpathSync(action?.cwd); } catch { return false; }
  return cwd === record.syncRegistrationCwd;
}

function nativeAnswerMatches(record, action, now = Date.now()) {
  return [YES, NO].includes(action?.answer) && nativeQuestionMatches(record, action, now);
}

function acceptNativeAnswer(record, action, now = Date.now()) {
  if (!nativeAnswerMatches(record, action, now)) return null;
  if (action.answer === YES) {
    record.status = 'approved';
    record.expires = now + PERMIT_TTL_MS;
    return { status: 'approved', eventId: record.eventId, targetCwd: record.targetCwd };
  }
  record.status = 'consumed';
  return { status: 'denied', eventId: record.eventId };
}

module.exports = { YES, NO, SYNC_HEADER, digest, newPending, live, proposalStillAllowed, isProposalQuestion, isSyncQuestion, syncQuestionDigest, registerQuestion, acceptReply, nativeQuestionMatches, nativeAnswerMatches, acceptNativeAnswer, hostQuestionText };
