import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rollingAnalytics,annualAnalytics,priorYearAnalytics,analyzePeriods,comparableDelta,cumulativeBalances,balanceWithoutNisa} from '../dist/src/analysis/period-analytics.js';
const pay=(period,amount=240000)=>({id:`salary-${period}`,employerId:'main',payPeriod:period,paidOn:`${period}-25`,netPay:amount,grossPay:null,taxablePay:null,currency:'JPY',kind:'salary',revision:1});
const card=(period,amount=20000,extra={})=>({id:`rec-${period}-${extra.cardId??'smbc-nl'}`,statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'test',billingMonth:`${period.slice(0,4)}-${String(Number(period.slice(5))===1?12:Number(period.slice(5))-1).padStart(2,'0')}`,paymentDate:`${period}-27`,statedTotal:amount,confirmation:'confirmed',warnings:[],rows:[{id:`row-${period}`,usedOn:`${period}-01`,merchant:'MARKET',amount}],...extra}});
const base=(records=[],entries=[])=>({records,rules:[{id:'r-food',pattern:'MARKET',mode:'contains',displayName:'スーパー',cardId:null,enabled:true,priority:100,categoryId:'food'}],categories:[{id:'food',name:'食費',color:'orange'}],assets:{nisaCardRule:null,recurring:[],oneTime:[]},payroll:{ready:true,syncedAt:100,entries},currentPeriod:'2026-11'});
const periods=['2026-09','2026-10','2026-11'];
const data=()=>base(periods.map(p=>card(p,Number(p.slice(5))*1000)),periods.map(p=>pay(p)));

test('monthly 3/6/12 windows follow payment month and have stable order',()=>{
 const source=data();
 for(const count of [3,6,12]){
   const result=rollingAnalytics(source,'2026-11',count,'2026-11');
   assert.equal(result.months.length,count);assert.equal(result.months.at(-1).period,'2026-11');
 }
 assert.deepEqual(rollingAnalytics(source,'2026-11',3,'2026-11').months.map(m=>m.expense),[9000,10000,11000]);
});
test('missing card month stays null, not zero or a low spend month',()=>{
 const result=rollingAnalytics(base([card('2026-11',5000)],[pay('2026-09'),pay('2026-10'),pay('2026-11')]),'2026-11',3,'2026-11');
 assert.equal(result.months[0].expense,null);assert.equal(result.months[0].balance,null);
 assert.equal(result.months[0].coverage,'missing');assert.equal(result.totals.avgExpense,5000);
 assert.equal(result.totals.knownExpenseMonths,1);assert.equal(result.totals.minExpense.period,'2026-11');
 assert.equal(result.totals.comparable,false);
});
test('income without Payroll evidence is missing, rather than assumed zero',()=>{
 const source=data();source.payroll={ready:false,syncedAt:null,entries:[]};
 const result=rollingAnalytics(source,'2026-11',3,'2026-11');
 assert.equal(result.months.at(-1).income,null);assert.equal(result.months.at(-1).balance,null);
 assert.equal(result.totals.income,null);assert.equal(result.totals.balance,null);
});
test('payment date belongs to November even when billing month and usage month are October',()=>{
 const source=base([card('2026-11',20000,{billingMonth:'2026-10',rows:[{id:'r',usedOn:'2026-10-05',merchant:'MARKET',amount:20000}]})],[pay('2026-11')]);
 const result=rollingAnalytics(source,'2026-11',3,'2026-11');
 assert.equal(result.months[1].expense,null);assert.equal(result.months[2].expense,20000);
});
test('NISA is cash outflow but excluded from living expense and category totals',()=>{
 const source=base([card('2026-11',30000,{rows:[
 {id:'r1',usedOn:'2026-10-01',merchant:'MARKET',amount:10000},
 {id:'r2',usedOn:'2026-10-02',merchant:'RAKUTEN SECURITIES',amount:20000}]})],[pay('2026-11')]);
 source.assets.nisaCardRule={cardId:'smbc-nl',merchantContains:'RAKUTEN',enabled:true};
 const result=rollingAnalytics(source,'2026-11',3,'2026-11');
 assert.equal(result.months[2].expense,30000);assert.equal(result.months[2].livingExpense,10000);
 assert.equal(result.months[2].nisa,20000);assert.equal(result.groups.category.find(g=>g.id==='food').total,10000);
});
test('category, card and merchant grouping never add NISA or transfer twice',()=>{
 const source=data();
 const result=rollingAnalytics(source,'2026-11',3,'2026-11');
 assert.equal(result.groups.card.find(g=>g.id==='smbc-nl').total,30000);
 assert.equal(result.groups.category.find(g=>g.id==='food').total,30000);
 assert.equal(result.groups.merchant.find(g=>g.id==='スーパー').total,30000);
});
test('rolling category and merchant change highlights true latest-month delta',()=>{
 const result=rollingAnalytics(data(),'2026-11',3,'2026-11');
 assert.equal(result.categoryChanges[0].delta,1000);assert.equal(result.merchantChanges[0].delta,1000);
});
test('group amount stays missing for incomplete month even when category did not appear',()=>{
 const result=rollingAnalytics(base([card('2026-11',1000)],[pay('2026-11')]),'2026-11',3,'2026-11');
 assert.deepEqual(result.groups.category[0].amounts,[null,null,1000]);
 assert.equal(result.groups.category[0].delta,null);
});
test('provisional and unknown-confirmation card prevent comparability without changing totals',()=>{
 const source=base([card('2026-10',9000,{confirmation:'provisional'}),card('2026-11',11000,{confirmation:'unknown'})],[pay('2026-10'),pay('2026-11')]);
 const data=rollingAnalytics(source,'2026-11',3,'2026-11');
 assert.equal(data.months[1].coverage,'provisional');assert.equal(data.months[2].coverage,'review');
 assert.equal(data.totals.expense,20000);assert.equal(data.totals.comparable,false);
});
test('annual view uses year-to-date only, prior year compares same months',()=>{
 const s=base([card('2025-11',5000),card('2026-11',15000)],[pay('2025-11'),pay('2026-11')]);
 const current=annualAnalytics(s,2026,'2026-11');const previous=priorYearAnalytics(s,2026,'2026-11');
 assert.equal(current.months.length,11);assert.equal(previous.months.length,11);
 assert.equal(previous.months.at(-1).period,'2025-11');
 assert.equal(current.totals.knownExpenseMonths,1);assert.equal(comparableDelta(current,previous,'expense'),null);
});
test('complete consecutive periods can compare annual totals and percentage',()=>{
 const years=['2025','2026'];
 const records=[],entries=[];
 for(const year of years)for(const month of ['01','02','03']){
   records.push(card(`${year}-${month}`,year==='2026'?2000:1000));entries.push(pay(`${year}-${month}`,10000));
 }
 const s=base(records,entries);
 const a=analyzePeriods(s,['2026-01','2026-02','2026-03'],'2026-11');
 const b=analyzePeriods(s,['2025-01','2025-02','2025-03'],'2026-11');
 assert.equal(a.totals.comparable,true);assert.deepEqual(comparableDelta(a,b,'expense'),{amount:3000,percent:100});
});
test('annual comparison rejects invented comparison if the prior year lacks statements',()=>{
 const s=data();const current=annualAnalytics(s,2026,'2026-11'),previous=priorYearAnalytics(s,2026,'2026-11');
 assert.equal(comparableDelta(current,previous,'expense'),null);
});
test('analysis rejects future periods and discontinuous month sequences',()=>{
 assert.throws(()=>rollingAnalytics(data(),'2026-12',3,'2026-11'));
 assert.throws(()=>analyzePeriods(data(),['2026-09','2026-11'],'2026-11'));
 assert.throws(()=>annualAnalytics(data(),2027,'2026-11'));
});
test('new navigation, summary deep link and view preserve lock and existing analytics as separate UI',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
 const summary=readFileSync(new URL('../src/ui/monthly-summary.ts',import.meta.url),'utf8');
 const analytics=readFileSync(new URL('../src/ui/analysis.ts',import.meta.url),'utf8');
 assert.match(html,/id="nav-analysis"/);assert.match(html,/id="analysis-view"/);
 assert.match(styleOrder,/analysis-v180\.css/);assert.match(main,/summaryUi\?\.setPeriod\(period\)/);
 assert.match(summary,/setPeriod:\(next:string\)/);assert.match(analytics,/if\(!source\)/);
 assert.match(analytics,/root!\.replaceChildren\(\)/);
});
test('expense year-on-year remains valid independently of Payroll being connected',()=>{
 const s=base([card('2025-01',1000),card('2026-01',3000)],[]);s.payroll.ready=false;
 const a=analyzePeriods(s,['2026-01'],'2026-11'),b=analyzePeriods(s,['2025-01'],'2026-11');
 assert.deepEqual(comparableDelta(a,b,'expense'),{amount:2000,percent:200});
 assert.equal(comparableDelta(a,b,'income'),null);
 assert.equal(comparableDelta(a,b,'balance'),null);
});
test('a card absent from an otherwise populated month is unknown, never a verified zero',()=>{
 const s=base([card('2026-10',1000),card('2026-11',2000,{cardId:'rakuten'})],[pay('2026-10'),pay('2026-11')]);
 const result=rollingAnalytics(s,'2026-11',3,'2026-11');
 const smbc=result.groups.card.find(g=>g.id==='smbc-nl');
 assert.ok(smbc);assert.deepEqual(smbc.amounts,[null,1000,null]);assert.equal(smbc.delta,null);
});


test('cumulative cashflow carries bonus surplus across later deficit months and reconciles with period balance',()=>{
 const months=['2026-06','2026-07','2026-08','2026-09','2026-10','2026-11'];
 const result=analyzePeriods(base(months.map((p,i)=>card(p,i===4?450000:150000)),months.map((p,i)=>pay(p,i===2?500000:200000))),months,'2026-11');
 assert.deepEqual(cumulativeBalances(result.months).map(p=>p.amount),[50000,100000,450000,500000,250000,300000]);
 assert.equal(result.months[4].balance,-250000);
 assert.equal(cumulativeBalances(result.months).at(-1).amount,result.totals.balance);
 assert.equal(balanceWithoutNisa(result.months),300000);
});
test('cumulative cashflow stops at a missing month; later months cannot fill the unknown balance',()=>{
 const result=analyzePeriods(base([card(periods[0],20000),card(periods[2],20000)],periods.map(p=>pay(p,100000))),periods,'2026-11');
 assert.deepEqual(cumulativeBalances(result.months).map(p=>p.amount),[80000,null,null]);
 assert.equal(balanceWithoutNisa(result.months),null);
});
test('NISA exclusion uses the same complete months, while cumulative reference status carries forward',()=>{
 const s=base(periods.map((p,i)=>card(p,20000,{confirmation:i===1?'provisional':'confirmed',rows:[{id:'nisa-'+p,usedOn:p+'-01',merchant:'SECURITIES',amount:20000}]})),periods.map(p=>pay(p,100000)));
 s.assets.nisaCardRule={cardId:'smbc-nl',merchantContains:'SECURITIES',enabled:true};
 const result=analyzePeriods(s,periods,'2026-11');
 assert.equal(result.totals.balance,240000);assert.equal(balanceWithoutNisa(result.months),300000);
 assert.deepEqual(cumulativeBalances(result.months).map(p=>p.reference),[false,true,true]);
});
