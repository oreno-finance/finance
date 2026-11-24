import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {homeOverview} from '../dist/src/home/overview.js';
import {forecastAccounts} from '../dist/src/home/account-events.js';
import {homeActions,statementReviewDate} from '../dist/src/home/action-items.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';

const card=(id,cardId='smbc-nl',amount=20000,paymentDate='2026-11-27',confirmation='confirmed',billingMonth='2026-10')=>({
  id,statement:{provider:'smbc',cardId,sourceKind:'paste',sourceName:'sample',billingMonth,paymentDate,
    statedTotal:amount,confirmation,warnings:[],rows:[{id:`row-${id}`,usedOn:'2026-10-21',merchant:'SHOP',amount}]}
});
const snapshot=(id,accountId,balance,day='2026-11-01')=>({id,accountId,balance,observedAt:`${day}T00:00:00.000Z`});
const salary=(id,paidOn,netPay)=>({id,employerId:'main',payPeriod:paidOn.slice(0,7),paidOn,netPay,grossPay:null,taxablePay:null,currency:'JPY',kind:'salary',revision:1});
const assets=()=>({nisaCardRule:null,recurring:[],oneTime:[],snapshots:[],payrollDepositAccount:null,cardDebitAccounts:{'smbc-nl':'rakuten-bank'}});
const source=(records=[card('card-1')],rest={})=>({records,rules:[],categories:[],assets:assets(),
  payroll:{ready:true,syncedAt:Date.parse('2026-11-18T00:00:00Z'),entries:[salary('pay','2026-11-10',30000)]},currentPeriod:'2026-11',...rest});
const today='2026-11-18';

test('home reuses unchanged payment-date monthly cashflow and does not mutate input',()=>{
  const s=source();s.assets.payrollDepositAccount='rakuten-bank';s.assets.snapshots.push(snapshot('snap-1','rakuten-bank',15000));
  const before=JSON.stringify(s);
  const home=homeOverview(s,today),monthly=monthlyReport('2026-11',s);
  assert.equal(home.report.monthlyBalance,monthly.monthlyBalance);
  assert.equal(home.report.cardOutflow,20000);
  assert.equal(home.outflow,20000);
  assert.equal(home.report.income,30000);
  assert.equal(home.forecast.accounts[0].projected,55000); // Includes next-month projected salary by the 45-day horizon
  assert.equal(home.forecast.debits[0].afterBalance,25000);
  assert.equal(JSON.stringify(s),before);
});

test('missing statement month is explicitly missing even when payroll predicts positive cashflow',()=>{
  const s=source([card('prev','smbc-nl',20000,'2026-10-27','confirmed','2026-09')]);
  const home=homeOverview(s,today);
  assert.equal(home.coverage,'missing');
  assert.equal(home.outflow,null);
  assert.ok(home.actions.some(a=>a.kind==='missing-statements'));
});

test('a confirmed zero amount is never invented from an absent month',()=>{
  const home=homeOverview(source([]),today);
  assert.equal(home.coverage,'missing');
  assert.equal(home.report.cardOutflow,null);
});

test('unassigned card debit has no made-up bank account or after-balance and suggests configuration',()=>{
  const s=source();s.assets.cardDebitAccounts={};s.assets.snapshots.push(snapshot('snap-1','rakuten-bank',100000));
  const home=homeOverview(s,today);
  assert.equal(home.forecast.debits[0].accountId,null);
  assert.equal(home.forecast.debits[0].afterBalance,null);
  assert.ok(home.actions.some(a=>a.kind==='card-account'&&a.target==='settings'));
  assert.ok(!home.actions.some(a=>a.kind==='shortage'));
});

test('no snapshot means no invented forecast or balance-shortage alert',()=>{
  const home=homeOverview(source(),today);
  assert.equal(home.accounts[0].predicted,null);
  assert.ok(!home.actions.some(a=>a.kind==='shortage'));
});

test('warning uses reliable snapshot + known card debit; no false alarm after same-day salary',()=>{
  const s=source();s.assets.payrollDepositAccount='rakuten-bank';s.payroll.entries=[];s.assets.snapshots.push(snapshot('snap-1','rakuten-bank',10000,'2026-11-15'));
  let home=homeOverview(s,today);
  assert.ok(home.actions.some(a=>a.kind==='shortage'));
  s.payroll.entries=[salary('same-day','2026-11-27',50000)];
  home=homeOverview(s,today);
  assert.ok(!home.actions.some(a=>a.kind==='shortage'));
  assert.equal(home.forecast.debits[0].afterBalance,40000);
});

test('incomplete Payroll, provisional bills and invalid statements suppress confident shortage claims',()=>{
  const s=source();s.assets.snapshots.push(snapshot('snap-1','rakuten-bank',1));
  s.payroll.ready=false;
  assert.ok(!homeOverview(s,today).actions.some(a=>a.kind==='shortage'));
  s.payroll.ready=true;s.records[0].statement.confirmation='provisional';
  assert.ok(!homeOverview(s,today).actions.some(a=>a.kind==='shortage'));
  s.records[0].statement.confirmation='confirmed';s.records[0].statement.statedTotal=999;
  assert.ok(!homeOverview(s,today).actions.some(a=>a.kind==='shortage'));
});

test('bank-to-bank transfer moves money but never adds household spending',()=>{
  const s=source();s.assets.snapshots.push(snapshot('snap-r','rakuten-bank',100000),snapshot('snap-m','mizuho-bank',10000));
  s.assets.oneTime=[{id:'once-transfer',date:'2026-11-20',name:'送金',amount:30000,kind:'transfer',status:'planned',
    fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank'}];
  const home=homeOverview(s,today);
  assert.equal(home.report.recurringTransfers,0);
  assert.equal(home.report.oneTimeExpense,0);
  assert.equal(home.forecast.accounts[0].projected,50000); // 100k - 30k transfer - 20k card
  assert.equal(home.forecast.accounts[1].projected,40000);
});

test('a manual bank schedule replaced by a matching one-time entry is counted once',()=>{
  const s=source([]);s.assets.snapshots.push(snapshot('snap-r','rakuten-bank',100000));
  s.assets.recurring=[{id:'repeat-1',name:'貯金',amount:10000,kind:'transfer',fromAccountId:'rakuten-bank',toAccountId:'cash-savings',
    frequency:'monthly',dayOfMonth:25,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true}];
  s.assets.oneTime=[{id:'once-1',date:'2026-11-25',name:'貯金',amount:10000,kind:'transfer',status:'done',fromAccountId:'rakuten-bank',toAccountId:'cash-savings'}];
  assert.equal(forecastAccounts(s,today,15).accounts[0].projected,90000);
});

test('issuer schedule reminders appear only after their guideline date and stop when confirmed',()=>{
  assert.equal(statementReviewDate('rakuten-mizuho','2026-11-27'),'2026-11-12');
  assert.equal(statementReviewDate('amazon','2026-11-26'),'2026-11-11');
  assert.equal(statementReviewDate('smbc-nl','2026-11-10'),'2026-10-26');
  assert.equal(statementReviewDate('bic-suica','2026-11-04'),'2026-10-17');
  assert.equal(statementReviewDate('recruit-jcb','2026-11-10'),'2026-10-25');
  assert.equal(statementReviewDate('goldpoint','2026-11-27'),'2026-11-11');
  const s=source([card('provisional','rakuten-mizuho',20000,'2026-11-27','provisional')]);
  const report=monthlyReport('2026-11',s);
  const forecast=forecastAccounts(s,today);
  assert.equal(homeActions(s,report,forecast,'2026-11-11').filter(x=>x.kind==='provisional').length,0);
  assert.equal(homeActions(s,report,forecast,'2026-11-18').filter(x=>x.kind==='provisional').length,1);
  s.records.push(card('confirmed','rakuten-mizuho',20000,'2026-11-27','confirmed'));
  assert.equal(homeActions(s,report,forecast,'2026-11-18').filter(x=>x.kind==='provisional').length,0);
});

test('uncategorized, stale balance, payroll and invalid statement actions remain actionable',()=>{
  const s=source();s.assets.snapshots.push(snapshot('snap-old','rakuten-bank',200000,'2026-09-01'));
  const actions=homeOverview(s,today).actions;
  assert.ok(actions.some(x=>x.kind==='unclassified'&&x.target==='manage'));
  assert.ok(actions.some(x=>x.kind==='stale-balance'&&x.target==='assets'));
  s.payroll.ready=false;
  assert.ok(homeOverview(s,today).actions.some(x=>x.kind==='payroll'&&x.target==='settings'));
});

test('UI has home first on reload, locked-data protection and safe text rendering',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  const home=readFileSync(new URL('../src/ui/home.ts',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles/home-v170.css',import.meta.url),'utf8');
  assert.ok(html.indexOf('id="nav-home"')<html.indexOf('id="nav-import"'));
  assert.ok(html.indexOf('id="home-view"')<html.indexOf('id="import-view"'));
  assert.match(main,/showView\('home'\);/);
  assert.doesNotMatch(main,/showView\(lastView/);
  assert.match(home,/if\(!source\)/);
  assert.match(home,/textContent=content/);
  assert.doesNotMatch(home,/innerHTML/);
  assert.match(css,/@media\(max-width:530px\)/);
});

test('unknown payroll deposit destination or stale payroll sync does not trigger a confident shortage',()=>{
  const s=source();s.assets.snapshots.push(snapshot('snap-1','rakuten-bank',100));
  assert.equal(homeOverview(s,today).actions.filter(x=>x.kind==='shortage').length,0);
  s.assets.payrollDepositAccount='rakuten-bank';
  s.payroll.syncedAt=Date.parse('2026-10-01T00:00:00Z');
  assert.equal(homeOverview(s,today).actions.filter(x=>x.kind==='shortage').length,0);
});

test('10th-payment SMBC review guidance handles year rollover',()=>{
  assert.equal(statementReviewDate('smbc-nl','2027-01-10'),'2026-12-26');
  assert.equal(statementReviewDate('goldpoint','2027-01-12'),'2027-01-11');
  assert.equal(statementReviewDate('smbc-nl','2027-01-27'),'2027-01-11');
});
