import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {monthlyReport,prepareMonthlyReports,changePeriod} from '../dist/src/summary/monthly-summary.js';
import {analyzePeriods,rollingAnalytics} from '../dist/src/analysis/period-analytics.js';
import {clearFinancePerformance,financePerformanceReport,measureFinanceSync} from '../dist/src/cloud/performance-diagnostics.js';

const statement=(id,billingMonth,paymentDate,amount=120)=>({
  id,statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'synthetic',
    billingMonth,paymentDate,statedTotal:amount,confirmation:'confirmed',warnings:[],
    rows:[{id:`row-${id}`,usedOn:paymentDate??'2026-11-01',merchant:`synthetic-${id}`,amount}]},
});
const assets={recurring:[],oneTime:[],snapshots:[]};
const source=(records)=>({records,rules:[],categories:[],assets,payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'});
const records=[
  statement('a','2026-09','2026-10-01',100),
  statement('b','2026-10','2026-11-10',120),
  statement('c','2026-10','2026-12-10',170), // Duplicate *billing* month even across payment months.
  statement('d','2026-08',null,20), // Undated validation issue must appear in every report.
  statement('e','2025-07','2026-09-15',200),
];

test('indexed and ordinary monthly reports are byte-for-byte equivalent for missing, duplicate, dated and undated data',()=>{
  const s=source(records),idx=prepareMonthlyReports(s.records);
  for(const period of ['2026-08','2026-09','2026-10','2026-11','2026-12']){
    assert.deepEqual(monthlyReport(period,s,idx),monthlyReport(period,s),period);
  }
  // The duplicate BILLING month belongs to two different PAYMENT months.
  // Both actual payment months must flag the duplicate; October must not.
  assert.equal(monthlyReport('2026-10',s,idx).issues.some(x=>x.reason.includes('同じカード')),false);
  for(const [period,id] of [['2026-11','b'],['2026-12','c']]){
    assert.ok(monthlyReport(period,s,idx).issues.some(x=>x.id===id&&x.reason.includes('同じカード')),
      `${period}: duplicated billing month must flag record ${id}`);
  }
  assert.ok(monthlyReport('2026-09',s,idx).issues.some(x=>x.reason.includes('支払日')));
});

test('index never silently accepts a new records array or returns a stale global cache',()=>{
  const before=source(records),old=prepareMonthlyReports(before.records);
  const after=source([...records,statement('new','2026-11','2026-11-12',500)]);
  assert.throws(()=>monthlyReport('2026-11',after,old),/索引/);
  assert.deepEqual(monthlyReport('2026-11',after,prepareMonthlyReports(after.records)),monthlyReport('2026-11',after));
});

test('rolling analysis still uses the exact ordinary monthly reports and never invents zero for missing data',()=>{
  const s=source(records),periods=['2026-09','2026-10','2026-11'];
  const analysis=rollingAnalytics(s,'2026-11',3,'2026-11');
  assert.deepEqual(analysis.months.map(x=>x.period),periods);
  for(const month of analysis.months){
    assert.deepEqual(month.report,monthlyReport(month.period,{...s,currentPeriod:'2026-11'}));
  }
  assert.equal(analysis.months[2].period,'2026-11');
  assert.equal(changePeriod('2026-11',-1),'2026-10');
  assert.deepEqual(analyzePeriods(s,periods,'2026-11'),analysis);
});

test('only the visible import view is rebuilt and source snapshots are not requested twice by overview and annual controls',()=>{
  const main=readFileSync('src/main.ts','utf8');
  const home=readFileSync('src/ui/home.ts','utf8');
  const analysis=readFileSync('src/ui/analysis.ts','utf8');
  const render=main.split('function render(): void {')[1]?.split('function attachSource(')[0];
  assert.ok(render,'render() must exist');
  assert.match(render,/if \(!\$\('import-view'\)\.classList\.contains\('hidden'\)\) \{[\s\S]*buildStatementList\(\); renderSummary\(\); renderRows\(\); updateBatchStatus\(\);[\s\S]*\}/);
  assert.match(home,/renderOverview\(measureFinanceSync\('ui\.home\.overview',\(\)=>homeOverview\(source,today\)\),source\)/);
  assert.doesNotMatch(home,/const source=deps\.source\(\);\s*if\(source\)/);
  assert.match(analysis,/function controls\(today:string,source:MonthlySource\|null\)/);
  assert.match(analysis,/const source=deps\.source\(\);\s*reportContext=null;\s*root!\.append\(controls\(today,source\)\)/);
});

test('diagnostic timing records only fixed phase names and aggregate duration, no financial data',()=>{
  clearFinancePerformance();
  assert.equal(measureFinanceSync('ui.analysis.aggregate',()=>42),42);
  assert.throws(()=>measureFinanceSync('ui.home.overview',()=>{throw new Error('synthetic failure');}),/synthetic failure/);
  const report=financePerformanceReport();
  assert.equal(report.phases['ui.analysis.aggregate'].count,1);
  assert.equal(report.phases['ui.home.overview'].failures,1);
  assert.doesNotMatch(JSON.stringify(report),/synthetic failure|token|ciphertext|https:\/\//);
});
