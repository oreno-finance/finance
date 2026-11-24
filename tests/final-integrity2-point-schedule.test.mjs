import test from 'node:test';
import assert from 'node:assert/strict';
import {editPointRate,pointRate,statementPoints} from '../dist/src/summary/point-benefits.js';
import {validateCardPreferences} from '../dist/src/cloud/assets.js';
import {LiveVault,CloudEditCancelledError} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
const card='smbc-nl',today='2026-11-24',future='2027-03-01';
const old={pointRatePercent:1,pointRateHistory:[{effectiveOn:'1900-01-01',ratePercent:2},{effectiveOn:'2026-01-01',ratePercent:1.5},{effectiveOn:future,ratePercent:1}]};
const edit=(mode,rate=1,date=future,day=today,expected=future)=>editPointRate(card,old,mode,rate,date,day,expected);
const rates=(pref,day)=>pointRate(card,{[card]:pref},day);
test('②-C: 日付だけの前倒しは旧予定を置換し過去の利用日を保持する',()=>{
 const result=edit('replace',1,'2027-01-01');assert.equal(result.pointRateHistory.length,3);assert.deepEqual(result.pointRateHistory.slice(0,-1),old.pointRateHistory.slice(0,-1));
 assert.equal(rates(result,'2026-12-31'),1.5);assert.equal(rates(result,'2027-01-01'),1);assert.equal(old.pointRateHistory.at(-1).effectiveOn,future);
});
test('②-C: 日付だけの延期は旧予定日に旧還元率を維持する',()=>{const result=edit('replace',1,'2027-04-01');assert.equal(rates(result,future),1.5);assert.equal(rates(result,'2027-04-01'),1);});
test('②-C: 同日の予定還元率変更は重複を作らない',()=>{const result=edit('replace',0);assert.equal(result.pointRatePercent,0);assert.equal(result.pointRateHistory.length,3);assert.equal(rates(result,future),0);});
test('②-C: 取消は直前の還元率に戻し過去の履歴を維持する',()=>{const result=edit('cancel');assert.equal(result.pointRatePercent,1.5);assert.deepEqual(result.pointRateHistory,old.pointRateHistory.slice(0,-1));assert.equal(rates(result,future),1.5);assert.deepEqual(validateCardPreferences({[card]:result})[card],result);});
test('②-C: 複数の将来予定から最新だけを取消し前の予定を残す',()=>{const prior=edit('append',0.5,'2027-05-01');const result=editPointRate(card,prior,'cancel',0,'',today,'2027-05-01');assert.deepEqual(result,old);});
test('②-C: 適用済み・日付不一致・過去日・不正日・不正率の編集を拒否する',()=>{
 for(const action of [()=>edit('cancel',1,future,future),()=>edit('replace',1,future,future),()=>edit('cancel',1,future,today,'2027-02-01'),()=>edit('replace',1,'2026-11-23'),()=>edit('replace',1,'2027-02-30'),()=>edit('replace',0.001),()=>edit('append',0.5,future)])assert.throws(action);
});
test('②-C: 先行予定以前への移動を拒否する',()=>{const prior=edit('append',0.5,'2027-05-01');assert.throws(()=>editPointRate(card,prior,'replace',0.5,future,today,'2027-05-01'));});
test('②-C: 変更履歴がない旧設定に初回予定を追加し従来の還元率を保持する',()=>{const result=editPointRate(card,{pointRatePercent:1.2},'change',0.5,future,today);assert.equal(rates(result,today),1.2);assert.equal(rates(result,future),0.5);});
test('②-C: 支払日ではなく利用日で算定する既存ポイントは予定変更・取消で変動しない',()=>{const bill={cardId:card,rows:[{amount:10000,usedOn:'2025-12-31'},{amount:10000,usedOn:'2026-11-01'}]};for(const result of [old,edit('cancel'),edit('replace',0,'2027-01-01')])assert.equal(statementPoints(bill,{[card]:result}),350);});
class Graph {
 constructor(state){this.state=state;this.writes=0;this.reject=false;}
 read(name){const x=this.state.get(name);return x?{id:name,etag:`"${x.rev}"`,text:x.text}:null;}
 write(name,text,ref){const prior=this.read(name);if(prior?ref?.etag!==prior.etag:!!ref)throw new GraphError(412,'conflict');const rev=(this.state.get(name)?.rev??0)+1;this.state.set(name,{text,rev});this.writes++;return {id:name,etag:`"${rev}"`};}
 async readFinanceIndex(){return this.read('index');} async writeFinanceIndex(t,r){return this.write('index',t,r);} async readLiveVault(){return null;}
 async ensurePayrollNamespace(){} async listYearFiles(){return [];} async readMerchantRules(){return null;}
 async readAssetSettings(){return this.read('assets');} async writeAssetSettings(t,r){if(this.reject)throw new GraphError(403,'denied');return this.write('assets',t,r);}
}
const phrase='synthetic test passphrase only';
async function fixture(){const state=new Map(),ga=new Graph(state),a=new LiveVault(ga),b=new LiveVault(new Graph(state));await a.create(phrase);const day=new Date();day.setFullYear(day.getFullYear()+2);const futureDay=day.toLocaleDateString('sv-SE');const pref={pointRatePercent:1,pointRateHistory:[{effectiveOn:'1900-01-01',ratePercent:2},{effectiveOn:futureDay,ratePercent:1}]};await a.setCardConfiguration({[card]:pref},{});await b.unlock(phrase);return {state,ga,a,b,pref,futureDay};}
const cancel=(pref,futureDay)=>editPointRate(card,pref,'cancel',0,'',new Date().toLocaleDateString('sv-SE'),futureDay);
test('②-C: 暗号化保存・再解除で取消と別端末の独立した資産変更を維持する',async()=>{const {a,b,state,pref,futureDay}=await fixture();await b.setBirthMonth('2000-01');await a.setCardConfiguration({[card]:cancel(pref,futureDay)},{});const c=new LiveVault(new Graph(state));await c.unlock(phrase);assert.equal(c.assetSettings().birthMonth,'2000-01');assert.deepEqual(c.assetSettings().cardPreferences[card],cancel(pref,futureDay));});
test('②-C: 別端末が更新した予定は古い取消で上書きできない',async()=>{const {a,b,pref,futureDay}=await fixture();await b.setCardConfiguration({[card]:editPointRate(card,pref,'replace',0.5,futureDay,new Date().toLocaleDateString('sv-SE'),futureDay)},{});await assert.rejects(a.setCardConfiguration({[card]:cancel(pref,futureDay)},{}),CloudEditCancelledError);await a.refresh();assert.equal(a.assetSettings().cardPreferences[card].pointRatePercent,0.5);});
test('②-C: 別端末の予定変更を表示名の編集で巻き戻さない',async()=>{const {a,b,pref,futureDay}=await fixture();await b.setCardConfiguration({[card]:cancel(pref,futureDay)},{});await assert.rejects(a.setCardConfiguration({[card]:{...pref,name:'Test card'}},{}),CloudEditCancelledError);});
test('②-C: 保存拒否ではローカルの予定を変更しない',async()=>{const {a,ga,pref,futureDay}=await fixture();ga.reject=true;await assert.rejects(a.setCardConfiguration({[card]:cancel(pref,futureDay)},{}),GraphError);assert.deepEqual(a.assetSettings().cardPreferences[card],pref);});
