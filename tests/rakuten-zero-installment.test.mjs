import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStatementText} from '../dist/src/importers/statement-parser.js';
import {importErrors,importDisplayErrors,duplicateMonths} from '../dist/src/importers/batch-policy.js';
import {planStatementImport} from '../dist/src/importers/import-policy.js';
import {monthlyReport,prepareMonthlyReports,monthlyCashflow} from '../dist/src/summary/monthly-summary.js';
import {analyzePeriods} from '../dist/src/analysis/period-analytics.js';
import {monthlyPointBenefits} from '../dist/src/summary/point-benefits.js';
import {bankTimeline} from '../dist/src/summary/bank-timeline.js';
import {forecastAccounts} from '../dist/src/home/account-events.js';
import {mizuhoFundingStatusForMonth} from '../dist/src/home/mizuho-funding.js';
import {estimatedCardFixedBills} from '../dist/src/cloud/card-fixed-estimates.js';
import {emptyAssets} from '../dist/src/cloud/assets.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
import {isZeroUsage} from '../dist/src/models/types.js';
const month='2024-04';
const header='利用日 利用店名 利用者 支払方法 利用金額 手数料/利息 支払総額 当月請求額 翌月繰越残高';
const intro=`ご利用代金請求明細書\n楽天カード株式会社\n2024年04月ご請求金額 ご利用カード`;
const paymentHeader='お支払日 返済方法 引落口座 請求確定日 利用獲得ポイント 調整額 返金額';
const zeroText=`${intro}\n0円 楽天カード(Visa) ****-****-****-0000\n${paymentHeader}\n- - - - - 0円 0円\nご利用明細\n${header.replace('当月請求額','当月支払額 当月請求額')}\n- - - - - - - - - -\n※ポイントで支払いサービス\nリボのお支払予定\n4月お支払予定金額の明細\nリボのお支払金額 明細中の利用金額合計\n0 0\n内)キャッシング 0\n明細中のリボ払い利用金額合計 0 本カード会員様利用分 0`;
const parse=(text,kind='pdf')=>parseStatementText(text,kind,'synthetic');
const zero=(cardId='rakuten-etc')=>({...parse(zeroText),cardId});
const paid=(period=month,cardId='smbc-nl')=>({id:'paid-'+period,statement:{provider:'smbc',cardId,sourceKind:'paste',sourceName:'test',billingMonth:period,paymentDate:period+'-10',statedTotal:900,confirmation:'confirmed',warnings:[],rows:[{id:'row',usedOn:period+'-01',merchant:'SYNTHETIC STORE',amount:900}]}});
const record=(cardId='rakuten-etc')=>({id:'zero-'+cardId,originalId:'fake-original',statement:zero(cardId)});
const source=(records,assets=emptyAssets())=>({records,assets,rules:[],categories:[],payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2024-06'});
for(const extraColumn of [false,true])test(`楽天分割払い: ${extraColumn?'6':'5'}金額列の当月請求額だけを集計`,()=>{
 const raw=`${intro}\n4,500円 楽天カード(Visa) ****-****-****-0000\n${paymentHeader}\n2024/04/27 口座振替\n${extraColumn?header.replace('当月請求額','当月支払額 当月請求額'):header}\n2024/03/03 架空商店 本人* 1回払い 500 0 500 ${extraColumn?'500 ':''}500 0\n2024/01/01 架空家電店 本人 分割 10回払い ( 3回目 ) 36,000 4,000 40,000 ${extraColumn?'4,000 ':''}4,000 28,000\n※ポイントで支払いサービス`;
 const s={...parse(raw),cardId:'rakuten-etc'};assert.deepEqual(s.rows.map(r=>r.amount),[500,4000]);assert.deepEqual(importErrors(s,true),[]);assert.equal(s.statedTotal,4500);
 const broken={...parse(raw.replace('28,000','')),cardId:'rakuten-etc'};assert.ok(importErrors(broken,true).length);
});
test('楽天の明示的な0円PDFは日付・取引を捏造せずカード選択後に保存可能',()=>{
 const s=parse(zeroText);assert.equal(s.zeroUsage,true);assert.equal(s.paymentDate,null);assert.deepEqual(s.rows,[]);assert.equal(s.confirmation,'confirmed');assert.deepEqual(s.warnings,[]);
 assert.deepEqual(importDisplayErrors(s,true),[]);assert.ok(importErrors(s,true).length);assert.deepEqual(importErrors(zero(),true),[]);assert.ok(importErrors(zero(),false).length);
});
for(const [name,mutate] of [
 ['総額不明',t=>t.replace('0円 楽天カード','楽天カード')],['非ゼロ',t=>t.replace('0円 楽天カード','10円 楽天カード')],
 ['明細行欠落',t=>t.replace('- - - - - - - - - -\n','')],['未解析行',t=>t.replace('- - - - - - - - - -','2024/03/02 不明な形式')],
 ['返金あり',t=>t.replace('- - - - - 0円 0円','- - - - - 0円 100円')],['2ページ目なし',t=>t.split('リボのお支払予定')[0]],
 ['2ページ目非ゼロ',t=>t.replace('\n0 0\n','\n0 100\n')],['暫定',t=>t+'\n確定前'],['未来',t=>t.replaceAll('2024','2099')],['別明細混在',t=>t+'\n'+t],
])test('0円の誤認を拒否: '+name,()=>{const s={...parse(mutate(zeroText)),cardId:'rakuten-etc'};assert.equal(s.zeroUsage,undefined);assert.ok(importErrors(s,true).length);});
test('貼り付けやマーカーなしの空明細は従来どおり保存不可',()=>{
 assert.equal(parse(zeroText,'paste').zeroUsage,undefined);const {zeroUsage:_,...s}=zero();assert.ok(importErrors(s,true).length);assert.ok(importErrors({...zero(),statedTotal:1},true).length);assert.ok(importErrors({...zero(),cardId:'smbc-nl'},true).length);
});
test('同月の異なるカードは分離、選択前の同じ空明細は勝手に重複と扱わない',()=>{
 const a=parse(zeroText),b=parse(zeroText);assert.deepEqual(planStatementImport([a],b),{kind:'add'});a.cardId='rakuten-etc';b.cardId='rakuten-mizuho';assert.equal(duplicateMonths([a,b]).size,0);b.cardId=a.cardId;assert.equal(duplicateMonths([a,b]).size,2);assert.equal(planStatementImport([a],b).kind,'duplicate');
});
test('カード別に0円を表示し他カードや月全体は未取得、索引経由でも同一',()=>{
 const s=source([record(),paid('2024-03')]);const r=monthlyReport(month,s);assert.deepEqual(r,monthlyReport(month,s,prepareMonthlyReports(s.records)));assert.equal(r.cardLines.length,1);assert.equal(r.cardLines[0].amount,0);assert.equal(r.cardLines[0].paymentDate,null);assert.equal(r.cardOutflow,null);assert.equal(r.monthlyBalance,null);assert.equal(r.issues.length,0);assert.equal(monthlyCashflow(r).coverage,'partial');assert.equal(r.cardNoUseConfirmed,false);
 const a=analyzePeriods(s,['2024-03',month],'2024-06');assert.deepEqual(a.groups.card.find(c=>c.id==='rakuten-etc').amounts,[null,0]);assert.deepEqual(a.groups.card.find(c=>c.id==='smbc-nl').amounts,[900,null]);assert.equal(monthlyPointBenefits(month,s).cards[0].points,0);
 const mixed=monthlyReport(month,source([record(),paid()]));assert.equal(mixed.cardOutflow,900);assert.equal(mixed.cardLines.length,2);assert.equal(mixed.categories.length,1);
});
test('利用なしPDFは引落イベント・送金・口座未設定警告を発生させない',()=>{
 const assets={...emptyAssets(),snapshots:[{id:'s',accountId:'rakuten-bank',balance:10000,observedAt:'2024-03-31T00:00:00Z'}],cardDebitAccounts:{'rakuten-mizuho':'mizuho-bank'},mizuhoTransferPlan:{enabled:true,leadDays:5,extraForSmallBills:true}};
 const s=source([record('rakuten-mizuho')],assets);const r=monthlyReport(month,s);assert.equal(mizuhoFundingStatusForMonth(s,r,'2024-04-25'),null);const timeline=bankTimeline(month,s,'2024-04-01');assert.equal(timeline.days.flatMap(d=>d.items).length,0);assert.equal(timeline.endBalance,10000);assert.deepEqual(forecastAccounts(s,'2024-04-01').debits,[]);assert.deepEqual(forecastAccounts(s,'2024-04-01').missingCardIds,[]);
});
test('0円PDFはそのカードの固定費予測のみを抑止する',()=>{
 const contract=cardId=>({id:'cost-'+cardId,name:'TEST',payment:'card',cardId,merchantKey:cardId+'|TEST',categoryId:null,frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:'2024-01-01',endOn:null,amount:1000,priceKind:'fixed',pricing:[{effectiveOn:'2024-01-01',amount:1000}],pauses:[],note:'',updatedAt:'2024-01-01T00:00:00Z'});
 const assets={...emptyAssets(),cardDebitAccounts:{'rakuten-etc':'rakuten-bank','rakuten-mizuho':'mizuho-bank'},cardPreferences:Object.fromEntries(['rakuten-etc','rakuten-mizuho'].map(id=>[id,{payment:{monthOffset:0,day:27}}])),fixedCosts:[contract('rakuten-etc'),contract('rakuten-mizuho')]};
 assert.deepEqual(estimatedCardFixedBills(assets,[record()],'2024-04-01','2024-04-30').map(x=>x.cardId),['rakuten-mizuho']);
});
class Graph {
 constructor(state){this.state=state;this.originals=state.originals??=new Map();}
 read(name){const x=this.state.get(name);return x?{id:name,etag:`"${x.rev}"`,text:x.text}:null;}
 write(name,text,ref){const old=this.read(name);if(old?ref?.etag!==old.etag:!!ref)throw new GraphError(412,'conflict');const rev=(this.state.get(name)?.rev??0)+1;this.state.set(name,{text,rev});return {id:name,etag:`"${rev}"`};}
 async readFinanceIndex(){return this.read('index');} async writeFinanceIndex(t,r){return this.write('index',t,r);}
 async readLiveVault(){return null;} async ensurePayrollNamespace(){}
 async listYearFiles(){return [...this.state.keys()].filter(x=>x.startsWith('year:')).map(x=>({year:x.slice(5),id:x,etag:this.read(x).etag}));}
 async readYearVault(y){return this.read('year:'+y);} async writeYearVault(y,t,r){return this.write('year:'+y,t,r);}
 async readMerchantRules(){return null;} async readAssetSettings(){return this.read('assets');} async writeAssetSettings(t,r){return this.write('assets',t,r);}
 async uploadDatedOriginal(id,t,m){const k=m+':'+id;if(this.originals.has(k))throw new GraphError(409,'exists');this.originals.set(k,t);}
 async downloadDatedOriginal(id,m){return this.originals.get(m+':'+id);}
}
test('暗号化保存・別端末・同月別カード・削除でも全カード利用なしが復活しない',async()=>{
 const state=new Map(),a=new LiveVault(new Graph(state)),b=new LiveVault(new Graph(state)),phrase='synthetic vault test phrase';await a.create(phrase);await b.unlock(phrase);await a.setCardNoUseMonth(month,true);
 const bytes=Uint8Array.from([37,80,68,70,1,2,3]);const item=(id,cardId)=>({id,statement:zero(cardId),source:{bytes:bytes.slice(),mime:'application/pdf'}});
 await a.saveBatch([item('a','rakuten-etc')]);assert.deepEqual(a.assetSettings().cardNoUseMonths,[]);await assert.rejects(b.setCardNoUseMonth(month,true),/明細がある月/);await b.refresh();await b.saveBatch([item('b','rakuten-mizuho')]);await assert.rejects(a.saveBatch([item('duplicate','rakuten-etc')]),/重複/);await a.refresh();assert.equal(a.records().length,2);assert.ok(a.records().every(r=>isZeroUsage(r.statement)));assert.deepEqual(await a.original('a'),bytes);assert.ok(!state.get('year:2024').text.includes('zeroUsage'));await a.delete('a');await a.delete('b');const c=new LiveVault(new Graph(state));await c.unlock(phrase);assert.equal(c.records().length,0);assert.deepEqual(c.assetSettings().cardNoUseMonths,[]);
});
