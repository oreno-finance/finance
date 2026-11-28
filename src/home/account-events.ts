import {reconcileNisaMovements} from '../cloud/nisa-movements.js';
import {matchingNisaRows} from '../cloud/asset-projection.js';
import {fixedCostCalculationAssets,fixedCostRuleViews} from '../fixed-costs/rule-fixed-costs.js';
import {recurringForCalculation} from '../fixed-costs/payment-history.js';
/** Read-only account-level cashflow. Bank balances are projections from a manually
 * observed snapshot, never a bank API balance. No assets or statements are mutated. */
import { overdueAccountImpact,cardDebitAccountOnDay,payrollDepositAccountOnDay, ASSET_ACCOUNTS, recurringOneTimeMatch, type AssetAccountId, type BalanceSnapshot } from '../cloud/assets.js';
import { recurringInMonth } from '../cloud/recurring-schedule.js';
import { estimatedCardFixedBills, estimatedMizuhoFunding } from '../cloud/card-fixed-estimates.js';
import { mizuhoTransferForBill } from '../cloud/mizuho-transfer.js';
import { payrollRole, payrollRoleLabel, payrollCoversRecurringSalary, recurringSalaryRole, reconcileManualSalary, manualMainSalaryInMonth } from '../cloud/payroll-income.js';
import { expectedMainSalaries } from '../cloud/salary-projection.js';
import { changePeriod, monthlyReport, type MonthlyReport, type MonthlySource, type SummaryCard } from '../summary/monthly-summary.js';

export type BankAccountId = Exclude<AssetAccountId, 'nisa'>;
export type CashEventKind = 'card' | 'card-estimate' | 'transfer' | 'recurring' | 'one-time' | 'salary' | 'salary-estimate';
export interface AccountCashEvent {
  id: string; date: string; accountId: BankAccountId; amount: number; title: string;
  kind: CashEventKind; recordId?: string; cardId?: string; confirmation?: SummaryCard['confirmation']; estimated?:boolean;
  movementStatus?:'planned'|'done'|'estimated';route?:string;transferId?:string;
}
export interface AccountBalanceForecast {
  accountId: BankAccountId; name: string; observed: BalanceSnapshot | null;
  projected: number | null; projectedAt: string; reliable: boolean; sameDayEvents:boolean;
  days: ReadonlyArray<{date: string; balance: number; events: AccountCashEvent[]}>;
  overdue?:{count:number;delta:number;debit:number};
  reason: 'overdue-movement' | 'estimated-card-debit' | 'no-snapshot' | 'stale-snapshot' | 'missing-card-account' | 'possible-duplicate' | 'unverified-debit' | 'payroll-unavailable' | 'invalid-statement' | null;
}
export interface DueCard {
  id: string; cardId: string; name: string; date: string; amount: number;
  confirmation: SummaryCard['confirmation']; accountId: BankAccountId | null;
  afterBalance: number | null; balanceReliable: boolean; estimated?:boolean;
}
export interface AccountForecasts {
  accounts: AccountBalanceForecast[]; debits: DueCard[];
  upcomingMovements: AccountCashEvent[];
  missingCardIds: string[]; overlap: boolean;
}
const period=(day:string)=>day.slice(0,7);
const isDay=(value:string)=>/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)&&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
export function shiftedDay(day:string,days:number):string {
  if(!isDay(day)||!Number.isSafeInteger(days))throw new Error('予測日が不正です。');
  const date=new Date(`${day}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}
function observedDay(snapshot:BalanceSnapshot):string {
  const date=new Date(snapshot.observedAt);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function addMonths(from:string,to:string):string[] {
  const result:string[]=[];let current=period(from);
  while(current<=period(to)&&result.length<7){result.push(current);current=changePeriod(current,1);}
  return result;
}
function safeAmount(previous:number,change:number):number {
  const value=previous+change;
  if(!Number.isSafeInteger(value))throw new Error('口座の予測金額が大きすぎます。');
  return value;
}
/** Every explicit account movement is evaluated per-account; internal transfers
 * generate equal-and-opposite events and are never household spending. */
export function forecastAccounts(source:MonthlySource,today:string,horizonDays=45,
  reportForMonth:(period:string)=>MonthlyReport=(period)=>monthlyReport(period,{...source,currentDay:today,currentPeriod:today.slice(0,7)}),
  nisaRows?:readonly ReturnType<typeof matchingNisaRows>[number][]):AccountForecasts {
  if(!isDay(today)||!Number.isSafeInteger(horizonDays)||horizonDays<1||horizonDays>90)throw Error('予測期間が不正です。');
  const until=shiftedDay(today,horizonDays);
  const cutoff=shiftedDay(today,-90);
  const snapshots=source.assets.snapshots??[];
  const bankIds:BankAccountId[]=['rakuten-bank','mizuho-bank','cash-savings'];
  const observed=new Map<BankAccountId,BalanceSnapshot|null>();
  for(const accountId of bankIds){
    const found=snapshots.filter(s=>s.accountId===accountId&&observedDay(s)<=today)
      .sort((a,b)=>b.observedAt.localeCompare(a.observedAt));
    observed.set(accountId,found[0]??null);
  }
  const events:AccountCashEvent[]=[];
  const push=(event:AccountCashEvent)=>{
    if(!bankIds.includes(event.accountId)||event.date<=cutoff||event.date>until||!isDay(event.date)||!Number.isSafeInteger(event.amount))return;
    events.push(event);
  };
  const addMovement=(id:string,date:string,title:string,amount:number,kind:CashEventKind,from:AssetAccountId|null,to:AssetAccountId|null,movementStatus:AccountCashEvent['movementStatus']='planned')=>{
    const name=(id:AssetAccountId)=>ASSET_ACCOUNTS.find(account=>account.id===id)?.name??'口座';
    const route=from&&to?`${name(from)} → ${name(to)}`:undefined;
    const transferId=route?id:undefined;
    if(from&&from!=='nisa')push({id:`${id}:from`,date,title,amount:-amount,kind,accountId:from,movementStatus,route,transferId});
    if(to&&to!=='nisa')push({id:`${id}:to`,date,title,amount,kind,accountId:to,movementStatus,route,transferId});
  };
  const missingCardIds=new Set<string>();
  const cardLines:(SummaryCard&{paymentDate:string})[]=[];
  const ambiguousRecurring:Array<{date:string;from:AssetAccountId|null;to:AssetAccountId|null}>=[];
  const overlapMonths:string[]=[];const invalidMonths:string[]=[];let unverified=false;
  const recurring=recurringForCalculation(source.assets);
  const nisaPlan=reconcileNisaMovements(source.assets,nisaRows??matchingNisaRows(source.assets,source.records),today,recurring);
  for(const month of addMonths(cutoff,until)){
    const report=reportForMonth(month);
    if(report.recurringCardOverlap>0)overlapMonths.push(month);
    if(report.issues.some(issue=>issue.month===month||issue.month===null))invalidMonths.push(month);
    for(const card of report.cardLines){
      if(!card.paymentDate)continue;
      cardLines.push({...card,paymentDate:card.paymentDate});
      if(card.paymentDate>=today&&card.confirmation!=='confirmed')unverified=true;
      const accountId=cardDebitAccountOnDay(source.assets,card.cardId,card.paymentDate);
      if(!accountId||accountId==='nisa')missingCardIds.add(card.cardId);
      else push({id:`card:${card.id}`,date:card.paymentDate,title:card.name,amount:-card.amount,kind:'card',
        accountId,recordId:card.id,cardId:card.cardId,confirmation:card.confirmation});
      const funding=mizuhoTransferForBill(card,{
        mizuhoTransferPlan:source.assets.mizuhoTransferPlan,
        cardDebitAccounts:source.assets.cardDebitAccounts,
        cardDebitAccountHistory:source.assets.cardDebitAccountHistory,
        recurring:source.assets.recurring,
        oneTime:source.assets.oneTime,
      });
      if(funding)addMovement(`fund:${card.id}`,funding.date,'みずほ銀行へ送金（見込み）',funding.amount,'transfer','rakuten-bank','mizuho-bank','estimated');
    }
    for(const occurrence of recurringInMonth(month,recurring)){
      const entry=occurrence.entry;
      if(nisaPlan.excludesRecurring(entry.id,occurrence.date))continue;
      const match=recurringOneTimeMatch(entry,occurrence.date,source.assets.oneTime,undefined,recurring);
      if(match==='unique')continue;
      if(match==='ambiguous')ambiguousRecurring.push({date:occurrence.date,from:entry.fromAccountId,to:entry.toAccountId});
      if(source.payroll.ready&&payrollCoversRecurringSalary(entry,occurrence.date,source.payroll.entries,paidOn=>payrollDepositAccountOnDay(source.assets,paidOn)))continue;
      addMovement(`recurring:${occurrence.id}`,occurrence.date,entry.name,entry.amount,'recurring',entry.fromAccountId,entry.toAccountId);
    }
  }
  // A confirmed bill in the following month may require funding before the
  // current horizon ends. Do not include its card debit or unrelated warnings.
  if(source.assets.mizuhoTransferPlan?.enabled){
    const nextReport=reportForMonth(changePeriod(period(until),1));
    for(const card of nextReport.cardLines){
      const funding=mizuhoTransferForBill(card,source.assets);
      if(funding&&funding.date<=until)addMovement(`fund:${card.id}`,funding.date,'みずほ銀行へ送金（見込み）',funding.amount,'transfer','rakuten-bank','mizuho-bank','estimated');
    }
  }
  const fixedAssets=fixedCostCalculationAssets(source,today);
  const estimates=estimatedCardFixedBills(fixedAssets,
    source.records,today,until);
  for(const item of estimates){
    const assigned=cardDebitAccountOnDay(source.assets,item.cardId,item.paymentDate);
    if(!assigned||assigned==='nisa'){missingCardIds.add(item.cardId);continue;}
    push({id:item.id,date:item.paymentDate,accountId:assigned,amount:-item.amount,
      title:item.name,kind:'card-estimate',cardId:item.cardId,confirmation:'unknown',estimated:true});
  }
  for(const funding of estimatedMizuhoFunding(fixedAssets,source.records,today,until)){
    for(const [accountId,sign] of [['rakuten-bank',-1],['mizuho-bank',1]] as const)
      push({id:`${funding.id}:${accountId}`,date:funding.date,title:'みずほ銀行へ送金（見込み）',amount:sign*funding.amount,
        kind:'transfer',accountId,estimated:true,movementStatus:'estimated',transferId:funding.id,route:'楽天銀行 → みずほ銀行'});
  }
  const salaryPlan=reconcileManualSalary(source.assets.oneTime,source.payroll.ready?source.payroll.entries:[],day=>payrollDepositAccountOnDay(source.assets,day));
  for(const entry of source.assets.oneTime??[])if(!nisaPlan.excludesOneTime(entry.id)&&!salaryPlan.excludes(entry.id))addMovement(`once:${entry.id}`,entry.date,entry.name,entry.amount,'one-time',entry.fromAccountId,entry.toAccountId,entry.status);
  if(source.payroll.ready){
    for(const entry of source.payroll.entries){
      const payrollAccount=payrollDepositAccountOnDay(source.assets,entry.paidOn);
      if(!payrollAccount||payrollAccount==='nisa')continue;
      push({id:`salary:${entry.id}`,date:entry.paidOn,accountId:payrollAccount,
        title:`${payrollRoleLabel(payrollRole(entry))} · ${entry.kind==='bonus'?'賞与':entry.kind==='adjustment'?'調整':'給与'}`,amount:entry.netPay,kind:'salary'});
    }
    for(const estimate of expectedMainSalaries(source.payroll.entries,today,until)){
      const payrollAccount=payrollDepositAccountOnDay(source.assets,estimate.date);
      if(!payrollAccount||payrollAccount==='nisa')continue;
      const scheduled=manualMainSalaryInMonth(source.assets.oneTime,estimate.date,payrollAccount)||source.assets.recurring.some(r=>r.toAccountId===payrollAccount&&recurringSalaryRole(r)==='main'&&
        recurringInMonth(period(estimate.date),[r]).length>0);
      if(!scheduled)push({id:`estimated-salary:${estimate.date}`,date:estimate.date,accountId:payrollAccount,
        title:'本業給与（見込み）',amount:estimate.amount,kind:'salary-estimate'});
    }
  }
  events.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
  const payrollStale=!!source.payroll.syncedAt&&Date.parse(`${today}T12:00:00Z`)-source.payroll.syncedAt>14*86400000;
  const unknownFixedCards=fixedCostRuleViews(source,today).filter(x=>x.status==='active'&&!x.charge).map(x=>x.rule.cardId);
  const forecasts:AccountBalanceForecast[]=bankIds.map(accountId=>{
    const snapshot=observed.get(accountId)??null;
    const name=ASSET_ACCOUNTS.find(a=>a.id===accountId)!.name;
    const start=snapshot?observedDay(snapshot):null;
    const unknownAfterBaseline=start&&cardLines.some(card=>!cardDebitAccountOnDay(source.assets,card.cardId,card.paymentDate)&&card.paymentDate>start);
    const affectedOverlap=start&&overlapMonths.some(month=>month>=period(start));
    const affectedInvalid=start&&invalidMonths.some(month=>month>=period(start));
    const overdue=start?overdueAccountImpact((source.assets.oneTime??[]).filter(e=>!nisaPlan.excludesOneTime(e.id)&&!salaryPlan.excludes(e.id)),accountId,start,until,today):null;
    const reason:AccountBalanceForecast['reason']=!start?'no-snapshot':start<cutoff?'stale-snapshot':unknownAfterBaseline?'missing-card-account':
      overdue?.count?'overdue-movement':(affectedOverlap||salaryPlan.ambiguous.some(e=>e.toAccountId===accountId&&e.date>start&&e.date<=until)||nisaPlan.ambiguousFor(accountId,start,until).length||ambiguousRecurring.some(e=>e.date>start&&e.date<=until&&(e.from===accountId||e.to===accountId)))?'possible-duplicate':affectedInvalid?'invalid-statement':unverified?'unverified-debit':
      (unknownFixedCards.some(id=>id&&cardDebitAccountOnDay(source.assets,id,today)===accountId)||events.some(e=>e.accountId===accountId&&(e.kind==='card-estimate'||e.estimated===true))||
      (accountId==='rakuten-bank'&&estimates.some(e=>{const funding=mizuhoTransferForBill(e,source.assets);return !!funding&&funding.date<today;})))?'estimated-card-debit':
      ((!source.payroll.ready||payrollStale)&&(!source.assets.payrollDepositAccount||source.assets.payrollDepositAccount===accountId))||
      (source.payroll.entries.some(e=>e.paidOn>start&&e.paidOn<=until&&!payrollDepositAccountOnDay(source.assets,e.paidOn)))?'payroll-unavailable':null;
    const sameDayEvents=!!start&&events.some(e=>e.accountId===accountId&&e.date===start);
    if(!snapshot||!start||start<cutoff)return {accountId,name,observed:snapshot,projected:null,projectedAt:until,sameDayEvents,
      reliable:false,days:[],reason};
    const days:Array<{date:string;balance:number;events:AccountCashEvent[]}>=[];
    let balance=snapshot.balance;
    for(const event of events){
      if(event.accountId!==accountId||event.date<=start)continue;
      const overdueEvent=event.kind==='one-time'&&event.movementStatus==='planned'&&event.date<today;
      if(!overdueEvent)balance=safeAmount(balance,event.amount);
      const last=days[days.length-1];
      if(last?.date===event.date){last.balance=balance;last.events.push(event);}
      else days.push({date:event.date,balance,events:[event]});
    }
    if(overdue){safeAmount(balance,overdue.delta);safeAmount(balance,overdue.debit);}
    return {accountId,name,observed:snapshot,projected:balance,projectedAt:until,
      reliable:reason===null,days,reason,sameDayEvents,...(overdue?.count?{overdue}:{})};
  });
  const predictedCards:(SummaryCard&{paymentDate:string})[]=estimates.map(e=>({id:e.id,cardId:e.cardId,name:e.name,
    billingMonth:null,paymentDate:e.paymentDate,amount:e.amount,confirmation:'unknown'}));
  const debits=[...cardLines,...predictedCards].filter(card=>card.paymentDate>=today&&card.paymentDate<=until)
    .map(card=>{
      const assigned=cardDebitAccountOnDay(source.assets,card.cardId,card.paymentDate);
      const accountId=assigned&&assigned!=='nisa'?assigned:null;
      const forecast=forecasts.find(a=>a.accountId===accountId);
      const day=forecast?.days.find(d=>d.date===card.paymentDate);
      return {id:card.id,cardId:card.cardId,name:card.name,date:card.paymentDate,amount:card.amount,
        confirmation:card.confirmation,accountId,estimated:card.id.startsWith('estimate:'),afterBalance:forecast?.reliable&&day?day.balance:null,
        balanceReliable:!!forecast?.reliable&&!!day};
    })
    .sort((a,b)=>a.date.localeCompare(b.date)||a.cardId.localeCompare(b.cardId)||a.id.localeCompare(b.id));
  const upcomingMovements=events.filter(event=>event.date>=today&&event.kind!=='card'&&event.kind!=='card-estimate');
  return {accounts:forecasts,debits,upcomingMovements,missingCardIds:[...missingCardIds],overlap:overlapMonths.length>0};
}
