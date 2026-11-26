import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {emptyAssets, validateAssets, validateSnapshot, validateRecurring, latestBalance, mergeAssets} from '../dist/src/cloud/assets.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {encryptAssets, decryptAssets, freshSalt, deriveCloudKey, encryptRules} from '../dist/src/cloud/cloud-crypto.js';
import {emptyRules} from '../dist/src/cloud/merchant-rules.js';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const secret='a very long test passphrase for finance';
const snap=(id='snapshot-1',accountId='rakuten-bank',balance=125000,observedAt='2026-11-16T01:30:00.000Z')=>({id,accountId,balance,observedAt});
const item=(id='recurring-1',patch={})=>({id,name:'貯金口座への積立',amount:10000,kind:'transfer',fromAccountId:'rakuten-bank',toAccountId:'cash-savings',frequency:'monthly',dayOfMonth:27,monthOfYear:null,weekday:null,startOn:'2026-11-01',endOn:null,categoryId:null,enabled:true,...patch});
class FakeGraph {
  constructor(store){this.store=store;this.failSave=false;}
  read(k){const v=this.store.get(k);return v?{text:v.text,id:k,etag:`"${v.rev}"`}:null;}
  write(k,text,ref){
    if(this.failSave)throw new Error('simulated network outage');
    const before=this.store.get(k);
    if(before && (!ref||ref.etag!==`"${before.rev}"`))throw new GraphError(412,'conflict');
    if(!before && ref)throw new GraphError(412,'conflict');
    const rev=(before?.rev??0)+1;this.store.set(k,{text,rev});return {id:k,etag:`"${rev}"`};
  }
  async readFinanceIndex(){return this.read('index');}
  async writeFinanceIndex(text,ref){this.write('index',text,ref);}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async listYearFiles(){return [];}
  async readMerchantRules(){return this.read('rules');}
  async writeMerchantRules(text,ref){return this.write('rules',text,ref);}
  async readAssetSettings(){return this.read('assets');}
  async writeAssetSettings(text,ref){return this.write('assets',text,ref);}
}

test('three independent asset balances can be snapshotted at precise instants',()=>{
  const doc={...emptyAssets(),snapshots:[snap('snapshot-old','rakuten-bank',100000,'2026-11-01T01:30:00.000Z'),snap('snapshot-new'),snap('snapshot-nisa','nisa',500000)]};
  assert.equal(latestBalance(doc,'rakuten-bank').balance,125000);
  assert.equal(latestBalance(doc,'rakuten-bank','2026-11-10T00:00:00.000Z').balance,100000);
  assert.equal(latestBalance(doc,'nisa').balance,500000);
  assert.equal(latestBalance(doc,'cash-savings'),null);
  assert.equal(validateSnapshot(snap()).observedAt,'2026-11-16T01:30:00.000Z');
});

test('validation rejects negative balances, noninteger money, invalid dates and invalid transfers',()=>{
  assert.throws(()=>validateSnapshot(snap('snapshot-1','nisa',-2)),/不正/);
  assert.throws(()=>validateSnapshot(snap('snapshot-1','nisa',1.5)),/不正/);
  assert.throws(()=>validateSnapshot(snap('snapshot-1','nisa',10,'2026-13-99T01:00:00Z')),/不正/);
  assert.throws(()=>validateRecurring(item('recurring-1',{toAccountId:'rakuten-bank'})),/別/);
  assert.throws(()=>validateRecurring(item('recurring-1',{endOn:'2026-10-01'})),/不正/);
  assert.throws(()=>validateRecurring(item('recurring-1',{dayOfMonth:32})),/不正/);
  assert.deepEqual(validateRecurring(item()),item());
  assert.deepEqual(validateRecurring(item('recurring-w',{frequency:'weekly',dayOfMonth:null,monthOfYear:null,weekday:3})).weekday,3);
  assert.deepEqual(validateRecurring(item('recurring-y',{frequency:'yearly',monthOfYear:12})).monthOfYear,12);
  assert.throws(()=>validateAssets({...emptyAssets(),snapshots:[snap(),snap()]}),/重複/);
});

test('assets encryption uses independent authenticated context and hides personal values',async()=>{
  const salt=freshSalt(),key=await deriveCloudKey(secret,salt);
  const doc={...emptyAssets(),snapshots:[snap()],recurring:[item()]};
  const encoded=await encryptAssets(doc,key,salt);
  assert.equal(encoded.includes('貯金口座'),false);
  assert.equal(encoded.includes('125000'),false);
  assert.deepEqual(await decryptAssets(encoded,key,salt),doc);
  await assert.rejects(decryptAssets(encoded,key,freshSalt()),/ソルト/);
  await assert.rejects(decryptAssets(encoded,await deriveCloudKey('wrong password',salt),salt),/復号/);
  const rules=await encryptRules(emptyRules(),key,salt);
  await assert.rejects(decryptAssets(rules,key,salt),/暗号形式/);
  const parsed=JSON.parse(encoded);parsed.data='AAAA'+parsed.data.slice(4);
  await assert.rejects(decryptAssets(JSON.stringify(parsed),key,salt),/復号/);
});

test('independent inserts, edits and tombstone deletion safely merge from stale clients',()=>{
  const base={...emptyAssets(),snapshots:[snap()],recurring:[item()]};
  const a=structuredClone(base),b=structuredClone(base);
  a.snapshots.push(snap('snapshot-nisa','nisa',800000));
  a.recurring[0].amount=11000;
  b.snapshots.push(snap('snapshot-savings','cash-savings',100000));
  b.recurring[0].name='現金貯金へ';
  const merged=mergeAssets(base,a,b);
  assert.equal(merged.snapshots.length,3);
  assert.equal(merged.recurring[0].amount,11000);
  assert.equal(merged.recurring[0].name,'現金貯金へ');
  const deleted=structuredClone(base);
  deleted.recurring=[];deleted.deletedRecurring=['recurring-1'];
  assert.equal(mergeAssets(base,deleted,base).recurring.length,0);
  assert.equal(mergeAssets(base,base,deleted).recurring.length,0);
  const other=structuredClone(base);other.recurring[0].amount=13000;
  assert.equal(mergeAssets(base,deleted,other).recurring[0].amount,13000);
  const conflicting=mergeAssets(base,{...base,recurring:[item('recurring-1',{amount:17000})]},{...base,recurring:[item('recurring-1',{amount:14000})]});
  assert.equal(conflicting.recurring[0].amount,17000);
  assert.equal(conflicting.conflicts.at(-1).discarded,14000);
});

test('LiveVault saves assets independently, preserves when unlocked and never touches statements',async()=>{
  const store=new Map();const a=new LiveVault(new FakeGraph(store));
  await a.create(secret);
  assert.deepEqual([...store.keys()],['index']);
  await a.addBalanceSnapshot(snap());
  await a.upsertRecurring(item());
  assert.deepEqual([...store.keys()].sort(),['assets','index']);
  assert.equal(store.get('assets').text.includes('貯金口座への積立'),false);
  const b=new LiveVault(new FakeGraph(store));await b.unlock(secret);
  assert.equal(b.assetSettings().snapshots[0].balance,125000);
  assert.equal(b.assetSettings().recurring[0].amount,10000);
  b.lock();assert.throws(()=>b.assetSettings(),/ロック解除/);
});

test('two devices merge independent balance histories and repeat settings without losing edits',async()=>{
  const store=new Map(),a=new LiveVault(new FakeGraph(store)),b=new LiveVault(new FakeGraph(store));
  await a.create(secret);await b.unlock(secret);
  await a.addBalanceSnapshot(snap('snapshot-a'));
  await b.addBalanceSnapshot(snap('snapshot-b','nisa',40000));
  await a.upsertRecurring(item('recurring-a'));
  await b.upsertRecurring(item('recurring-b',{kind:'expense',toAccountId:null,name:'保険',amount:9900}));
  await a.refresh();
  assert.equal(a.assetSettings().snapshots.length,2);
  assert.equal(a.assetSettings().recurring.length,2);
  await a.deleteRecurring('recurring-a');
  await b.upsertRecurring(item('recurring-c'));
  await a.refresh();
  assert.deepEqual(a.assetSettings().recurring.map(x=>x.id).sort(),['recurring-b','recurring-c']);
});

test('failed Graph saves never mark in-memory settings as saved',async()=>{
  const store=new Map(),graph=new FakeGraph(store),a=new LiveVault(graph);
  await a.create(secret);graph.failSave=true;
  await assert.rejects(a.addBalanceSnapshot(snap()),/outage/);
  assert.equal(a.assetSettings().snapshots.length,0);
  assert.equal(store.has('assets'),false);
  // A timeout-like upload failure could have committed remotely; reconcile before retrying.
  graph.failSave=false;await a.refresh();await a.addBalanceSnapshot(snap());
  graph.failSave=true;
  await assert.rejects(a.deleteBalanceSnapshot('snapshot-1'),/outage/);
  assert.equal(a.assetSettings().snapshots.length,1);
});

test('one save action commits multiple account snapshots together in one cloud write',async()=>{
  const store=new Map(),graph=new FakeGraph(store),vault=new LiveVault(graph);
  let writes=0;
  const original=graph.writeAssetSettings.bind(graph);
  graph.writeAssetSettings=async(...args)=>{writes++;return original(...args);};
  await vault.create(secret);
  const snapshots=[snap('bulk-rakuten','rakuten-bank',205000),snap('bulk-savings','cash-savings',80000)];
  await vault.addBalanceSnapshots(snapshots);
  assert.equal(writes,1);
  assert.deepEqual(vault.assetSettings().snapshots.map(x=>x.id),['bulk-rakuten','bulk-savings']);
  await assert.rejects(vault.addBalanceSnapshots([snap('bulk-nisa','nisa',5000),snap('bulk-rakuten','rakuten-bank',3)]),/登録できません/);
  await assert.rejects(vault.addBalanceSnapshots([snap('bad-negative','nisa',-1)]),/不正/);
  assert.equal(writes,1,'validation failures never reach Graph');
  graph.failSave=true;
  await assert.rejects(vault.addBalanceSnapshots([snap('network-failure','nisa',42000)]),/outage/);
  assert.equal(vault.assetSettings().snapshots.length,2,'failed save does not mutate visible balances');
  graph.failSave=false;
  await vault.refresh(); // Ambiguous writes block resubmission until remote state is re-read.
  await vault.addBalanceSnapshot(snap('single-compatible','nisa',42000));
  assert.equal(writes,3,'existing single-snapshot API still works');
  assert.equal(vault.assetSettings().snapshots.length,3);
});

test('NISA card matching is encrypted and persists without exposing merchant terms in ciphertext',async()=>{
  const store=new Map(),vault=new LiveVault(new FakeGraph(store));await vault.create(secret);
  await vault.setNisaCardRule({cardId:'rakuten-mizuho',merchantContains:'楽天証券',enabled:true});
  const encrypted=store.get('assets').text;
  assert.equal(encrypted.includes('楽天証券'),false);
  assert.equal(vault.assetSettings().nisaCardRule.merchantContains,'楽天証券');
  const other=new LiveVault(new FakeGraph(store));await other.unlock(secret);
  assert.deepEqual(other.assetSettings().nisaCardRule,{cardId:'rakuten-mizuho',merchantContains:'楽天証券',enabled:true});
  await other.setNisaCardRule(null);
  assert.equal(other.assetSettings().nisaCardRule,null);
});

test('stale device updating an independent balance cannot erase newly enabled NISA linkage',async()=>{
  const store=new Map(),first=new LiveVault(new FakeGraph(store)),stale=new LiveVault(new FakeGraph(store));
  await first.create(secret);await stale.unlock(secret);
  await first.setNisaCardRule({cardId:'rakuten-mizuho',merchantContains:'楽天証券',enabled:true});
  await stale.addBalanceSnapshot(snap('independent-snapshot','cash-savings',123000));
  await first.refresh();
  assert.equal(first.assetSettings().nisaCardRule.merchantContains,'楽天証券');
  assert.equal(first.assetSettings().snapshots.length,1);
});

test('LiveVault keeps NISA rule history encrypted and restores it after refresh and re-unlock',async()=>{
  const store=new Map();
  const first=new LiveVault(new FakeGraph(store));await first.create(secret);
  await first.setNisaCardRule({cardId:'smbc-nl',merchantContains:'RAKUTEN SECURITIES',enabled:true},'2026-11-20');
  await first.setNisaCardRule({cardId:'amazon',merchantContains:'INVEST',enabled:true},'2026-11-21');
  const original=first.assetSettings();
  assert.equal(original.nisaCardRuleHistory[0].effectiveOn,'2026-11-22');
  assert.equal(original.nisaCardRuleHistory[0].previous.cardId,'smbc-nl');
  assert.equal(store.get('assets').text.includes('RAKUTEN SECURITIES'),false);
  const second=new LiveVault(new FakeGraph(store));await second.unlock(secret);
  assert.deepEqual(second.assetSettings().nisaCardRuleHistory,original.nisaCardRuleHistory);
  await second.setNisaCardRule(null,'2026-11-22');
  await first.refresh();
  assert.equal(first.assetSettings().nisaCardRule,null);
  assert.equal(first.assetSettings().nisaCardRuleHistory.length,2);
  assert.equal(first.assetSettings().nisaCardRuleHistory[1].previous.cardId,'amazon');
});


test('bank warning settings survive encrypted writes, unlock, independent edits and clearing',async()=>{
  const store=new Map(),a=new LiveVault(new FakeGraph(store));await a.create(secret);
  await a.addBalanceSnapshot(snap());
  const b=new LiveVault(new FakeGraph(store));await b.unlock(secret);
  await a.setBalanceWarningLimits({'rakuten-bank':50000});
  await b.setBalanceWarningLimits({'mizuho-bank':10000});
  const c=new LiveVault(new FakeGraph(store));await c.unlock(secret);
  assert.deepEqual(c.assetSettings().balanceWarningLimits,{'rakuten-bank':50000,'mizuho-bank':10000});
  assert.equal(c.assetSettings().snapshots[0].balance,125000);
  assert.ok(!store.get('assets').text.includes('balanceWarningLimits'));
  await assert.rejects(c.setBalanceWarningLimits({'rakuten-bank':-1}),/残高警告/);
  await c.setBalanceWarningLimits({'rakuten-bank':0,'mizuho-bank':10000});
  c.lock();await c.unlock(secret);
  assert.deepEqual(c.assetSettings().balanceWarningLimits,{'mizuho-bank':10000});
});
