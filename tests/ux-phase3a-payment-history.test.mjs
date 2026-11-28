import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyAssets,validateAssets,mergeAssets,detectAssetsEditCollisions,describeAssetsEditCollisions} from '../dist/src/cloud/assets.js';
import {originalPaymentTerms,appendPaymentChange,paymentTermsOn,recurringForCalculation,fixedCostsForCalculation,nextContractPayment} from '../dist/src/fixed-costs/payment-history.js';
import {recurringInMonth} from '../dist/src/cloud/recurring-schedule.js';
import {fixedCostOccurrences,changeFixedCostState} from '../dist/src/fixed-costs/contracts.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {forecastAssets} from '../dist/src/cloud/asset-projection.js';
import {forecastAccounts} from '../dist/src/home/account-events.js';
import {bankTimeline} from '../dist/src/summary/bank-timeline.js';
import {estimatedCardFixedBills} from '../dist/src/cloud/card-fixed-estimates.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
import {encryptAssets,decryptAssets,deriveCloudKey,freshSalt} from '../dist/src/cloud/cloud-crypto.js';
const bank={id:'contract-bank',name:'契約例',kind:'expense',amount:1000,fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true};
const card={id:'contract-card',name:'カード契約例',payment:'card',cardId:'smbc-nl',merchantKey:'smbc-nl|synthetic',categoryId:null,frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,amount:1000,priceKind:'fixed',pricing:[{effectiveOn:'2026-01-01',amount:1000}],pauses:[],note:'',updatedAt:'2026-01-01T00:00:00Z'};
const terms=(overrides={})=>({...originalPaymentTerms(bank),...overrides});
const cardTerms=terms({payment:'card',accountId:null,cardId:'smbc-nl',merchantKey:'smbc-nl|synthetic'});
const cashTerms=terms({payment:'cash',accountId:null});
const change=(item,route,day)=>({...item,paymentHistory:appendPaymentChange(item,route,day,'2026-01-01')});
const doc=(recurring=[],fixedCosts=[])=>validateAssets({...emptyAssets(),format:'finance-assets-v2',recurring,fixedCosts});
const legacy=(recurring=[],fixedCosts=[])=>validateAssets({...emptyAssets(),recurring,fixedCosts});
const source=assets=>({assets,records:[],rules:[],categories:[],payroll:{ready:true,entries:[]},currentPeriod:'2026-11'});
const monthly=(assets,period)=>monthlyReport(period,source(assets));
const movements=(assets,period)=>recurringInMonth(period,recurringForCalculation(assets));
const cash=(assets,period)=>fixedCostOccurrences(period,fixedCostsForCalculation(assets).filter(x=>x.payment==='cash'));
const bills=(assets,from,to)=>estimatedCardFixedBills({...assets,cardDebitAccounts:{'smbc-nl':'rakuten-bank'},cardPreferences:{'smbc-nl':{payment:{monthOffset:0,day:27}}}},[],from,to);

test('支払条件の変更は旧契約IDと適用日前の金額・口座を維持し、銀行・カード・現金を一つの履歴として扱う',()=>{
 const input=structuredClone(bank);
 const changed=change(change(bank,cardTerms,'2026-10-01'),cashTerms,'2026-12-01');
 const a=doc([changed]);
 assert.deepEqual(bank,input);
 assert.equal(a.recurring.length,1);assert.equal(a.fixedCosts.length,0);
 assert.equal(paymentTermsOn(changed,'2026-09-30').payment,'bank');
 assert.equal(paymentTermsOn(changed,'2026-10-01').payment,'card');
 assert.equal(paymentTermsOn(changed,'2026-12-01').payment,'cash');
 assert.equal(movements(a,'2026-09')[0].entry.id,bank.id);
 assert.equal(movements(a,'2026-10').length,0);
 assert.equal(bills(a,'2026-10-01','2026-11-30').length,2);
 assert.deepEqual(bills(a,'2026-10-01','2026-11-30').map(x=>[x.amount,x.contractIds]),[[1000,[bank.id]],[1000,[bank.id]]]);
 assert.equal(cash(a,'2026-12')[0].item.id,bank.id);
 assert.equal(monthly(a,'2026-09').recurringExpense,1000);
 assert.equal(monthly(a,'2026-10').recurringExpense,0);
 assert.equal(monthly(a,'2026-12').recurringExpense,1000);
 assert.equal(bills(a,'2026-12-01','2026-12-31').length,0);
});
test('支払日・周期・口座の変更は適用日の境界で切り替わり、年払いと月末補正も維持する',()=>{
 const yearly=terms({frequency:'yearly',dayOfMonth:31,monthOfYear:2,accountId:'mizuho-bank'});
 const item=change(bank,yearly,'2026-11-05');const a=doc([item]);
 assert.equal(movements(a,'2026-10')[0].date,'2026-10-05');
 assert.equal(movements(a,'2026-11').length,0); // old date is exactly the effective day
 const events=movements(a,'2027-02');assert.equal(events.length,1);assert.equal(events[0].date,'2027-02-28');assert.equal(events[0].entry.fromAccountId,'mizuho-bank');
 assert.equal(nextContractPayment(item,'2026-11-01'),'2027-02-28');
 const weekly=change(item,terms({frequency:'weekly',dayOfMonth:null,weekday:1}),'2027-03-01');
 assert.deepEqual(movements(doc([weekly]),'2027-03').map(x=>x.date),['2027-03-01','2027-03-08','2027-03-15','2027-03-22','2027-03-29']);
});
test('カードから銀行への変更は残高予測・月次収支・ホーム・銀行推移で同じ支払を計上する',()=>{
 const item=change(card,terms(),'2026-11-01');const a=doc([], [item]);
 a.snapshots=[{id:'snapshot-demo',accountId:'rakuten-bank',balance:10000,observedAt:'2026-11-01T12:00:00Z'}];
 assert.equal(monthly(a,'2026-11').recurringExpense,1000);
 assert.equal(movements(a,'2026-11')[0].entry.id,card.id);
 assert.equal(forecastAssets(a,'2026-11-30')['rakuten-bank'].balance,9000);
 assert.equal(bankTimeline('2026-11',source(a),'2026-11-02').endBalance,9000);
 assert.equal(forecastAccounts(source(a),'2026-11-02',28).accounts.find(x=>x.accountId==='rakuten-bank').projected,9000);
 assert.equal(bills(a,'2026-11-01','2026-11-30').length,0);
});
test('停止・終了・料金変更を支払条件の全期間で維持し、旧停止フラグの契約を復活させない',()=>{
 const item=change({...bank,amount:2000,pricing:[{effectiveOn:bank.startOn,amount:1000},{effectiveOn:'2026-11-01',amount:2000}],pauses:[{startOn:'2026-10-01',endOn:'2026-11-30'}],endOn:'2027-01-01'},cashTerms,'2026-10-01');
 const a=doc([item]);assert.equal(movements(a,'2026-09')[0].entry.amount,1000);
 assert.equal(cash(a,'2026-10').length,0);assert.equal(cash(a,'2026-11').length,0);
 assert.equal(cash(a,'2026-12')[0].amount,2000);assert.equal(cash(a,'2027-01').length,0);
 assert.equal(nextContractPayment(item,'2026-10-01'),'2026-12-05');
 const disabled=doc([{...item,enabled:false}]);assert.equal(cash(disabled,'2026-12').length,0);assert.equal(movements(disabled,'2026-09').length,0);
});
test('不正な支払条件・履歴の日付・元契約の書換え・旧形式への履歴混入を拒否する',()=>{
 const changed=change(bank,cardTerms,'2026-11-01');
 for(const route of [terms({accountId:'unknown'}),{...cardTerms,accountId:'rakuten-bank'},{...cardTerms,merchantKey:'other|test'},terms({dayOfMonth:32}),{...cashTerms,cardId:'smbc-nl'}])assert.throws(()=>change(bank,route,'2026-11-01'));
 assert.throws(()=>appendPaymentChange(bank,cardTerms,'2026-11-01','2026-11-02'));
 assert.throws(()=>change(changed,cashTerms,'2026-11-01'));
 assert.throws(()=>change(bank,cardTerms,'2026-02-31'));
 assert.throws(()=>legacy([changed]));
 assert.throws(()=>doc([{...changed,fromAccountId:'mizuho-bank'}]));
 assert.throws(()=>doc([{...changed,paymentHistory:[changed.paymentHistory[1],changed.paymentHistory[0]]}]));
 assert.throws(()=>doc([{...changed,kind:'income',fromAccountId:null,toAccountId:'rakuten-bank'}]));
 assert.throws(()=>doc([changed],[card])); // overlapping merchant/card
 assert.throws(()=>doc([changed],[{...card,id:bank.id,merchantKey:null}]));
 const a=legacy([bank],[card]);assert.equal(a.format,'finance-assets-v1');assert.equal(a.recurring[0].paymentHistory,undefined);
});
test('履歴は暗号化データの中だけに保持され、復号と独立編集のマージで失われない',async()=>{
 const base=legacy([bank]);const local=doc([change(bank,cardTerms,'2026-11-01')]);
 const remote=structuredClone(base);remote.recurring[0].name='名称変更';
 const merged=mergeAssets(base,local,remote);
 assert.equal(merged.format,'finance-assets-v2');assert.equal(merged.recurring[0].name,'名称変更');
 assert.deepEqual(merged.recurring[0].paymentHistory,local.recurring[0].paymentHistory);
 assert.deepEqual(detectAssetsEditCollisions(base,local,remote),[]);
 const other=doc([change(bank,cashTerms,'2026-11-01')]);const collisions=detectAssetsEditCollisions(base,local,other);
 assert.deepEqual(collisions,[{itemId:bank.id,field:'paymentHistory'}]);assert.equal(describeAssetsEditCollisions(base,local,other,collisions)[0].label,'定期入出金「契約例」');
 assert.throws(()=>mergeAssets(base,local,other),/同時に変更/);
 const salt=freshSalt(),key=await deriveCloudKey('synthetic fixture password',salt);
 const encrypted=await encryptAssets(merged,key,salt);
 assert.doesNotMatch(encrypted,/paymentHistory|synthetic|契約例|2026-11-01/);
 assert.deepEqual(await decryptAssets(encrypted,key,salt),JSON.parse(JSON.stringify(merged)));
 const deleted=mergeAssets(merged,{...merged,recurring:[],deletedRecurring:[bank.id]},merged);
 assert.equal(deleted.format,'finance-assets-v2');assert.equal(deleted.recurring.length,0);
});

// Exercise the real LiveVault API over an isolated encrypted in-memory Graph stand-in.
class FakeGraph {
 constructor(){this.files=new Map();this.writes=0;}
 read(name){const item=this.files.get(name);return item?{id:name,text:item.text,etag:String(item.version)}:null;}
 write(name,text,ref){const old=this.files.get(name);if(old?ref?.etag!==String(old.version):!!ref)throw new GraphError(412,'conflict');
  const version=(old?.version??0)+1;this.files.set(name,{text,version});this.writes++;return {id:name,etag:String(version)};}
 async readFinanceIndex(){return this.read('index');}
 async writeFinanceIndex(text,ref){return this.write('index',text,ref);}
 async readLiveVault(){return null;}
 async ensurePayrollNamespace(){}
 async listYearFiles(){return [];}
 async readMerchantRules(){return this.read('rules');}
 async writeMerchantRules(text,ref){return this.write('rules',text,ref);}
 async readAssetSettings(){return this.read('assets');}
 async writeAssetSettings(text,ref){return this.write('assets',text,ref);}
}
test('実際のLiveVaultの暗号化保存・再読込・旧編集APIで支払条件履歴を失わない',async()=>{
 const graph=new FakeGraph(),a=new LiveVault(graph),secret='fixture passphrase for history';
 await a.create(secret);await a.upsertRecurring(bank);
 const b=new LiveVault(graph);await b.unlock(secret);
 const salt=JSON.parse(graph.read('index').text).salt,key=await deriveCloudKey(secret,salt);
 const changed=doc([change(bank,cardTerms,'2026-11-01')]);
 // Simulate an existing v2 document from a separate writer.
 graph.write('assets',await encryptAssets(changed,key,salt),graph.read('assets'));
 await a.refresh();const before=graph.writes;
 await assert.rejects(a.upsertRecurring({...bank,name:'旧式編集'}),/専用の変更操作/);
 await assert.rejects(a.upsertFixedCost(change(card,cashTerms,'2026-11-01')),/専用の変更操作/);
 assert.equal(graph.writes,before);
 // A stale client saving an independent snapshot merges the v2 history without downgrading.
 await b.addBalanceSnapshot({id:'snapshot-test',accountId:'rakuten-bank',balance:10000,observedAt:'2026-11-01T12:00:00Z'});
 await a.refresh();assert.equal(a.assetSettings().format,'finance-assets-v2');
 assert.deepEqual(a.assetSettings().recurring[0].paymentHistory,changed.recurring[0].paymentHistory);
 await a.upsertRecurring({...a.assetSettings().recurring[0],name:'契約例の編集'});
 const c=new LiveVault(graph);await c.unlock(secret);assert.equal(c.assetSettings().recurring[0].name,'契約例の編集');
 assert.deepEqual(c.assetSettings().recurring[0].paymentHistory,changed.recurring[0].paymentHistory);
 assert.equal(c.assetSettings().snapshots.length,1);
});


test('M03: 銀行→カード→現金の支払履歴に対する停止・再開は境界日と未請求分を維持する',()=>{
  const item=change(change(bank,cardTerms,'2026-10-01'),cashTerms,'2026-12-01');
  const paused={...item,...changeFixedCostState(item,'paused','2026-10-05')};
  const resumed={...paused,...changeFixedCostState(paused,'active','2026-12-05')};
  const a=doc([resumed]);
  assert.deepEqual(resumed.paymentHistory,item.paymentHistory);
  assert.equal(movements(a,'2026-09')[0].entry.amount,1000);
  assert.deepEqual(estimatedCardFixedBills({...a,cardDebitAccounts:{'smbc-nl':'rakuten-bank'},cardPreferences:{'smbc-nl':{payment:{monthOffset:1,day:27}}}},[],'2026-11-01','2026-12-31').map(x=>[x.paymentDate,x.amount]),[['2026-11-27',1000]]);
  assert.equal(cash(a,'2026-12')[0].date,'2026-12-05');
});
