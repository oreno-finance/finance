import test from 'node:test';
import assert from 'node:assert/strict';
import {applyContractEdit,correctInitialPayment} from '../dist/src/fixed-costs/contract-edit.js';
import {originalPaymentTerms,appendPaymentChange,paymentTermsOn,recurringForCalculation,fixedCostsForCalculation,nextContractPayment,originContracts} from '../dist/src/fixed-costs/payment-history.js';
import {fixedCostOccurrences} from '../dist/src/fixed-costs/contracts.js';
import {emptyAssets,validateAssets,mergeAssets,cardRecurringKey} from '../dist/src/cloud/assets.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
const today=new Date().toLocaleDateString('sv-SE'),start=`${Number(today.slice(0,4))+1}-01-01`,later=`${Number(today.slice(0,4))+1}-02-01`;
const bank={id:'future-contract-demo',kind:'expense',name:'合成契約',amount:1000,fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:start,endOn:null,categoryId:null,enabled:true};
const route={...originalPaymentTerms(bank),payment:'card',accountId:null,cardId:'smbc-nl',merchantKey:cardRecurringKey('smbc-nl','SYNTHETIC SERVICE')};
const cash={...route,payment:'cash',cardId:null,merchantKey:null};
const basic={name:bank.name,categoryId:null,priceKind:'fixed',note:''};
const edit=(terms,date=start)=>({...basic,payment:{terms,effectiveOn:date}});
const correct=(item,terms)=>applyContractEdit(item,edit(terms),today);
test('②-D: 開始前の引落口座・周期を初期条件として訂正し架空の履歴を作らない',()=>{
 const terms={...originalPaymentTerms(bank),accountId:'mizuho-bank',frequency:'weekly',dayOfMonth:null,weekday:3};const result=correct(bank,terms);
 assert.equal(result.id,bank.id);assert.equal(result.startOn,start);assert.deepEqual(originalPaymentTerms(result),terms);assert.equal(result.paymentHistory,undefined);assert.equal(bank.fromAccountId,'rakuten-bank');
});
test('②-D: 銀行からカードへ訂正しても契約ID・開始日・金額は維持される',()=>{
 const result=correct(bank,route);assert.equal(result.id,bank.id);assert.equal(result.startOn,start);assert.equal(result.amount,1000);assert.equal(result.payment,'card');assert.equal('kind' in result,false);
 const doc=validateAssets({...emptyAssets(),fixedCosts:[result]});assert.equal(recurringForCalculation(doc).length,0);assert.equal(fixedCostOccurrences(start.slice(0,7),fixedCostsForCalculation(doc)).length,1);assert.equal(fixedCostOccurrences(today.slice(0,7),fixedCostsForCalculation(doc)).length,0);
});
test('②-D: カードから現金、銀行へ再訂正でき初回の支払日も正しい',()=>{
 const a=correct(bank,route),b=correct(a,cash),c=correct(b,originalPaymentTerms(bank));assert.equal(b.payment,'cash');assert.equal(c.kind,'expense');assert.equal(c.id,bank.id);assert.equal(c.paymentHistory,undefined);assert.equal(nextContractPayment(c,today),start.slice(0,7)+'-05');
});
test('②-D: 初期料金の訂正と支払方法を一つの編集にまとめる',()=>{
 const result=applyContractEdit(bank,{...edit(route),price:{amount:2300,effectiveOn:start}},today);assert.equal(result.amount,2300);assert.deepEqual(result.pricing,[{effectiveOn:start,amount:2300}]);assert.equal(result.paymentHistory,undefined);
});
test('②-D: 開始日当日・過去の開始日・既存の後続履歴は初期条件訂正できない',()=>{
 for(const day of [start,later])assert.throws(()=>correctInitialPayment(bank,route,day));
 const scheduled={...bank,paymentHistory:appendPaymentChange(bank,route,later,today)};assert.throws(()=>correctInitialPayment(scheduled,cash,today));assert.throws(()=>applyContractEdit(scheduled,edit(cash),today));
});
test('②-D: 開始後の変更予定を指定した場合は初期条件を維持し通常の履歴を追加する',()=>{
 const result=applyContractEdit(bank,edit(route,later),today);assert.equal(result.kind,'expense');assert.equal(paymentTermsOn(result,start).payment,'bank');assert.equal(paymentTermsOn(result,later).payment,'card');assert.equal(result.paymentHistory.length,2);
});
test('②-D: 不正な口座・利用先・未変更・停止中の旧銀行契約の移動は拒否する',()=>{
 for(const terms of [{...originalPaymentTerms(bank),accountId:'nisa'},{...route,merchantKey:'wrong|service'},originalPaymentTerms(bank)])assert.throws(()=>correct(bank,terms));assert.throws(()=>correct({...bank,enabled:false},route));
});
class Graph {
 constructor(state=new Map()){this.state=state;this.writes=0;this.reject=false;}
 read(name){const x=this.state.get(name);return x?{id:name,text:x.text,etag:String(x.rev)}:null;}
 write(name,text,ref){const old=this.read(name);if(old?ref?.etag!==old.etag:!!ref)throw new GraphError(412,'conflict');const rev=(this.state.get(name)?.rev??0)+1;this.state.set(name,{text,rev});this.writes++;return {id:name,etag:String(rev)};}
 async readFinanceIndex(){return this.read('index');} async writeFinanceIndex(t,r){return this.write('index',t,r);} async readLiveVault(){return null;}
 async ensurePayrollNamespace(){} async listYearFiles(){return [];} async readMerchantRules(){return null;}
 async readAssetSettings(){return this.read('assets');} async writeAssetSettings(t,r){if(this.reject)throw new GraphError(403,'denied');return this.write('assets',t,r);}
}
const phrase='synthetic test vault phrase';
async function fixture(){const graph=new Graph(),a=new LiveVault(graph);await a.create(phrase);await a.upsertRecurring(bank);const b=new LiveVault(new Graph(graph.state));await b.unlock(phrase);return {a,b,graph};}
const only=v=>{const entries=originContracts(v.assetSettings());assert.equal(entries.length,1);return entries[0];};
test('②-D: 暗号化保存一回で移動し再解除でも二重登録されない',async()=>{
 const {a,graph}=await fixture(),n=graph.writes;await a.editContract(only(a),edit(route));assert.equal(graph.writes,n+1);assert.equal(only(a).payment,'card');assert.ok(a.assetSettings().deletedRecurring.includes(bank.id));assert.doesNotMatch(graph.read('assets').text,/合成契約|SYNTHETIC SERVICE/);
 const c=new LiveVault(new Graph(graph.state));await c.unlock(phrase);assert.equal(only(c).id,bank.id);assert.equal(only(c).payment,'card');
});
test('②-D: 移動前の端末による無関係な残高保存で古い契約が復活しない',async()=>{
 const {a,b}=await fixture();await a.editContract(only(a),edit(route));await b.setBirthMonth('2000-01');assert.equal(only(b).payment,'card');assert.equal(b.assetSettings().birthMonth,'2000-01');await a.refresh();assert.equal(only(a).payment,'card');
});
test('②-D: 移動前の端末による同一契約の編集・削除を拒否する',async()=>{
 const {a,b}=await fixture(),old=only(b);await a.editContract(only(a),edit(route));await assert.rejects(b.editContract(old,edit(cash)));await assert.rejects(b.upsertRecurring({...old,name:'古い編集'}));await assert.rejects(b.deleteRecurring(old.id));await b.refresh();assert.equal(only(b).payment,'card');
});
test('②-D: 銀行→カード→銀行の再訂正を別端末の独立編集と両立する',async()=>{
 const {a,b}=await fixture();await a.editContract(only(a),edit(route));await b.refresh();await a.editContract(only(a),edit(originalPaymentTerms(bank)));await b.setBirthMonth('2000-02');assert.equal(only(b).kind,'expense');assert.equal(only(b).id,bank.id);assert.ok(b.assetSettings().deletedFixedCosts.includes(bank.id));assert.ok(!b.assetSettings().deletedRecurring.includes(bank.id));await b.editContract(only(b),edit(cash));assert.equal(only(b).payment,'cash');
});
test('②-D: 移動後の削除は移動前の端末が同期しても復活しない',async()=>{
 const {a,b}=await fixture();await a.editContract(only(a),edit(route));await a.deleteFixedCost(bank.id);await b.setBirthMonth('2000-03');assert.equal(originContracts(b.assetSettings()).length,0);assert.ok(b.assetSettings().deletedRecurring.includes(bank.id));assert.ok(b.assetSettings().deletedFixedCosts.includes(bank.id));
});
test('②-D: 移動書込み拒否時に元の契約・削除履歴を変更しない',async()=>{
 const {a,graph}=await fixture(),before=a.assetSettings();graph.reject=true;await assert.rejects(a.editContract(only(a),edit(route)),GraphError);assert.deepEqual(a.assetSettings(),before);
});
test('②-D: 別契約の同一カード利用先との重複を拒否し元の契約を保持する',async()=>{
 const {a,graph}=await fixture();const other={...correct(bank,route),id:'other-contract-demo'};await a.upsertFixedCost(other);const before=a.assetSettings(),n=graph.writes;await assert.rejects(a.editContract(before.recurring[0],edit(route)),/重複/);assert.equal(graph.writes,n);assert.deepEqual(a.assetSettings(),before);
});
test('②-D: 移動前の契約と別端末の異なる編集は三者マージで拒否する',()=>{
 const b=validateAssets({...emptyAssets(),recurring:[bank]});const l=validateAssets({...b,format:'finance-assets-v2',recurring:[],deletedRecurring:[bank.id],fixedCosts:[correct(bank,route)]});const r=validateAssets({...b,recurring:[{...bank,name:'他端末の編集'}]});assert.throws(()=>mergeAssets(b,l,r));
});
test('②-D: 旧利用先の登録済み候補を独立した固定費として復活させない',async()=>{
 const {a,graph}=await fixture();await a.editContract(only(a),edit(route));const card=only(a);
 await a.upsertFixedCost(card,{cardId:'smbc-nl',merchant:'synthetic service',label:'合成候補',amount:1000,frequency:'monthly',state:'registered',updatedAt:new Date().toISOString()});
 assert.equal(a.assetSettings().cardRecurringDecisions[route.merchantKey].state,'registered');
 const n=graph.writes;await a.editContract(only(a),edit(cash));assert.equal(graph.writes,n+1);assert.equal(a.assetSettings().cardRecurringDecisions?.[route.merchantKey],undefined);assert.equal(only(a).payment,'cash');
});
test('②-D: 移動応答の消失では再保存を止め、明示再取得で確定済みの移動を復元する',async()=>{
 const {a,graph}=await fixture(),before=only(a),write=graph.writeAssetSettings.bind(graph);let first=true;
 graph.writeAssetSettings=async(t,r)=>{const result=await write(t,r);if(first){first=false;throw new Error('synthetic lost response');}return result;};
 await assert.rejects(a.editContract(before,edit(route)));assert.deepEqual(only(a),before);await assert.rejects(a.editContract(before,edit(cash)));await a.refresh();assert.equal(only(a).payment,'card');assert.equal(only(a).id,bank.id);
});
test('②-D: 開始前に登録した後日の料金・停止予定を初期支払条件の訂正で失わない',()=>{
 const item={...bank,amount:1500,pricing:[{effectiveOn:start,amount:1000},{effectiveOn:later,amount:1500}],pauses:[{startOn:later,endOn:null}]};const result=correct(item,route);assert.deepEqual(result.pricing,item.pricing);assert.deepEqual(result.pauses,item.pauses);assert.equal(result.amount,1500);assert.equal(result.startOn,start);
});
