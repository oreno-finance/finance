import test from 'node:test';
import assert from 'node:assert/strict';
import {monthlyReport,changePeriod,estimateRegularNet} from '../dist/src/summary/monthly-summary.js';

const rule={id:'test-rule',pattern:'MARKET',mode:'contains',displayName:'スーパー',cardId:null,enabled:true,priority:100,categoryId:'food'};
const categories=[{id:'food',name:'食費',color:'orange'}];
const emptyAssets={nisaCardRule:null,recurring:[]};
const statement=(options={})=>({provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'テスト',billingMonth:'2026-10',paymentDate:'2026-11-27',statedTotal:10000,confirmation:'confirmed',warnings:[],rows:[{id:'row-1',usedOn:'2026-10-15',merchant:'MARKET',amount:10000}],...options});
const record=(id,options={})=>({id,statement:statement(options)});
const pay=(id,options={})=>({id,employerId:'main',payPeriod:'2026-10',paidOn:'2026-11-27',netPay:250000,grossPay:300000,taxablePay:null,currency:'JPY',kind:'salary',revision:1,...options});
const source=(records,entries=[pay('salary1')],extra={})=>({records,rules:[rule],categories,assets:{...emptyAssets,recurring:[]},payroll:{ready:true,syncedAt:1000,entries},currentPeriod:'2026-11',...extra});

test('payment date, not use date or billing shard, determines month',()=>{
 const s=source([record('a')]);
 assert.equal(monthlyReport('2026-10',s).cardOutflow,null);
 const actual=monthlyReport('2026-11',s);
 assert.equal(actual.cardOutflow,10000);
 assert.equal(actual.referenceBalance,240000);
 assert.equal(actual.categories[0].name,'食費');
 assert.equal(actual.merchants[0].name,'スーパー');
});
test('year rollover from a previous-year billing statement',()=>{
 const r=record('roll',{billingMonth:'2026-12',paymentDate:'2027-01-27'});
 assert.equal(monthlyReport('2027-01',source([r],[pay('next',{paidOn:'2027-01-27'})])).referenceBalance,240000);
 assert.equal(changePeriod('2026-12',1),'2027-01');
 assert.equal(changePeriod('2027-01',-1),'2026-12');
});
test('two cards are summed, and refund lines retain their sign',()=>{
 const r=record('a',{rows:[{id:'r1',usedOn:'2026-10-15',merchant:'MARKET',amount:12000},{id:'r2',usedOn:'2026-10-16',merchant:'MARKET',amount:-2000}]});
 const r2=record('b',{cardId:'amazon',billingMonth:'2026-11',statedTotal:5000,rows:[{id:'r3',usedOn:'2026-11-01',merchant:'Other',amount:5000}]});
 const result=monthlyReport('2026-11',source([r,r2]));
 assert.equal(result.cardOutflow,15000);
 assert.equal(result.referenceBalance,235000);
 assert.equal(result.merchants.find(x=>x.name==='スーパー').amount,10000);
});
test('duplicates of one card and billing month are excluded, not double-counted',()=>{
 const result=monthlyReport('2026-11',source([record('a'),record('b')]));
 assert.equal(result.cardOutflow,null);
 assert.equal(result.excludedCount,2);
 assert.equal(result.referenceBalance,null);
});
test('invalid dates and totals are excluded; provisional statements contribute to reference total',()=>{
 const bad=record('bad',{statedTotal:9000});
 const temp=record('temp',{confirmation:'provisional',billingMonth:'2026-11'});
 const undated=record('undated',{billingMonth:'2026-09',paymentDate:null});
 const result=monthlyReport('2026-11',source([bad,temp,undated]));
 assert.equal(result.cardOutflow,10000);
 assert.equal(result.referenceBalance,240000);
 assert.equal(result.provisional.length,1);
 assert.ok(result.issues.find(i=>i.id==='bad'));
 assert.ok(result.issues.find(i=>i.id==='undated'));
});
test('NISA card charge is included in outflow but excluded from living categories',()=>{
 const r=record('nisa',{statedTotal:120000,rows:[
  {id:'r1',usedOn:'2026-10-02',merchant:'MARKET',amount:100000},
  {id:'r2',usedOn:'2026-10-03',merchant:'RAKUTEN SECURITIES',amount:20000}
 ]});
 const s=source([r]);s.assets.nisaCardRule={cardId:'smbc-nl',merchantContains:'RAKUTEN',enabled:true};
 const result=monthlyReport('2026-11',s);
 assert.equal(result.cardOutflow,120000);
 assert.equal(result.nisaOutflow,20000);
 assert.equal(result.livingOutflow,100000);
 assert.equal(result.referenceBalance,130000);
});
test('payroll not refreshed, or no month evidence, cannot produce a balance',()=>{
 const s=source([record('a')]);s.payroll={ready:false,syncedAt:null,entries:[pay('stale')]};
 assert.equal(monthlyReport('2026-11',s).income,null);
 assert.equal(monthlyReport('2026-11',s).referenceBalance,null);
 const missing=source([record('a')],[]);
 assert.equal(monthlyReport('2026-11',missing).income,null);
 assert.equal(monthlyReport('2026-11',missing).referenceBalance,null);
});
test('salary and bonus from both employers are aggregated by paidOn',()=>{
 const s=source([record('a')],[pay('a',{netPay:180000}),pay('b',{employerId:'side',kind:'bonus',netPay:70000})]);
 const result=monthlyReport('2026-11',s);
 assert.equal(result.income,250000);
 assert.equal(result.incomeLines.length,2);
});
test('category name and merchant override are read live, never cached',()=>{
 const r=record('a',{rows:[{id:'row-1',usedOn:'2026-10-15',merchant:'MARKET',merchantOverride:'マイショップ',amount:10000}]});
 const s=source([r]);
 assert.equal(monthlyReport('2026-11',s).merchants[0].name,'マイショップ');
 s.categories[0].name='食料品';
 assert.equal(monthlyReport('2026-11',s).categories[0].name,'食料品');
});


test('current-month regular salary estimate uses previous net excluding non-taxable payment',()=>{
  const s=source([record('a')],[pay('last',{paidOn:'2026-10-27',grossPay:270000,taxablePay:250000,netPay:220000})]);
  const result=monthlyReport('2026-11',s);
  assert.equal(result.actualIncome,null);
  assert.equal(result.estimatedIncome,200000);
  assert.equal(result.income,200000);
  assert.equal(result.referenceBalance,190000);
  assert.equal(result.incomeEstimates[0].sourcePeriod,'2026-10');
});
test('actual current salary prevents estimate, even with a previous salary available',()=>{
  const s=source([record('a')],[pay('last',{paidOn:'2026-10-27',grossPay:270000,taxablePay:250000,netPay:220000}),pay('now',{paidOn:'2026-11-27',netPay:215000})]);
  const report=monthlyReport('2026-11',s);
  assert.equal(report.estimatedIncome,null);
  assert.equal(report.actualIncome,215000);
  assert.equal(report.referenceBalance,205000);
});
test('actual side income can be combined with estimated main, but bonus is not guessed',()=>{
  const s=source([record('a')],[pay('last',{paidOn:'2026-10-27',grossPay:270000,taxablePay:250000,netPay:220000}),pay('side',{employerId:'side',paidOn:'2026-11-16',netPay:12000})]);
  const report=monthlyReport('2026-11',s);
  assert.equal(report.actualIncome,12000);
  assert.equal(report.estimatedIncome,200000);
  assert.equal(report.income,212000);
  assert.equal(report.referenceBalance,202000);
  assert.equal(report.incomeEstimates.length,1);
});
test('estimate falls back to prior net without taxable breakdown, but rejects inconsistent input',()=>{
  assert.equal(estimateRegularNet(pay('bad',{grossPay:250000,taxablePay:null})),250000);
  assert.equal(estimateRegularNet(pay('bad',{grossPay:250000,taxablePay:260000})),null);
  assert.equal(estimateRegularNet(pay('bad',{grossPay:250000,taxablePay:100000,netPay:10000})),null);
  const s=source([record('a')],[pay('older',{paidOn:'2026-08-27',grossPay:270000,taxablePay:250000})]);
  assert.equal(monthlyReport('2026-11',s).estimatedIncome,null);
  assert.equal(monthlyReport('2026-11',s).referenceBalance,null);
});
test('no forecast for historical or future selected months',()=>{
  const s=source([record('a')],[pay('last',{paidOn:'2026-10-27',grossPay:270000,taxablePay:250000,netPay:220000})]);
  assert.equal(monthlyReport('2026-10',s).estimatedIncome,null);
  assert.equal(monthlyReport('2026-12',s).estimatedIncome,null);
});
test('no estimate is based on stale Payroll data',()=>{
  const s=source([record('a')],[pay('last',{paidOn:'2026-10-27',grossPay:270000,taxablePay:250000})]);
  s.payroll.ready=false;
  assert.equal(monthlyReport('2026-11',s).estimatedIncome,null);
  assert.equal(monthlyReport('2026-11',s).referenceBalance,null);
});
test('provisional card rows are classified and NISA included exactly once',()=>{
  const s=source([record('a',{confirmation:'provisional',statedTotal:120000,rows:[
    {id:'r1',usedOn:'2026-10-03',merchant:'MARKET',amount:100000},
    {id:'r2',usedOn:'2026-10-04',merchant:'RAKUTEN SECURITIES',amount:20000}]} )]);
  s.assets.nisaCardRule={cardId:'smbc-nl',merchantContains:'RAKUTEN',enabled:true};
  const report=monthlyReport('2026-11',s);
  assert.equal(report.cardOutflow,120000);
  assert.equal(report.nisaOutflow,20000);
  assert.equal(report.livingOutflow,100000);
  assert.equal(report.provisional.length,1);
  assert.equal(report.cardLines.length,1);
});


const recurring=(kind,amount,overrides={})=>({id:'entry-test-1',name:'保険料',amount,kind,fromAccountId:kind==='income'?null:'rakuten-bank',
  toAccountId:kind==='expense'?null:'cash-savings',frequency:'monthly',dayOfMonth:27,monthOfYear:null,
  weekday:null,startOn:'2026-01-01',endOn:null,categoryId:'food',enabled:true,...overrides});

test('scheduled bank expense is counted before its actual future debit',()=>{
 const s=source([record('a')]);
 s.assets.recurring=[recurring('expense',16000)];
 const result=monthlyReport('2026-11',s);
 assert.equal(result.cardOutflow,10000);
 assert.equal(result.recurringExpense,16000);
 assert.equal(result.monthlyBalance,224000);
 assert.equal(result.recurringLines[0].date,'2026-11-27');
 assert.equal(result.categories[0].amount,26000);
});
test('weekly recurrence occurs five times in a five-weekday month, including all future days',()=>{
 const s=source([record('a')]);
 s.assets.recurring=[recurring('expense',1000,{frequency:'weekly',dayOfMonth:null,weekday:0})];
 const result=monthlyReport('2026-11',s);
 assert.equal(result.recurringExpense,5000);
 assert.equal(result.recurringLines.length,5);
});
test('monthly 31st clamps to February 28, and annual event only runs in selected month',()=>{
 const s=source([],[]);
 s.assets.recurring=[recurring('expense',3200,{dayOfMonth:31}),recurring('expense',8000,{id:'annual-r',name:'年額',frequency:'yearly',monthOfYear:2,dayOfMonth:10})];
 const feb=monthlyReport('2027-02',s),mar=monthlyReport('2027-03',s);
 assert.equal(feb.recurringExpense,11200);
 assert.equal(feb.recurringLines.some(x=>x.date==='2027-02-28'),true);
 assert.equal(mar.recurringExpense,3200);
});
test('transfers do not change household balance and are listed separately',()=>{
 const s=source([record('a')]);
 s.assets.recurring=[recurring('transfer',10000)];
 const result=monthlyReport('2026-11',s);
 assert.equal(result.recurringTransfers,10000);
 assert.equal(result.recurringExpense,0);
 assert.equal(result.monthlyBalance,240000);
 assert.equal(result.recurringLines[0].kind,'transfer');
});
test('disabled or expired recurrences are skipped, enabled income adds to monthly balance',()=>{
 const s=source([record('a')]);
 s.assets.recurring=[recurring('expense',1000,{id:'disabled',enabled:false}),recurring('expense',1000,{id:'expired',endOn:'2026-10-31'}),recurring('income',7000,{id:'cashincome',name:'その他収入'})];
 const r=monthlyReport('2026-11',s);
 assert.equal(r.recurringIncome,7000);
 assert.equal(r.recurringExpense,0);
 assert.equal(r.monthlyBalance,247000);
});
test('recurring salary name is not counted twice when Payroll is available',()=>{
 const s=source([record('a')]);
 s.assets.recurring=[recurring('income',200000,{name:'本業給与入金'})];
 const result=monthlyReport('2026-11',s);
 assert.equal(result.recurringIncome,0);
 assert.equal(result.recurringSalaryExcluded,1);
 assert.equal(result.monthlyBalance,240000);
});
test('October take-home pay without taxable details becomes November estimate',()=>{
 const s=source([record('a')],[pay('october',{paidOn:'2026-10-27',grossPay:270000,taxablePay:null,netPay:220000})]);
 s.assets.recurring=[recurring('expense',9900,{name:'保険料'})];
 const r=monthlyReport('2026-11',s);
 assert.equal(r.incomeEstimates[0].method,'previous-regular-net-fallback');
 assert.equal(r.income,220000);
 assert.equal(r.recurringExpense,9900);
 assert.equal(r.monthlyBalance,200100);
});
test('unregistered cards do not erase registered recurring expenses from the report',()=>{
 const s=source([],[pay('november')]);
 s.assets.recurring=[recurring('expense',9000)];
 const report=monthlyReport('2026-11',s);
 assert.equal(report.cardOutflow,null);
 assert.equal(report.recurringExpense,9000);
 assert.equal(report.monthlyBalance,null);
 assert.equal(report.referenceBalance,null);
});
test('possible overlapping card and recurring transaction is flagged but not silently dropped',()=>{
 const s=source([record('a')]);
 s.assets.recurring=[recurring('expense',10000,{name:'スーパー'})];
 const report=monthlyReport('2026-11',s);
 assert.equal(report.recurringCardOverlap,1);
 assert.equal(report.recurringExpense,10000);
 assert.equal(report.monthlyBalance,230000);
});
