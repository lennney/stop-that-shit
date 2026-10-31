'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {handleHook}=require('../src/hook-policy.cjs');
const {cleanupCreatedHandoffs}=require('../src/dependency-handoff.cjs');

// Approval tests must not depend on package managers installed on the host.
// The entries are fingerprinted but never executed by this suite.
const managerFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-approval-managers-'));
const previousPath = process.env.PATH;
for (const [manager, entry] of [['pnpm', 'pnpm.cjs'], ['npm', 'npm-cli.js']]) {
  const bin = path.join(managerFixture, 'node_modules', manager, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, entry), '// test-only manager fixture\n');
}
process.env.PATH = [managerFixture, previousPath || ''].join(path.delimiter);
test.after(() => {
  cleanupCreatedHandoffs();
  process.env.PATH = previousPath;
  fs.rmSync(managerFixture, { recursive: true, force: true });
});
test('explicit card authorizes only the exact denied dependency action once',t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-action-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));const options={dataDir};const base={session_id:'approval-test',turn_id:'t',cwd:process.cwd()};
 const prompt=prompt=>handleHook({...base,hook_event_name:'UserPromptSubmit',prompt},options);
 const before=(id,name,input)=>handleHook({...base,hook_event_name:'PreToolUse',tool_name:name,tool_use_id:id,tool_input:input},options);
 prompt('$stop-that-shit change deps=ask -- work');const input={command:'pnpm install --offline --frozen-lockfile --ignore-scripts'};
 const denied=before('install-1','Bash',input);const reason=denied.hookSpecificOutput.permissionDecisionReason;assert.match(reason,/DEPENDENCY_NOT_AUTHORIZED/);assert.doesNotMatch(reason,/obtain explicit deps=allow/);assert.match(reason,/session.*deps=ask/i);
 const match=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(reason);assert.ok(match,'denial must provide exact question and options');
 const question=match[1].replace('<absolute canonical directory>',fs.realpathSync(process.cwd())),yes=match[2],no=match[3];assert.equal(before('question-1','request_user_input_async',{questions:[{title:question,options:[yes,no]}]}),null);
 const reply=JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','question-1',0]),question,answer:yes}]);prompt(`<send_user_message_question_reply>\n${reply}\n</send_user_message_question_reply>`);
 assert.equal(before('install-2','Bash',input).hookSpecificOutput.permissionDecision,'allow');
 const {readRuntime}=require('../src/runtime-audit.cjs');
 const runtime=readRuntime({sessionId:'approval-test'},options);
 const issued=runtime.events.find(event=>event.approval && !event.approval.consumed);
 assert.ok(issued);assert.equal(issued.approval.questionCallId,'question-1');assert.match(issued.approval.eventId,/^evt_/);
 assert.doesNotMatch(JSON.stringify(issued),/pnpm install|Allow this operation once/);
 assert.equal(before('install-3','Bash',input).hookSpecificOutput.permissionDecision,'allow');
});

test('synchronous native question registration is exact and does not accept prompt text as an answer', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-sync-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const opt={dataDir:dir},base={session_id:'sync',turn_id:'t',cwd:process.cwd()};
 const prompt=(text,more={})=>handleHook({...base,...more,hook_event_name:'UserPromptSubmit',prompt:text},opt);
 const before=(id,name,input,more={})=>handleHook({...base,...more,hook_event_name:'PreToolUse',tool_name:name,tool_use_id:id,tool_input:input},opt);
 const input={command:'pnpm install --offline --frozen-lockfile --ignore-scripts'};
 const targetCwd=fs.mkdtempSync(path.join(os.tmpdir(),'sts-sync-target-cwd-'));
 t.after(()=>fs.rmSync(targetCwd,{recursive:true,force:true}));
 const {SYNC_HEADER}=require('../src/action-approval.cjs');
 const {readState}=require('../src/state.cjs');
 function makePendingQuestion(session) {
  prompt('$stop-that-shit change deps=ask -- work',{session_id:session});
  const denied=before(`install-${session}`,'Bash',input,{session_id:session});
  const match=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denied.hookSpecificOutput.permissionDecisionReason);
  assert.ok(match,`proposal for ${session}`);
  const nativeQuestion={id:`dependency-approval-${session}`,header:SYNC_HEADER,
   question:match[1].replace('<absolute canonical directory>',fs.realpathSync(targetCwd)),options:[
    {description:'Authorize this operation once.',label:match[2]},
    {description:'Do not authorize this operation.',label:match[3]}
   ]};
  return {nativeQuestion,yes:match[2],no:match[3]};
 }
 const {nativeQuestion,yes}=makePendingQuestion('sync');
 assert.equal(before('sync-call-1','request_user_input',{questions:[nativeQuestion]}),null);
 const record=readState('sync',dir).actionApproval;
 assert.equal(record.status,'question');
 assert.equal(record.targetCwd,fs.realpathSync(targetCwd));
 assert.equal(record.syncRegistrationCwd,fs.realpathSync(base.cwd));
 assert.equal(record.questionCallId,'sync-call-1');
 assert.equal(record.questionToolName,'request_user_input');
 assert.equal(record.syncQuestionId,'dependency-approval-sync');
 assert.equal(record.questionId,JSON.stringify(['request_user_input','sync-call-1','dependency-approval-sync']));
 prompt(`<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:record.questionId,question:record.question,answer:yes}])}\n</send_user_message_question_reply>`);
 assert.equal(readState('sync',dir).actionApproval.status,'question');
 const corruptions=[
  question=>({...question,question:`${question.question} extra`}),
  question=>({...question,header:'Other'}),
  question=>({...question,options:[question.options[1],question.options[0]]}),
  question=>({...question,options:question.options.map(x=>({...x,description:'changed'}))})
 ];
 for (const [index,corrupt] of corruptions.entries()) {
  const session=`sync-invalid-${index}`;
  const {nativeQuestion:valid}=makePendingQuestion(session);
  assert.equal(readState(session,dir).actionApproval.status,'pending');
  const result=before(`bad-${index}`,'request_user_input',{questions:[corrupt(valid)]},{session_id:session});
  assert.ok(result,`guard must return a denial for corruption ${index}`);
  assert.equal(result.hookSpecificOutput.permissionDecision,'deny',`corruption ${index}`);
  assert.equal(readState(session,dir).actionApproval.status,'pending',`state stays pending ${index}`);
 }
 const missingCwd='sync-missing-cwd';
 const {nativeQuestion:forMissingCwd}=makePendingQuestion(missingCwd);
 assert.equal(before('bad-cwd','request_user_input',{questions:[forMissingCwd]},{session_id:missingCwd,cwd:undefined}).hookSpecificOutput.permissionDecision,'deny');
 assert.equal(readState(missingCwd,dir).actionApproval.status,'pending');
 assert.equal(before('sync-call-duplicate','request_user_input',{questions:[nativeQuestion]}).hookSpecificOutput.permissionDecision,'deny');
});

test('ordinary synchronous questions do not write or wait on the session ledger', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-sync-ordinary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const session='sync-ordinary',base={session_id:session,turn_id:'t',cwd:process.cwd()},opt={dataDir:dir};
 const {statePath}=require('../src/state.cjs');
 handleHook({...base,hook_event_name:'UserPromptSubmit',prompt:'$stop-that-shit change deps=ask -- work'},opt);
 const stateFile=statePath(session,dir),lockDirectory=`${stateFile}.lock`;
 const oldTime=new Date(Date.now()-120000);
 fs.utimesSync(stateFile,oldTime,oldTime);
 const expectedMtime=fs.statSync(stateFile).mtimeMs;
 fs.mkdirSync(lockDirectory);
 fs.writeFileSync(path.join(lockDirectory,`${process.pid}-00000000-0000-4000-8000-000000000000`),'');
 t.after(()=>fs.rmSync(lockDirectory,{recursive:true,force:true}));
 const question={id:'ordinary-question',header:require('../src/action-approval.cjs').SYNC_HEADER,question:'Which option should I use?',options:[
  {label:'Allow this operation once',description:'Authorize this operation once.'},
  {label:'Deny this operation',description:'Do not authorize this operation.'}
 ]};
 assert.equal(handleHook({...base,hook_event_name:'PreToolUse',tool_name:'request_user_input',tool_use_id:'ordinary-call',tool_input:{questions:[question]}},opt),null);
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'ordinary PreToolUse leaves the session file untouched');
 assert.equal(handleHook({...base,hook_event_name:'PostToolUse',tool_name:'request_user_input',tool_use_id:'ordinary-call',tool_input:{questions:[question]},
  tool_response:{answers:{'ordinary-question':{answers:['Allow this operation once']}}}},opt),null);
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'ordinary PostToolUse leaves the session file untouched');
 assert.equal(handleHook({...base,hook_event_name:'PostToolUse',tool_name:'request_user_input',tool_use_id:'ordinary-call',tool_input:{questions:[question]},
  tool_response:{answers:{}}},opt),null);
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'ordinary empty response leaves the session file untouched');
});

test('a completed synchronous question with no selected answer is retired, never granted or denied', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-sync-empty-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const opt={dataDir:dir},base={session_id:'sync-empty',turn_id:'t',cwd:process.cwd()};
 const prompt=text=>handleHook({...base,hook_event_name:'UserPromptSubmit',prompt:text},opt);
 const before=(id,name,input)=>handleHook({...base,hook_event_name:'PreToolUse',tool_name:name,tool_use_id:id,tool_input:input},opt);
 const after=(id,question,response)=>handleHook({...base,hook_event_name:'PostToolUse',tool_name:'request_user_input',tool_use_id:id,tool_input:{questions:[question]},tool_response:response},opt);
 const {readState,statePath}=require('../src/state.cjs');
 const state=()=>readState(base.session_id,dir).actionApproval;
 const stateFile=statePath(base.session_id,dir);
 const input={command:'pnpm install --offline --frozen-lockfile --ignore-scripts'};
 prompt('$stop-that-shit change deps=ask -- work');
 const first=before('install-1','Bash',input);
 const firstMatch=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(first.hookSpecificOutput.permissionDecisionReason);
 const question={id:'empty-answer-question',header:require('../src/action-approval.cjs').SYNC_HEADER,
  question:firstMatch[1].replace('<absolute canonical directory>',fs.realpathSync(base.cwd)),
  options:[{label:firstMatch[2],description:'Authorize this operation once.'},{label:firstMatch[3],description:'Do not authorize this operation.'}]};
 assert.equal(before('native-empty','request_user_input',{questions:[question]}),null);
 assert.equal(state().status,'question');
 const oldTime=new Date(Date.now()-120000);
 fs.utimesSync(stateFile,oldTime,oldTime);
 const expectedMtime=fs.statSync(stateFile).mtimeMs;
 assert.equal(after('wrong-call',question,{answers:{}}),null);
 assert.equal(state().status,'question');
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'wrong toolUseId cannot retire a registered question');
 const changedQuestion={...question,id:'other-empty-question'};
 assert.equal(after('native-empty',changedQuestion,{answers:{}}),null);
 assert.equal(state().status,'question');
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'changed question id cannot retire a registered question');
 assert.equal(after('native-empty',question,{answers:{},extra:true}),null);
 assert.equal(state().status,'question');
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'extra response fields cannot retire a registered question');
 assert.equal(after('native-empty',question,{answers:{}}),null);
 assert.equal(state(),null,'a completed empty native response retires only the unanswered registration');
 const retry=before('install-2','Bash',input);
 assert.equal(retry.hookSpecificOutput.permissionDecision,'deny');
 const retryMatch=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(retry.hookSpecificOutput.permissionDecisionReason);
 assert.ok(retryMatch,'the next attempt must receive a fresh proposal');
 assert.doesNotMatch(retry.hookSpecificOutput.permissionDecisionReason,/already bound|awaiting execution/);
 assert.notEqual(/\((evt_[0-9a-f-]+)\)/.exec(firstMatch[1])[1],/\((evt_[0-9a-f-]+)\)/.exec(retryMatch[1])[1]);
 assert.equal(state().status,'pending');
});

test('an issued approval never recreates a missing one-time handoff', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-issued-handoff-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const opt={dataDir:dir},base={session_id:'issued-handoff',turn_id:'t',cwd:process.cwd()};
 const prompt=text=>handleHook({...base,hook_event_name:'UserPromptSubmit',prompt:text},opt);
 const before=(id,name,input)=>handleHook({...base,hook_event_name:'PreToolUse',tool_name:name,tool_use_id:id,tool_input:input},opt);
 const {readState}=require('../src/state.cjs');
 const input={command:'pnpm install --offline --frozen-lockfile --ignore-scripts'};
 prompt('$stop-that-shit change deps=ask -- work');
 const denial=before('install-1','Bash',input);
 const match=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denial.hookSpecificOutput.permissionDecisionReason);
 const question=match[1].replace('<absolute canonical directory>',fs.realpathSync(base.cwd));
 assert.equal(before('question','request_user_input_async',{questions:[{title:question,options:[match[2],match[3]]}]}),null);
 prompt(`<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','question',0]),question,answer:match[2]}])}\n</send_user_message_question_reply>`);
 const issued=before('retry-1','Bash',input);
 assert.equal(issued.hookSpecificOutput.permissionDecision,'allow');
 const original=readState(base.session_id,dir).actionApproval;
 const handoffPath=original.handoff.path;
 fs.unlinkSync(handoffPath);
 const replay=before('retry-2','Bash',input);
 assert.equal(replay.hookSpecificOutput.permissionDecision,'deny');
 assert.equal(Object.hasOwn(replay.hookSpecificOutput,'updatedInput'),false);
 const current=readState(base.session_id,dir).actionApproval;
 assert.equal(current.status,'pending');
 assert.notEqual(current.eventId,original.eventId);
 assert.equal(Object.hasOwn(current,'ticket'),false);
 assert.equal(fs.existsSync(handoffPath),false);
});

test('only the exact synchronous tool result can approve or deny the registered proposal', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-sync-answer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const opt={dataDir:dir},base={session_id:'sync-answer',turn_id:'t',cwd:process.cwd()};
 const prompt=text=>handleHook({...base,hook_event_name:'UserPromptSubmit',prompt:text},opt);
 const before=(id,name,input,more={})=>handleHook({...base,...more,hook_event_name:'PreToolUse',tool_name:name,tool_use_id:id,tool_input:input},opt);
 const after=(id,question,answers,more={})=>handleHook({...base,...more,hook_event_name:'PostToolUse',tool_name:'request_user_input',tool_use_id:id,tool_input:{questions:[question]},tool_response:answers},opt);
 prompt('$stop-that-shit change deps=ask -- work');
 const input={command:'pnpm install --offline --frozen-lockfile --ignore-scripts'};
 const denial=before('install','Bash',input);
 const match=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denial.hookSpecificOutput.permissionDecisionReason);
 const question={id:'sync-question',header:require('../src/action-approval.cjs').SYNC_HEADER,
  question:match[1].replace('<absolute canonical directory>',fs.realpathSync(base.cwd)),
  options:[{label:match[2],description:'Authorize this operation once.'},{label:match[3],description:'Do not authorize this operation.'}]};
 assert.equal(before('native-call','request_user_input',{questions:[question]}),null);
 const {readState,writeState,statePath}=require('../src/state.cjs');
 const state=()=>readState(base.session_id,dir).actionApproval;
 const stateFile=statePath(base.session_id,dir);
 function ageStateFile(){const oldTime=new Date(Date.now()-120000);fs.utimesSync(stateFile,oldTime,oldTime);return fs.statSync(stateFile).mtimeMs;}
 for (const result of [
  {answers:{other:{answers:[match[2]]}}},
  {answers:{'sync-question':{answers:[]}}},
  {answers:{'sync-question':{answers:[match[2],match[3]]}}},
  {answers:{'sync-question':{answers:['ordinary text']}}},
  {answers:{'sync-question':{answers:[match[2]]},extra:{answers:[match[2]]}}},
  {answers:{'sync-question':{answers:[match[2]]}},extra:'ignored no'}
 ]) {
  after('native-call',question,result);
  assert.equal(state().status,'question');
 }
 let expectedMtime=ageStateFile();
 after('wrong-tool-call',question,{answers:{'sync-question':{answers:[match[2]]}}});
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'wrong toolUseId does not write the session ledger');
 const mismatchedQuestion={...question,id:'other-question'};
 expectedMtime=ageStateFile();
 after('native-call',mismatchedQuestion,{answers:{'other-question':{answers:[match[2]]}}});
 assert.equal(state().status,'question');
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'wrong questionId does not write the session ledger');
 const {toControlEvent}=require('../src/adapters/codex-hooks.cjs');
 const {handleControlEvent}=require('../src/controller.cjs');
 const codexPost=toControlEvent({...base,hook_event_name:'PostToolUse',tool_name:'request_user_input',tool_use_id:'native-call',
  tool_input:{questions:[question]},tool_response:{answers:{'sync-question':{answers:[match[2]]}}}});
 expectedMtime=ageStateFile();
 for (const event of [{...codexPost,host:{family:'claude'}},{...codexPost,host:undefined}]) {
  handleControlEvent(event,opt);
  assert.equal(state().status,'question');
  assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'unsupported host result does not write the session ledger');
 }
 expectedMtime=ageStateFile();
 after('native-call',question,{answers:{'sync-question':{answers:[match[2]]}}},{cwd:os.tmpdir()});
 assert.equal(state().status,'question');
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'wrong cwd does not write the session ledger');
 const unrelatedQuestion={...question,question:'Can you handle an unrelated request?'};
 expectedMtime=ageStateFile();
 assert.equal(before('native-call','request_user_input',{questions:[unrelatedQuestion]}),null,'same toolUseId can run an ordinary question');
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'ordinary reused toolUseId does not change the pending proposal');
 after('native-call',unrelatedQuestion,{answers:{'sync-question':{answers:[match[2]]}}});
 assert.equal(state().status,'question');
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'answer to a different question does not write the session ledger');
 const changedDescription={...question,options:question.options.map((option,index)=>index===0?{...option,description:'Changed operation description.'}:option)};
 after('native-call',changedDescription,{answers:{'sync-question':{answers:[match[2]]}}});
 assert.equal(state().status,'question');
 assert.equal(fs.statSync(stateFile).mtimeMs,expectedMtime,'changed option description does not write the session ledger');
 after('native-call',question,JSON.stringify({answers:{'sync-question':{answers:[match[2]]}}}));
 assert.equal(state().status,'approved');
 assert.equal(before('retry','Bash',input).hookSpecificOutput.permissionDecision,'allow');

 base.session_id='sync-expired-answer';
 prompt('$stop-that-shit change deps=ask -- work');
 const expiredDenial=before('install','Bash',input);
 const expiredMatch=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(expiredDenial.hookSpecificOutput.permissionDecisionReason);
 const expiredQuestion={...question,id:'expired-question',question:expiredMatch[1].replace('<absolute canonical directory>',fs.realpathSync(base.cwd)),options:[
  {label:expiredMatch[2],description:'Authorize this operation once.'},{label:expiredMatch[3],description:'Do not authorize this operation.'}
 ]};
 before('expired-native-call','request_user_input',{questions:[expiredQuestion]});
 const expiredState=readState(base.session_id,dir);
 expiredState.actionApproval.proposalExpires=Date.now()-1;
 writeState(base.session_id,expiredState,dir);
 const expiredFile=statePath(base.session_id,dir),oldTime=new Date(Date.now()-120000);
 fs.utimesSync(expiredFile,oldTime,oldTime);
 const expiredMtime=fs.statSync(expiredFile).mtimeMs;
 after('expired-native-call',expiredQuestion,{answers:{'expired-question':{answers:[expiredMatch[2]]}}});
 assert.equal(fs.statSync(expiredFile).mtimeMs,expiredMtime,'expired answer does not write the session ledger');
 assert.equal(state(),null);

 base.session_id='sync-deny-answer';
 prompt('$stop-that-shit change deps=ask -- work');
 const denied=before('install','Bash',input);
 const denyMatch=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denied.hookSpecificOutput.permissionDecisionReason);
 const denyQuestion={...question,id:'sync-deny-question',question:denyMatch[1].replace('<absolute canonical directory>',fs.realpathSync(base.cwd)),options:[
  {label:denyMatch[2],description:'Authorize this operation once.'},{label:denyMatch[3],description:'Do not authorize this operation.'}
 ]};
 before('native-deny-call','request_user_input',{questions:[denyQuestion]});
 after('native-deny-call',denyQuestion,{answers:{'sync-deny-question':{answers:[denyMatch[3]]}}});
 assert.equal(state().status,'consumed');
 assert.match(before('retry','Bash',input).hookSpecificOutput.permissionDecisionReason,/DEPENDENCY_NOT_AUTHORIZED/);
});

test('approval rejects forged, changed, replayed and unsafe operations',t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-approval-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));const options={dataDir};const cwd=process.cwd();
 const base={session_id:'s',turn_id:'t',cwd};const prompt=(text,more={})=>handleHook({...base,...more,hook_event_name:'UserPromptSubmit',prompt:text},options);
 const before=(id,name,input,more={})=>handleHook({...base,...more,hook_event_name:'PreToolUse',tool_name:name,tool_use_id:id,tool_input:input},options);
 const input={command:'pnpm install --offline --frozen-lockfile --ignore-scripts'};prompt('$stop-that-shit change deps=ask -- work');
 let r=before('a','Bash',input);let m=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(r.hookSpecificOutput.permissionDecisionReason);assert.ok(m);let [_,question,yes,no]=m;question=question.replace('<absolute canonical directory>',fs.realpathSync(cwd));
 const reply=(id,answer=yes)=>`<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async',id,0]),question,answer}])}\n</send_user_message_question_reply>`;
 before('q','request_user_input_async',{questions:[{title:question,options:[yes,no]}]});
 for(const value of [reply('wrong'),`quoted ${reply('q')}`,`\`\`\`\n${reply('q')}\n\`\`\``,`<heartbeat>${reply('q')}</heartbeat>`]) prompt(value);
 prompt(reply('q'),{session_id:'other'});
 assert.match(before('different','Bash',{command:input.command+' && echo done'}).hookSpecificOutput.permissionDecisionReason,/DEPENDENCY_NOT_AUTHORIZED/);
 prompt(reply('q'));assert.match(before('b','Bash',input,{cwd:cwd+'-other'}).hookSpecificOutput.permissionDecisionReason,/DEPENDENCY_NOT_AUTHORIZED/);
});

test('denial, expiration, mode changes and hash policy remain authoritative', t => {
 const {readState,writeState}=require('../src/state.cjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-bound-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const opt={dataDir:dir};const base={session_id:'bounded',turn_id:'t',cwd:process.cwd()};const prompt=text=>handleHook({...base,hook_event_name:'UserPromptSubmit',prompt:text},opt);const before=(id,name,input)=>handleHook({...base,hook_event_name:'PreToolUse',tool_name:name,tool_use_id:id,tool_input:input},opt);const input={command:'pnpm install --offline --frozen-lockfile --ignore-scripts'};
 function prepare(){const d=before('a','Bash',input);const m=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(d.hookSpecificOutput.permissionDecisionReason);assert.ok(m);m[1]=m[1].replace('<absolute canonical directory>',fs.realpathSync(base.cwd));before('q','request_user_input_async',{questions:[{title:m[1],options:[m[2],m[3]]}]});return answer=>`<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','q',0]),question:m[1],answer}])}\n</send_user_message_question_reply>`;}
 prompt('$stop-that-shit change deps=deny -- work');const denyReason=before('deny','Bash',input).hookSpecificOutput.permissionDecisionReason;assert.doesNotMatch(denyReason,/Approval question:/);assert.match(denyReason,/deps=allow/);
 prompt('$stop-that-shit change deps=ask -- work');let reply=prepare();prompt(reply('Deny this operation'));assert.match(before('b','Bash',input).hookSpecificOutput.permissionDecisionReason,/DEPENDENCY_NOT_AUTHORIZED/);
 reply=prepare();let state=readState('bounded',dir);state.actionApproval.proposalExpires=Date.now()-1;writeState('bounded',state,dir);prompt(reply('Allow this operation once'));assert.match(before('c','Bash',input).hookSpecificOutput.permissionDecisionReason,/DEPENDENCY_NOT_AUTHORIZED/);
 reply=prepare();prompt(reply('Allow this operation once'));prompt('$stop-that-shit review -- inspect');assert.match(before('d','Bash',input).hookSpecificOutput.permissionDecisionReason,/MODE_FORBIDS_MUTATION/);prompt('$stop-that-shit change deps=ask -- work');assert.match(before('e','Bash',input).hookSpecificOutput.permissionDecisionReason,/DEPENDENCY_NOT_AUTHORIZED/);
});

test('hook stdin persists one approval across separate processes',t=>{
 const {spawnSync}=require('node:child_process');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-stdin-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const base={session_id:'stdin',turn_id:'t',cwd:process.cwd()};
 const call=(kind,extra)=>{const r=spawnSync(process.execPath,[path.join(__dirname,'../hooks/stop-that-shit.cjs')],{input:JSON.stringify({...base,hook_event_name:kind,...extra}),env:{...process.env,PLUGIN_DATA:dir,STS_RUNTIME_DATA:dir},encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout?JSON.parse(r.stdout):null};
 call('UserPromptSubmit',{prompt:'$stop-that-shit change deps=ask -- work'});const input={command:'pnpm install --offline --frozen-lockfile --ignore-scripts'};const pre=(id,tool_name,tool_input)=>call('PreToolUse',{tool_name,tool_use_id:id,tool_input});const d=pre('a','Bash',input);const m=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(d.hookSpecificOutput.permissionDecisionReason);assert.ok(m);m[1]=m[1].replace('<absolute canonical directory>',fs.realpathSync(base.cwd));assert.equal(pre('q','request_user_input_async',{questions:[{title:m[1],options:[m[2],m[3]]}]}),null);call('UserPromptSubmit',{prompt:`<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','q',0]),question:m[1],answer:m[2]}])}\n</send_user_message_question_reply>`});assert.equal(pre('b','Bash',input).hookSpecificOutput.permissionDecision,'allow');assert.equal(pre('b','Bash',input).hookSpecificOutput.permissionDecision,'allow');
});

test('concurrent retries consume the permit at most once',async t=>{
 const {spawn,spawnSync}=require('node:child_process');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-race-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const base={session_id:'race',turn_id:'t',cwd:process.cwd()},env={...process.env,PLUGIN_DATA:dir,STS_RUNTIME_DATA:dir},entry=path.join(__dirname,'../hooks/stop-that-shit.cjs');
 const run=(kind,extra)=>{const r=spawnSync(process.execPath,[entry],{input:JSON.stringify({...base,hook_event_name:kind,...extra}),env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout?JSON.parse(r.stdout):null};const input={command:'pnpm install --offline --frozen-lockfile --ignore-scripts'};run('UserPromptSubmit',{prompt:'$stop-that-shit change deps=ask -- work'});let d=run('PreToolUse',{tool_name:'Bash',tool_use_id:'original',tool_input:input});let m=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(d.hookSpecificOutput.permissionDecisionReason);assert.ok(m);m[1]=m[1].replace('<absolute canonical directory>',fs.realpathSync(base.cwd));run('PreToolUse',{tool_name:'request_user_input_async',tool_use_id:'q',tool_input:{questions:[{title:m[1],options:[m[2],m[3]]}]}});run('UserPromptSubmit',{prompt:`<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','q',0]),question:m[1],answer:m[2]}])}\n</send_user_message_question_reply>`});
 const runAsync=id=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[entry],{env});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>code===0?resolve(out?JSON.parse(out):null):reject(Error(err)));p.stdin.end(JSON.stringify({...base,hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:id,tool_input:input}));});
 const results=await Promise.all([runAsync('one'),runAsync('two')]);assert.equal(results.filter(x=>x?.hookSpecificOutput?.permissionDecision==='allow').length,2);assert.equal(results[0].hookSpecificOutput.updatedInput.command,results[1].hookSpecificOutput.updatedInput.command);
});

test('direct supported dependency operations bind exact flags and reject shell chains',t=>{
 const {isDirectDependencyCommand}=require('../src/shell-analysis.cjs');
 for(const command of ['npm install package','pnpm add package','yarn install','pip install package','cargo add pkg','dotnet add app.csproj package Example','go get example.org/pkg','composer require vendor/pkg','bundle add pkg']) assert.equal(isDirectDependencyCommand(command),true,command);
 assert.equal(isDirectDependencyCommand("pwsh -NoProfile -Command 'pnpm install --offline'"),true);
 for(const command of ['pnpm install && echo done','npm install > out.txt','npm install $(other)',"pwsh -Command 'npm install; echo done'",'pwsh -EncodedCommand anything','node script.js npm install']) assert.equal(isDirectDependencyCommand(command),false,command);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-flags-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const opt={dataDir:dir};const base={session_id:'flags',turn_id:'t',cwd:process.cwd()};const prompt=prompt=>handleHook({...base,hook_event_name:'UserPromptSubmit',prompt},opt),pre=(id,tool_input)=>handleHook({...base,hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:id,tool_input},opt);
 for(const command of ['npm install package','pnpm add package']) {base.session_id = command;prompt('$stop-that-shit change deps=ask -- work');let denied=pre('original',{command});let m=/Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denied.hookSpecificOutput.permissionDecisionReason);assert.ok(m,command);m[1]=m[1].replace('<absolute canonical directory>',fs.realpathSync(base.cwd));handleHook({...base,hook_event_name:'PreToolUse',tool_name:'request_user_input_async',tool_use_id:'q',tool_input:{questions:[{title:m[1],options:[m[2],m[3]]}]}},opt);prompt(`<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','q',0]),question:m[1],answer:m[2]}])}\n</send_user_message_question_reply>`);assert.match(pre('changed',{command:command+' --ignore-scripts'}).hookSpecificOutput.permissionDecisionReason,/DEPENDENCY_NOT_AUTHORIZED/);assert.equal(pre('exact',{command}).hookSpecificOutput.permissionDecision,'allow');}
});

test('other policy gates take precedence and no approval is generated for unsafe inputs',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-gates-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const opt={dataDir:dir},base={session_id:'gates',turn_id:'t',cwd:process.cwd()};const prompt=prompt=>handleHook({...base,hook_event_name:'UserPromptSubmit',prompt},opt);const pre=(command,extra={})=>handleHook({...base,...extra,hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'id',tool_input:{command}},opt);
 prompt('$stop-that-shit change deps=ask hash=deny -- work');let output=pre('npm install sha256sum');assert.match(output.hookSpecificOutput.permissionDecisionReason,/HASH_NOT_AUTHORIZED/);assert.doesNotMatch(output.hookSpecificOutput.permissionDecisionReason,/Approval question:/);
 prompt('$stop-that-shit change deps=ask files=src/** -- work');output=pre('npm install package');assert.match(output.hookSpecificOutput.permissionDecisionReason,/WRITE_PATH_UNPROVEN/);assert.doesNotMatch(output.hookSpecificOutput.permissionDecisionReason,/Approval question:/);
});

test('card reply accepts exactly the host UTF-8 truncation, not an arbitrary prefix',()=>{
 const {hostQuestionText}=require('../src/action-approval.cjs');
 const question='字'.repeat(180)+'\nend';
 const truncated=hostQuestionText(question);
 assert.equal(Buffer.byteLength(truncated,'utf8'),510);
 assert.equal(truncated,'字'.repeat(170));
 assert.equal(hostQuestionText('first\r\nsecond'),'first  second');
});

test('long card validates the exact host-rendered truncation and call identity',()=>{
 const {acceptReply,hostQuestionText}=require('../src/action-approval.cjs');
 const question='Allow this controlled child operation once '+ '字'.repeat(180);const record={digest:'a'.repeat(64),eventId:'evt_00000000-0000-0000-0000-000000000000',questionPrefix:'prefix',argv:['pnpm','install'],manager:{kind:'native',entry:{path:'manager'}},deniedActionId:'a',expires:Date.now()+30000,proposalExpires:Date.now()+30000,status:'question',question,questionCallId:'q',questionId:JSON.stringify(['request_user_input_async','q',0])};
 const answer=questionValue=>`<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:record.questionId,question:questionValue,answer:'Allow this operation once'}])}\n</send_user_message_question_reply>`;
 acceptReply(record,answer(hostQuestionText(question).slice(0,-1)));assert.equal(record.status,'question');
 acceptReply(record,answer(hostQuestionText(question)));assert.equal(record.status,'approved');
});

test('unsupported fields and credential-like arguments do not enter the visible approval question',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sts-private-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const opt={dataDir:dir},base={session_id:'private',turn_id:'t',cwd:process.cwd()};
 handleHook({...base,hook_event_name:'UserPromptSubmit',prompt:'$stop-that-shit change deps=ask -- work'},opt);
 for(const input of [{command:'pnpm install --offline',environment:{SECRET:'private'}},{command:'npm install --token=private'}]){
  const denied=handleHook({...base,hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'a',tool_input:input},opt);
  assert.match(denied.hookSpecificOutput.permissionDecisionReason,/DEPENDENCY_NOT_AUTHORIZED/);
  assert.doesNotMatch(denied.hookSpecificOutput.permissionDecisionReason,/Approval question:|private/);
 }
});

test('hook rejects invalid approval cards and acknowledges an exact user decision', t => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-card-feedback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = { session_id: 'feedback', turn_id: 't', cwd: process.cwd() };
  const call = (event, extra) => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../hooks/stop-that-shit.cjs')], {
      input: JSON.stringify({ ...base, hook_event_name: event, ...extra }),
      env: { ...process.env, PLUGIN_DATA: dir, STS_RUNTIME_DATA: dir }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  const pre = (id, tool_name, tool_input) => call('PreToolUse', { tool_name, tool_use_id: id, tool_input });
  call('UserPromptSubmit', { prompt: '$stop-that-shit change deps=ask -- task' });
  const input = { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' };
  const denial = pre('original', 'Bash', input);
  const match = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denial.hookSpecificOutput.permissionDecisionReason);
  assert.ok(match);
  const proposalEvent = /evt_[0-9a-f-]{36}/.exec(match[1])[0];
  const unbound = pre('unbound', 'request_user_input_async', { questions: [{ title: `Approve ${proposalEvent}?`, options: [match[2], match[3]] }] });
  assert.equal(unbound.hookSpecificOutput.permissionDecision, 'deny');
  const makeQuestion = directory => match[1].replace('<absolute canonical directory>', directory);
  const invalid = pre('bad', 'request_user_input_async', { questions: [{ title: makeQuestion('relative'), options: [match[2], match[3]] }] });
  assert.equal(invalid.hookSpecificOutput.permissionDecision, 'deny');
  const question = makeQuestion(fs.realpathSync(process.cwd()));
  assert.equal(pre('q', 'request_user_input_async', { questions: [{ title: question, options: [match[2], match[3]] }] }), null);
  const reply = answer => `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'q', 0]), question, answer }])}\n</send_user_message_question_reply>`;
  const acknowledged = call('UserPromptSubmit', { prompt: reply(match[2]) });
  assert.match(acknowledged.hookSpecificOutput.additionalContext, /one-time approval.*available/i);
  assert.match(acknowledged.hookSpecificOutput.additionalContext, /deps=ask/);
  const duplicate = pre('q2', 'request_user_input_async', { questions: [{ title: question, options: [match[2], match[3]] }] });
  assert.equal(duplicate.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(pre('retry', 'Bash', input).hookSpecificOutput.permissionDecision, 'allow');

  base.session_id = 'denied-feedback';
  call('UserPromptSubmit', { prompt: '$stop-that-shit change deps=ask -- task' });
  const next = pre('original', 'Bash', input);
  const nextMatch = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(next.hookSpecificOutput.permissionDecisionReason);
  const nextQuestion = nextMatch[1].replace('<absolute canonical directory>', fs.realpathSync(process.cwd()));
  assert.equal(pre('q', 'request_user_input_async', { questions: [{ title: nextQuestion, options: [nextMatch[2], nextMatch[3]] }] }), null);
  const deniedReply = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'q', 0]), question: nextQuestion, answer: nextMatch[3] }])}\n</send_user_message_question_reply>`;
  const deniedAck = call('UserPromptSubmit', { prompt: deniedReply });
  assert.match(deniedAck.hookSpecificOutput.additionalContext, /one-time approval.*denied/i);
  assert.match(pre('retry', 'Bash', input).hookSpecificOutput.permissionDecisionReason, /DEPENDENCY_NOT_AUTHORIZED/);

  base.session_id = 'expired-feedback';
  call('UserPromptSubmit', { prompt: '$stop-that-shit change deps=ask -- task' });
  const expired = pre('original', 'Bash', input);
  const expiredMatch = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(expired.hookSpecificOutput.permissionDecisionReason);
  const { readState, writeState } = require('../src/state.cjs');
  const state = readState(base.session_id, dir);
  state.actionApproval.proposalExpires = Date.now() - 1;
  writeState(base.session_id, state, dir);
  const expiredQuestion = expiredMatch[1].replace('<absolute canonical directory>', fs.realpathSync(process.cwd()));
  assert.equal(pre('q', 'request_user_input_async', { questions: [{ title: expiredQuestion, options: [expiredMatch[2], expiredMatch[3]] }] }).hookSpecificOutput.permissionDecision, 'deny');
  const expiredEvent = /evt_[0-9a-f-]{36}/.exec(expiredQuestion)[0];
  assert.equal(pre('expired-unbound', 'request_user_input_async', { questions: [{ title: `Approve ${expiredEvent}?`, options: [expiredMatch[2], expiredMatch[3]] }] }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(pre('ordinary', 'request_user_input_async', { questions: [{ title: 'Which option?', options: ['A', 'B'] }] }), null);
  const expiredReply = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'q', 0]), question: expiredQuestion, answer: expiredMatch[2] }])}\n</send_user_message_question_reply>`;
  assert.match(call('UserPromptSubmit', { prompt: expiredReply }).hookSpecificOutput.additionalContext, /No one-time approval was accepted/);
});

test('asynchronous approval has a 24-hour reply window and 10-minute consumption window', () => {
  const { acceptReply, live } = require('../src/action-approval.cjs');
  const now = Date.now();
  const question = 'Allow this controlled child operation once before a known UTC deadline: example';
  const makeRecord = age => ({
    digest: 'a'.repeat(64), eventId: 'evt_00000000-0000-0000-0000-000000000000',
    questionPrefix: 'prefix', question, questionId: 'question-id', questionCallId: 'q', deniedActionId: 'a',
    argv: ['pnpm', 'install'], manager: { kind: 'native', entry: { path: 'manager' } },
    targetCwd: 'target', status: 'question', expires: now - age + 10 * 60 * 1000,
    proposalExpires: now - age + 24 * 60 * 60 * 1000
  });
  const reply = `<send_user_message_question_reply>\n${JSON.stringify([{questionItemId:'question-id',question,answer:'Allow this operation once'}])}\n</send_user_message_question_reply>`;
  for (const age of [67 * 60 * 1000, 23 * 60 * 60 * 1000 + 59 * 60 * 1000]) {
    const record = makeRecord(age);
    assert.equal(acceptReply(record, reply, now).status, 'approved');
    assert.equal(record.expires, now + 10 * 60 * 1000);
    assert.equal(live(record, now + 10 * 60 * 1000 + 1), false);
  }
  const expired = makeRecord(24 * 60 * 60 * 1000 + 1);
  assert.equal(acceptReply(expired, reply, now).status, 'unavailable');
  assert.equal(expired.status, 'question');
});

test('approval deadline is rendered in UTC across midnight', t => {
  const { newPending } = require('../src/action-approval.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-deadline-'));
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); });
  const entry = path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '');
  process.env.PATH = root;
  const event = { sessionId: 'deadline', action: { id: 'a', name: 'Bash', cwd: root, input: { command: 'pnpm install --offline' } } };
  const start = Date.parse('2030-01-01T23:59:00.000Z');
  const record = newPending(event, 'evt_00000000-0000-0000-0000-000000000000', start);
  assert.match(record.questionPrefix, /Reply by 2030-01-02T23:59:00\.000Z/);
  assert.match(record.questionPrefix, /within 10 minutes after your reply/);
});

test('unsupported dependency syntax does not instruct a session-wide policy change', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-unsupported-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { dataDir: dir };
  const base = { session_id: 'unsupported', turn_id: 't', cwd: process.cwd() };
  handleHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '$stop-that-shit change deps=ask -- task' }, options);
  const denied = handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'pnpm install && echo done' } }, options);
  const reason = denied.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /DEPENDENCY_NOT_AUTHORIZED/);
  assert.doesNotMatch(reason, /deps=allow/);
  assert.match(reason, /single direct static dependency command/);
});

test('native reply arrays authorize the unique matching question and reject duplicate IDs', t => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-reply-array-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = { session_id: 'array', turn_id: 't', cwd: process.cwd() };
  const call = (event, extra) => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../hooks/stop-that-shit.cjs')], {
      input: JSON.stringify({ ...base, hook_event_name: event, ...extra }),
      env: { ...process.env, PLUGIN_DATA: dir, STS_RUNTIME_DATA: dir }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  const pre = (id, tool_name, tool_input) => call('PreToolUse', { tool_name, tool_use_id: id, tool_input });
  const input = { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' };
  function prepare(session) {
    base.session_id = session;
    call('UserPromptSubmit', { prompt: '$stop-that-shit change deps=ask -- task' });
    const denied = pre('original', 'Bash', input);
    const match = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denied.hookSpecificOutput.permissionDecisionReason);
    const question = match[1].replace('<absolute canonical directory>', fs.realpathSync(process.cwd()));
    assert.equal(pre('q', 'request_user_input_async', { questions: [{ title: question, options: [match[2], match[3]] }] }), null);
    return { questionItemId: JSON.stringify(['request_user_input_async', 'q', 0]), question, answer: match[2] };
  }
  const approved = prepare('array-one');
  const other = { questionItemId: 'other', question: 'Other question?', answer: 'Other answer' };
  const ack = call('UserPromptSubmit', { prompt: `<send_user_message_question_reply>\n${JSON.stringify([other, approved])}\n</send_user_message_question_reply>` });
  assert.match(ack.hookSpecificOutput.additionalContext, /one-time approval.*available/i);
  assert.equal(pre('retry', 'Bash', input).hookSpecificOutput.permissionDecision, 'allow');
  const duplicate = prepare('array-duplicate');
  const rejected = call('UserPromptSubmit', { prompt: `<send_user_message_question_reply>\n${JSON.stringify([duplicate, duplicate])}\n</send_user_message_question_reply>` });
  assert.match(rejected.hookSpecificOutput.additionalContext, /No one-time approval was accepted/);
  assert.match(pre('retry', 'Bash', input).hookSpecificOutput.permissionDecisionReason, /DEPENDENCY_NOT_AUTHORIZED/);
});

test('approved retry is denied with a clear reason when the system launcher is unavailable', { skip: process.platform !== 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-launcher-unavailable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { dataDir: dir };
  const base = { session_id: 'launcher-unavailable', turn_id: 't', cwd: process.cwd() };
  const prompt = text => handleHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: text }, options);
  const pre = (id, tool_name, tool_input) => handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_use_id: id, tool_input }, options);
  const input = { command: 'pnpm install --offline --frozen-lockfile --ignore-scripts' };
  prompt('$stop-that-shit change deps=ask -- task');
  const denied = pre('original', 'Bash', input);
  const match = /Approval question: (.+)\nApproval options: (.+) \| (.+)/.exec(denied.hookSpecificOutput.permissionDecisionReason);
  assert.ok(match);
  const question = match[1].replace('<absolute canonical directory>', fs.realpathSync(process.cwd()));
  assert.equal(pre('question', 'request_user_input_async', { questions: [{ title: question, options: [match[2], match[3]] }] }), null);
  prompt(`<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'question', 0]), question, answer: match[2] }])}\n</send_user_message_question_reply>`);

  const previousRoot = process.env.SystemRoot;
  process.env.SystemRoot = path.join(dir, 'missing system root');
  let result;
  try { result = pre('retry', 'Bash', input); }
  finally {
    if (previousRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousRoot;
  }
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /APPROVED_LAUNCHER_UNAVAILABLE/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /SystemRoot/);
});
