import test from 'node:test';
import assert from 'node:assert/strict';
import {showActivity,clearActivity,activityHistory} from '../dist/src/ui/activity-feedback.js';
import {readFileSync} from 'node:fs';
const read=n=>readFileSync(new URL('../'+n,import.meta.url),'utf8');
test('警告とエラーは後続通知で失われず、ロックで消去する',()=>{
 const classes=new Set();const label={textContent:''};let dismiss;
 const button={addEventListener(_,fn){dismiss=fn;}};
 const panel={dataset:{},classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k)},querySelector:s=>s==='.activity-message'?label:s==='.activity-dismiss'?button:null,setAttribute(){}};
 const old=globalThis.document;globalThis.document={getElementById:id=>id==='toast'?panel:null};
 const oldTimer=globalThis.setTimeout;let scheduled=0;globalThis.setTimeout=(...args)=>{scheduled++;return oldTimer(...args);};
 try{clearActivity();showActivity('test warning','warn');showActivity('test error','bad');assert.equal(scheduled,0);dismiss();showActivity('test success','good');assert.equal(scheduled,1);assert.deepEqual(activityHistory().map(x=>x.kind),['good','bad','warn']);assert.equal(activityHistory().filter(x=>x.unread).length,2);clearActivity();assert.equal(activityHistory().length,0);}
 finally{clearActivity();globalThis.document=old;globalThis.setTimeout=oldTimer;}
});
test('通常保存の結果はトーストへ統一し、復旧内訳と再送禁止を維持する',()=>{
 const html=read('public/index.html'),main=read('src/main.ts');
 assert.doesNotMatch(html,/id="batch-outcome"/);assert.match(html,/id="batch-outcome-details" hidden/);
 assert.match(main,/showBatchDetails\(\[\], ''\)/);assert.match(main,/operationResult\(mutationWarning\?/);assert.match(main,/showPendingBatchResults\(results\)/);
 assert.match(main,/if\(batchBusy\|\|filesBusy\|\|revisionBusy\|\|liveVault\?\.hasPendingYearBatch\)return/);
 assert.match(main,/import-resume-batch'\)\.addEventListener\('click',\(\)=>\$\('cloud-resume-batch'\)\.click/);
 assert.match(main,/function importCollision\(/);assert.doesNotMatch(main,/failedImports.push\(`重複：/);
});


test('明細保存・削除は結果通知を重ねず、不明や解除警告を維持する',()=>{
 const main=read('src/main.ts');
 for(const [start,end] of [['async function deleteStatement(','function renderSummary('],['async function saveEditedStatement(','function showBatchDetails(']]){
  const section=main.slice(main.indexOf(start),main.indexOf(end,main.indexOf(start)));
  assert.match(section,/operationResult\(mutationWarning\?\?/);
  assert.doesNotMatch(section,/operationResult\([^;]+;\s*toast\(/);
  assert.match(section,/operationResult\(result,(?:uncertain|unknown)\?'warn':'bad'\)/);
 }
});

test('一括保存は書込みと画面反映の完了前に成功を通知せず、固定結果欄を残さない',async()=>{
 const vm=await import('node:vm');const code=read('dist/src/main.js');
 const fn=code.slice(code.indexOf('async function saveAllPending() {'),code.indexOf('function confirmStatementRevision('));
 const draft={sourceKind:'csv'};let completeWrite,completeRefresh;
 const write=new Promise(resolve=>{completeWrite=resolve;});const refresh=new Promise(resolve=>{completeRefresh=resolve;});
 const notices=[],details=[];const vault={unlocked:true,hasPendingYearBatch:false,saveBatch:async(_items,progress)=>{progress('年度データ保存・原本検証',0,1);return write;},takeMutationWarning:()=>null,records:()=>[]};
 const ctx=vm.createContext({batchBusy:false,filesBusy:false,revisionBusy:false,liveVault:vault,lockSequence:0,importQueue:()=>[draft],hasUnsavedChanges:()=>true,issues:()=>[],failedImports:[],updateBatchStatus(){},showBatchDetails:(items)=>details.push(items.length),operationResult:(message,kind)=>notices.push({message,kind}),showActivity:(message,kind)=>notices.push({message,kind}),finishActivity(){},ensureUnlocked:async()=>true,statementWorkingFingerprint:()=>'',savedIds:new Map(),pendingCloudIds:new Map(),pendingSources:new Map(),savedFingerprints:new Map(),dirty:new Set(),importStaged:new Set([draft]),originalSaved:new Set(),crypto:{randomUUID:()=> 'synthetic-id'},structuredClone,pending:()=>[],replaceCloudRecords(){},refreshVaultControls:()=>refresh,render(){}});
 vm.runInContext(fn+'\nthis.save=saveAllPending;',ctx);
 const task=ctx.save();await new Promise(resolve=>setImmediate(resolve));
 assert.ok(notices.length>0);assert.ok(notices.every(n=>n.kind==='working'));assert.deepEqual(details,[0]);
 completeWrite(['synthetic-id']);await new Promise(resolve=>setImmediate(resolve));
 assert.ok(notices.every(n=>n.kind==='working'),'画面反映待ちも成功扱いにしない');
 completeRefresh();await task;
 assert.equal(notices.at(-1).kind,'good');assert.match(notices.at(-1).message,/暗号化保存しました/);assert.deepEqual(details,[0]);assert.equal(ctx.batchBusy,false);
});
