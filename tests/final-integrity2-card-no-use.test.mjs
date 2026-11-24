import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {LiveVault,CloudWriteUncertainError} from './helpers/coordinated-vault.mjs';
import {GraphError,OneDriveTestClient} from '../dist/src/cloud/onedrive-api.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {emptyAssets} from '../dist/src/cloud/assets.js';
import {estimatedCardFixedBills} from '../dist/src/cloud/card-fixed-estimates.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const phrase='synthetic words for this isolated vault';
const month='2025-01',other='2025-02';
const statement=(payment=month,billing='2024-12')=>({provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'synthetic',billingMonth:billing,paymentDate:payment+'-10',statedTotal:100,confirmation:'confirmed',warnings:[],rows:[{id:'row-a',usedOn:billing+'-01',merchant:'STORE',amount:100}]});
class Graph {
 constructor(state){this.state=state;this.writes=[];this.failAsset=null;this.failYear=null;}
 read(name){const x=this.state.get(name);return x?{id:name,etag:`"${x.rev}"`,text:x.text}:null;}
 write(name,text,ref){const old=this.read(name);if(old?ref?.etag!==old.etag:!!ref)throw new GraphError(412,'conflict');const rev=(this.state.get(name)?.rev??0)+1;this.state.set(name,{text,rev});this.writes.push(name);return {id:name,etag:`"${rev}"`};}
 async readFinanceIndex(){return this.read('index');}
 async writeFinanceIndex(t,r){return this.write('index',t,r);}
 async readLiveVault(){return null;}
 async ensurePayrollNamespace(){}
 async listYearFiles(){return [...this.state.keys()].filter(x=>x.startsWith('year:')).map(x=>({year:x.slice(5),id:x,etag:this.read(x).etag}));}
 async readYearVault(y){return this.read('year:'+y);}
 async writeYearVault(y,t,r){if(this.failYear)throw this.failYear;return this.write('year:'+y,t,r);}
 async readMerchantRules(){return null;}
 async readAssetSettings(){return this.read('assets');}
 async writeAssetSettings(t,r){if(this.failAsset==='reject')throw new GraphError(403,'denied');const result=this.write('assets',t,r);if(this.failAsset==='lost')throw new Error('response lost');return this.failAsset==='noetag'?null:result;}
}
async function fixture(){const state=new Map(),ga=new Graph(state),gb=new Graph(state),a=new LiveVault(ga),b=new LiveVault(gb);await a.create(phrase);return {a,b,ga,gb,state};}
const save=(v,p=month,b='2024-12')=>v.saveBatch([{id:'bill-a',statement:statement(p,b)}]);
const flags=v=>v.assetSettings().cardNoUseMonths??[];
const report=v=>monthlyReport(month,{assets:v.assetSettings(),records:v.records(),rules:[],categories:[],payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2025-03'});
async function reopen(state){const c=new LiveVault(new Graph(state));await c.unlock(phrase);return c;}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('②-B: 利用なし→異なる請求年の明細→削除でも古い0円は復活しない',async()=>{
 const {a,ga,state}=await fixture();await a.setCardNoUseMonth(month,true);await a.setCardNoUseMonth(other,true);
 const before=ga.writes.length;await save(a);assert.deepEqual(ga.writes.slice(before, before+2),['assets','year:2024']);
 assert.deepEqual(flags(a),[other]);assert.equal(report(a).cardOutflow,100);
 await a.delete('bill-a');const c=await reopen(state);assert.deepEqual(flags(c),[other]);assert.equal(report(c).cardOutflow,null);
 await c.setCardNoUseMonth(month,true);assert.equal(report(c).cardOutflow,0);
});
test('②-B: 古い端末の明細登録は別端末の新しい確認と独立した資産変更を維持・取消する',async()=>{
 const {a,b,state}=await fixture();await b.unlock(phrase);await a.setCardNoUseMonth(month,true);await a.setCardNoUseMonth(other,true);await a.setBirthMonth('2000-01');
 await save(b);await a.setBirthMonth('2000-02');await b.delete('bill-a');const c=await reopen(state);assert.deepEqual(flags(c),[other]);assert.equal(c.assetSettings().birthMonth,'2000-02');assert.equal(report(c).cardOutflow,null);
});
test('②-B: 古い端末の利用なし操作は別端末の既存明細・登録削除済み明細の両方で停止する',async()=>{
 const {a,b,state}=await fixture();await b.unlock(phrase);await save(a);
 await assert.rejects(b.setCardNoUseMonth(month,true),/明細がある月/);
 await a.delete('bill-a');await assert.rejects(b.setCardNoUseMonth(month,true),/別端末で更新/);
 assert.deepEqual(flags(await reopen(state)),[]);await b.refresh();await b.setCardNoUseMonth(month,true);assert.deepEqual(flags(await reopen(state)),[month]);
});
test('②-B: 利用なし取消の拒否時に明細は一件も書かない',async()=>{
 const {a,ga,state}=await fixture();await a.setCardNoUseMonth(month,true);ga.failAsset='reject';
 await assert.rejects(save(a),e=>e instanceof GraphError&&e.status===403);assert.equal(state.has('year:2024'),false);assert.deepEqual(flags(await reopen(state)),[month]);
 ga.failAsset=null;await save(a);assert.deepEqual(flags(await reopen(state)),[]);
});
test('②-B: 取消の応答不明は明細送信を止め、再取得・再開で古い確認を戻さない',async()=>{
 const {a,ga,state}=await fixture();await a.setCardNoUseMonth(month,true);ga.failAsset='lost';
 await assert.rejects(save(a),CloudWriteUncertainError);assert.equal(state.has('year:2024'),false);assert.deepEqual(flags(a),[]);
 await assert.rejects(a.setCardNoUseMonth(month,true),/未確認/);await assert.rejects(save(a),CloudWriteUncertainError);
 ga.failAsset=null;await a.resumePendingYearBatch();assert.equal(report(a).cardOutflow,100);await a.delete('bill-a');assert.equal(report(await reopen(state)).cardOutflow,null);
});
test('②-B: 明細書込み拒否後は以前の確認を復活させず、明示再確認だけを認める',async()=>{
 const {a,ga,state}=await fixture();await a.setCardNoUseMonth(month,true);ga.failYear=new GraphError(403,'denied');
 await assert.rejects(save(a),e=>e instanceof GraphError&&e.status===403);assert.equal(state.has('year:2024'),false);assert.equal(report(await reopen(state)).cardOutflow,null);
 await a.setCardNoUseMonth(month,true);assert.equal(report(await reopen(state)).cardOutflow,0);
});
test('②-B: ETagなしの取消は暗号データ再読込で照合してから明細を書き込む',async()=>{
 const {a,ga,state}=await fixture();await a.setCardNoUseMonth(month,true);ga.failAsset='noetag';await save(a);await a.delete('bill-a');assert.equal(report(await reopen(state)).cardOutflow,null);
});
test('②-B: 支払月を変更した場合は移動元・移動先の古い確認を維持しない',async()=>{
 const {a,state}=await fixture();await a.setCardNoUseMonth(other,true);await save(a);await save(a,other,'2025-01');await a.delete('bill-a');assert.deepEqual(flags(await reopen(state)),[]);
});
test('②-B: 明細書込みの操作権保持中は別端末による利用なし確認を拒否する',async()=>{
 const {a,b,ga,state}=await fixture();await a.setCardNoUseMonth(month,true);await b.unlock(phrase);
 const entered=deferred(),release=deferred(),original=ga.writeYearVault.bind(ga);ga.writeYearVault=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
 const saving=save(a);await entered.promise;try{await assert.rejects(b.setCardNoUseMonth(month,true),/別の端末/);}finally{release.resolve();}await saving;assert.deepEqual(flags(await reopen(state)),[]);
});
test('②-B: 先行refreshの遅延結果は明細保存後の取消を巻き戻さない',async()=>{
 const {a,ga}=await fixture();await a.setCardNoUseMonth(month,true);const entered=deferred(),release=deferred(),read=ga.readAssetSettings.bind(ga);let once=true;
 ga.readAssetSettings=async(fresh)=>{const result=await read();if(once&&!fresh){once=false;entered.resolve();await release.promise;}return result;};
 const refresh=a.refresh(),rejected=assert.rejects(refresh,/取得中/);await entered.promise;try{await save(a);}finally{release.resolve();}await rejected;assert.deepEqual(flags(a),[]);assert.equal(report(a).cardOutflow,100);
});
test('②-B: 別端末の古い確認と新しい削除済み年度を組み合わせるrefreshを拒否する',async()=>{
 const {a,b,gb}=await fixture();await a.setCardNoUseMonth(month,true);await b.unlock(phrase);
 const entered=deferred(),release=deferred(),original=gb.listYearFiles.bind(gb);let once=true;gb.listYearFiles=async()=>{if(once){once=false;entered.resolve();await release.promise;}return original();};
 const refresh=b.refresh(),rejected=assert.rejects(refresh,/利用なし確認が取得中に更新/);await entered.promise;
 try{await save(a);await a.delete('bill-a');}finally{release.resolve();}await rejected;await b.refresh();assert.equal(report(b).cardOutflow,null);
});
test('②-B: 既存の矛盾した利用なし確認は他カードの固定費見込みを隠さない',()=>{
 const assets={...emptyAssets(),cardNoUseMonths:[month],cardDebitAccounts:{'rakuten-mizuho':'mizuho-bank'},cardPreferences:{'rakuten-mizuho':{payment:{monthOffset:0,day:27}}},fixedCosts:[{id:'cost-1',name:'TEST',payment:'card',cardId:'rakuten-mizuho',merchantKey:'rakuten-mizuho|TEST',categoryId:null,frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:'2025-01-01',endOn:null,amount:1000,priceKind:'fixed',pricing:[{effectiveOn:'2025-01-01',amount:1000}],pauses:[],note:'',updatedAt:'2025-01-01T00:00:00Z'}]};
 assert.equal(estimatedCardFixedBills(assets,[],'2025-01-01','2025-01-31').length,0);assert.equal(estimatedCardFixedBills(assets,[{id:'other',statement:statement()}],'2025-01-01','2025-01-31').length,1);
});
test('②-B: 実Graphのfresh読込は先行暗号ファイル読込の共有結果に依存しない',async()=>{
 const entered=deferred(),release=deferred();let version=1,calls=0;
 const client=new OneDriveTestClient('stub',async(url)=>{
  if(url.endsWith('/special/approot'))return Response.json({id:'root'});
  if(url.endsWith('/root:/finance'))return Response.json({id:'f',folder:{}});
  if(url.endsWith('/f:/settings'))return Response.json({id:'s',folder:{}});
  if(url.endsWith('/s:/assets.enc')){const v=version;calls++;if(v===1){entered.resolve();await release.promise;}return Response.json({id:'a',eTag:`"${v}"`,'@microsoft.graph.downloadUrl':`https://files.test/${v}`});}
  if(url.startsWith('https://files.test/'))return new Response('cipher-'+url.at(-1));
  throw new Error('unexpected route');
 });
 const old=client.readAssetSettings();await entered.promise;version=2;
 try{assert.equal((await client.readAssetSettings(true)).text,'cipher-2');}finally{release.resolve();}assert.equal((await old).text,'cipher-1');assert.equal(calls,2);assert.equal((await client.readAssetSettings()).text,'cipher-2');
});

test('②-B: 確認時の年度取得失敗は資産の未確認書込みにしない',async()=>{
 const {a,ga,state}=await fixture();const read=ga.listYearFiles.bind(ga);ga.listYearFiles=async()=>{throw new Error('offline');};
 await assert.rejects(a.setCardNoUseMonth(month,true),/最新のカード明細を確認できない/);assert.equal(state.has('assets'),false);
 ga.listYearFiles=read;await a.setCardNoUseMonth(month,true);assert.deepEqual(flags(a),[month]);
});
test('②-B: 最新の資産設定を読めない場合は明細の書込み前に停止する',async()=>{
 const {a,ga,state}=await fixture();await a.setCardNoUseMonth(month,true);const read=ga.readAssetSettings.bind(ga);ga.readAssetSettings=async()=>{throw new Error('offline');};
 await assert.rejects(save(a),/最新状態を取得できない/);assert.equal(state.has('year:2024'),false);
 ga.readAssetSettings=read;await save(a);assert.deepEqual(flags(await reopen(state)),[]);
});
test('②-B: 旧端末で残された矛盾した確認も既存明細の削除前に取消す',async()=>{
 const {a,ga,state}=await fixture();await a.setCardNoUseMonth(month,true);
 // Simulate the exact pre-fix storage state, including real encrypted assets.
 const asset=structuredClone(state.get('assets'));await save(a);
 state.set('assets',{text:asset.text,rev:state.get('assets').rev+1});
 const b=await reopen(state);assert.deepEqual(flags(b),[month]);assert.equal(report(b).cardOutflow,100);
 await b.delete('bill-a');assert.equal(report(await reopen(state)).cardOutflow,null);
});
test('②-B: 資産ETag競合で再取得しても別端末の無関係な設定を失わない',async()=>{
 const {a,ga,state}=await fixture();await a.setCardNoUseMonth(month,true);await a.setBirthMonth('2000-01');
 const write=ga.writeAssetSettings.bind(ga);let once=true;ga.writeAssetSettings=async(...args)=>{if(once){once=false;const old=state.get('assets');state.set('assets',{...old,rev:old.rev+1});throw new GraphError(412,'conflict');}return write(...args);};
 await save(a);const c=await reopen(state);assert.equal(c.assetSettings().birthMonth,'2000-01');assert.deepEqual(flags(c),[]);
});
