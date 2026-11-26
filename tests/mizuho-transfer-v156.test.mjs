import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyAssets, validateAssets, mergeAssets, detectAssetsEditCollisions, describeAssetsEditCollisions } from '../dist/src/cloud/assets.js';
import { estimateMizuhoTransferAmount, mizuhoTransferForBill } from '../dist/src/cloud/mizuho-transfer.js';
import { bankTimeline } from '../dist/src/summary/bank-timeline.js';
import { forecastBankBalances } from '../dist/src/cloud/salary-projection.js';
const snap=(id,account,balance,date='2026-11-16T00:00:00Z')=>({id,accountId:account,balance,observedAt:date});
const plan={enabled:true,leadDays:3,extraForSmallBills:true};
const bill=(amount,date='2026-11-27')=>({id:'record-1',statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'test.pdf',billingMonth:'2026-10',paymentDate:date,statedTotal:amount,confirmation:'confirmed',warnings:[],rows:[{id:'row-1',usedOn:'2026-10-10',merchant:'SHOP',amount}]}});
const data=(amount=24245)=>({...emptyAssets(),mizuhoTransferPlan:plan,cardDebitAccounts:{'rakuten-mizuho':'mizuho-bank'},snapshots:[snap('snap-r','rakuten-bank',100000),snap('snap-m','mizuho-bank',0)],recurring:[]});
const source=(doc,amount=24245)=>({records:[bill(amount)],rules:[],categories:[],assets:doc,payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'});
test('send target is 5,000-yen units, with an optional small-charge reserve',()=>{
 assert.equal(estimateMizuhoTransferAmount(24245,true),30000);
 assert.equal(estimateMizuhoTransferAmount(24245,false),25000);
 assert.equal(estimateMizuhoTransferAmount(160500,true),165000);
 assert.equal(estimateMizuhoTransferAmount(0),0);
 assert.throws(()=>estimateMizuhoTransferAmount(-1));
});
test('timeline debits Rakuten at transfer date, not the card settlement date',()=>{
 const doc=data();const results=bankTimeline('2026-11',source(doc),'2026-11-17');
 assert.deepEqual(results.days.map(day=>[day.date,day.delta,day.balance]),[['2026-11-24',-30000,70000]]);
 assert.equal(results.endBalance,70000);
 assert.equal(results.minimum,70000);
});
test('bank projection credits Mizuho then debits card, no double debit at Rakuten',()=>{
 const doc=data();const results=forecastBankBalances(doc,'2026-11-30',[bill(24245)],[],null,'2026-11-17');
 assert.equal(results.accounts['rakuten-bank'].balance,70000);
 assert.equal(results.accounts['mizuho-bank'].balance,5755);
 assert.equal(results.cardDebitByAccount['mizuho-bank'],24245);
 assert.equal(results.cardDebitByAccount['rakuten-bank']??0,0);
 assert.equal(results.autoTransferByAccount['rakuten-bank'],-30000);
 assert.equal(results.autoTransferByAccount['mizuho-bank'],30000);
});
test('snapshot after predicted transfer excludes past transfer for that account',()=>{
 const doc=data();doc.snapshots.push(snap('snap-new','rakuten-bank',80000,'2026-11-25T00:00:00Z'));
 const results=forecastBankBalances(doc,'2026-11-30',[bill(24245)],[],null,'2026-11-17');
 assert.equal(results.accounts['rakuten-bank'].balance,80000);
 assert.equal(results.accounts['mizuho-bank'].balance,5755);
});
test('disabled prediction and manual transfer do not produce duplicate auto transfers',()=>{
 const doc=data();assert.equal(mizuhoTransferForBill({cardId:'rakuten-mizuho',paymentDate:'2026-11-27',amount:24245},{...doc,mizuhoTransferPlan:{...plan,enabled:false}}),null);
 doc.recurring=[{id:'manual-1',name:'みずほへ送金',amount:30000,kind:'transfer',fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',frequency:'monthly',dayOfMonth:24,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true}];
 assert.equal(mizuhoTransferForBill({cardId:'rakuten-mizuho',paymentDate:'2026-11-27',amount:24245},doc),null);
});
test('optional settings preserve legacy assets and merge independent modifications',()=>{
 const base=emptyAssets();assert.deepEqual(validateAssets(base),base);
 const local={...base,mizuhoTransferPlan:plan};
 const remote={...base,cardDebitAccounts:{amazon:'rakuten-bank'}};
 const merged=mergeAssets(base,local,remote);
 assert.deepEqual(merged.mizuhoTransferPlan,plan);
 assert.equal(merged.cardDebitAccounts.amazon,'rakuten-bank');
 assert.throws(()=>validateAssets({...base,mizuhoTransferPlan:{...plan,leadDays:33}}));
});

test('a transfer scheduled at month end for a next-month card debit appears in the earlier month',()=>{
 const doc=data();const due=bill(24245,'2026-12-02');
 const sourceForDec={...source(doc),records:[due]};
 const november=bankTimeline('2026-11',sourceForDec,'2026-11-17');
 assert.deepEqual(november.days.map(x=>[x.date,x.delta]),[['2026-11-29',-30000]]);
 const forecast=forecastBankBalances(doc,'2026-11-30',[due],[],null,'2026-11-17');
 assert.equal(forecast.accounts['rakuten-bank'].balance,70000);
 assert.equal(forecast.accounts['mizuho-bank'].balance,30000);
});


test('optional encrypted warning floors validate, merge per bank, and clear at zero',()=>{
 const base=emptyAssets();assert.deepEqual(validateAssets(base),base);
 const local={...base,balanceWarningLimits:{'rakuten-bank':50000}};
 const remote={...base,balanceWarningLimits:{'mizuho-bank':10000}};
 assert.deepEqual(mergeAssets(base,local,remote).balanceWarningLimits,{'rakuten-bank':50000,'mizuho-bank':10000});
 assert.deepEqual(detectAssetsEditCollisions(base,local,remote),[]);
 const conflicting={...base,balanceWarningLimits:{'rakuten-bank':30000}};
 const collisions=detectAssetsEditCollisions(base,local,conflicting);assert.equal(collisions.length,1);
 assert.match(describeAssetsEditCollisions(base,local,conflicting,collisions)[0].label,/楽天銀行/);
 assert.equal(mergeAssets(base,local,conflicting).balanceWarningLimits['rakuten-bank'],50000);
 assert.equal(mergeAssets(local,{...local,balanceWarningLimits:{'rakuten-bank':0}},local).balanceWarningLimits,undefined);
 for(const value of [null,[],{'nisa':1},{'rakuten-bank':-1},{'rakuten-bank':1.2},{'rakuten-bank':'1'},{'rakuten-bank':Number.MAX_SAFE_INTEGER+1}])
   assert.throws(()=>validateAssets({...base,balanceWarningLimits:value}),/残高警告/);
});

test('actual later funding replaces the predicted transfer across all bank calculations without changing cashflow',async()=>{
 const {homeOverview}=await import('../dist/src/home/overview.js');
 const {monthlyReport}=await import('../dist/src/summary/monthly-summary.js');
 const doc=data();doc.snapshots=[snap('snap-r','rakuten-bank',100000,'2026-11-25T00:00:00Z'),snap('snap-m','mizuho-bank',0,'2026-11-23T00:00:00Z')];
 const s=source(doc);const before=monthlyReport('2026-11',s);
 // Transfer occurs after the predicted 24th and after the Rakuten snapshot.
 doc.oneTime=[{id:'actual-transfer',date:'2026-11-26',name:'実際の送金',amount:28000,kind:'transfer',status:'done',fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',cardFunding:true}];
 const h=homeOverview(s,'2026-11-26'),projection=forecastBankBalances(doc,'2026-11-30',s.records,[],null,'2026-11-26');
 assert.deepEqual([h.monthEnd.rakuten,h.monthEnd.mizuho,h.monthEnd.total],[72000,3755,75755]);
 assert.equal(projection.accounts['rakuten-bank'].balance,72000);assert.equal(projection.accounts['mizuho-bank'].balance,3755);
 assert.deepEqual(bankTimeline('2026-11',s,'2026-11-26').days.map(d=>[d.date,d.delta]),[['2026-11-26',-28000]]);
 assert.equal(monthlyReport('2026-11',s).monthlyBalance,before.monthlyBalance);
 assert.equal(monthlyReport('2026-11',s).oneTimeExpense,0);
 assert.equal(projection.autoTransferByAccount['rakuten-bank'],undefined);
});

test('month-end forecast excludes next-month debit and savings assets, and never assumes a missing bank balance is zero',async()=>{
 const {homeOverview}=await import('../dist/src/home/overview.js');
 const doc=data();doc.snapshots.push(snap('savings-1','cash-savings',999999));
 const s=source(doc);s.records.push({...bill(12000,'2026-12-27'),id:'record-2',statement:{...bill(12000,'2026-12-27').statement,billingMonth:'2026-11'}});
 const home=homeOverview(s,'2026-11-26');
 assert.deepEqual([home.monthEnd.date,home.monthEnd.rakuten,home.monthEnd.mizuho,home.monthEnd.total],['2026-11-30',70000,5755,75755]);
 assert.equal(home.monthEnd.reference,true);
 doc.snapshots=doc.snapshots.filter(x=>x.accountId!=='mizuho-bank');
 assert.equal(homeOverview(s,'2026-11-26').monthEnd.total,null);
});

test('same-day actual movement is not blindly added to a balance snapshot and is marked as a reference',async()=>{
 const {homeOverview}=await import('../dist/src/home/overview.js');
 const doc=data();doc.snapshots=[snap('snap-r','rakuten-bank',100000,'2026-11-26T00:00:00Z'),snap('snap-m','mizuho-bank',0,'2026-11-25T00:00:00Z')];
 doc.oneTime=[{id:'actual-transfer',date:'2026-11-26',name:'実際の送金',amount:30000,kind:'transfer',status:'done',fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',cardFunding:true}];
 const h=homeOverview(source(doc),'2026-11-26');assert.equal(h.monthEnd.sameDayEvents,true);assert.equal(h.monthEnd.reference,true);assert.equal(h.monthEnd.rakuten,100000);
});

test('reconciliation identifies salary and predicted funding on the balance observation date',async()=>{
 const {reconcileBalance}=await import('../dist/src/cloud/balance-reconciliation.js');
 const doc=data();doc.snapshots.push(snap('latest-r','rakuten-bank',70000,'2026-11-24T00:00:00Z'));
 const result=reconcileBalance(doc,'rakuten-bank',[bill(24245)],[],null,true,'2026-11-26');
 assert.equal(result.sameDayEntries,true);
 const income=[{id:'salary-test',employerId:'main',kind:'salary',paidOn:'2026-11-24',payPeriod:'2026-11',netPay:10000,grossPay:null,taxablePay:null,currency:'JPY',revision:1}];
 assert.equal(reconcileBalance(doc,'rakuten-bank',[],income,'rakuten-bank',true,'2026-11-26').sameDayEntries,true);
});
