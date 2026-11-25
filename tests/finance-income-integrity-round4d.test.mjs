import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyAssets} from '../dist/src/cloud/assets.js';
import {payrollRole,payrollRoleLabel} from '../dist/src/cloud/payroll-income.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {forecastAssets} from '../dist/src/cloud/asset-projection.js';
import {forecastBankBalances} from '../dist/src/cloud/salary-projection.js';
import {forecastAccounts} from '../dist/src/home/account-events.js';
import {bankTimeline} from '../dist/src/summary/bank-timeline.js';
import {estimatedMizuhoFunding} from '../dist/src/cloud/card-fixed-estimates.js';
import {mizuhoFundingStatus} from '../dist/src/home/mizuho-funding.js';
const mainId='emp_'+'a'.repeat(32),sideId='emp_'+'b'.repeat(32);
const pay=(id,date,netPay,employerId,job,kind='salary')=>({id,paidOn:date,payPeriod:date.slice(0,7),netPay,employerId,...(job?{job}:{}),kind,grossPay:null,taxablePay:null,currency:'JPY',revision:1});
const snapshot=(accountId,balance)=>({id:'snap-'+accountId,accountId,balance,observedAt:'2026-11-01T12:00:00Z'});
const doc=()=>({...emptyAssets(),payrollDepositAccount:'rakuten-bank',snapshots:[snapshot('rakuten-bank',300000),snapshot('mizuho-bank',10000)]});
const source=(entries,assets=doc(),records=[])=>({assets,records,categories:[{id:'food',name:'食費',color:'orange'}],rules:[],payroll:{ready:true,syncedAt:Date.parse('2026-11-24T12:00:00Z'),entries},currentPeriod:'2026-11'});
const rec=(patch={})=>({id:'rec-pay',name:'給与',kind:'income',amount:190000,fromAccountId:null,toAccountId:'rakuten-bank',frequency:'monthly',dayOfMonth:27,monthOfYear:null,weekday:null,startOn:'2026-11-01',endOn:null,categoryId:null,enabled:true,...patch});
const cost=(patch={})=>({id:'cost-test',name:'固定費',payment:'card',cardId:'rakuten-mizuho',merchantKey:'rakuten-mizuho|fixed',categoryId:'food',frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:'2026-10-01',endOn:null,amount:30000,priceKind:'fixed',pricing:[{effectiveOn:'2026-10-01',amount:30000}],pauses:[],note:'',updatedAt:'2026-11-23T00:00:00Z',...patch});
const card=(date='2026-12-28')=>({id:'card-stmt',statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'synthetic',billingMonth:'2026-11',paymentDate:date,statedTotal:30000,confirmation:'confirmed',warnings:[],rows:[{id:'row-test',usedOn:'2026-11-05',merchant:'SHOP',amount:30000}]}});
const today='2026-11-24',end='2026-11-30';
const projected=(a,entries,records=[],target=end)=>forecastBankBalances(a,target,records,entries,a.payrollDepositAccount,today);
const home=(a,entries,records=[],horizon=6)=>forecastAccounts(source(entries,a,records),today,horizon);
const bank=(r,id)=>r.accounts.find(a=>a.accountId===id);
const total=(a,entries,records=[])=>monthlyReport('2026-11',source(entries,records.length?a:{...a,cardNoUseMonths:['2026-11']},records));

test('旧ID、新ID、新旧混在の給与見込みと副業実績が同じ月次収支になる',()=>{
 for(const [oldId,oldRole,side,sideRole] of [['main',null,'side',null],[mainId,'main',sideId,'side'],['main',null,sideId,'side'],[mainId,'main','side',null]]){
  const entries=[pay('oct','2026-10-27',190000,oldId,oldRole),pay('side','2026-11-30',20000,side,sideRole)];
  const r=total(doc(),entries);
  assert.equal(r.income,210000);assert.equal(r.actualIncome,20000);assert.equal(r.estimatedIncome,190000);assert.equal(r.monthlyBalance,210000);
  assert.equal(r.incomeLines[0].employerId,side);assert.equal(r.incomeLines[0].job,'side');
  assert.equal(r.incomeEstimates[0].employerId,oldId);assert.equal(r.incomeEstimates[0].job,'main');
 }
});
test('転職後の本業実績は旧IDの見込みを置換し、賞与と副業は本業判定に流用しない',()=>{
 const old=pay('old','2026-10-27',190000,'main');
 const actual=pay('new','2026-11-27',210000,mainId,'main');
 const side=pay('side','2026-11-30',20000,sideId,'side');
 const bonus=pay('bonus','2026-11-25',10000,mainId,'main','bonus');
 assert.equal(total(doc(),[old,actual,side,bonus]).income,240000);
 assert.equal(total(doc(),[old,actual,side,bonus]).estimatedIncome,null);
 assert.equal(total(doc(),[old,side,bonus]).income,220000);
 const unknown=pay('unknown','2026-11-29',5000,'unknown');
 assert.equal(payrollRole(unknown),null);assert.equal(payrollRoleLabel(payrollRole(unknown)),'勤務区分不明');
 assert.equal(total(doc(),[unknown]).incomeLines[0].job,null);
 assert.equal(total(doc(),[pay('stale','2026-08-27',190000,mainId,'main'),side]).income,null);
});
test('画面の給与ラベルは勤務区分だけで決まり、内部勤務先IDを表示しない',()=>{
 const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
 assert.match(read('src/ui/monthly-summary.ts'),/payrollRoleLabel\(row.job\)/);
 for(const p of ['src/home/account-events.ts','src/summary/bank-timeline.ts'])assert.match(read(p),/payrollRoleLabel\(payrollRole\(entry\)\)/);
 assert.equal(payrollRoleLabel(payrollRole(pay('x',end,1,mainId,'main'))),'本業');
 assert.equal(payrollRoleLabel(payrollRole(pay('x',end,1,sideId,'side'))),'副業');
});
test('実績給与と定期入金は残高カード・ホーム・銀行推移で一度だけ計上する',()=>{
 const a=doc();a.recurring=[rec()];
 const entries=[pay('actual','2026-11-27',190000,mainId,'main')];
 assert.equal(forecastAssets(a,end,[],entries,'rakuten-bank')['rakuten-bank'].balance,490000);
 assert.equal(projected(a,entries).accounts['rakuten-bank'].balance,490000);
 assert.equal(bank(home(a,entries),'rakuten-bank').projected,490000);
 assert.equal(bankTimeline('2026-11',source(entries,a),today).endBalance,490000);
 // No actual main pay: an explicit manual estimate is retained even with side-job or bonus income.
 const side=[pay('side','2026-11-30',20000,sideId,'side'),pay('bonus','2026-11-25',10000,mainId,'main','bonus')];
 assert.equal(projected(a,side).accounts['rakuten-bank'].balance,520000);
 assert.equal(bank(home(a,side),'rakuten-bank').projected,520000);
 assert.equal(bankTimeline('2026-11',source(side,a),today).endBalance,520000);
 assert.equal(forecastAssets(a,end,[],[],'rakuten-bank')['rakuten-bank'].balance,490000);
 // Do not suppress a different deposit account or a side-job schedule.
 a.recurring.push(rec({id:'side-rec',name:'副業給与',amount:20000}),rec({id:'other-rec',toAccountId:'cash-savings',amount:3000}));
 a.snapshots.push(snapshot('cash-savings',1000));
 const result=projected(a,entries);
 assert.equal(result.accounts['rakuten-bank'].balance,510000);assert.equal(result.accounts['cash-savings'].balance,4000);
});
test('予定の単発入出金は月次の定期分を消さず、残高予測では一度だけ計上する',()=>{
 const a=doc();a.recurring=[rec({id:'insurance',name:'保険',kind:'expense',amount:9900,fromAccountId:'rakuten-bank',toAccountId:null,categoryId:'food'})];
 const item={id:'manual-insurance',date:'2026-11-27',name:'保険',amount:9900,kind:'expense',fromAccountId:'rakuten-bank',toAccountId:null,categoryId:'food'};
 const entries=[pay('actual','2026-11-27',190000,mainId,'main')];
 for(const status of ['planned','done']){
  a.oneTime=[{...item,status}];const r=total(a,entries);
  assert.equal(r.recurringExpense,status==='planned'?9900:0);assert.equal(r.oneTimeExpense,status==='done'?9900:0);
  assert.equal(r.monthlyBalance,180100);assert.equal(r.categories.reduce((n,x)=>n+x.amount,0),9900);
  assert.equal(projected(a,entries).accounts['rakuten-bank'].balance,480100);
 }
 a.recurring=[];a.fixedCosts=[cost({payment:'cash',cardId:null,merchantKey:null,name:'保険',amount:9900,dayOfMonth:27,pricing:[{effectiveOn:'2026-10-01',amount:9900}]})];
 for(const status of ['planned','done']){a.oneTime=[{...item,status}];const r=total(a,entries);assert.equal(r.monthlyBalance,status==='planned'?180100:170200);assert.equal(r.categories.reduce((n,x)=>n+x.amount,0),status==='planned'?9900:19800);assert.equal(r.recurringExpense,9900);}
});
function fundingDoc(){const a=doc();a.fixedCosts=[cost()];a.cardDebitAccounts={'rakuten-mizuho':'mizuho-bank'};a.cardPreferences={'rakuten-mizuho':{name:'楽天みずほ',issuer:'rakuten',payment:{monthOffset:1,day:27}}};a.mizuhoTransferPlan={enabled:true,leadDays:3,extraForSmallBills:false};return a;}
test('固定費の推定カード請求は仮送金として両口座へ反映し、確定チェックを変更しない',()=>{
 const a=fundingDoc();const before=structuredClone(a);const target='2026-12-31';
 const forecast=projected(a,[],[],target);
 assert.equal(forecast.estimatedTransferByAccount['rakuten-bank'],-60000);
 assert.equal(forecast.estimatedTransferByAccount['mizuho-bank'],60000);
 assert.equal(forecast.accounts['rakuten-bank'].balance,240000);assert.equal(forecast.accounts['mizuho-bank'].balance,10000);
 assert.equal(forecast.autoTransferByAccount['rakuten-bank'],undefined);
 const h=home(a,[],[],37);assert.equal(bank(h,'rakuten-bank').projected,240000);assert.equal(bank(h,'mizuho-bank').projected,10000);
 assert.ok(bank(h,'rakuten-bank').days.flatMap(d=>d.events).some(e=>e.estimated&&e.title.includes('見込み')));
 assert.equal(bankTimeline('2026-12',source([],a),today).endBalance,240000);
 const r=total(a,[]);assert.equal(r.cardLines.length,0);assert.equal(mizuhoFundingStatus({assets:a},r,today).billConfirmed,false);
 assert.deepEqual(a,before);
});
test('仮送金は明細の取得・手動送金・機能無効化で消え、月またぎにも対応する',()=>{
 const a=fundingDoc();const target='2026-12-31';
 assert.equal(estimatedMizuhoFunding(a,[card()],today,target).length,1);
 const withActual=projected(a,[],[card()],target);assert.equal(withActual.estimatedTransferByAccount['rakuten-bank'],-30000);assert.equal(withActual.autoTransferByAccount['rakuten-bank'],-30000);
 a.oneTime=[{id:'manual-fund',name:'送金',kind:'transfer',status:'planned',date:'2026-12-25',amount:30000,fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',cardFunding:true}];
 assert.equal(estimatedMizuhoFunding(a,[],today,target).length,1);
 a.mizuhoTransferPlan.enabled=false;assert.deepEqual(estimatedMizuhoFunding(a,[],today,target),[]);
 a.oneTime=[];a.mizuhoTransferPlan={enabled:true,leadDays:5,extraForSmallBills:false};a.cardPreferences['rakuten-mizuho'].payment={monthOffset:1,day:2};
 assert.ok(estimatedMizuhoFunding(a,[],today,'2026-11-30').some(e=>e.paymentDate==='2026-12-02'&&e.date==='2026-11-27'));
 assert.deepEqual(estimatedMizuhoFunding(a,[],'2026-11-28','2026-11-30'),[]);
});

test('月またぎの仮送金を確定明細へ置き換えてもホームと口座残高に同じ送金が残る',()=>{
 const a=fundingDoc();a.mizuhoTransferPlan.leadDays=5;a.cardPreferences['rakuten-mizuho'].payment={monthOffset:1,day:2};
 const actual=card('2026-12-02');
 assert.equal(projected(a,[],[]).accounts['rakuten-bank'].balance,270000);
 assert.equal(projected(a,[],[actual]).accounts['rakuten-bank'].balance,270000);
 assert.equal(bank(home(a,[],[]),'rakuten-bank').projected,270000);
 assert.equal(bank(home(a,[],[actual]),'rakuten-bank').projected,270000);
});

test('Phase 6B: 本業実績と副業予定は同じ月の収入に含まれ、副業実績があれば置換する',()=>{
 const a=doc();a.recurring=[rec(),rec({id:'manual-side',name:'副業給与',amount:20000,dayOfMonth:28})];
 const main=pay('actual-main','2026-11-27',190000,mainId,'main');
 const side=pay('actual-side','2026-11-28',23000,sideId,'side');
 for(const [entries,amount,manual,excluded] of [[[main],210000,20000,1],[[main,side],213000,0,2]]){
  const r=total(a,entries);
  assert.equal(r.income,amount);assert.equal(r.recurringIncome,manual);assert.equal(r.recurringSalaryExcluded,excluded);
  assert.equal(r.actualIncome,entries.reduce((n,x)=>n+x.netPay,0));
  assert.equal(projected(a,entries).accounts['rakuten-bank'].balance,300000+amount);
  assert.equal(bank(home(a,entries),'rakuten-bank').projected,300000+amount);
  assert.equal(bankTimeline('2026-11',source(entries,a),today).endBalance,300000+amount);
 }
});
test('Phase 6B: 本業の手動予定を自動見込みや副業・賞与で消さず、実績にすり替えない',async()=>{
 const a=doc();a.recurring=[rec({amount:180000}),rec({id:'manual-side',name:'副業給与',amount:20000,dayOfMonth:28})];
 const old=pay('last-main','2026-10-27',190000,mainId,'main');
 const bonus=pay('bonus','2026-11-25',10000,mainId,'main','bonus');
 const r=total(a,[old,bonus]);
 assert.equal(r.income,210000);assert.equal(r.actualIncome,10000);assert.equal(r.estimatedIncome,null);assert.equal(r.recurringIncome,200000);
 assert.equal(projected(a,[old,bonus]).accounts['rakuten-bank'].balance,510000);
 assert.equal(bank(home(a,[old,bonus]),'rakuten-bank').projected,510000);
 assert.equal(bankTimeline('2026-11',source([old,bonus],a),today).endBalance,510000);
 const {reportSnapshot}=await import('../dist/src/reports/monthly-report.js');
 const {analyzePeriods}=await import('../dist/src/analysis/period-analytics.js');
 const s=source([old,bonus],{...a,cardNoUseMonths:['2026-11']});
 assert.ok(reportSnapshot('2026-11',s).quality.includes('手動の給与入金予定を含む'));
 assert.equal(analyzePeriods(s,['2026-11'],'2026-11').totals.comparable,false);
 const noEvidence=total(a,[]);assert.equal(noEvidence.income,200000);assert.equal(noEvidence.actualIncome,null);
 const stale=source([old],a);stale.payroll.ready=false;assert.equal(monthlyReport('2026-11',stale).income,null);
});
test('Phase 6B: 受取口座が違う予定、未設定口座、過去月、無効な定期予定を区別する',()=>{
 const a=doc();a.recurring=[rec({toAccountId:'cash-savings',amount:3000}),rec({id:'side',name:'副業給与',amount:20000}),rec({id:'disabled',amount:900000,enabled:false})];
 const main=pay('actual-main','2026-11-27',190000,mainId,'main');
 const r=total(a,[main]);assert.equal(r.income,213000);assert.equal(r.recurringSalaryExcluded,0);
 // An unassigned account does not invent a bank route; household role matching remains compatible.
 const unassigned={...a,payrollDepositAccount:null};assert.equal(total(unassigned,[main]).income,210000);
 const past=pay('past','2026-10-27',190000,mainId,'main');
 const other=total(a,[past]);assert.equal(other.estimatedIncome,190000);assert.equal(other.recurringIncome,23000);
 a.recurring=[rec({startOn:'2026-12-01'})];assert.equal(total(a,[past]).estimatedIncome,190000);
});

test('Phase 6C: 給与見込みは最新月の複数本業給与と不整合な額面を両方の計算で拒否する',()=>{
 for(const entries of [[pay('a','2026-10-25',190000,'main'),pay('b','2026-10-27',80000,mainId,'main')],[{...pay('a','2026-10-27',190000,'main'),grossPay:200000,taxablePay:300000}]]){
  assert.equal(total(doc(),entries).estimatedIncome,null);
  assert.equal(projected(doc(),entries).accounts['rakuten-bank'].balance,300000);
 }
 const entries=[pay('a','2026-10-27',190000,'main')];
 assert.equal(total(doc(),entries).estimatedIncome,190000);
 assert.equal(projected(doc(),entries).accounts['rakuten-bank'].balance,490000);
});
test('Phase 6C: 同名同額の現金固定費を銀行単発出金で消さず、複数の銀行定期支出も曖昧な一致では消さない',()=>{
 const a=doc();const expense=rec({id:'bank-a',kind:'expense',name:'契約例',amount:1000,fromAccountId:'rakuten-bank',toAccountId:null,dayOfMonth:27});
 a.recurring=[expense];a.fixedCosts=[cost({id:'cash-a',name:'契約例',payment:'cash',cardId:null,merchantKey:null,amount:1000,dayOfMonth:27,pricing:[{effectiveOn:'2026-10-01',amount:1000}]})];
 a.oneTime=[{id:'one',kind:'expense',name:'契約例',amount:1000,fromAccountId:'rakuten-bank',toAccountId:null,date:'2026-11-27',status:'done',categoryId:null,note:''}];
 assert.equal(total(a,[]).recurringExpense,1000);assert.equal(total(a,[]).oneTimeExpense,1000);
 a.recurring.push({...expense,id:'bank-b'});
 assert.equal(total(a,[]).recurringExpense,3000);assert.equal(total(a,[]).recurringOneTimeOverlap,2);
 assert.equal(projected(a,[]).accounts['rakuten-bank'].balance,297000);
});
