import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {detectCardSubscriptions,pendingCardSubscriptions,subscriptionDecision} from '../dist/src/subscriptions/detect.js';
import {emptyAssets,validateAssets,validateCardRecurringDecisions,mergeAssets,detectAssetsEditCollisions,cardRecurringKey} from '../dist/src/cloud/assets.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
const record=(p,merchant='MICROSOFT 365',amount=1490,cardId='smbc-nl',confirmation='confirmed',i=0)=>({
  id:`${p}-${cardId}-${i}`,statement:{provider:'smbc',cardId,sourceKind:'paste',sourceName:'test',
    billingMonth:p,paymentDate:`${p}-27`,statedTotal:amount,confirmation,warnings:[],
    rows:[{id:`r-${p}-${i}`,usedOn:`${p}-01`,merchant,amount}]}});
const source=(records,assets=emptyAssets(),rules=[])=>({records,rules,categories:[],assets,
  payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'});
const months=['2026-07','2026-08','2026-09','2026-10'];
const records=()=>months.map(p=>record(p));

test('monthly card charges are suggested using payment month, card identity and rule alias',()=>{
  const data=source(records(),emptyAssets(),[{id:'normalized-rule',pattern:'MICROSOFT',mode:'contains',displayName:'Microsoft 365',cardId:null,enabled:true,priority:10}]);
  const c=detectCardSubscriptions(data,'2026-11');
  assert.equal(c.length,1);assert.equal(c[0].frequency,'monthly');assert.equal(c[0].amount,1490);
  assert.deepEqual(c[0].months,months);
  assert.equal(c[0].merchant,'Microsoft 365');assert.equal(c[0].cardId,'smbc-nl');
});
test('provisional, invalid, duplicate billing months and refunds cannot manufacture evidence',()=>{
  const faulty=[record('2026-07'),record('2026-08','MICROSOFT 365',1490,'smbc-nl','provisional'),record('2026-09'),record('2026-10')];
  assert.equal(detectCardSubscriptions(source(faulty),'2026-11').length,0);
  const dup=[...records(),record('2026-09','DIFFERENT',10,'smbc-nl','confirmed',1)];
  assert.equal(detectCardSubscriptions(source(dup),'2026-11').length,0);
  assert.equal(detectCardSubscriptions(source(months.map(p=>record(p,'REFUND',-990))),'2026-11').length,0);
});
test('price adjustments within 8% are allowed, unrelated high amounts are not',()=>{
  const variation=[1490,1530,1500,1550];
  assert.equal(detectCardSubscriptions(source(months.map((p,i)=>record(p,'SERVICE',variation[i]))),'2026-11').length,1);
  const wrong=[1490,1490,6000,6000];
  assert.equal(detectCardSubscriptions(source(months.map((p,i)=>record(p,'SERVICE',wrong[i]))),'2026-11').length,0);
});
test('yearly subscriptions need at least two distinct years with matching payment months',()=>{
  const annual=source(['2024-10','2025-10','2026-10'].map(p=>record(p,'ANNUAL',12000)));
  const items=detectCardSubscriptions(annual,'2026-11');
  assert.equal(items.length,1);assert.equal(items[0].frequency,'yearly');
  assert.deepEqual(items[0].months,['2025-10','2026-10']);
  assert.equal(detectCardSubscriptions(source([record('2026-10','ANNUAL',12000)]),'2026-11').length,0);
  assert.equal(detectCardSubscriptions(source([record('2025-09','ANNUAL',12000),record('2026-10','ANNUAL',12000)]),'2026-11').length,0);
});
test('NISA card investments and already registered bank recurring expenses are not suggested',()=>{
  const assets=emptyAssets();assets.nisaCardRule={enabled:true,cardId:'smbc-nl',merchantContains:'MICROSOFT',};
  assert.equal(detectCardSubscriptions(source(records(),assets),'2026-11').length,0);
  assets.nisaCardRule=null;
  assets.recurring.push({id:'bank-schedule-1',name:'MICROSOFT 365',amount:1490,kind:'expense',
    fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:27,monthOfYear:null,weekday:null,
    startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true});
  assert.equal(detectCardSubscriptions(source(records(),assets),'2026-11').length,0);
});
test('registered and ignored decisions hide candidates, remain encrypted assets metadata, never change financial totals',()=>{
  const initial=source(records());const before=monthlyReport('2026-10',initial);
  const cand=detectCardSubscriptions(initial,'2026-11')[0];
  const assets=emptyAssets();const decision=subscriptionDecision(cand,'registered','2026-11-01T00:00:00.000Z');
  assets.cardRecurringDecisions={[cand.key]:decision};
  const verified=validateAssets(assets);
  assert.equal(verified.cardRecurringDecisions[cand.key].state,'registered');
  const updated=source(records(),verified);
  assert.deepEqual(pendingCardSubscriptions(updated,'2026-11'),[]);
  const after=monthlyReport('2026-10',updated);
  assert.equal(before.cardOutflow,after.cardOutflow);
  assert.equal(before.recurringExpense,after.recurringExpense);
  assert.equal(before.monthlyBalance,after.monthlyBalance);
  const ignored=subscriptionDecision(cand,'ignored','2026-11-01T00:00:00.000Z');
  assert.equal(ignored.state,'ignored');
  assert.equal(pendingCardSubscriptions(source(records(),{...verified,cardRecurringDecisions:{[cand.key]:ignored}}),'2026-11').length,0);
});
test('existing old assets remain readable; invalid decisions are rejected',()=>{
  assert.equal(validateAssets(emptyAssets()).cardRecurringDecisions,undefined);
  const key=cardRecurringKey('smbc-nl','SERVICE');
  const valid={cardId:'smbc-nl',merchant:'service',label:'Service',amount:2000,frequency:'monthly',state:'ignored',updatedAt:'2026-11-18T00:00:00Z'};
  assert.equal(validateCardRecurringDecisions({[key]:valid})[key].amount,2000);
  for(const bad of [
    {'not-a-card|service':valid},
    {[key]:{...valid,amount:0}},
    {[key]:{...valid,state:'active'}},
    {[key]:{...valid,updatedAt:'invalid'}},
    {[key]:{...valid,merchant:'OTHER'}},
  ])assert.throws(()=>validateAssets({...emptyAssets(),cardRecurringDecisions:bad}));
});
test('different card decisions merge; same key edits require approval',()=>{
  const base=emptyAssets();const local=structuredClone(base),remote=structuredClone(base);
  const make=(cardId,merchant,state)=>({cardId,merchant,label:merchant,amount:1000,frequency:'monthly',state,updatedAt:'2026-11-01T00:00:00Z'});
  const a=cardRecurringKey('smbc-nl','A'),b=cardRecurringKey('amazon','B');
  local.cardRecurringDecisions={[a]:make('smbc-nl','a','registered')};
  remote.cardRecurringDecisions={[b]:make('amazon','b','ignored')};
  assert.deepEqual(detectAssetsEditCollisions(base,local,remote),[]);
  const merged=mergeAssets(base,local,remote);
  assert.equal(merged.cardRecurringDecisions[a].state,'registered');
  assert.equal(merged.cardRecurringDecisions[b].state,'ignored');
  remote.cardRecurringDecisions={[a]:make('smbc-nl','a','ignored')};
  const conflicts=detectAssetsEditCollisions(base,local,remote);
  assert.deepEqual(conflicts,[{itemId:'card-recurring-decisions',field:a}]);
});
test('screen includes separate analysis-only actions, and tracks new navigation',()=>{
  const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
  assert.match(html,/id="nav-subscriptions"/);assert.match(html,/id="subscriptions-content"/);
  assert.match(styleOrder,/subscriptions-v183.css/);
  const js=readFileSync(new URL('../dist/src/ui/subscriptions.js',import.meta.url),'utf8');
  assert.match(js,/候補から除外/);assert.match(js,/カード払い/);
  const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  assert.match(main,/function interruptionState\(\)[\s\S]*?subscriptionsUi\?\.isBusy\(\)/);
  assert.match(main,/beforeunload[\s\S]*?hasInterruptionRisk\(state\)/);
});

test('encrypted decisions survive fresh vault unlock and passphrase rotation without plaintext leakage',async()=>{
  const {webcrypto}=await import('node:crypto');if(!globalThis.crypto)globalThis.crypto=webcrypto;
  const {LiveVault}=await import('../dist/src/cloud/live-vault.js');
  const {GraphError}=await import('../dist/src/cloud/onedrive-api.js');
  class MockGraph {
    constructor(store=new Map(),generation=null){this.store=store;this.generation=generation;}
    setVaultDataSet(id){this.generation=id;}
    forVaultDataSet(id){return new MockGraph(this.store,id);}
    key(name){return `${this.generation??'legacy'}:${name}`;}
    read(name){const key=name==='index'?'root:index':this.key(name),v=this.store.get(key);return v?{id:key,etag:String(v.rev),text:v.text}:null;}
    write(name,text,ref){const key=name==='index'?'root:index':this.key(name),v=this.store.get(key);
      if(v&&(!ref||ref.etag!==String(v.rev)))throw new GraphError(412,'conflict');
      if(!v&&ref)throw new GraphError(412,'conflict');
      const rev=(v?.rev??0)+1;this.store.set(key,{rev,text});return this.read(name);}
    async readFinanceIndex(){return this.read('index');}
    async writeFinanceIndex(text,ref){return this.write('index',text,ref);}
    async readLiveVault(){return null;}async ensurePayrollNamespace(){}
    async listYearFiles(){return [];}async readAssetSettings(){return this.read('assets');}
    async writeAssetSettings(text,ref){return this.write('assets',text,ref);}
    async readMerchantRules(){return null;}
  }
  const oldPass='recurring testing vault secret 2026';
  const newPass='recurring testing vault new secret 2026';
  const graph=new MockGraph(),vault=new LiveVault(graph);
  await vault.create(oldPass);
  const key=cardRecurringKey('smbc-nl','subscription');
  const decision={cardId:'smbc-nl',merchant:'subscription',label:'SUBSCRIPTION',amount:1500,
    frequency:'monthly',state:'registered',updatedAt:'2026-11-18T00:00:00Z'};
  await vault.setCardRecurringDecision(key,decision);
  assert.equal(graph.store.get(graph.key('assets')).text.includes('SUBSCRIPTION'),false);
  const reader=new LiveVault(new MockGraph(graph.store));await reader.unlock(oldPass);
  assert.equal(reader.assetSettings().cardRecurringDecisions[key].state,'registered');
  await reader.changePassphrase(oldPass,newPass);
  const after=new LiveVault(new MockGraph(graph.store));await after.unlock(newPass);
  assert.equal(after.assetSettings().cardRecurringDecisions[key].amount,1500);
  await after.setCardRecurringDecision(key,null);
  assert.equal(after.assetSettings().cardRecurringDecisions?.[key],undefined);
  const peer=new LiveVault(new MockGraph(graph.store));await peer.unlock(newPass);
  await after.setCardRecurringDecision(key,{...decision,state:'registered'});
  await assert.rejects(peer.setCardRecurringDecision(key,{...decision,state:'ignored'}),/別の端末/);
  assert.equal(after.assetSettings().cardRecurringDecisions[key].state,'registered');
});
