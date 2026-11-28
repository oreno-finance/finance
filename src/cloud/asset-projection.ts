import {reconcileNisaMovements,type NisaCardContribution} from './nisa-movements.js';
import {recurringForCalculation} from '../fixed-costs/payment-history.js';
/** Read-only asset forecast: no remote writes, guessed debit accounts, or future salary estimates. */
import { isOverdueOneTime,overdueAccountImpact,payrollDepositAccountOnDay, ASSET_ACCOUNTS, oneTimeAccountDelta, recurringOneTimeMatch, nisaRuleOnDay, type AssetAccountId, type AssetsDocument, type BalanceSnapshot, type RecurringEntry } from './assets.js';
import { recurringOccursOn, recurringEffectiveAmount } from './recurring-schedule.js'; /* finance-monthly-v142 */
import { confirmedRecords } from '../importers/batch-policy.js';
import type { CloudRecord } from './merge.js';
import { depositedIncomeBetween, reconcileManualSalary, payrollCoversRecurringSalary, type PayrollIncomeEntry } from './payroll-income.js';

export interface AccountForecast {
  accountId:AssetAccountId;
  baseline:BalanceSnapshot|null;
  balance:number|null;
  recurringDelta:number;
  oneTimeDelta:number;
  cardNisaDelta:number;
  payrollDelta:number;
  forecastEvents:number;
  warning:string|null;
  overdue?:{count:number;delta:number;debit:number};
  nisaOverlap?:{count:number;scheduledDelta:number};
  oneTimeOverlap?:true;
}
export type AssetForecast = Record<AssetAccountId,AccountForecast>;
function dayString(date:Date):string {
  const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,'0'),d=String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
export function localDay(date:Date):string {return dayString(date);}
export function lastDayOfNextMonth(date:Date):string {
  return dayString(new Date(date.getFullYear(),date.getMonth()+2,0));
}
function validDay(day:string):boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return false;
  const date=new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===day;
}
function snapshotDay(s:BalanceSnapshot):string {return dayString(new Date(s.observedAt));}
function accountDelta(entry:RecurringEntry,account:AssetAccountId):number {
  if(entry.fromAccountId===account)return -entry.amount;
  if(entry.toAccountId===account)return entry.amount;
  return 0;
}
export function matchingNisaRows(doc:Pick<AssetsDocument,'nisaCardRule'|'nisaCardRuleHistory'>,records:readonly CloudRecord[]):NisaCardContribution[]{
  const matches:NisaCardContribution[]=[];
  if(!doc.nisaCardRule?.enabled&&!doc.nisaCardRuleHistory?.some(entry=>entry.previous?.enabled))return matches;
  for(const record of confirmedRecords(records)){
    for(const row of record.statement.rows){
      const date=row.usedOn;
      if(!validDay(date)||!Number.isSafeInteger(row.amount)||row.amount<=0)continue;
      const rule=nisaRuleOnDay(doc,date);
      if(!rule?.enabled||record.statement.cardId!==rule.cardId||
         !row.merchant.normalize('NFKC').toLocaleLowerCase().includes(rule.merchantContains.normalize('NFKC').toLocaleLowerCase()))continue;
      matches.push({date,amount:row.amount,recordId:record.id,rowId:row.id});
    }
  }
  return matches;
}
/**
 * Project from the latest snapshot on/before the target date.
 * All events on a snapshot's calendar day are excluded, because a manually
 * confirmed balance may already include them. Future entries are included up
 * to and including the selected target date. Card rows are never bank debits.
 */
export function forecastAssets(
  doc:AssetsDocument,asOf:string,records:readonly CloudRecord[]=[],
  payrollIncome:PayrollIncomeEntry[]=[],payrollDepositAccount:AssetAccountId|null=null,
  nisaMatches?:readonly ReturnType<typeof matchingNisaRows>[number][],
  actualThrough=asOf,
):AssetForecast {
  if(!validDay(asOf))throw new Error('予測対象日が不正です。');
  const cardRows=nisaMatches??matchingNisaRows(doc,records);
  // Validate IDs before routing so duplicates cannot hide across destination accounts.
  depositedIncomeBetween(payrollIncome,asOf,asOf);
  const result={} as AssetForecast;
  const recurring=recurringForCalculation(doc);
  const nisaPlan=reconcileNisaMovements(doc,cardRows,asOf<actualThrough?asOf:actualThrough,recurring);
  const salaryPlan=reconcileManualSalary(doc.oneTime,payrollIncome,day=>payrollDepositAccountOnDay(doc,day,payrollDepositAccount));
  const oneTime=(doc.oneTime??[]).filter(e=>!salaryPlan.excludes(e.id));
  for(const account of ASSET_ACCOUNTS){
    const found=doc.snapshots.filter(s=>s.accountId===account.id&&snapshotDay(s)<=asOf);
    found.sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||b.id.localeCompare(a.id));
    const baseline=found[0]??null;
    if(!baseline){result[account.id]={accountId:account.id,baseline:null,balance:null,recurringDelta:0,oneTimeDelta:0,cardNisaDelta:0,payrollDelta:0,forecastEvents:0,warning:'基準残高を登録してください。'};continue;}
    const start=snapshotDay(baseline);
    const from=Date.parse(`${start}T00:00:00Z`),to=Date.parse(`${asOf}T00:00:00Z`);
    if(!Number.isFinite(from)||!Number.isFinite(to)||to-from>366*10*86400000)
      {result[account.id]={accountId:account.id,baseline,balance:null,recurringDelta:0,oneTimeDelta:0,cardNisaDelta:0,payrollDelta:0,forecastEvents:0,warning:'基準残高が古いため、確認済み残高を更新してください。'};continue;}
    let recurringDelta=0,forecastEvents=0,ambiguousRecurring=false;
    // Iterate at most 3,660 days. Using UTC days keeps DST away from recurrence scheduling.
    for(let t=from+86400000;t<=to;t+=86400000){
      const day=new Date(t).toISOString().slice(0,10);
      for(const entry of recurring){
        if(entry.fromAccountId!==account.id&&entry.toAccountId!==account.id)continue;
        if(!recurringOccursOn(entry,day)||nisaPlan.excludesRecurring(entry.id,day))continue;
        const historic={...entry,amount:recurringEffectiveAmount(entry,day)};
        if(payrollCoversRecurringSalary(historic,day,payrollIncome,paidOn=>payrollDepositAccountOnDay(doc,paidOn,payrollDepositAccount)))continue;
        const delta=accountDelta(historic,account.id);
        if(delta!==0){
          const match=recurringOneTimeMatch(historic,day,doc.oneTime,undefined,recurring);
          if(match==='ambiguous')ambiguousRecurring=true;
          if(match!=='unique'){recurringDelta+=delta;forecastEvents++;}
        }
      }
    }
    // Do not replay movements already incorporated in a manually checked balance.
    let oneTimeDelta=0;
    for(const entry of oneTime){
      if(entry.date<=start||entry.date>asOf||isOverdueOneTime(entry,actualThrough)||nisaPlan.excludesOneTime(entry.id))continue;
      const delta=oneTimeAccountDelta(entry,account.id);
      if(delta!==0){oneTimeDelta+=delta;forecastEvents++;}
    }
    let cardNisaDelta=0;
    if(account.id==='nisa')for(const row of cardRows){
      if(row.date>start&&row.date<=asOf&&row.date<=actualThrough)cardNisaDelta+=row.amount;
    }
    // Opt-in only. The producer must provide confirmed salary payments;
    // never infer projected pay or the deposit account. No card debit here.
    const payrollDelta=depositedIncomeBetween(payrollIncome.filter(item=>payrollDepositAccountOnDay(doc,item.paidOn,payrollDepositAccount)===account.id),start,asOf);
    const balance=baseline.balance+recurringDelta+oneTimeDelta+cardNisaDelta+payrollDelta;
    if(!Number.isSafeInteger(balance))throw new Error('残高予測の金額が上限を超えています。');
    const overdue=overdueAccountImpact(oneTime.filter(e=>!nisaPlan.excludesOneTime(e.id)),account.id,start,asOf,actualThrough);
    const candidates=nisaPlan.ambiguousFor(account.id,start,asOf);
    const salaryOverlap=salaryPlan.ambiguous.some(e=>e.toAccountId===account.id&&e.date>start&&e.date<=asOf);
    const scheduledDelta=candidates.filter(e=>e.status==='planned'&&!(e.kind==='one-time'&&e.date<actualThrough)).reduce((sum,e)=>sum+(e.toAccountId===account.id?e.amount:-e.amount),0);
    if(!Number.isSafeInteger(scheduledDelta)||!Number.isSafeInteger(balance-scheduledDelta))throw Error('NISA積立の参考額が大きすぎます。');
    if(!Number.isSafeInteger(balance+overdue.delta)||!Number.isSafeInteger(balance+overdue.debit))throw Error('未確認予定を含む予測額が大きすぎます。');
    result[account.id]={accountId:account.id,baseline,balance,recurringDelta,oneTimeDelta,cardNisaDelta,payrollDelta,forecastEvents,
      ...(overdue.count?{overdue}:{}),...(ambiguousRecurring||salaryOverlap?{oneTimeOverlap:true as const}:{}),...(candidates.length?{nisaOverlap:{count:candidates.length,scheduledDelta}}:{}),warning:[account.id==='nisa'?'評価額の変動は含まず、積立額のみを加算した参考値です。':null,
        ambiguousRecurring?'単発入出金と定期予定の対応が不明です。重複候補を含む参考値です。':null,
        salaryOverlap?'単発給与とPayrollの対応が不明です。重複候補を含む参考値です。':null,
        overdue.count?'期限経過・未確認の単発入出金は基準参考値に含めていません。':null,
        candidates.length?'NISAのカード積立と銀行積立の対応が不明です。両方を含む参考値であり、積立設定を確認してください。':null].filter(Boolean).join(' ')||null};
  }
  return result;
}
