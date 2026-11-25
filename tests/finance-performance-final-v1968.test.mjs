import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {emptyDocument} from '../dist/src/cloud/merge.js';
import {monthlyReport,prepareMonthlyReports} from '../dist/src/summary/monthly-summary.js';

const statement=(rows)=>({provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'synthetic',
  billingMonth:'2026-10',paymentDate:'2026-11-27',statedTotal:rows.length,confirmation:'confirmed',warnings:[],rows});
const row=i=>({id:`r-${i}`,merchant:`fictitious merchant ${i}`,amount:1,usedOn:'2026-10-05'});
const source=records=>({records,rules:[],categories:[],assets:{recurring:[],nisaCardRule:null},
  payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'});

test('linear duplicate-row detection preserves totals and catches a duplicate at the very end',()=>{
  const rows=Array.from({length:5000},(_,i)=>row(i));
  const safe=source([{id:'one',statement:statement(rows)}]);
  const without=monthlyReport('2026-11',safe);
  const prepared=monthlyReport('2026-11',safe,prepareMonthlyReports(safe.records));
  assert.equal(without.issues.length,0);
  assert.equal(without.cardOutflow,5000);
  assert.deepEqual(prepared,without);
  const badRows=[...rows,row(0)];
  const bad=source([{id:'one',statement:statement(badRows)}]);
  const output=monthlyReport('2026-11',bad,prepareMonthlyReports(bad.records));
  assert.ok(output.issues.some(x=>/取引行IDが重複/.test(x.reason)));
  assert.equal(output.cardOutflow,null,'invalid rows must not enter the monthly total');
  assert.equal(output.excludedCount,1);
});

test('read-only vault view is cached, deeply immutable, and invalidates on year changes and lock',()=>{
  const vault=new LiveVault({});
  const make=amount=>({format:'finance-cloud-document-v1',records:[{id:'one',statement:statement([{
    id:'row',merchant:'SYNTHETIC',amount,usedOn:'2026-10-05'}])}],deleted:[],conflicts:[]});
  vault.key={};
  vault.shards=new Map([['2026',{document:make(10),ref:{id:'y',etag:'"1"'}}]]);
  const one=vault.readonlyRecords();
  assert.strictEqual(one,vault.readonlyRecords(),'an unchanged vault must reuse its read-only snapshot');
  assert.ok(Object.isFrozen(one));
  assert.ok(Object.isFrozen(one[0].statement.rows[0]));
  assert.throws(()=>{one[0].statement.rows[0].amount=15;},TypeError);
  const edited=vault.records();edited[0].statement.rows[0].amount=99;
  assert.equal(vault.records()[0].statement.rows[0].amount,10,'editor-facing records() still isolates changes');
  assert.equal(one[0].statement.rows[0].amount,10);
  vault.shards.set('2026',{document:make(20),ref:{id:'y',etag:'"2"'}});
  const two=vault.readonlyRecords();
  assert.notStrictEqual(two,one);
  assert.equal(two[0].statement.rows[0].amount,20);
  vault.shards.set('2025',{document:{...emptyDocument(),records:[]},ref:{id:'y2',etag:'"1"'}});
  assert.notStrictEqual(vault.readonlyRecords(),two);
  vault.lock();
  assert.equal(vault.recordsViewCache,null,'lock must release the cached decrypted view');
  assert.throws(()=>vault.readonlyRecords(),/ロック/);
});

test('the import batch defers full DOM renders but keeps feedback and final rendering',()=>{
  const code=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
  const begin=code.indexOf('function render() {');
  const end=code.indexOf('function attachSource(',begin);
  assert.ok(begin>=0&&end>begin);
  const events={feedback:0,rows:0,list:0,summary:0,sort:0};
  const node={classList:{contains:key=>key!=='hidden'}};
  const ctx=vm.createContext({filesBusy:true,revisionBusy:false,$:()=>node,events,
    updateImportUploadFeedback:()=>events.feedback++,applyCsvPaymentSettings:()=>{},
    refreshCardOptionLabels:()=>{},buildStatementList:()=>events.list++,renderSummary:()=>events.summary++,
    renderRows:()=>events.rows++,updateBatchStatus:()=>{},
    summaryUi:null,homeUi:null,analysisUi:null,subscriptionsUi:null,futureUi:null,
    renderManager:()=>{},renderRules:()=>{},syncCloudGate:()=>{}});
  vm.runInContext(code.slice(begin,end)+'\nthis.doRender=render;',ctx);
  ctx.doRender();ctx.doRender();
  assert.deepEqual(events,{feedback:2,rows:0,list:0,summary:0,sort:0});
  ctx.filesBusy=false;ctx.doRender();
  assert.equal(events.rows,1);
  assert.equal(events.list,1);
  assert.equal(events.summary,1);
  assert.equal(events.feedback,2);
});

test('PDF parser passes a distinct worker byte copy and file import reads original once',()=>{
  const pdf=readFileSync(new URL('../src/importers/pdf-reader.ts',import.meta.url),'utf8');
  const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  assert.match(pdf,/const data=originalBytes \? new Uint8Array\(originalBytes\)[\s\S]*?lib.getDocument\(\{\s*data,/);
  assert.match(main,/assertPdfLimits\(file\.size\);\s*\/\/ Read the Blob once[\s\S]*?const originalBytes=new Uint8Array\(await file\.arrayBuffer\(\)\);\s*if\(!current\(\)\)return;\s*const parsed=await parsePdfFile\(file,originalBytes,controller\.signal\);if\(!current\(\)\)return;/);
  assert.match(main,/acceptStatement\(parsed,\{bytes:originalBytes,mime:'application\/pdf'\}\)/);
  assert.doesNotMatch(main,/acceptStatement\(parsed,\{bytes:new Uint8Array\(await file\.arrayBuffer\(\)\)/);
});


test('Phase 4B: 同期後は表示中の画面だけ一度描画し、給与同期は維持する',async t=>{
  const code=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
  const render=code.slice(code.indexOf('function render() {'),code.indexOf('function attachSource('));
  const refresh=code.slice(code.indexOf('async function refreshCloud() {'),code.indexOf('async function migrateLegacy('));
  const counts={rules:0,assets:0,future:0,home:0,payroll:0};let visible='home-view';
  const vault={unlocked:true,exists:true,refresh:async()=>[]};
  const ctx=vm.createContext({filesBusy:false,revisionBusy:false,$:id=>({classList:{contains:()=>id!==visible}}),
    liveVault:vault,vaultDiscoveryCompleted:true,cloudStartupRunning:false,currentModal:null,cloudRefreshing:false,lastCloudCheckAt:0,assertRefreshSafe(){},
    renderRules:()=>counts.rules++,assetsUi:{render:()=>counts.assets++,refreshPayroll:async()=>{counts.payroll++;}},
    futureUi:{render:()=>counts.future++},homeUi:{render:()=>counts.home++},summaryUi:null,analysisUi:null,subscriptionsUi:null,
    syncCloudGate(){},updateCloudStatus(){}});
  vm.runInContext(render+refresh+'\nthis.doRefresh=refreshCloud;this.replaceCloudRecords=()=>render();',ctx);
  ctx.cloudStartupRunning=true;await assert.rejects(ctx.doRefresh(),/保管庫を確認中/);ctx.cloudStartupRunning=false;
  const results=[];
  for(const view of ['home-view','rules-view','assets-page','future-view']){
    visible=view;for(const k of Object.keys(counts))counts[k]=0;await ctx.doRefresh();results.push({...counts});
  }
  t.diagnostic(JSON.stringify(results));
  assert.deepEqual(results,[{rules:0,assets:0,future:0,home:1,payroll:1},{rules:1,assets:0,future:0,home:0,payroll:1},{rules:0,assets:1,future:0,home:0,payroll:1},{rules:0,assets:0,future:1,home:0,payroll:1}]);
});
