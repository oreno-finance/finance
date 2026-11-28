import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyAssets,validateAssets,cardRecurringKey} from '../dist/src/cloud/assets.js';
import {appendPaymentChange,originalPaymentTerms,paymentTermsOn,contractPaymentHistory,contractMerchantKeys} from '../dist/src/fixed-costs/payment-history.js';
import {contractCardEvidence,latestContractCardCharge,pendingCardSubscriptions,detectCardSubscriptions} from '../dist/src/subscriptions/detect.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
import {encryptAssets} from '../dist/src/cloud/cloud-crypto.js';
import {pointRate} from '../dist/src/summary/point-benefits.js';
const bank={id:'test-bank-contract',kind:'expense',name:'契約例',amount:1000,fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:'2020-01-01',endOn:null,categoryId:null,enabled:true};
const key=cardRecurringKey('smbc-nl','SYNTHETIC SERVICE');
const card={id:'test-card-contract',name:'契約例2',payment:'card',cardId:'smbc-nl',merchantKey:key,frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:'2020-01-01',endOn:null,categoryId:null,amount:1000,priceKind:'fixed',pricing:[{effectiveOn:'2020-01-01',amount:1000}],pauses:[],note:'',updatedAt:'2020-01-01T00:00:00Z'};
const route={...originalPaymentTerms(bank),payment:'card',accountId:null,cardId:'smbc-nl',merchantKey:key};
const cash={...route,payment:'cash',cardId:null,merchantKey:null};
const today=()=>new Date().toLocaleDateString('sv-SE');
const tomorrow=()=>{const d=new Date();d.setDate(d.getDate()+1);return d.toLocaleDateString('sv-SE');};
class Graph {
 constructor(){this.files=new Map();this.writes=0;}
 read(name){const item=this.files.get(name);return item?{id:name,text:item.text,etag:String(item.version)}:null;}
 write(name,text,ref){const old=this.files.get(name);if(old?ref?.etag!==String(old.version):!!ref)throw new GraphError(412,'conflict');const version=(old?.version??0)+1;this.files.set(name,{text,version});this.writes++;return {id:name,etag:String(version)};}
 async readFinanceIndex(){return this.read('index');} async writeFinanceIndex(t,r){return this.write('index',t,r);}
 async readLiveVault(){return null;} async ensurePayrollNamespace(){} async listYearFiles(){return [];}
 async readMerchantRules(){return this.read('rules');} async writeMerchantRules(t,r){return this.write('rules',t,r);}
 async readAssetSettings(){return this.read('assets');} async writeAssetSettings(t,r){return this.write('assets',t,r);}
}
const secret='synthetic test vault phrase';
async function create(){const graph=new Graph(),a=new LiveVault(graph);await a.create(secret);return {graph,a};}
test('専用保存APIは初回変更時だけv2へ移行し、元契約と料金履歴を維持する',async()=>{
 const {graph,a}=await create();await a.upsertRecurring(bank);const expected=a.assetSettings().recurring[0],before=graph.writes;
 await a.changeContractPayment(expected,route,today());assert.equal(graph.writes,before+1);
 const now=a.assetSettings();assert.equal(now.format,'finance-assets-v2');assert.equal(now.recurring.length,1);assert.equal(now.recurring[0].fromAccountId,bank.fromAccountId);assert.equal(now.recurring[0].id,bank.id);
 assert.equal(paymentTermsOn(now.recurring[0],today()).payment,'card');assert.equal(paymentTermsOn(now.recurring[0],'2020-01-01').payment,'bank');
 assert.deepEqual(contractPaymentHistory(now.recurring[0]).map(x=>x.payment),['bank','card']);
 assert.doesNotMatch(graph.read('assets').text,/paymentHistory|契約例|synthetic service/);
 const b=new LiveVault(graph);await b.unlock(secret);assert.deepEqual(b.assetSettings(),JSON.parse(JSON.stringify(now)));
 await b.changeContractPayment(b.assetSettings().recurring[0],cash,tomorrow());
 assert.equal(paymentTermsOn(b.assetSettings().recurring[0],tomorrow()).payment,'cash');
 const n=graph.writes;await assert.rejects(b.changeContractPayment(b.assetSettings().recurring[0],route,today()));assert.equal(graph.writes,n);
});
test('別端末の独立した残高変更は維持し、同一契約の変更・削除は履歴保存前に拒否する',async()=>{
 const {graph,a}=await create();await a.upsertFixedCost(card);const b=new LiveVault(graph);await b.unlock(secret);
 const expected=a.assetSettings().fixedCosts[0];
 await b.addBalanceSnapshot({id:'sample-snapshot',accountId:'rakuten-bank',balance:10000,observedAt:'2020-01-01T12:00:00Z'});
 await a.changeContractPayment(expected,originalPaymentTerms(bank),today());assert.equal(a.assetSettings().snapshots.length,1);
 await b.refresh();const stale=b.assetSettings().fixedCosts[0];await a.upsertFixedCost({...a.assetSettings().fixedCosts[0],note:'別端末の編集'});
 let n=graph.writes;await assert.rejects(b.changeContractPayment(stale,cash,tomorrow()),/同時に変更/);assert.equal(graph.writes,n);
 await b.refresh();const deleting=b.assetSettings().fixedCosts[0];await a.deleteFixedCost(card.id);n=graph.writes;
 await assert.rejects(b.changeContractPayment(deleting,cash,tomorrow()),/削除/);assert.equal(graph.writes,n);
});
test('同時の支払条件変更と412リトライでも元契約が更新されれば保存を停止する',async()=>{
 const {graph,a}=await create();await a.upsertRecurring(bank);const b=new LiveVault(graph);await b.unlock(secret);
 const original=graph.writeAssetSettings.bind(graph);let intercept=true;
 // Simulate an external/legacy writer bypassing the new lock to retain the
 // original 412 and same-contract conflict coverage.
 graph.writeAssetSettings=async(t,r)=>{if(intercept){intercept=false;
   await assert.rejects(b.changeContractPayment(b.assetSettings().recurring[0],cash,today()),/別の端末/);
   const current=b.assetSettings(),record=current.recurring[0],key=b.verifiedBrowserKey();
   const changed={...current,format:'finance-assets-v2',recurring:[{...record,paymentHistory:appendPaymentChange(record,cash,today(),today())}]};
   await original(await encryptAssets(validateAssets(changed),key.key,key.salt),graph.read('assets'));
 }return original(t,r);};
 const n=graph.writes;await assert.rejects(a.changeContractPayment(a.assetSettings().recurring[0],route,today()),/同時に変更/);assert.equal(graph.writes,n+1);
 await a.refresh();assert.equal(paymentTermsOn(a.assetSettings().recurring[0],today()).payment,'cash');
});
test('履歴上のカード利用先は再登録候補にならず、利用日に一致する確定請求だけを採用する',()=>{
 const item={...bank,paymentHistory:appendPaymentChange(bank,route,'2026-08-01','2026-01-01')};
 const assets=validateAssets({...emptyAssets(),format:'finance-assets-v2',recurring:[{...item,paymentHistory:appendPaymentChange(item,cash,'2026-11-01','2026-01-01')}]});
 const row=(month,amount,usedOn=month+'-01',confirmation='confirmed')=>({id:month,statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'test',billingMonth:month,paymentDate:month+'-27',statedTotal:amount,confirmation,warnings:[],rows:[{id:month,usedOn,merchant:'SYNTHETIC SERVICE',amount}]}});
 const source={assets,records:[row('2026-07',1000),row('2026-08',1000),row('2026-09',1000),row('2026-10',1000),row('2026-11',2000)],rules:[],categories:[],payroll:{ready:false,entries:[]}};
 assert.ok(contractMerchantKeys(assets).has(key));assert.ok(detectCardSubscriptions(source,'2026-11').some(x=>x.key===key));assert.equal(pendingCardSubscriptions(source,'2026-11').length,0);
 const evidence=contractCardEvidence(source,'2026-11-30')(assets.recurring[0]);assert.deepEqual(evidence.map(x=>x.period),['2026-10','2026-09','2026-08']);assert.deepEqual(latestContractCardCharge(evidence),{month:'2026-10',amount:1000});
});
test('還元率の現在値と将来の登録値を区別し、画面の表示は履歴計算を変更しない',()=>{
 const preferences={'smbc-nl':{pointRatePercent:1,pointRateHistory:[{effectiveOn:'1900-01-01',ratePercent:2},{effectiveOn:'2027-01-01',ratePercent:1}]}};
 assert.equal(pointRate('smbc-nl',preferences,'2026-11-24'),2);assert.equal(pointRate('smbc-nl',preferences,'2027-01-01'),1);
 const ui=readFileSync('src/ui/card-settings.ts','utf8');assert.match(ui,/変更予定の還元率/);assert.match(ui,/現在適用中/);assert.doesNotMatch(ui,/現在適用中：/);assert.match(ui,/還元率の変更履歴/);assert.match(ui,/適用予定/);
});

test('Phase 6C: 将来の最新の支払変更だけを修正・取消し、既存契約とv2形式を維持する',async()=>{
 const {graph,a}=await create();await a.upsertRecurring(bank);const original=a.assetSettings().recurring[0];await a.changeContractPayment(original,route,tomorrow());
 const scheduled=a.assetSettings().recurring[0];await a.reviseContractPayment(scheduled,tomorrow(),{terms:cash,effectiveOn:tomorrow()});
 const revised=a.assetSettings().recurring[0];assert.equal(paymentTermsOn(revised,tomorrow()).payment,'cash');assert.equal(paymentTermsOn(revised,today()).payment,'bank');
 await assert.rejects(a.reviseContractPayment(scheduled,tomorrow()));await a.reviseContractPayment(revised,tomorrow());
 assert.equal(a.assetSettings().format,'finance-assets-v2');assert.deepEqual(JSON.parse(JSON.stringify(a.assetSettings().recurring[0])),JSON.parse(JSON.stringify(original)));const reopened=new LiveVault(graph);await reopened.unlock(secret);assert.deepEqual(reopened.assetSettings().recurring[0],JSON.parse(JSON.stringify(original)));
 await a.changeContractPayment(original,route,today());const n=graph.writes;await assert.rejects(a.reviseContractPayment(a.assetSettings().recurring[0],today()));assert.equal(graph.writes,n);
});
test('Phase 6C: 支払有効期間が重ならなければ同じカード利用先の別契約を保存できる',async()=>{
 const {a}=await create();await a.upsertFixedCost(card);const first=a.assetSettings().fixedCosts[0];await a.changeContractPayment(first,originalPaymentTerms(bank),tomorrow());
 const second={...card,id:'second-contract',startOn:tomorrow(),pricing:[{effectiveOn:tomorrow(),amount:1000}]};await a.upsertFixedCost(second);
 assert.equal(a.assetSettings().fixedCosts.length,2);
 await assert.rejects(a.reviseContractPayment(a.assetSettings().fixedCosts.find(x=>x.id===card.id),tomorrow()));
});


test('統合編集は料金・支払条件・基本情報・契約状態を一回の暗号化保存で確定する',async()=>{
 const {graph,a}=await create();await a.upsertRecurring(bank);const expected=a.assetSettings().recurring[0],n=graph.writes;
 await a.editContract(expected,{name:'更新した契約',categoryId:null,priceKind:'variable',note:'変更内容',price:{amount:2300,effectiveOn:today()},payment:{terms:route,effectiveOn:today()},state:{action:'paused',effectiveOn:tomorrow()}});
 assert.equal(graph.writes,n+1);const changed=a.assetSettings().recurring[0];assert.equal(changed.id,bank.id);assert.equal(changed.fromAccountId,bank.fromAccountId);
 assert.equal(changed.name,'更新した契約');assert.equal(changed.note,'変更内容');assert.equal(changed.priceKind,'variable');assert.equal(changed.amount,2300);assert.deepEqual(changed.pricing,[{effectiveOn:bank.startOn,amount:1000},{effectiveOn:today(),amount:2300}]);
 assert.equal(paymentTermsOn(changed,bank.startOn).payment,'bank');assert.equal(paymentTermsOn(changed,today()).payment,'card');assert.deepEqual(changed.pauses,[{startOn:new Date(Date.parse(tomorrow()+'T00:00:00Z')+86400000).toISOString().slice(0,10),endOn:null}]);assert.equal(a.assetSettings().format,'finance-assets-v2');
 const b=new LiveVault(graph);await b.unlock(secret);assert.deepEqual(b.assetSettings(),JSON.parse(JSON.stringify(a.assetSettings())));
 assert.doesNotMatch(graph.read('assets').text,/変更内容|更新した契約|paymentHistory/);
});
test('統合編集は不正な変更・他端末の契約更新・書込み拒否で部分保存しない',async()=>{
 const {graph,a}=await create();await a.upsertFixedCost(card);const expected=a.assetSettings().fixedCosts[0],n=graph.writes;
 const edit={name:'変更後',categoryId:null,priceKind:'fixed',note:'同時編集',price:{amount:2000,effectiveOn:today()},payment:{terms:cash,effectiveOn:today()}};
 await assert.rejects(a.editContract(expected,{...edit,payment:{terms:cash,effectiveOn:'2020-01-01'}}));assert.equal(graph.writes,n);assert.deepEqual(a.assetSettings().fixedCosts[0],expected);
 const b=new LiveVault(graph);await b.unlock(secret);await b.upsertFixedCost({...expected,note:'別端末'});const after=graph.writes;
 await assert.rejects(a.editContract(expected,edit),/同時に変更/);assert.equal(graph.writes,after);await a.refresh();assert.equal(a.assetSettings().fixedCosts[0].note,'別端末');
 const fresh=a.assetSettings().fixedCosts[0];graph.writeAssetSettings=async()=>{throw new GraphError(403,'denied');};await assert.rejects(a.editContract(fresh,edit));assert.deepEqual(a.assetSettings().fixedCosts[0],fresh);
});
test('統合編集で将来の支払条件の修正・取消を基本情報の保存と同時に行える',async()=>{
 const {graph,a}=await create();await a.upsertRecurring(bank);await a.changeContractPayment(a.assetSettings().recurring[0],route,tomorrow());
 const expected=a.assetSettings().recurring[0],n=graph.writes;
 await a.editContract(expected,{name:'変更後',categoryId:null,priceKind:'fixed',note:'修正',payment:{terms:cash,effectiveOn:tomorrow(),replaceDate:tomorrow()}});
 assert.equal(graph.writes,n+1);const revised=a.assetSettings().recurring[0];assert.equal(paymentTermsOn(revised,tomorrow()).payment,'cash');assert.equal(paymentTermsOn(revised,today()).payment,'bank');
 await a.editContract(revised,{name:'取消後',categoryId:null,priceKind:'fixed',note:'取消',payment:{cancelDate:tomorrow()}});
 assert.equal(graph.writes,n+2);assert.equal(a.assetSettings().recurring[0].paymentHistory,undefined);assert.equal(a.assetSettings().recurring[0].note,'取消');assert.equal(a.assetSettings().format,'finance-assets-v2');
});


test('将来の料金と支払条件を同時に修正・取消しても適用前の履歴は維持する',async()=>{
 const {graph,a}=await create();await a.upsertRecurring(bank);const original=a.assetSettings().recurring[0];
 const basic={name:bank.name,categoryId:null,priceKind:'fixed',note:''};
 await a.editContract(original,{...basic,price:{amount:3000,effectiveOn:tomorrow()},payment:{terms:route,effectiveOn:tomorrow()}});
 const pending=a.assetSettings().recurring[0],n=graph.writes;
 await assert.rejects(a.editContract(pending,{...basic,price:{amount:4000,effectiveOn:tomorrow()}}));assert.equal(graph.writes,n);
 await a.editContract(pending,{...basic,price:{amount:4000,effectiveOn:tomorrow(),replaceDate:tomorrow()},payment:{terms:cash,effectiveOn:tomorrow(),replaceDate:tomorrow()}});
 assert.equal(graph.writes,n+1);const revised=a.assetSettings().recurring[0];assert.deepEqual(revised.pricing,[{effectiveOn:bank.startOn,amount:1000},{effectiveOn:tomorrow(),amount:4000}]);
 await a.editContract(revised,{...basic,price:{cancelDate:tomorrow()},payment:{cancelDate:tomorrow()}});assert.equal(graph.writes,n+2);
 const result=a.assetSettings().recurring[0];assert.equal(result.amount,1000);assert.deepEqual(result.pricing,[{effectiveOn:bank.startOn,amount:1000}]);assert.equal(result.paymentHistory,undefined);assert.equal(a.assetSettings().format,'finance-assets-v2');
});

test('検出候補の支払カード変更は旧候補の除外と新契約を一括保存する',async()=>{
 const {a,graph}=await create();const before=graph.writes;
 const decision={cardId:'smbc-nl',merchant:'synthetic service',label:'合成候補',amount:1000,frequency:'monthly',state:'ignored',updatedAt:new Date().toISOString()};
 const changed={...card,cardId:'amazon',merchantKey:cardRecurringKey('amazon',decision.merchant)};
 await a.upsertFixedCost(changed,decision);assert.equal(graph.writes,before+1);
 const saved=a.assetSettings();assert.equal(saved.fixedCosts.length,1);assert.equal(saved.fixedCosts[0].merchantKey,changed.merchantKey);
 assert.equal(saved.cardRecurringDecisions[key].state,'ignored');assert.equal(saved.cardRecurringDecisions[changed.merchantKey],undefined);
 const b=new LiveVault(graph);await b.unlock(secret);assert.deepEqual(b.assetSettings(),JSON.parse(JSON.stringify(saved)));
 await assert.rejects(a.upsertFixedCost({...changed,id:'duplicate-test'},decision),/重複|登録・確認/);assert.deepEqual(a.assetSettings(),saved);
});
test('検出候補のカード変更は不一致や別端末の登録済み候補を上書きしない',async()=>{
 const {a,graph}=await create();const decision={cardId:'smbc-nl',merchant:'synthetic service',label:'合成候補',amount:1000,frequency:'monthly',state:'ignored',updatedAt:new Date().toISOString()};
 const changed={...card,cardId:'amazon',merchantKey:cardRecurringKey('amazon',decision.merchant)};
 const before=graph.writes;await assert.rejects(a.upsertFixedCost({...changed,merchantKey:key},decision),/対応関係/);
 await assert.rejects(a.upsertFixedCost(changed,{...decision,state:'registered'}),/対応関係/);assert.equal(graph.writes,before);
 const b=new LiveVault(graph);await b.unlock(secret);await b.upsertFixedCost(card,{...decision,state:'registered'});
 const writes=graph.writes;await assert.rejects(a.upsertFixedCost(changed,decision),/登録・確認/);assert.equal(graph.writes,writes);await a.refresh();assert.equal(a.assetSettings().fixedCosts[0].cardId,'smbc-nl');
});


test('M03: 開始前の終了は暗号化保存形式を保護し、再取得後の再開でも契約履歴を維持する',async()=>{
  const {graph,a}=await create();
  const start=tomorrow();
  const scheduled={...card,startOn:start,pricing:[{effectiveOn:start,amount:card.amount}]};
  const scheduledBank={...bank,startOn:start};
  await a.upsertFixedCost(scheduled);await a.upsertRecurring(scheduledBank);
  const edit=item=>({name:item.name,categoryId:item.categoryId,priceKind:'fixed',note:'',state:{action:'ended',effectiveOn:today()}});
  await a.editContract(a.assetSettings().fixedCosts[0],edit(scheduled));
  await a.editContract(a.assetSettings().recurring[0],edit(scheduledBank));
  const saved=a.assetSettings();
  assert.equal(saved.format,'finance-assets-v3');
  assert.equal(JSON.parse(graph.read('index').text).format,'finance-cloud-index-envelope-v4');
  assert.equal(saved.fixedCosts[0].endOn,today());assert.equal(saved.recurring[0].endOn,today());
  assert.throws(()=>validateAssets({...saved,format:'finance-assets-v2'}),/保存形式/);
  const b=new LiveVault(graph);await b.unlock(secret);
  assert.deepEqual(b.assetSettings(),JSON.parse(JSON.stringify(saved)));
  const item=b.assetSettings().fixedCosts[0];
  await b.editContract(item,{...edit(item),state:{action:'active',effectiveOn:today()}});
  assert.equal(b.assetSettings().fixedCosts[0].startOn,start);
  assert.equal(b.assetSettings().fixedCosts[0].endOn,null);
  assert.deepEqual(b.assetSettings().fixedCosts[0].pricing,scheduled.pricing);
});
