import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyRules,validateRule,validateRules,mergeRules,matchingRule,displayMerchant,normalizeMerchant} from '../dist/src/cloud/merchant-rules.js';
import {freshSalt,deriveCloudKey,encryptRules,decryptRules,parseEnvelope,decryptDocument,encryptDocument} from '../dist/src/cloud/cloud-crypto.js';
import {emptyDocument} from '../dist/src/cloud/merge.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';

const secret='長くて安全な1Passwordのパスフレーズ';
const item=(id,pattern,displayName,extra={})=>({id,pattern,displayName,mode:'contains',cardId:null,enabled:true,priority:100,...extra});

test('comparison is normalized, but original issuer merchant never mutates',()=>{
  const original='ＡＭＡＺＯＮ  .CO.JP';
  const rules=[item('rule-1','amazon .co.jp','Amazon')];
  assert.equal(normalizeMerchant(original),'amazon .co.jp');
  assert.equal(displayMerchant(original,null,rules),'Amazon');
  assert.equal(original,'ＡＭＡＺＯＮ  .CO.JP');
  assert.equal(displayMerchant(original,null,rules,'特別な注文'),'特別な注文');
  assert.equal(displayMerchant(original,null,[]),original);
});

test('exact, prefix and contains matching, priorities and per-card scope',()=>{
  const rules=[
    item('rule-1','AMAZON','一般Amazon',{priority:10}),
    item('rule-2','AMAZON.CO.JP','正規Amazon',{mode:'exact',priority:100}),
    item('rule-3','AMAZON','Amazon専用カード',{cardId:'amazon',priority:200}),
    item('rule-4','SEVEN','セブン',{mode:'prefix'}),
    item('rule-5','AMAZON','一時停止中',{priority:999,enabled:false}),
  ];
  assert.equal(matchingRule('amazon.co.jp','recruit-jcb',rules)?.id,'rule-2');
  assert.equal(matchingRule('Amazon-Market','amazon',rules)?.id,'rule-3');
  assert.equal(matchingRule('SEVEN 7','recruit-jcb',rules)?.id,'rule-4');
  assert.equal(matchingRule('Hello SEVEN','recruit-jcb',rules),undefined);
  assert.equal(displayMerchant('Hello','amazon',rules),'Hello');
});

test('same priority selects exact, then prefix, then contains and longer pattern',()=>{
  const rules=[item('rule-1','abc','含む'),item('rule-2','ab','前方',{mode:'prefix'}),item('rule-3','ABC','完全',{mode:'exact'})];
  assert.equal(displayMerchant('abc',null,rules),'完全');
  assert.equal(displayMerchant('abcd',null,rules),'前方');
});

test('rule validation rejects invalid predicates and oversized docs',()=>{
  assert.throws(()=>validateRule(item('rule-1','  ','無効')),/不正/);
  assert.throws(()=>validateRule(item('rule-1','a','b',{mode:'regex'})),/不正/);
  assert.throws(()=>validateRule(item('rule-1','a','b',{priority:-3})),/不正/);
  assert.throws(()=>validateRules({...emptyRules(),rules:[item('rule-1','A','B'),item('rule-1','C','D')]}),/重複/);
});

test('concurrent additions merge; edits to different fields preserve both',()=>{
  const base=emptyRules();
  const local={...base,rules:[item('rule-local','A','表示A')]};
  const remote={...base,rules:[item('rule-remote','B','表示B')]};
  const joined=mergeRules(base,local,remote);
  assert.deepEqual(joined.rules.map(r=>r.id).sort(),['rule-local','rule-remote']);
  const first={...joined,rules:joined.rules.map(r=>r.id==='rule-local'?{...r,displayName:'別名A'}:r)};
  const second={...joined,rules:joined.rules.map(r=>r.id==='rule-local'?{...r,priority:300}:r)};
  const merged=mergeRules(joined,first,second);
  assert.equal(merged.rules.find(r=>r.id==='rule-local').displayName,'別名A');
  assert.equal(merged.rules.find(r=>r.id==='rule-local').priority,300);
});

test('same-field edits keep losing value in encrypted conflict log',()=>{
  const base={...emptyRules(),rules:[item('rule-1','A','旧名')]};
  const local={...base,rules:[item('rule-1','A','Mac案')]};
  const remote={...base,rules:[item('rule-1','A','Galaxy案')]};
  const merged=mergeRules(base,local,remote);
  assert.equal(merged.rules[0].displayName,'Mac案');
  assert.equal(merged.conflicts[0].discarded,'Galaxy案');
  assert.equal(merged.conflicts[0].chosen,'Mac案');
});

test('deleted rules do not resurrect; delete vs edit preserves edited rule and audits conflict',()=>{
  const base={...emptyRules(),rules:[item('rule-1','A','最初')]};
  const removed={...emptyRules(),deleted:['rule-1']};
  assert.deepEqual(mergeRules(base,removed,base).rules,[]);
  assert.deepEqual(mergeRules(base,base,removed).rules,[]);
  const changed={...base,rules:[item('rule-1','A','更新後')]};
  const merged=mergeRules(base,removed,changed);
  assert.equal(merged.rules[0].displayName,'更新後');
  assert.equal(merged.conflicts.at(-1).discarded,'削除');
});

test('rules encryption is separate and authenticated; no plaintext and wrong-key rejection',async()=>{
  const salt=freshSalt(),key=await deriveCloudKey(secret,salt);
  const doc={...emptyRules(),rules:[item('rule-1','SECRET STORE','PRIVATE ALIAS')]};
  const ciphertext=await encryptRules(doc,key,salt);
  assert.equal(ciphertext.includes('SECRET STORE'),false);
  assert.equal(ciphertext.includes('PRIVATE ALIAS'),false);
  assert.deepEqual(await decryptRules(ciphertext,key,salt),doc);
  await assert.rejects(decryptRules(ciphertext,key,freshSalt()),/ソルト/);
  await assert.rejects(decryptRules(ciphertext,await deriveCloudKey('wrong pass',salt),salt),/復号/);
  const parsed=JSON.parse(ciphertext);parsed.data='AAAA'+parsed.data.slice(4);
  await assert.rejects(decryptRules(JSON.stringify(parsed),key,salt),/復号/);
  const statement=await encryptDocument(emptyDocument(),key,salt);
  await assert.rejects(decryptRules(statement,key,salt),/暗号形式/);
});

class FakeGraph {
  constructor(store){this.store=store;}
  async readFinanceIndex(){return this.read('index');}
  async writeFinanceIndex(text,ref){return this.write('index',text,ref);}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async listYearFiles(){return [];}
  async readMerchantRules(){return this.read('rules');}
  async writeMerchantRules(text,ref){return this.write('rules',text,ref);}
  read(kind){const data=this.store.get(kind);return data?{text:data.text,id:kind,etag:`"${data.rev}"`}:null;}
  write(kind,text,ref){const prev=this.store.get(kind);
    if(prev && (!ref || ref.etag!==`"${prev.rev}"`))throw new GraphError(412,'conflict');
    if(!prev&&ref)throw new GraphError(412,'conflict');
    const rev=(prev?.rev??0)+1;this.store.set(kind,{text,rev});return {id:kind,etag:`"${rev}"`};
  }
}

test('LiveVault syncs encrypted rule file, auto-merges independent device additions and leaves annual files alone',async()=>{
  const store=new Map();const a=new LiveVault(new FakeGraph(store)),b=new LiveVault(new FakeGraph(store));
  await a.create(secret);await b.unlock(secret);
  await a.upsertMerchantRule(item('rule-1','AMAZON','Amazon'));
  await b.upsertMerchantRule(item('rule-2','SEVEN','セブン'));
  assert.equal(store.has('rules'),true);
  assert.equal(store.get('rules').text.includes('AMAZON'),false);
  assert.deepEqual([...store.keys()].sort(),['index','rules']);
  await a.refresh();
  assert.deepEqual(a.merchantRules().map(r=>r.id).sort(),['rule-1','rule-2']);
  await a.removeMerchantRule('rule-1');
  await b.refresh();assert.deepEqual(b.merchantRules().map(r=>r.id),['rule-2']);
  b.lock();assert.throws(()=>b.merchantRules(),/解除/);
});

test('LiveVault preserves original rule state after remote storage failure',async()=>{
  const store=new Map();const graph=new FakeGraph(store);const vault=new LiveVault(graph);await vault.create(secret);
  graph.writeMerchantRules=()=>{throw new Error('network outage');};
  await assert.rejects(vault.upsertMerchantRule(item('rule-1','A','B')),/network outage/);
  assert.deepEqual(vault.merchantRules(),[]);
  assert.equal(store.has('rules'),false);
});

test('corrupt rule file blocks unlock; cannot silently replace encrypted data',async()=>{
  const store=new Map(),a=new LiveVault(new FakeGraph(store));await a.create(secret);
  await a.upsertMerchantRule(item('rule-1','A','B'));
  store.get('rules').text='INVALID';
  const b=new LiveVault(new FakeGraph(store));
  await assert.rejects(b.unlock(secret));
  assert.equal(b.unlocked,false);
});

test('H01: observed merchant rules disappearing cannot reset or recreate the rules document',async()=>{
  const store=new Map(),graph=new FakeGraph(store),vault=new LiveVault(graph);
  await vault.create(secret);
  await vault.upsertMerchantRule(item('rule-1','A','B'));
  const backup=store.get('rules');store.delete('rules');
  for(let i=0;i<2;i++){
    await assert.rejects(vault.refresh(),/消失/);
    assert.equal(vault.merchantRules()[0].displayName,'B');
  }
  await assert.rejects(vault.upsertMerchantRule(item('rule-2','C','D')),/消去|消失/);
  assert.equal(store.has('rules'),false);
  store.set('rules',backup);await vault.refresh();
  assert.equal(vault.merchantRules()[0].displayName,'B');
});

function fixedGraph(store){const graph=new FakeGraph(store);graph.readAssetSettings=async()=>graph.read('assets');graph.writeAssetSettings=async(text,ref)=>graph.write('assets',text,ref);return graph;}
const legacyCost={id:'legacy-cost-a',name:'Sample',payment:'card',cardId:'smbc-nl',merchantKey:'smbc-nl|service',categoryId:null,frequency:'monthly',dayOfMonth:1,monthOfYear:null,weekday:null,startOn:'2026-08-01',endOn:null,amount:1200,priceKind:'fixed',pricing:[{effectiveOn:'2026-08-01',amount:1200}],pauses:[],note:'',updatedAt:'2026-08-01T00:00:00Z'};
const fixedRule={id:'fixed-rule-a',pattern:'SERVICE',mode:'exact',displayName:'Sample',cardId:'smbc-nl',enabled:true,priority:100,categoryId:null,fixedCost:{frequency:'monthly',state:'active',startOn:'2026-08-01',legacyId:legacyCost.id}};

test('H03: a stale migration cannot retire a contract modified or deleted on another device',async()=>{
 for(const remove of [false,true]){
  const store=new Map(),a=new LiveVault(fixedGraph(store)),b=new LiveVault(fixedGraph(store));await a.create(secret);await a.upsertFixedCost(legacyCost);await b.unlock(secret);
  if(remove)await a.deleteFixedCost(legacyCost.id);else await a.upsertFixedCost({...legacyCost,amount:1600,pricing:[{effectiveOn:legacyCost.startOn,amount:1600}]});
  const assets=store.get('assets');await assert.rejects(b.upsertMerchantRule(fixedRule),/別端末で移行・変更/);
  assert.strictEqual(store.get('assets'),assets);assert.equal(store.has('rules'),false);
 }
});

test('H03: migration preserves unrelated changes; a stale old editor cannot revive a retired contract',async()=>{
 const store=new Map(),a=new LiveVault(fixedGraph(store)),b=new LiveVault(fixedGraph(store));await a.create(secret);await a.upsertFixedCost(legacyCost);await b.unlock(secret);
 await a.setBirthMonth('2000-01');await b.upsertMerchantRule(fixedRule);assert.equal(b.fixedCostMigrations().includes(legacyCost.id),true);
 const assets=store.get('assets');await assert.rejects(a.upsertFixedCost({...legacyCost,note:'old edit'}),/移行済み固定費/);assert.strictEqual(store.get('assets'),assets);
 await a.setBirthMonth('2001-01');await b.refresh();assert.equal(b.assetSettings().birthMonth,'2001-01');assert.equal(b.fixedCostMigrations().includes(legacyCost.id),true);
 await b.removeMerchantRule(fixedRule.id);await a.refresh();assert.equal(a.fixedCostMigrations().includes(legacyCost.id),true);
});

test('H03 integration: adjacent separate contracts are not implicitly migrated or rejected',async()=>{
 const store=new Map(),a=new LiveVault(fixedGraph(store)),b=new LiveVault(fixedGraph(store));await a.create(secret);
 const ended={...legacyCost,endOn:'2026-09-30'};await a.upsertFixedCost(ended);await b.unlock(secret);
 const next={...fixedRule,fixedCost:{frequency:'monthly',state:'active',startOn:'2026-10-01'}};
 await b.upsertMerchantRule(next);assert.deepEqual(b.fixedCostMigrations(),[]);assert.equal(b.merchantRules()[0].fixedCost.legacyId,undefined);
 await a.upsertFixedCost({...ended,note:'historical edit'});await b.refresh();assert.equal(b.assetSettings().fixedCosts[0].note,'historical edit');
 const {fixedCostCalculationAssets}=await import('../dist/src/fixed-costs/rule-fixed-costs.js');
 const view=fixedCostCalculationAssets({assets:b.assetSettings(),rules:b.merchantRules(),fixedCostMigrations:b.fixedCostMigrations(),records:[]},'2026-11-01');
 assert.ok(view.fixedCosts.some(x=>x.id===ended.id));
 await assert.rejects(a.upsertFixedCost({...ended,endOn:'2026-10-01'}),/同じ固定費/);
});

test('M304 integration: first account history save activates the same one-way writer fence, ordinary settings do not',async()=>{
 const store=new Map(),graph=fixedGraph(store),a=new LiveVault(graph);await a.create(secret);
 const initial=store.get('index');await a.setBirthMonth('2000-01');assert.deepEqual(store.get('index'),initial);
 await a.setPayrollDepositAccount('rakuten-bank');const updated=store.get('index');assert.equal(JSON.parse(updated.text).format,'finance-cloud-index-envelope-v4');
 const b=new LiveVault(fixedGraph(store));await b.unlock(secret);assert.equal(b.assetSettings().format,'finance-assets-v3');
 await b.setBirthMonth('2001-01');assert.deepEqual(store.get('index'),updated);
});

test('INT-02: dated former card route uses the existing writer fence and survives a new client refresh',async()=>{
 const {editRuleFixedDraft}=await import('../dist/src/fixed-costs/rule-fixed-costs.js');
 const store=new Map(),a=new LiveVault(fixedGraph(store)),b=new LiveVault(fixedGraph(store));await a.create(secret);
 const old={...fixedRule,fixedCost:{frequency:'monthly',state:'active',startOn:'2026-08-01',pauses:[{startOn:'2026-09-01',endOn:'2026-09-30'}]}};
 await a.upsertMerchantRule(old);await b.unlock(secret);
 assert.equal(JSON.parse(store.get('index').text).format,'finance-cloud-index-envelope-v3');
 const next={...old,cardId:'amazon'};next.fixedCost=editRuleFixedDraft(next,old.fixedCost,'smbc-nl|service','active','monthly','2026-11-26');
 await a.upsertMerchantRule(next);
 assert.equal(JSON.parse(store.get('index').text).format,'finance-cloud-index-envelope-v4');
 await b.refresh();assert.deepEqual(b.merchantRules()[0].fixedCost.previous,next.fixedCost.previous);
 const reopened=new LiveVault(fixedGraph(store));await reopened.unlock(secret);assert.deepEqual(reopened.merchantRules()[0].fixedCost.previous,next.fixedCost.previous);
});
