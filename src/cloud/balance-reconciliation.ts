import {recurringForCalculation} from '../fixed-costs/payment-history.js';
/** Compare two manually confirmed balances against the forecast reconstructed
 * from the earlier snapshot. Never mutate the assets document or infer a bank
 * transaction from a discrepancy. */
import { cardDebitAccountOnDay,payrollDepositAccountOnDay, ASSET_ACCOUNTS, oneTimeAccountDelta, type AssetAccountId, type AssetsDocument, type BalanceSnapshot } from './assets.js';
import { recurringOccursOn } from './recurring-schedule.js';
import { forecastBankBalances,prepareBankForecast } from './salary-projection.js';
import type { PayrollIncomeEntry } from './payroll-income.js';
import {mizuhoTransferForBill} from './mizuho-transfer.js';
import type { CloudRecord } from './merge.js';

export interface BalanceReconciliation {
  accountId: AssetAccountId;
  previous: BalanceSnapshot;
  latest: BalanceSnapshot;
  previousDay: string;
  latestDay: string;
  predicted: number;
  actual: number;
  difference: number; // actual minus predicted; not necessarily an unknown expense
  provisionalEntries: number;
  provisionalDelta:number;
  sameDayEntries: boolean;
  unmappedCard: boolean;
  payrollNotReady: boolean;
  valuationMayChange: boolean;
  nisaOverlap?:boolean;
  oneTimeOverlap?:boolean;
}
const day=(iso:string):string=>{
  const d=new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const nextDay=(date:string):string=>new Date(Date.parse(`${date}T00:00:00Z`)+86400000).toISOString().slice(0,10);
export function reconcileBalance(
  doc:AssetsDocument, accountId:AssetAccountId, records:readonly CloudRecord[],
  payrollIncome:PayrollIncomeEntry[], payrollDepositAccount:AssetAccountId|null,
  payrollReady:boolean, today:string,
):BalanceReconciliation|null {
  if(!ASSET_ACCOUNTS.some(a=>a.id===accountId)||!/^\d{4}-\d{2}-\d{2}$/.test(today))return null;
  const sorted=doc.snapshots.filter(s=>s.accountId===accountId).sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||b.id.localeCompare(a.id));
  const latest=sorted[0];
  if(!latest)return null;
  const latestDay=day(latest.observedAt);
  // Same-day edits are not a reliable separate reconciliation interval.
  const previous=sorted.find(s=>day(s.observedAt)<latestDay);
  if(!previous||latestDay>today)return null;
  const previousDay=day(previous.observedAt);
  // Avoid expensive and misleading comparisons across many years of changed rules.
  if(Date.parse(`${latestDay}T00:00:00Z`)-Date.parse(`${previousDay}T00:00:00Z`)>1096*86400000)return null;
  // The newest snapshot is EXCLUDED when forecasting its own expected value.
  // Other account snapshots are left untouched for linked transfer bookkeeping.
  const reconstructed:AssetsDocument={...doc,snapshots:doc.snapshots.filter(s=>s.accountId!==accountId||s.observedAt<=previous.observedAt)};
  // Historical reconciliation never includes a future salary estimate.
  const work=prepareBankForecast(records,reconstructed);
  const result=forecastBankBalances(reconstructed,latestDay,records,payrollIncome,payrollDepositAccount,nextDay(latestDay),work);
  const predicted=result.accounts[accountId].balance;
  if(predicted===null||!Number.isSafeInteger(predicted))return null;
  const difference=latest.balance-predicted;
  if(!Number.isSafeInteger(difference))return null;
  const inInterval=(date:string)=>date>previousDay&&date<=latestDay;
  const touches=(from:AssetAccountId|null,to:AssetAccountId|null)=>from===accountId||to===accountId;
  // The reconstructed forecast already excludes explicitly matched NISA plans.
  // Reuse its pending impact rather than counting the suppressed schedule again.
  const pending=result.accounts[accountId].overdue;
  const provisionalEntries=pending?.count??0,provisionalDelta=pending?.delta??0;
  if(!Number.isSafeInteger(provisionalDelta))throw Error('未確認予定の合計額が大きすぎます。');
  const sameDayEntries=(doc.oneTime??[]).some(e=>e.date===latestDay&&oneTimeAccountDelta(e,accountId)!==0)||
    recurringForCalculation(doc).some(e=>e.enabled&&touches(e.fromAccountId,e.toAccountId)&&recurringOccursOn(e,latestDay))||
    records.some(r=>r.statement.paymentDate===latestDay&&(r.statement.cardId!==null&&cardDebitAccountOnDay(doc,r.statement.cardId,r.statement.paymentDate)===accountId))||
    (payrollIncome.some(e=>e.paidOn===latestDay&&payrollDepositAccountOnDay(doc,e.paidOn,payrollDepositAccount)===accountId))||
    ((accountId==='rakuten-bank'||accountId==='mizuho-bank')&&[...work.reports.values()].some(r=>r.cardLines.some(c=>mizuhoTransferForBill(c,doc)?.date===latestDay)));
  const unmappedCard=(accountId==='rakuten-bank'||accountId==='mizuho-bank')&&
    records.some(r=>inInterval(r.statement.paymentDate??'')&&(r.statement.cardId===null||!cardDebitAccountOnDay(doc,r.statement.cardId,r.statement.paymentDate)));
  return {accountId,previous,latest,previousDay,latestDay,predicted,actual:latest.balance,difference,
    provisionalEntries,provisionalDelta,sameDayEntries,unmappedCard:!!unmappedCard,
    payrollNotReady:!payrollReady&&(payrollDepositAccountOnDay(doc,latestDay,payrollDepositAccount)===accountId||payrollDepositAccountOnDay(doc,previousDay,payrollDepositAccount)===accountId||!!doc.payrollDepositAccountHistory?.some(h=>h.effectiveOn>previousDay&&h.effectiveOn<=latestDay&&h.accountId===accountId)),
    valuationMayChange:accountId==='nisa',...(result.accounts[accountId].oneTimeOverlap?{oneTimeOverlap:true}:{}),...(result.accounts[accountId].nisaOverlap?{nisaOverlap:true}:{})};
}
