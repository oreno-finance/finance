import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectionAgeBounds,targetMonthForAge,futureProjection} from '../dist/src/cloud/future-projection.js';
import {emptyAssets,cardRecurringKey} from '../dist/src/cloud/assets.js';
import {
  detectCardSubscriptions,pendingCardSubscriptions,matchedCardRecurringDecision,
  legacyDecisionMigrationCandidate,latestRegisteredCardCharge,subscriptionDecision
} from '../dist/src/subscriptions/detect.js';
import {initMonthlyReports} from '../dist/src/ui/monthly-reports.js';

const rows=(merchant='VIDEO SERVICE')=>['2026-07','2026-08','2026-09','2026-10'].map(month=>({
  id:month,statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'test',
    billingMonth:month,paymentDate:`${month}-27`,statedTotal:980,confirmation:'confirmed',warnings:[],
    rows:[{id:month,usedOn:`${month}-01`,merchant,amount:980}]}
}));
const rule=(name)=>({id:'abc123-rule',pattern:'VIDEO',mode:'contains',displayName:name,cardId:null,enabled:true,priority:10});
const source=(rules,assets=emptyAssets())=>({records:rows(),assets,rules,categories:[],currentPeriod:'2026-11',payroll:{ready:false,syncedAt:null,entries:[]}});

test('age slider only offers birthday months within 50 years, never a past target',()=>{
  assert.deepEqual(projectionAgeBounds('2003-05','2026-11'),{min:24,max:73});
  const range=projectionAgeBounds('2003-05','2026-11');
  assert.equal(targetMonthForAge('2003-05',range.min),'2027-05');
  // A birthday already passed is still in the current calendar year, which is in the past:
  // the first *target birthday month* must be no earlier than the current month.
  assert.ok(targetMonthForAge('2003-05',range.min)>='2026-11');
  assert.ok(targetMonthForAge('2003-05',range.max)<='2076-11');
  assert.equal(projectionAgeBounds('2003-13','2026-11'),null);
  assert.deepEqual(projectionAgeBounds('2003-12','2026-11'),{min:23,max:72});
});

test('display rule renaming cannot change the stable issuer merchant decision key',()=>{
  const old=detectCardSubscriptions(source([rule('Old name')]),'2026-11')[0];
  const current=detectCardSubscriptions(source([rule('New name')]),'2026-11')[0];
  assert.equal(old.key,cardRecurringKey('smbc-nl','VIDEO SERVICE'));
  assert.equal(current.key,old.key);
  assert.notEqual(old.merchant,current.merchant);
  const saved=subscriptionDecision(old,'registered');
  assert.equal(saved.merchant,'video service');
  const assets=emptyAssets();assets.cardRecurringDecisions={[old.key]:saved};
  assert.deepEqual(pendingCardSubscriptions(source([rule('New name')],assets),'2026-11'),[]);
  assert.deepEqual(latestRegisteredCardCharge(source([rule('New name')],assets),old.key,'2026-11'),{month:'2026-10',amount:980});
});

test('unchanged legacy display decisions stay recognized; renamed ones need explicit unambiguous migration',()=>{
  const old=detectCardSubscriptions(source([rule('Legacy label')]),'2026-11')[0];
  const oldKey=cardRecurringKey('smbc-nl',old.merchant);
  const oldDecision={...subscriptionDecision(old,'registered'),merchant:'legacy label'};
  const legacy={[oldKey]:oldDecision};
  assert.equal(matchedCardRecurringDecision(legacy,old),oldKey);
  const next=detectCardSubscriptions(source([rule('Renamed label')]),'2026-11')[0];
  assert.equal(matchedCardRecurringDecision(legacy,next),null);
  assert.equal(legacyDecisionMigrationCandidate(legacy,[next],next),oldKey);
  const other={...next,key:cardRecurringKey('smbc-nl','OTHER'),merchant:'Other'};
  assert.equal(legacyDecisionMigrationCandidate(legacy,[next,other],next),null);
});

test('CSV is rejected based on File.size before allocating an ArrayBuffer',()=>{
  const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  assert.match(main,/if\(file\.size===0\|\|file\.size>2_000_000\)throw new Error\('CSVのサイズが不正です（上限2MB）。'\);\s*const bytes=await file\.arrayBuffer\(\);if\(!current\(\)\)return;\s*const text=decodeCardCsv\(bytes\)/);
});

class Node {
  constructor(tag='div'){this.tag=tag;this.children=[];this.attrs={};this.handlers={};this.value='';this.className='';this.textContent='';}
  get classList(){return {add:(name)=>{this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),name])].join(' ');}};}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=[...items];}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(k,callback){this.handlers[k]=callback;}
  querySelectorAll(){return [];}
  querySelector(selector){return walk(this).find(n=>selector.startsWith('.')&&n.className.split(/\s+/).includes(selector.slice(1)))??null;}
  get childNodes(){return this.children;}
}
const later=()=>{let resolve;const promise=new Promise(ok=>resolve=ok);return {promise,resolve};};
test('month switch during an in-flight report load supersedes old loading and finishes new loading',async()=>{
  const oldDocument=globalThis.document;
  const root=new Node('div');
  globalThis.document={getElementById:(id)=>id==='reports-content'?root:null,createElement:(tag)=>new Node(tag)};
  const pending=new Map();
  const vault={unlocked:true,loadArchivedReports:(period)=>{
    const deferred=later();pending.set(period,deferred);return deferred.promise;
  }};
  try{
    const ui=initMonthlyReports({source:()=>null,vault:()=>vault,openMonth:()=>{}});
    ui.openPeriod('2026-11');ui.render();
    assert.equal(ui.isBusy(),true);
    assert.deepEqual(root.children.map(n=>[n.tag,n.textContent,n.attrs.role]),[['p','読み込み中…','status']]);
    ui.openPeriod('2026-10');ui.render();
    assert.equal(ui.isBusy(),true);
    pending.get('2026-11').resolve([[],null]);
    await Promise.resolve();await Promise.resolve();
    assert.equal(ui.isBusy(),true,'outdated request must not clear the newer one');
    pending.get('2026-10').resolve([[],null]);
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(ui.isBusy(),false,'new request must clear its own busy flag');
    ui.reset();
  }finally{globalThis.document=oldDocument;}
});

function walk(node){return [node,...node.children.flatMap(walk)];}
test('saving locks its target month and reset discards any late UI response',async()=>{
  const original=globalThis.document;
  const root=new Node();
  globalThis.document={getElementById:(id)=>id==='reports-content'?root:null,createElement:(tag)=>new Node(tag)};
  const deferred=later();
  let writtenPeriod='';
  const vault={unlocked:true,loadArchivedReports:async()=>[[],null],
    saveArchivedReport:(snapshot)=>{writtenPeriod=snapshot.period;return deferred.promise;}};
  const src={records:[],assets:emptyAssets(),rules:[],categories:[],currentPeriod:'2026-10',payroll:{ready:false,syncedAt:null,entries:[]}};
  try{
    const ui=initMonthlyReports({source:()=>src,vault:()=>vault,openMonth:()=>{}});
    ui.openPeriod('2026-10');ui.render();
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    const action=walk(root).find(n=>n.tag==='button'&&n.textContent==='レポートを作成');
    assert.ok(action,'report save action must become available');
    action.handlers.click();
    assert.equal(ui.isBusy(),true);
    assert.deepEqual(root.children.map(n=>[n.tag,n.textContent,n.attrs.role]),[['p','保存中…','status']]);
    ui.openPeriod('2026-11'); // Cannot change the save's selected period mid-flight.
    assert.equal(writtenPeriod,'2026-10');
    ui.reset(); // Simulate a lock or account change while cloud write is pending.
    deferred.resolve({current:{id:'test',note:'',savedAt:'2026-11-01T00:00:00Z'}});
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(ui.isBusy(),false);
    assert.deepEqual(root.children,[],'a stale save must not reinsert private report content after reset');
  }finally{globalThis.document=original;}
});

test('L303: failed comparison is visible and preserves the saved report',async()=>{
 const {reportSnapshot,snapshotHash}=await import('../dist/src/reports/monthly-report.js');
 const original=globalThis.document,originalOption=globalThis.Option,root=new Node();
 globalThis.Option=class extends Node{constructor(text,value){super('option');this.textContent=text;this.value=value;}};
 globalThis.document={getElementById:id=>id==='reports-content'?root:null,createElement:tag=>new Node(tag)};
 const src={records:[],assets:emptyAssets(),rules:[],categories:[],currentPeriod:'2026-10',payroll:{ready:false,syncedAt:null,entries:[]}};
 const snapshot=reportSnapshot('2026-10',src),hash=await snapshotHash(snapshot);
 const archive={current:{id:'fixture',snapshot,sourceHash:hash,note:'saved note',savedAt:'2026-10-20T00:00:00Z'},history:[]};
 let writes=0,memoWrites=0;const vault={unlocked:true,loadArchivedReports:async()=>[[],archive],saveArchivedReport:async()=>{writes++;return archive;},saveArchivedReportNote:async(period,note,revision)=>{assert.equal(period,'2026-10');assert.equal(note,'saved note');assert.equal(revision,'fixture');memoWrites++;return archive;}};
 try{
  const ui=initMonthlyReports({source:()=>{throw new Error('synthetic calculation failure');},vault:()=>vault,openMonth:()=>{}});
  ui.openPeriod('2026-10');ui.render();
  await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  const notice=root.querySelector('.reports-source-changed');assert.ok(notice);assert.equal(notice.hidden,false);
  assert.match(notice.textContent,/一致を確認できません/);
  assert.equal(walk(root).find(n=>n.tag==='textarea').value,'saved note');
  walk(root).find(n=>n.tag==='button'&&n.textContent==='レポートを更新').handlers.click();
  await Promise.resolve();await Promise.resolve();
  assert.equal(writes,0);assert.equal(ui.isBusy(),false);
  assert.equal(walk(root).find(n=>n.tag==='textarea').value,'saved note');
  const memoOnly=root.querySelector('.reports-note-only');assert.equal(memoOnly.hidden,false);memoOnly.handlers.click();
  await Promise.resolve();await Promise.resolve();await Promise.resolve();assert.equal(memoWrites,1);assert.equal(writes,0);
  ui.reset();
 }finally{globalThis.document=original;globalThis.Option=originalOption;}
});
