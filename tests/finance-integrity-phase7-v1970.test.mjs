import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyAssets, validateAssets, mergeAssets, detectAssetsEditCollisions} from '../dist/src/cloud/assets.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {analyzePeriods} from '../dist/src/analysis/period-analytics.js';
import {analysisDrilldownBreakdown,validateAnalysisDrilldown} from '../dist/src/ui/analysis-drilldown.js';
import {mizuhoFundingStatus,mizuhoFundingDescription} from '../dist/src/home/mizuho-funding.js';
import {estimatedCardFixedBills} from '../dist/src/cloud/card-fixed-estimates.js';
import {forecastAccounts} from '../dist/src/home/account-events.js';

const cat=[{id:'home',name:'生活費',color:'#7799aa'}];
const payroll={ready:false,syncedAt:null,entries:[]};
const source=(assets=emptyAssets(),records=[])=>({records,assets,rules:[],categories:cat,payroll,currentPeriod:'2026-11'});
const once=(id,kind,amount,status='done',date='2026-10-05',categoryId='home')=>({id,date,name:'単発 '+id,amount,kind,status,categoryId,
  fromAccountId:kind==='expense'?'cash-savings':null,toAccountId:kind==='income'?'cash-savings':null});
const cost=(overrides={})=>({id:'cost-sub-0001',name:'動画サービス',payment:'card',cardId:'smbc-nl',merchantKey:'smbc-nl|video',categoryId:'home',
 frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:'2026-10-01',endOn:null,amount:2000,priceKind:'fixed',
 pricing:[{effectiveOn:'2026-10-01',amount:2000}],pauses:[],note:'',updatedAt:'2026-11-23T00:00:00Z',...overrides});
const row=(id,merchant,amount)=>({id,merchant,amount,usedOn:'2026-10-05'});
const record=(id,paymentDate,amount=50000,cardId='smbc-nl',billingMonth='2026-09')=>({id,statement:{provider:'smbc',cardId,
 sourceKind:'paste',sourceName:'synthetic',billingMonth,paymentDate,statedTotal:amount,confirmation:'confirmed',warnings:[],rows:[row('r-'+id,'STORE',amount)]}});
const read=(p)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('one-off expense category reconciles exactly to card + recurring + executed one-off total',()=>{
 const assets={...emptyAssets(),oneTime:[once('once-cat-01','expense',20000)]};
 const reports=monthlyReport('2026-10',source(assets,[record('statement-01','2026-10-27')]));
 assert.equal(reports.cardOutflow,50000);assert.equal(reports.oneTimeExpense,20000);
 assert.equal(reports.categories.reduce((s,x)=>s+x.amount,0),70000);
 assert.equal(reports.categories.find(c=>c.id==='home')?.amount,20000);
 const withBank={...assets,recurring:[{id:'bank-cost-01',name:'銀行引落',kind:'expense',amount:10000,fromAccountId:'cash-savings',toAccountId:null,
  categoryId:'home',frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,enabled:true}]};
 const full=monthlyReport('2026-10',source(withBank,[record('statement-01','2026-10-27')]));
 assert.equal(full.recurringExpense,10000);assert.equal(full.categories.reduce((s,x)=>s+x.amount,0),80000);
});

test('past planned one-offs are excluded from registered expense and surfaced separately',()=>{
 const a={...emptyAssets(),oneTime:[once('planned-1','expense',50000,'planned')]};
 const r=monthlyReport('2026-10',source(a,[]));
 assert.equal(r.oneTimeExpense,0);assert.equal(r.oneTimePlannedExpense,50000);
 assert.equal(r.pastUnconfirmedOneTime,1);assert.equal(r.categories.reduce((n,x)=>n+x.amount,0),0);
 const changed={...a,oneTime:[{...a.oneTime[0],status:'done'}]};
 assert.equal(monthlyReport('2026-10',source(changed,[])).oneTimeExpense,50000);
});

test('missing cards still expose known cash/bank expense; explicit no-use is zero, not missing',()=>{
 const a={...emptyAssets(),oneTime:[once('one-no-card','expense',30000)]};
 const missing=monthlyReport('2026-10',source(a));
 assert.equal(missing.cardOutflow,null);
 const analysis=analyzePeriods(source(a),['2026-10'],'2026-11');
 assert.equal(analysis.months[0].coverage,'partial');assert.equal(analysis.months[0].expense,30000);
 const noUse={...a,cardNoUseMonths:['2026-10']};
 assert.equal(monthlyReport('2026-10',source(noUse)).cardOutflow,0);
 assert.equal(analyzePeriods(source(noUse),['2026-10'],'2026-11').months[0].coverage,'registered');
 assert.equal(monthlyReport('2026-10',source(emptyAssets())).cardOutflow,null);
});

test('mizuho funding acknowledgement invalidates after bill amount/payment date/record changes',()=>{
 const bill={id:'confirmed-statement',cardId:'rakuten-mizuho',amount:24245,confirmation:'confirmed',paymentDate:'2026-11-27'};
 const check={done:true,updatedAt:'2026-11-23T09:00:00Z',billAmount:24245,paymentDate:bill.paymentDate,transferAmount:30000,billId:bill.id};
 const a={...emptyAssets(),cardDebitAccounts:{'rakuten-mizuho':'mizuho-bank'},mizuhoTransferPlan:{enabled:true,leadDays:3,extraForSmallBills:true},mizuhoFundingChecks:{'2026-11':check}};
 const status=b=>mizuhoFundingStatus({assets:a},{period:'2026-11',cardLines:[b]},'2026-11-24');
 assert.equal(status(bill).completed,true);
 for(const change of [{amount:36000},{paymentDate:'2026-11-28'},{id:'replacement'},{confirmation:'provisional'}]){
   const result=status({...bill,...change});assert.equal(result.completed,false);assert.equal(result.changedSinceCheck,true);
   assert.match(mizuhoFundingDescription(result),/再確認/);
 }
 const legacy={...a,mizuhoFundingChecks:{'2026-11':{done:true,updatedAt:check.updatedAt}}};
 assert.equal(mizuhoFundingStatus({assets:legacy},{period:'2026-11',cardLines:[bill]},'2026-11-24').completed,false);
});

test('future card fixed costs produce labeled estimates only when no statement exists',()=>{
 const a={...emptyAssets(),fixedCosts:[cost()],cardDebitAccounts:{'smbc-nl':'rakuten-bank'},
  cardPreferences:{'smbc-nl':{name:'三井住友NL',issuer:'smbc',payment:{monthOffset:1,day:27}}}};
 const bills=estimatedCardFixedBills(a,[],'2026-11-01','2026-12-31');
 assert.ok(bills.some(b=>b.paymentDate==='2026-11-27'&&b.amount===2000&&b.estimated));
 assert.ok(bills.some(b=>b.paymentDate==='2026-12-28'&&b.name.includes('推定')));
 assert.equal(estimatedCardFixedBills(a,[record('actual-bill','2026-12-28',25000)],'2026-12-01','2026-12-31').length,0);
 assert.equal(estimatedCardFixedBills({...a,cardDebitAccounts:{}},[],'2026-11-01','2026-12-31').length,0);
 assert.equal(estimatedCardFixedBills({...a,cardNoUseMonths:['2026-12']},[],'2026-12-01','2026-12-31').length,0);
});

test('card estimates affect account cashflow without fabricating confirmed cards',()=>{
 const a={...emptyAssets(),fixedCosts:[cost()],cardDebitAccounts:{'smbc-nl':'rakuten-bank'},
  cardPreferences:{'smbc-nl':{name:'三井住友NL',issuer:'smbc',payment:{monthOffset:1,day:27}}},
  snapshots:[{id:'balance-rakuten-01',accountId:'rakuten-bank',balance:100000,observedAt:'2026-11-01T00:00:00Z'}]};
 const result=forecastAccounts(source(a),'2026-11-23',45);
 const events=result.accounts.flatMap(account=>account.days.flatMap(day=>day.events));
 assert.ok(events.some(e=>e.kind==='card-estimate'&&e.amount===-2000&&e.title.includes('推定')));
 assert.ok(!events.some(e=>e.kind==='card'&&e.amount===-2000));
});

test('one-time categories survive validated encrypted assets and concurrent cloud merges',()=>{
 const b=validateAssets(emptyAssets());
 const local=validateAssets({...b,oneTime:[once('once-cat-01','expense',999,'done','2026-10-05','home')]});
 const remote=validateAssets({...b,cardNoUseMonths:['2026-10']});
 const merged=mergeAssets(b,local,remote);
 assert.equal(merged.oneTime[0].categoryId,'home');assert.deepEqual(merged.cardNoUseMonths,['2026-10']);
 const b2=validateAssets({...b,oneTime:[once('once-cat-01','expense',999,'done','2026-10-05',null)]});
 const l2=validateAssets({...b2,oneTime:[{...b2.oneTime[0],categoryId:'home'}]});
 const r2=validateAssets({...b2,birthMonth:'2003-11'});
 assert.equal(mergeAssets(b2,l2,r2).oneTime[0].categoryId,'home');
 assert.deepEqual(detectAssetsEditCollisions(b2,l2,r2),[]);
});

test('contract deletion tombstones survive cloud merges and prevent reappearance',()=>{
 const item=cost();const base=validateAssets({...emptyAssets(),fixedCosts:[item]});
 const local=validateAssets({...base,fixedCosts:[],deletedFixedCosts:[item.id]});
 const merged=mergeAssets(base,local,base);
 assert.deepEqual(merged.fixedCosts,[]);assert.deepEqual(merged.deletedFixedCosts,[item.id]);
 assert.throws(()=>validateAssets({...base,deletedFixedCosts:[item.id]}),/削除済み/);
 const ui=read('src/ui/subscriptions.ts');
 assert.match(ui,/deleteFixedCost\(item.contract.id\)/);
 assert.match(ui,/if\(!ignore\)\{/);
 assert.match(ui,/内容を確認して登録/);
});

test('year-over-year drilldown accepts up to 24 months and shows side-by-side years',()=>{
 const months=Array.from({length:24},(_,i)=>`${2025+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`);
 const request={dimension:'category',value:'home',label:'生活費',periods:months};
 assert.doesNotThrow(()=>validateAnalysisDrilldown(request));
 const a={...emptyAssets(),oneTime:[once('one-2025','expense',10000,'done','2025-11-01'),once('one-2026','expense',2000,'done','2026-11-01')]};
 const data=analysisDrilldownBreakdown(source(a),request);
 assert.equal(data.oneTimeAmount,12000);assert.equal(data.total,12000);
 assert.equal(data.byYear.find(x=>x.year==='2025').total,10000);
 assert.equal(data.byYear.find(x=>x.year==='2026').total,2000);
 assert.match(read('src/ui/analysis.ts'),/\.\.\.prior\.months\.map/);
});

test('report archive warns about previous-month missing history without automatically writing',()=>{
 const reports=read('src/ui/monthly-reports.ts');
 assert.match(reports,/前月のレポートはまだ保存されていません/);
 assert.match(reports,/button\(`\$\{month\(previous\)\}を開く`/);
 assert.doesNotMatch(reports,/setInterval\([^)]*save/);
});
