import test from 'node:test';
import assert from 'node:assert/strict';
import {CATEGORIES, PALETTE, categoryMeta, emptyRules, validateRules, validateRule, mergeRules, matchingRule} from '../dist/src/cloud/merchant-rules.js';
import {recentMerchants} from '../dist/src/ui/recent-merchants.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
import {freshSalt,deriveCloudKey,encryptRules,decryptRules} from '../dist/src/cloud/cloud-crypto.js';

const rule=(id,categoryId)=>({id,pattern:'AMAZON',mode:'contains',displayName:'Amazon',cardId:null,enabled:true,priority:100,categoryId});
test('12 named palette colors and unique persistent categories',()=>{
  assert.equal(CATEGORIES.length,12);
  assert.equal(PALETTE.length,12);
  assert.equal(new Set(CATEGORIES.map(x=>x.id)).size,12);
  assert.equal(new Set(PALETTE.map(x=>x.id)).size,12);
  assert.equal(categoryMeta('food')?.name,'食費');
  assert.equal(categoryMeta('investment')?.name,'資産形成');
  assert.equal(categoryMeta('food',{food:'blue'})?.color,'blue');
  assert.equal(categoryMeta('food',{food:'blue'})?.hex,'#4285F4');
});
test('old v1 merchant document and old rule remain loadable with no category',()=>{
  const old=emptyRules();old.rules=[{id:'old-rule',pattern:'A',mode:'exact',displayName:'B',cardId:null,enabled:true,priority:1}];
  assert.deepEqual(validateRules(old),old);
  assert.equal(matchingRule('A',null,validateRules(old).rules)?.categoryId,undefined);
});
test('category, color and invalid values validate, no freeform color accepted',()=>{
  assert.equal(validateRule(rule('rule-food','food')).categoryId,'food');
  assert.throws(()=>validateRule(rule('rule-bad','anything')),/不正/);
  assert.equal(validateRules({...emptyRules(),categoryColors:{food:'blue'}}).categoryColors.food,'blue');
  assert.throws(()=>validateRules({...emptyRules(),categoryColors:{food:'#ff0000'}}),/色設定/);
  assert.throws(()=>validateRules({...emptyRules(),categoryColors:{nonsense:'blue'}}),/色設定/);
});
test('3-way merge combines category selection and other-field updates',()=>{
  const base={...emptyRules(),rules:[rule('rule-a',null)]};
  const local={...base,rules:[rule('rule-a','subscription')]};
  const remote={...base,rules:[{...rule('rule-a',null),displayName:'Amazon新版'}]};
  const merged=mergeRules(base,local,remote);
  assert.equal(merged.rules[0].categoryId,'subscription');
  assert.equal(merged.rules[0].displayName,'Amazon新版');
});
test('independent color updates merge, conflicting color update auditable',()=>{
  const base=emptyRules();
  const local={...base,categoryColors:{food:'red'}};
  const remote={...base,categoryColors:{subscription:'blue'}};
  const merged=mergeRules(base,local,remote);
  assert.equal(merged.categoryColors.food,'red');
  assert.equal(merged.categoryColors.subscription,'blue');
  const conflicting=mergeRules(base,{...base,categoryColors:{food:'pink'}},{...base,categoryColors:{food:'orange'}});
  assert.equal(conflicting.categoryColors.food,'pink');
  assert.equal(conflicting.conflicts.find(x=>x.ruleId==='category:food').discarded,'orange');
});
test('named palette and category assignments are encrypted in one document',async()=>{
  const salt=freshSalt(),key=await deriveCloudKey('a secure test passphrase 2026',salt);
  const raw={...emptyRules(),rules:[rule('rule-food','food')],categoryColors:{food:'blue'}};
  const enc=await encryptRules(raw,key,salt);
  assert.equal(enc.includes('AMAZON'),false);
  assert.equal(enc.includes('"food"'),false);
  assert.deepEqual(await decryptRules(enc,key,salt),raw);
});
test('recent merchant picker groups issuer names across cards, preserves latest amount and filters registered scopes',()=>{
  const fake=(cardId,billingMonth,rows)=>({cardId,billingMonth,rows});
  const statements=[
    fake('amazon','2026-11',[{merchant:'ＡＭＡＺＯＮ',usedOn:'2026-11-08',amount:100},{merchant:'AMAZON',usedOn:'2026-11-14',amount:350}]),
    fake('recruit-jcb','2026-11',[{merchant:'Amazon',usedOn:'2026-11-12',amount:500}]),
    fake('amazon','2026-10',[{merchant:'ヨドバシ',usedOn:'2026-10-05',amount:700}]),
  ];
  const data=recentMerchants(statements);
  assert.equal(data.length,2);assert.equal(data[0].merchant,'AMAZON');assert.equal(data[0].count,3);
  assert.equal(data[0].amount,350);assert.equal(data[0].lastDate,'2026-11-14');
  assert.equal(data[1].merchant,'ヨドバシ');
  const rule={id:'synthetic',pattern:'am',mode:'prefix',displayName:'Synthetic',cardId:'amazon',enabled:false,priority:100};
  const filtered=recentMerchants(statements,{rules:[rule]});
  assert.equal(filtered[0].cardId,'recruit-jcb');assert.equal(filtered[0].count,1);assert.equal(filtered[0].amount,500);assert.equal(filtered[0].partiallyRegistered,true);
  assert.deepEqual(recentMerchants(statements,{cardId:'amazon',rules:[rule]}).map(x=>x.merchant),['ヨドバシ']);
  assert.deepEqual(recentMerchants(statements,{rules:[{...rule,cardId:null}]}).map(x=>x.merchant),['ヨドバシ']);
  assert.equal(recentMerchants(statements,{cardId:'recruit-jcb',merchant:'amazon'})[0].amount,500);
  const ambiguous=[...statements,fake('amazon','2026-11',[{merchant:'Amazon',usedOn:'2026-11-14',amount:999}])];
  assert.equal(recentMerchants(ambiguous)[0].amount,null);
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
  read(key){const x=this.store.get(key);return x?{text:x.text,id:key,etag:`"${x.rev}"`}:null;}
  write(key,text,ref){const x=this.store.get(key);if(x&&ref?.etag!==`"${x.rev}"`)throw new GraphError(412,'conflict');if(!x&&ref)throw new GraphError(412,'conflict');const rev=(x?.rev??0)+1;this.store.set(key,{text,rev});return {id:key,etag:`"${rev}"`};}
}
test('LiveVault persists category color and merges concurrent category + merchant changes',async()=>{
  const store=new Map(),g=new FakeGraph(store),a=new LiveVault(g),b=new LiveVault(new FakeGraph(store));
  await a.create('a secure test passphrase 2026');await b.unlock('a secure test passphrase 2026');
  await a.setCategoryColor('food','pink');
  await b.upsertMerchantRule(rule('rule-food','food'));
  await a.refresh();
  assert.equal(a.merchantCategoryColors().food,'pink');
  assert.equal(a.merchantRules()[0].categoryId,'food');
  assert.equal(store.size,2);
  assert.equal(store.get('rules').text.includes('pink'),false);
});
