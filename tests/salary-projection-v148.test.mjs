import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedMainSalaries,forecastBankBalances} from '../dist/src/cloud/salary-projection.js';
import {emptyAssets} from '../dist/src/cloud/assets.js';

const salary=(id,paidOn,netPay=200000,patch={})=>({id,employerId:'main',payPeriod:paidOn.slice(0,7),paidOn,
  grossPay:240000,netPay,taxablePay:235000,currency:'JPY',kind:'salary',revision:1,...patch});
const snap=(id,accountId,balance)=>({id,accountId,balance,observedAt:'2026-11-16T08:00:00.000Z'});
const transfer=(id,monthDay=27)=>({id,name:'現金貯金へ振替',amount:10000,kind:'transfer',fromAccountId:'rakuten-bank',toAccountId:'cash-savings',frequency:'monthly',dayOfMonth:monthDay,monthOfYear:null,weekday:null,startOn:'2026-11-01',endOn:null,categoryId:null,enabled:true});
function doc(){return {...emptyAssets(),snapshots:[snap('a','rakuten-bank',100000),snap('b','cash-savings',50000)],recurring:[transfer('t1')]};}
const today='2026-11-17',target='2026-12-31';

test('missing November salary is estimated using October net minus non-taxable support',()=>{
  const items=expectedMainSalaries([salary('oct','2026-10-27')],today,target);
  assert.deepEqual(items.map(i=>[i.date,i.amount,i.method]),[
    ['2026-11-27',195000,'net-excluding-nontaxable'],
    ['2026-12-27',195000,'net-excluding-nontaxable']]);
});
test('bank forecast includes two unconfirmed salaries but not transfers as household income',()=>{
  const result=forecastBankBalances(doc(),target,[],[salary('oct','2026-10-27')],'rakuten-bank',today);
  assert.equal(result.estimatedByAccount['rakuten-bank'],390000);
  assert.equal(result.accounts['rakuten-bank'].balance,100000-20000+390000);
  assert.equal(result.accounts['cash-savings'].balance,50000+20000);
  assert.equal(result.estimates.length,2);
});
test('actual salary replaces estimate for same month',()=>{
  const result=forecastBankBalances(doc(),target,[],[salary('oct','2026-10-27'),salary('nov','2026-11-27',215000)],'rakuten-bank',today);
  assert.equal(result.estimates.length,1);
  assert.equal(result.estimates[0].date,'2026-12-27');
  assert.equal(result.accounts['rakuten-bank'].balance,100000-20000+215000+195000);
});
test('missing taxable breakdown uses previous net, bonus is never a basis',()=>{
  const list=expectedMainSalaries([salary('oct','2026-10-27',202000,{grossPay:null,taxablePay:null}),salary('bonus','2026-11-05',900000,{kind:'bonus'})],today,target);
  assert.equal(list.length,2);
  assert.equal(list[0].amount,202000);
  assert.equal(list[0].method,'previous-net');
});
test('salary recurring income in same target account is not added twice',()=>{
  const data=doc();data.recurring.push({...transfer('pay'),name:'給与',kind:'income',amount:190000,fromAccountId:null,toAccountId:'rakuten-bank'});
  const result=forecastBankBalances(data,target,[],[salary('oct','2026-10-27')],'rakuten-bank',today);
  assert.equal(result.estimates.length,0);
});
test('no linked deposit account, no recent salary or no reference balance never invents deposits',()=>{
  const noLink=forecastBankBalances(doc(),target,[],[salary('oct','2026-10-27')],null,today);
  assert.equal(noLink.estimates.length,0);
  assert.equal(expectedMainSalaries([salary('jun','2026-06-27')],today,target).length,0);
  const empty=forecastBankBalances(emptyAssets(),target,[],[salary('oct','2026-10-27')],'rakuten-bank',today);
  assert.equal(empty.accounts['rakuten-bank'].balance,null);
  assert.equal(empty.estimates.length,0);
});
test('future bonus is not silently projected and beyond following month is not estimated',()=>{
  const list=expectedMainSalaries([salary('oct','2026-10-27')],today,'2027-05-31');
  assert.deepEqual(list.map(i=>i.date),['2026-11-27','2026-12-27']);
});

test('M304: manual one-off salary uses paid month, role and historical account across projections',async()=>{
  const {monthlyReport}=await import('../dist/src/summary/monthly-summary.js');
  const {bankTimeline}=await import('../dist/src/summary/bank-timeline.js');
  const {forecastAccounts}=await import('../dist/src/home/account-events.js');
  const assets={...doc(),recurring:[],payrollDepositAccount:'cash-savings',payrollDepositAccountHistory:[{effectiveOn:'0001-01-01',accountId:'rakuten-bank'},{effectiveOn:'2026-11-28',accountId:'cash-savings'}],oneTime:[{id:'salary-plan',name:'本業給与',kind:'income',amount:190000,date:'2026-11-26',fromAccountId:null,toAccountId:'rakuten-bank',status:'planned'}]};
  const entries=[salary('nov','2026-11-27',205000,{payPeriod:'2026-10'})];
  const source={assets,records:[],rules:[],categories:[],payroll:{ready:true,syncedAt:1,entries},currentPeriod:'2026-11',currentDay:'2026-11-28'};
  const before=JSON.stringify(assets);
  const report=monthlyReport('2026-11',source);
  assert.equal(report.income,205000);assert.equal(report.oneTimeLines.length,0);assert.equal(report.pastUnconfirmedOneTime,0);
  const result=forecastBankBalances(assets,'2026-11-30',[],entries,'cash-savings','2026-11-28');
  assert.equal(result.accounts['rakuten-bank'].balance,305000);assert.equal(result.accounts['rakuten-bank'].overdue,undefined);
  assert.equal(bankTimeline('2026-11',source,'2026-11-28').endBalance,305000);
  assert.equal(forecastAccounts(source,'2026-11-28',2).accounts.find(a=>a.accountId==='rakuten-bank').projected,305000);
  assert.equal(JSON.stringify(assets),before);
});

test('M304: manual salary plans do not replace a different role, account, or bonus; executed and ambiguous candidates are kept',async()=>{
  const {reconcileManualSalary}=await import('../dist/src/cloud/payroll-income.js');
  const base={id:'manual',name:'本業給与',kind:'income',date:'2026-11-27',status:'planned',toAccountId:'rakuten-bank'};
  const entries=[salary('pay','2026-11-27')],route=()=> 'rakuten-bank';
  for(const changed of [{name:'副業給与'},{name:'本業給与・賞与'},{toAccountId:'cash-savings'},{date:'2026-12-01'}]){
    const result=reconcileManualSalary([{...base,...changed}],entries,route);assert.equal(result.excludes(base.id),false);assert.equal(result.ambiguous.length,0);
  }
  const done=reconcileManualSalary([{...base,status:'done'}],entries,route);assert.equal(done.excludes(base.id),false);assert.equal(done.ambiguous.length,1);
  const multi=reconcileManualSalary([base,{...base,id:'second'}],entries,route);assert.equal(multi.excludes(base.id),false);assert.equal(multi.ambiguous.length,2);
  const manyActual=reconcileManualSalary([base],[...entries,salary('another','2026-11-28')],route);assert.equal(manyActual.excludes(base.id),false);assert.equal(manyActual.ambiguous.length,1);
});

test('M301: manual future salary takes precedence over automatic estimate without turning overdue plans into income',async()=>{
  const {monthlyReport}=await import('../dist/src/summary/monthly-summary.js');
  const assets={...doc(),recurring:[],payrollDepositAccount:'rakuten-bank',oneTime:[{id:'manual-pay',name:'給与',kind:'income',amount:180000,date:'2026-11-27',fromAccountId:null,toAccountId:'rakuten-bank',status:'planned'}]};
  const entries=[salary('oct','2026-10-27')];
  const first=forecastBankBalances(assets,'2026-11-30',[],entries,'rakuten-bank','2026-11-17');
  assert.equal(first.estimates.length,0);assert.equal(first.accounts['rakuten-bank'].balance,280000);
  const overdue=forecastBankBalances(assets,'2026-11-30',[],entries,'rakuten-bank','2026-11-28');
  assert.equal(overdue.estimates.length,0);assert.equal(overdue.accounts['rakuten-bank'].balance,100000);assert.equal(overdue.accounts['rakuten-bank'].overdue.delta,180000);
  const report=monthlyReport('2026-11',{assets,records:[],rules:[],categories:[],payroll:{ready:true,syncedAt:1,entries},currentPeriod:'2026-11',currentDay:'2026-11-28'});
  assert.equal(report.income,null);assert.equal(report.estimatedIncome,null);assert.equal(report.oneTimePlannedIncome,180000);
});
