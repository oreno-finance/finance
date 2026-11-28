import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyAssets} from '../dist/src/cloud/assets.js';
import {fixedCostState,fixedCostOccurrences} from '../dist/src/fixed-costs/contracts.js';
import {matchingNisaRows,forecastAssets} from '../dist/src/cloud/asset-projection.js';
import {suggestedNisaMonthly,futureProjection} from '../dist/src/cloud/future-projection.js';
import {prepareBankForecast,forecastBankBalances} from '../dist/src/cloud/salary-projection.js';
import {monthlyReport,prepareMonthlyReports} from '../dist/src/summary/monthly-summary.js';
import {bankTimeline} from '../dist/src/summary/bank-timeline.js';
import {analysisDrilldownMatches,analysisDrilldownBreakdown} from '../dist/src/ui/analysis-drilldown.js';
const row=(id,merchant,amount,usedOn='2026-10-15')=>({id,merchant,amount,usedOn});
const record=(id,month,paymentDate,cardId,rows)=>({id,statement:{provider:'smbc',cardId,sourceKind:'paste',sourceName:'synthetic',billingMonth:month,paymentDate,statedTotal:rows.reduce((sum,r)=>sum+r.amount,0),confirmation:'confirmed',warnings:[],rows}});
const payroll={ready:false,syncedAt:null,entries:[]};
const snap=(id,accountId,balance,observedAt)=>({id,accountId,balance,observedAt});
const source=(assets,records)=>({assets,records,rules:[],categories:[],payroll,currentPeriod:'2026-11'});
const cost=(startOn,endOn=null)=>({id:'test-future-cost',name:'Synthetic',payment:'cash',cardId:null,merchantKey:null,categoryId:null,frequency:'monthly',dayOfMonth:1,monthOfYear:null,weekday:null,startOn,endOn,amount:5000,priceKind:'fixed',pricing:[{effectiveOn:startOn,amount:5000}],pauses:[],note:'',updatedAt:'2026-11-23T00:00:00Z'});

test('future fixed-cost contract is scheduled until start; no premature expense or active total',()=>{
 const planned=cost('2026-12-01');
 assert.equal(fixedCostState(planned,'2026-11-23'),'scheduled');
 assert.equal(fixedCostState(planned,'2026-12-01'),'active');
 assert.equal(fixedCostOccurrences('2026-11',[planned]).length,0);
 assert.equal(fixedCostOccurrences('2026-12',[planned]).length,1);
 assert.equal(monthlyReport('2026-11',source({...emptyAssets(),fixedCosts:[planned]},[])).recurringExpense,0);
 assert.equal(monthlyReport('2026-12',source({...emptyAssets(),fixedCosts:[planned]},[])).recurringExpense,5000);
 assert.equal(fixedCostState(cost('2026-12-01','2026-12-10'),'2026-12-11'),'ended');
 assert.equal(fixedCostState({...planned,pauses:[{startOn:'2026-12-05',endOn:null}]},'2026-12-06'),'paused');
 const ui=readFileSync('src/ui/subscriptions.ts','utf8');
 assert.match(ui,/state==='scheduled'\?'開始予定'/);
 assert.match(ui,/active\.filter\(x=>x\.status==='active'\)/);
 assert.match(ui,/itemsFromSource\(source,candidates,latest\)/);
});

test('one NISA extraction is reused by the estimate, asset forecast and future projection without changing amounts',()=>{
 const assets={...emptyAssets(),birthMonth:'2003-11',nisaCardRule:{cardId:'smbc-nl',merchantContains:'INVEST',enabled:true},snapshots:[snap('nisa-1','nisa',100000,'2026-09-01T12:00:00Z'),snap('cash-1','cash-savings',50000,'2026-09-01T12:00:00Z')]};
 const records=[record('r1','2026-10','2026-11-27','smbc-nl',[row('a','INVEST',10000)]),record('r2','2026-09','2026-10-27','smbc-nl',[row('b','SHOP',500)])];
 const matches=matchingNisaRows(assets,Object.freeze(records));
 assert.equal(matches.length,1);
 assert.deepEqual(suggestedNisaMonthly(assets,records,'2026-11-23',matches),suggestedNisaMonthly(assets,records,'2026-11-23'));
 assert.deepEqual(forecastAssets(assets,'2026-11-23',records,[],null,matches),forecastAssets(assets,'2026-11-23',records));
 const opts={today:'2026-11-23',targetMonth:'2027-12',changeMonth:'2027-02',savingsRuleId:null,savingsAmount:10000,nisaMonthly:10000,nisaAnnualReturn:0.03};
 assert.deepEqual(futureProjection(assets,records,opts,matches),futureProjection(assets,records,opts));
 const linked={...assets,nisaCardRule:{cardId:'smbc-nl',merchantContains:'SHOP',enabled:true}};
 assert.deepEqual(matchingNisaRows(linked,records).map(r=>r.amount),[500]);
 const ui=readFileSync('src/ui/future-projection.ts','utf8');
 assert.match(ui,/cachedNisa\.records!==source\.records\|\|cachedNisa\.rules!==ruleFingerprint/);
 assert.match(ui,/scheduleRender/);
 assert.match(readFileSync('src/main.ts','utf8'),/futureUi=initFutureProjection\(\(\)=>!liveVault\?\.unlocked\|\|liveVault\.recoveryOnly\?null:\{assets:liveVault\.assetSettings\(\),records:liveVault\.readonlyRecords\(\)\}\)/);
});

test('bank forecasts share reports and source index, preserving current and next-month balances',()=>{
 const assets={...emptyAssets(),cardDebitAccounts:{'smbc-nl':'rakuten-bank'},snapshots:[snap('s1','rakuten-bank',200000,'2026-10-01T12:00:00Z')]};
 const records=Object.freeze([record('r1','2026-10','2026-11-20','smbc-nl',[row('a','SHOP',12000)]),record('r2','2026-11','2026-12-20','smbc-nl',[row('b','SHOP',25000,'2026-11-11')])]);
 const work=prepareBankForecast(records,assets);
 const args=[assets,'2026-11-23',records,[],null,'2026-11-23'];
 const current=forecastBankBalances(...args,work);
 assert.deepEqual(current,forecastBankBalances(...args));
 assert.ok(work.reports.size>=1);
 const nextArgs=[assets,'2026-12-31',records,[],null,'2026-11-23'];
 assert.deepEqual(forecastBankBalances(...nextArgs,work),forecastBankBalances(...nextArgs));
 const previousSize=work.reports.size;
 forecastBankBalances(...nextArgs,work);
 assert.equal(work.reports.size,previousSize);
 assert.throws(()=>forecastBankBalances(assets,'2026-11-23',[...records],[],null,'2026-11-23',work),/索引/);
});

test('monthly bank timeline accepts reports from same draw without changing its event history',()=>{
 const assets={...emptyAssets(),cardDebitAccounts:{'smbc-nl':'rakuten-bank'},snapshots:[snap('s1','rakuten-bank',100000,'2026-10-05T12:00:00Z')]};
 const records=[record('r1','2026-10','2026-11-20','smbc-nl',[row('a','SHOP',10000)])];
 const s=source(assets,records),prepared=prepareMonthlyReports(records);
 const reports=new Map(['2026-11','2026-10'].map(month=>[month,monthlyReport(month,s,prepared)]));
 assert.deepEqual(bankTimeline('2026-11',s,'2026-11-23',{prepared,reports}),bankTimeline('2026-11',s,'2026-11-23'));
 assert.throws(()=>bankTimeline('2026-11',{...s,records:[...records]},'2026-11-23',{prepared,reports}),/索引/);
});

test('analysis drilldown shares one set of month reports between card matching and recurring breakdown',()=>{
 const assets=emptyAssets();const records=[record('r1','2026-10','2026-11-20','smbc-nl',[row('a','SHOP',4000)])];
 const s=source(assets,records),prepared=prepareMonthlyReports(records);
 const reports=new Map([['2026-11',monthlyReport('2026-11',s,prepared)]]);
 const request={periods:['2026-11'],dimension:'card',value:'smbc-nl',label:'Card'};
 assert.deepEqual(analysisDrilldownMatches(s,request,reports),analysisDrilldownMatches(s,request));
 assert.deepEqual(analysisDrilldownBreakdown(s,request,reports),analysisDrilldownBreakdown(s,request));
 assert.throws(()=>analysisDrilldownBreakdown(s,{...request,periods:Array.from({length:100},()=> '2026-11')},reports),/不正/);
 const main=readFileSync('src/main.ts','utf8');
 assert.match(main,/seed\.source\.records===source\.records/);
 assert.match(main,/analysisDrilldownMatches\(source,activeAnalysisDrilldown,context\?\.reports\)/);
 assert.match(main,/const indices=managerIndices\(context\)/);
 assert.match(main,/const matches=drilldownRows\.get\(record\.id\)/);
});
