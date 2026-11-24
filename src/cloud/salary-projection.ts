/** Read-only bank balance projection including clearly labelled, unconfirmed salary estimates.
 * Neither the monthly estimate nor the input salary is persisted to Finance/OneDrive.
 */
import { forecastAssets, matchingNisaRows, type AssetForecast } from './asset-projection.js';
import type { AssetsDocument, AssetAccountId, BalanceSnapshot } from './assets.js';
import type { CloudRecord } from './merge.js';
import type { PayrollIncomeEntry } from './payroll-income.js';
import { recurringInMonth } from './recurring-schedule.js';
import { monthlyReport, prepareMonthlyReports, type PreparedMonthlyReports, type MonthlyReport } from '../summary/monthly-summary.js';
import { estimatedCardFixedBills } from './card-fixed-estimates.js';
import { mizuhoTransferForBill } from './mizuho-transfer.js';

export interface ExpectedSalary {
  date:string;
  amount:number;
  sourceMonth:string;
  method:'net-excluding-nontaxable'|'previous-net';
}
export interface BankProjection {
  accounts:AssetForecast;
  estimatedByAccount:Partial<Record<AssetAccountId,number>>;
  estimates:ExpectedSalary[];
  cardDebitByAccount:Partial<Record<AssetAccountId,number>>;
  fixedCostCardEstimatesByAccount:Partial<Record<AssetAccountId,number>>;
  autoTransferByAccount:Partial<Record<AssetAccountId,number>>;
}
const period=(date:string)=>date.slice(0,7);
/** New producer includes job separately; old income files used employerId=main/side. */
const roleOf=(item:PayrollIncomeEntry)=>item.job??(item.employerId==='main'?'main':item.employerId==='side'?'side':null);
const monthIndex=(date:string)=>Number(date.slice(0,4))*12+Number(date.slice(5,7));
const monthFromIndex=(value:number)=>`${Math.floor((value-1)/12)}-${String(((value-1)%12)+1).padStart(2,'0')}`;
const validDay=(day:string)=>/^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day+'T00:00:00Z')) && new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
const snapshotDay=(snap:BalanceSnapshot)=>{
  const d=new Date(snap.observedAt);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const payday=(month:string,day:number)=>{
  const year=Number(month.slice(0,4)),mm=Number(month.slice(5,7));
  const last=new Date(Date.UTC(year,mm,0)).getUTCDate();
  return `${month}-${String(Math.min(day,last)).padStart(2,'0')}`;
};
const sane=(amount:number)=>Number.isSafeInteger(amount)&&amount>=0;
/** Forecast a missing normal main-job salary from an actual recent salary, not from a bonus.
 * Never project more than the current and next month in account balance widgets.
 */
export function expectedMainSalaries(entries:readonly PayrollIncomeEntry[],today:string,until:string):ExpectedSalary[] {
  if(!validDay(today)||!validDay(until)||until<today)return [];
  const current=monthIndex(today),last=monthIndex(until);
  const past=entries.filter(item=>roleOf(item)==='main'&&item.kind==='salary'&&
    validDay(item.paidOn)&&item.paidOn<=today&&sane(item.netPay))
    .sort((a,b)=>b.paidOn.localeCompare(a.paidOn)||b.revision-a.revision);
  const latest=past[0];
  if(!latest||current-monthIndex(latest.paidOn)>2)return [];
  let amount=latest.netPay;
  let method:ExpectedSalary['method']='previous-net';
  if(latest.grossPay!==null && latest.taxablePay!==null &&
      sane(latest.grossPay)&&sane(latest.taxablePay)&&latest.taxablePay<=latest.grossPay){
    const taxFree=latest.grossPay-latest.taxablePay;
    if(taxFree<=latest.netPay){amount=latest.netPay-taxFree;method='net-excluding-nontaxable';}
  }
  if(!sane(amount)||amount===0)return [];
  const result:ExpectedSalary[]=[];
  for(let i=current;i<=Math.min(last,current+1);i++){
    const month=monthFromIndex(i);
    if(entries.some(item=>roleOf(item)==='main'&&item.kind==='salary'&&period(item.paidOn)===month))continue;
    const date=payday(month,Number(latest.paidOn.slice(8,10)));
    if(date<=until)result.push({date,amount,sourceMonth:period(latest.paidOn),method});
  }
  return result;
}
/** Extend the existing confirmed-only calculation, never replace its saved values.
 * If a salary-named recurring bank income exists in the same month, trust the
 * explicit user-managed schedule instead of adding an additional estimate.
 */
export interface BankForecastWork {
  records:readonly CloudRecord[];prepared:PreparedMonthlyReports;reports:Map<string,MonthlyReport>;
  nisaRows:ReturnType<typeof matchingNisaRows>;months:readonly string[];
}
/** A per-render context: never share across asset edits or cloud refreshes. */
export function prepareBankForecast(records:readonly CloudRecord[],doc:AssetsDocument):BankForecastWork {
  const prepared=prepareMonthlyReports(records);
  const months=[...new Set(records.map(r=>r.statement.paymentDate?.slice(0,7))
    .filter((p):p is string=>!!p&&/^\d{4}-(0[1-9]|1[0-2])$/.test(p)))];
  return {records,prepared,reports:new Map(),nisaRows:matchingNisaRows(doc,records),months};
}
export function forecastBankBalances(
  doc:AssetsDocument,asOf:string,records:readonly CloudRecord[],income:PayrollIncomeEntry[],
  payrollDepositAccount:AssetAccountId|null,today:string,work?:BankForecastWork,
):BankProjection {
  if(work&&work.records!==records)throw new Error('口座予測の明細索引が一致しません。');
  const context=work??prepareBankForecast(records,doc);
  const accounts=forecastAssets(doc,asOf,records,income,payrollDepositAccount,context.nisaRows);
  const estimatedByAccount:Partial<Record<AssetAccountId,number>>={};
  const cardDebitByAccount:Partial<Record<AssetAccountId,number>>={};
  const fixedCostCardEstimatesByAccount:Partial<Record<AssetAccountId,number>>={};
  const autoTransferByAccount:Partial<Record<AssetAccountId,number>>={};
  for(const month of context.months){
    if(month>monthFromIndex(monthIndex(asOf)+1))continue;
    let report=context.reports.get(month);
    if(!report){report=monthlyReport(month,{records,rules:[],categories:[],assets:doc,
      payroll:{ready:false,syncedAt:null,entries:[]}},context.prepared);context.reports.set(month,report);}
    for(const line of report.cardLines){
      const transfer=mizuhoTransferForBill(line,doc);
      if(transfer){
        for(const [id,sign] of [['rakuten-bank',-1],['mizuho-bank',1]] as const){
          const forecast=accounts[id];
          if(forecast.balance===null||!forecast.baseline||transfer.date<=snapshotDay(forecast.baseline)||transfer.date>asOf)continue;
          forecast.balance+=sign*transfer.amount;
          if(!Number.isSafeInteger(forecast.balance))throw Error('送金予測額が大きすぎます。');
          autoTransferByAccount[id]=(autoTransferByAccount[id]??0)+sign*transfer.amount;
        }
      }
      const account=doc.cardDebitAccounts?.[line.cardId];
      if(!account)continue;
      const balance=accounts[account];
      if(balance.balance===null||!balance.baseline)continue;
      if(line.paymentDate>snapshotDay(balance.baseline)&&line.paymentDate<=asOf){
        const after=balance.balance-line.amount;
        if(!Number.isSafeInteger(after))throw Error('カード引落見込み額が大きすぎます。');
        balance.balance=after;
        cardDebitByAccount[account]=(cardDebitByAccount[account]??0)+line.amount;
      }
    }
  }
  // Imported payment-month statements override all estimated contracts for that card.
  for(const estimate of estimatedCardFixedBills(doc,records,today,asOf)){
    const account=doc.cardDebitAccounts?.[estimate.cardId];if(!account)continue;
    const bank=accounts[account];
    if(bank.balance===null||!bank.baseline||estimate.paymentDate<=snapshotDay(bank.baseline))continue;
    const result=bank.balance-estimate.amount;
    if(!Number.isSafeInteger(result))throw new Error('カード固定費の残高予測が大きすぎます。');
    bank.balance=result;
    fixedCostCardEstimatesByAccount[account]=(fixedCostCardEstimatesByAccount[account]??0)+estimate.amount;
    bank.warning=[bank.warning,'固定費から推定したカード引落額を含みます（請求額未確定）。'].filter(Boolean).join(' ');
  }
  if(!payrollDepositAccount||!['rakuten-bank','cash-savings'].includes(payrollDepositAccount)||asOf<today)
    return {accounts,estimatedByAccount,estimates:[],cardDebitByAccount,fixedCostCardEstimatesByAccount,autoTransferByAccount};
  const balance=accounts[payrollDepositAccount];
  if(balance.balance===null||!balance.baseline)return {accounts,estimatedByAccount,estimates:[],cardDebitByAccount,fixedCostCardEstimatesByAccount,autoTransferByAccount};
  const baselineDay=snapshotDay(balance.baseline);
  const estimates=expectedMainSalaries(income,today,asOf).filter(estimate=>{
    if(estimate.date<=baselineDay)return false;
    return !recurringInMonth(period(estimate.date),doc.recurring).some(event=>
      event.entry.kind==='income'&&event.entry.toAccountId===payrollDepositAccount&&
      /給与|給料|salary|payroll/i.test(event.entry.name));
  });
  let sum=0;
  for(const item of estimates){sum+=item.amount;if(!Number.isSafeInteger(sum))throw new Error('給与見込みの集計額が大きすぎます。');}
  if(sum){
    const next=balance.balance+sum;
    if(!Number.isSafeInteger(next))throw new Error('口座残高の見込み額が大きすぎます。');
    balance.balance=next;
    estimatedByAccount[payrollDepositAccount]=sum;
  }
  return {accounts,estimatedByAccount,estimates,cardDebitByAccount,fixedCostCardEstimatesByAccount,autoTransferByAccount};
}
