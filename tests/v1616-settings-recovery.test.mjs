import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {OneDriveTestClient} from '../dist/src/cloud/onedrive-api.js';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const ts=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');

test('v1.6.16: payroll is collapsible and comes immediately above advanced settings',()=>{
  const settings=html.split('id="settings-view"')[1].split('<footer>')[0];
  const nisa=settings.indexOf('id="settings-nisa-panel"');
  const payroll=settings.indexOf('id="settings-payroll-disclosure"');
  const advanced=settings.indexOf('id="cloud-advanced"');
  assert.ok(nisa>=0&&nisa<payroll&&payroll<advanced);
  assert.match(settings,/<details class="panel assets-payroll-panel settings-payroll-disclosure"/);
  assert.match(settings,/<summary class="settings-payroll-summary">/);
  assert.ok(!/<details class="panel assets-payroll-panel[^>]*\bopen\b/.test(settings));
  for(const id of ['assets-payroll-connect','assets-payroll-deposit-form','assets-payroll-summary','cloud-advanced'])
    assert.equal(settings.split(`id="${id}"`).length,2);
});

test('v1.6.16: pending recovery uses an explicit button and no browser storage',()=>{
  assert.match(html,/id="cloud-resume-batch"[^>]*class="secondary-action hidden"/);
  assert.match(ts,/resumePendingYearBatch\(async results=>/);
  const src=readFileSync(new URL('../src/cloud/live-vault.ts',import.meta.url),'utf8');
  assert.match(src,/private pendingYearBatch/);
  assert.doesNotMatch(src,/localStorage\.setItem\(['"]pendingYearBatch/);
});

test('v1.6.16: reads time out even after GET headers arrive',async()=>{
  const originalTimeout=globalThis.setTimeout;
  globalThis.setTimeout=(fn,delay,...args)=>originalTimeout(fn,delay===30000?20:delay,...args);
  let aborted=false;
  const client=new OneDriveTestClient('test-only',async(_url,init)=>{
    init.signal?.addEventListener('abort',()=>{aborted=true;});
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('partial'));}}),{status:200});
  });
  try{
    await assert.rejects(client.httpWithReadTimeout('https://graph.microsoft.com/test',{method:'GET'}),/30秒/);
    assert.equal(aborted,true);
  }finally{globalThis.setTimeout=originalTimeout;}
});

test('v1.6.16: stalled signed download is subject to whole-body deadline, without bearer token',async()=>{
  const originalTimeout=globalThis.setTimeout;
  globalThis.setTimeout=(fn,delay,...args)=>originalTimeout(fn,delay===30000?20:delay,...args);
  let signedAuth;
  const client=new OneDriveTestClient('test-only',async(url,init)=>{
    if(url==='https://test.example/download'){
      signedAuth=init.headers?.Authorization;
      return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('half'));}}),{status:200});
    }
    return Response.json({id:'asset',eTag:'"1"','@microsoft.graph.downloadUrl':'https://test.example/download'});
  });
  try{
    await assert.rejects(client.downloadItemInfo('asset',1000),/30秒/);
    assert.equal(signedAuth,undefined);
  }finally{globalThis.setTimeout=originalTimeout;}
});

// Exercise the actual bound UI callback, not a duplicate implementation.
import vm from 'node:vm';
import {CloudEditCancelledError} from '../dist/src/cloud/live-vault.js';
const compiledMain=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
const compiledAuth=readFileSync(new URL('../dist/src/cloud/cloud-settings.js',import.meta.url),'utf8');
const resumeStart=compiledMain.indexOf("$('cloud-resume-batch').addEventListener");
const resumeEnd=compiledMain.indexOf('\n}\nfunction renderStatementSortControl',resumeStart);
const resumeHandler=compiledMain.slice(resumeStart,resumeEnd);
const draft=(month,merchant)=>({cardId:'synthetic-card',provider:'rakuten',billingMonth:month,rows:[{merchant}]});
function recoveryUi(approve=true){
  const conflict=draft('2026-01','local'),remaining=draft('2026-02','saved'),unrelated=draft('2026-03','unsaved'),later=draft('2026-04','later edit');
  const laterOriginal=draft('2026-04','before edit'),remote=draft('2026-01','remote');
  const list=[{id:'conflict',statement:structuredClone(conflict)},{id:'remaining',statement:structuredClone(remaining)},{id:'later',statement:laterOriginal}];
  const records=[{id:'conflict',statement:remote},{id:'remaining',statement:structuredClone(remaining)},{id:'later',statement:laterOriginal,originalId:'pdf'}];
  const statuses=list.map((item,i)=>({...item,status:i===0?'conflict':'unsaved'}));
  const messages=[];let listener,finished;const done=new Promise(resolve=>{finished=resolve;});
  const ctx={Error,CloudEditCancelledError,statements:[conflict,remaining,unrelated,later],savedIds:new WeakMap(),pendingCloudIds:new WeakMap([[conflict,'conflict'],[remaining,'remaining'],[later,'later']]),savedFingerprints:new WeakMap(),dirty:new WeakSet(),originalSaved:new WeakSet(),importedSignatures:new WeakMap(),activeIndex:0,batchBusy:false,filesBusy:false,revisionBusy:false,cloudRefreshing:false,lockSequence:0,
    liveVault:{unlocked:true,hasPendingYearBatch:true,pendingYearBatchEntries:()=>list,records:()=>records,takeMutationWarning:()=>null,async resumePendingYearBatch(confirm){if(!await confirm(statuses))throw new CloudEditCancelledError('取消');this.hasPendingYearBatch=false;return ['remaining','later'];}},
    $:()=>({addEventListener:(_,fn)=>{listener=fn;}}),updateCloudStatus(){},render(){if(!ctx.batchBusy)finished();},showActivity(){},finishActivity(){},showPendingBatchResults:()=> '競合1件',cardDisplayName:x=>x,providerLabel:x=>x,ordinaryConfirmationOwner:{},requestConfirmation:async options=>{assert.match(options.message,/OneDriveの保存済みデータ/);return approve;},hasUnsavedChanges:()=>true,statementWorkingFingerprint:JSON.stringify,statementSignature:JSON.stringify,rememberStorageConflict(){},renderRules(){},assetsUi:null,futureUi:null,cardSettingsUi:null,showBatchDetails(){},operationResult:(message,kind)=>messages.push({message,kind})};
  vm.createContext(ctx);vm.runInContext(resumeHandler,ctx);return {ctx,done,run:()=>listener(),conflict,remaining,unrelated,later,remote,messages};
}
test('v2.0.3 recovery UI retains unrelated and later edits, replaces only the approved conflict, and reports actual counts',async()=>{
  const h=recoveryUi();h.run();await h.done;
  assert.equal(h.ctx.liveVault.hasPendingYearBatch,false);assert.equal(h.ctx.batchBusy,false);
  assert.ok(h.ctx.statements.includes(h.unrelated));assert.ok(h.ctx.statements.includes(h.later));assert.ok(h.ctx.statements.includes(h.remote));
  assert.ok(!h.ctx.statements.includes(h.conflict));assert.ok(!h.ctx.statements.includes(h.remaining));
  assert.equal(h.ctx.savedIds.get(h.later),'later');assert.ok(h.ctx.dirty.has(h.later));assert.ok(h.ctx.originalSaved.has(h.later));
  assert.match(h.messages.at(-1).message,/2件の保存を確認.*競合1件/);assert.equal(h.messages.at(-1).kind,'warn');
});
test('v2.0.3 recovery UI leaves every draft intact on cancellation',async()=>{
  const h=recoveryUi(false);h.run();await h.done;
  assert.equal(h.ctx.liveVault.hasPendingYearBatch,true);assert.equal(h.ctx.batchBusy,false);
  assert.deepEqual(h.ctx.statements,[h.conflict,h.remaining,h.unrelated,h.later]);
});
test('v2.0.3 recovery authentication uses only an explicit same-account popup and preserves the pending plan',async()=>{
  const start=compiledAuth.indexOf('async function recoverAuthentication('),end=compiledAuth.indexOf('async function confirmAction(',start);
  assert.ok(start>=0&&end>start);
  let popupCalls=0,pending=true,valid=true,resultAccount='account-a',reject=false;
  const account={homeAccountId:'account-a'};
  const ctx={Error,handlers:{recoveryPending:()=>pending,confirmationContext:()=>()=>valid,runRecoveryAuthentication:async fn=>fn()},authContext:()=>()=>true,SCOPES:['synthetic-scope'],reauthenticationRequired:true,lastAuthIssue:{},authState:'reauth',updateUi(){},status(){}};
  vm.createContext(ctx);vm.runInContext(compiledAuth.slice(start,end)+'\nthis.recover=recoverAuthentication;',ctx);
  const instance={async acquireTokenPopup(request){popupCalls++;assert.equal(request.account,account);if(reject)throw new Error('synthetic failure');return {account:{homeAccountId:resultAccount},accessToken:'synthetic'};}};
  assert.equal(await ctx.recover(instance,account),true);assert.equal(ctx.authState,'connected');assert.equal(pending,true);
  ctx.authState='reauth';resultAccount='account-b';await assert.rejects(ctx.recover(instance,account),/同じMicrosoftアカウント/);assert.equal(ctx.authState,'reauth');
  resultAccount='account-a';valid=false;await assert.rejects(ctx.recover(instance,account),/同じMicrosoftアカウント/);valid=true;
  reject=true;await assert.rejects(ctx.recover(instance,account),/ポップアップ/);assert.equal(pending,true);
  pending=false;assert.equal(await ctx.recover(instance,account),false);assert.equal(popupCalls,4);
  assert.match(ts,/hasPendingYearBatch\)unsaved\.push/);assert.doesNotMatch(ts,/hasPendingYearBatch\)busy\.push/);
});
