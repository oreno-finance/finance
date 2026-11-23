import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analysisDrilldownMatches,drilldownPeriodLabel,validateAnalysisDrilldown} from '../dist/src/ui/analysis-drilldown.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';

const row=(id,merchant,amount,override)=>({id,usedOn:'2026-10-09',merchant,amount,...(override?{merchantOverride:override}:{})});
const card=(id,paymentDate,billingMonth,rows,cardId='smbc-nl',more={})=>({id,statement:{
  provider:'smbc',cardId,sourceKind:'paste',sourceName:'fixture',paymentDate,billingMonth,
  statedTotal:rows.reduce((sum,row)=>sum+row.amount,0),confirmation:'confirmed',warnings:[],rows,...more}});
const source=(records,extras={})=>({
  records,rules:[
    {id:'food-rule',pattern:'MARKET',mode:'contains',displayName:'スーパー',cardId:null,enabled:true,priority:100,categoryId:'food'},
    {id:'digital-rule',pattern:'CLOUD',mode:'contains',displayName:'クラウド',cardId:null,enabled:true,priority:100,categoryId:'subscription'},
  ],categories:[{id:'food',name:'食費',color:'orange'},{id:'subscription',name:'サブスク',color:'violet'}],
  assets:{nisaCardRule:null,recurring:[],oneTime:[]},
  payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11',...extras,
});
const request=(periods,dimension,value,label='テスト')=>({periods,dimension,value,label});
const ids=matches=>[...matches.entries()].map(([id,rowIds])=>[id,[...rowIds]]);
const batch=()=>source([
  card('a','2026-11-27','2026-10',[row('r1','MARKET',1300),row('r2','CLOUD',2000),row('r3','OTHER',500)]),
  card('b','2026-10-27','2026-09',[row('r4','MARKET',900)]),
  card('c','2026-11-27','2026-10',[row('r5','MARKET',300)],'amazon'),
]);

test('payment month, not usage month or billing month, selects November',()=>{
  const s=batch();
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-11'],'card','smbc-nl'))),[['a',['r1','r2','r3']]]);
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-10'],'card','smbc-nl'))),[['b',['r4']]]);
  assert.equal(monthlyReport('2026-11',s).cardLines.length,2);
});
test('category drill-down restricts selected transaction rows without changing source',()=>{
  const s=batch(),before=JSON.stringify(s);
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-11'],'category','food'))),[['a',['r1']],['c',['r5']]]);
  assert.equal(JSON.stringify(s),before);
});
test('merchant drill-down uses current merchant display alias, including row override',()=>{
  const s=source([card('a','2026-11-27','2026-10',[row('r1','CLOUD',1000),row('r2','CLOUD',1500,'別名')])]);
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-11'],'merchant','クラウド'))),[['a',['r1']]]);
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-11'],'merchant','別名'))),[['a',['r2']]]);
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-11'],'merchant','CLOUD'))),[]);
});
test('unclassified filter does not include categorized transactions',()=>{
  assert.deepEqual(ids(analysisDrilldownMatches(batch(),request(['2026-11'],'category','__unclassified'))),[['a',['r3']]]);
});
test('NISA card row remains in card amount but excluded from merchant/category drill-down',()=>{
  const s=source([card('a','2026-11-27','2026-10',[
    row('r1','MARKET',1000),row('r2','RAKUTEN SECURITIES',20000)])]);
  s.assets.nisaCardRule={cardId:'smbc-nl',merchantContains:'RAKUTEN',enabled:true};
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-11'],'card','smbc-nl'))),[['a',['r1','r2']]]);
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-11'],'category','__unclassified'))),[]);
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-11'],'merchant','RAKUTEN SECURITIES'))),[]);
});
test('invalid and duplicate bill statements never leak into analysis drill-down',()=>{
  const a=card('a','2026-11-27','2026-10',[row('r1','MARKET',500)]);
  const b=card('b','2026-11-27','2026-10',[row('r2','MARKET',600)]);
  const c=card('c','2026-11-10','2026-09',[row('r3','MARKET',700)],'amazon');
  c.statement.statedTotal=900;
  assert.equal(analysisDrilldownMatches(source([a,b,c]),request(['2026-11'],'category','food')).size,0);
});
test('12-month drill-down returns only existing matching records and rows',()=>{
  const s=batch();
  const periods=Array.from({length:12},(_,i)=>`2026-${String(i+1).padStart(2,'0')}`);
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(periods,'category','food'))),[['b',['r4']],['a',['r1']],['c',['r5']]]);
});
test('missing months and non-matching card do not invent transactions',()=>{
  const s=batch();
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-09'],'category','food'))),[]);
  assert.deepEqual(ids(analysisDrilldownMatches(s,request(['2026-11'],'card','goldpoint'))),[]);
});
test('invalid periods, dimensions and empty values are rejected',()=>{
  for(const req of [request([], 'card','smbc-nl'),request(['2026-13'],'card','smbc-nl'),
    request(['2026-11','2026-11'],'category','food'),request(['2026-11'],'other','x'),request(['2026-11'],'card','')]) {
    assert.throws(()=>validateAnalysisDrilldown(req));
  }
});
test('display labels distinguish a month from multi-month period',()=>{
  assert.equal(drilldownPeriodLabel(['2026-11']),'2026-11');
  assert.equal(drilldownPeriodLabel(['2026-09','2026-10','2026-11']),'2026-09〜2026-11');
});
test('UI navigation filters rows by stable original row ID, not array position',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  const analysis=readFileSync(new URL('../src/ui/analysis.ts',import.meta.url),'utf8');
  assert.match(html,/id="manage-back-analysis"/);
  assert.match(html,/id="manage-drilldown-clear"/);
  assert.match(html,/id="manage-period-controls"/);
  assert.match(main,/matchingRows\?\.has\(item\.row\.id\)/);
  assert.match(main,/s\.rows\.splice\(index, 1\)/);
  assert.match(main,/drilldownRows=source\?analysisDrilldownMatches/);
  assert.match(main,/\$\('manage-period-controls'\)\.classList\.toggle\('hidden',!!drilldown\)/);
  assert.match(analysis,/openDrilldown\(request:AnalysisDrilldown,context:AnalysisReportContext\|null\)/);
  assert.match(analysis,/drill\(dimension,group\.id,group\.label/);
});
test('home unclassified goes straight to filtered statement manager, not month summary',()=>{
  const home=readFileSync(new URL('../src/ui/home.ts',import.meta.url),'utf8');
  const actions=readFileSync(new URL('../src/home/action-items.ts',import.meta.url),'utf8');
  assert.match(home,/action\.kind==='unclassified'/);
  assert.match(home,/value:'__unclassified'/);
  assert.match(actions,/kind:'unclassified'[\s\S]*?target:'manage'/);
});
