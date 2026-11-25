/** Home uses the unchanged monthlyReport as its only household cashflow source. */
import { ASSET_ACCOUNTS, type AssetsDocument, type AssetAccountId, type BalanceSnapshot } from '../cloud/assets.js';
import { changePeriod, monthlyReport, monthlyCashflow, type MonthlyReport, type MonthlySource } from '../summary/monthly-summary.js';
import { lastDayOfNextMonth } from '../cloud/asset-projection.js';
import { prepareBankForecast, forecastBankBalances } from '../cloud/salary-projection.js';
import { forecastAccounts, type AccountForecasts } from './account-events.js';
import { homeActions, type HomeAction } from './action-items.js';
import {pendingCardSubscriptions} from '../subscriptions/detect.js';
export type HomeCoverage='missing'|'partial'|'needs-review'|'provisional'|'registered';
export interface HomeAccount {
  id:AssetAccountId; name:string; snapshot:BalanceSnapshot|null;
  current:number|null; predicted:number|null; warning:string|null;
}
export interface HomeOverview {
  today:string; period:string; report:MonthlyReport; coverage:HomeCoverage;
  outflow:number|null; cardNames:Record<string,string>; accounts:HomeAccount[]; forecast:AccountForecasts; actions:HomeAction[];
  /** Prior-month card report for stale/unfinished funding reminders. */
  priorFundingReport:MonthlyReport|null;
}
export function homeOverview(source:MonthlySource,today:string):HomeOverview {
  const currentPeriod=today.slice(0,7);
  const assets={...source.assets,snapshots:source.assets.snapshots??[]} as AssetsDocument;
  const work=prepareBankForecast(source.records,assets);
  const prepared=work.prepared;
  const adjusted={...source,currentPeriod};
  const byMonth=new Map<string,MonthlyReport>();
  const reportForMonth=(period:string):MonthlyReport=>{
    let report=byMonth.get(period);
    if(!report){report=monthlyReport(period,adjusted,prepared);byMonth.set(period,report);}
    return report;
  };
  const report=reportForMonth(currentPeriod);
  const forecast=forecastAccounts(source,today,45,reportForMonth);
  const previousPeriod=changePeriod(currentPeriod,-1);
  // Even a prior 'done' needs revalidation after a bill has changed.
  const priorFundingReport=source.assets.mizuhoTransferPlan?.enabled&&
    source.assets.cardDebitAccounts?.['rakuten-mizuho']==='mizuho-bank'
      ?reportForMonth(previousPeriod):null;
  const cashflow=monthlyCashflow(report);
  const coverage:HomeCoverage=cashflow.coverage==='review'?'needs-review':cashflow.coverage;
  const outflow=cashflow.expense;
  // Same projection as account management, including NISA and opted-in Payroll.
  const income=source.payroll.ready?[...source.payroll.entries]:[];
  const deposit=assets.payrollDepositAccount??null;
  const current=forecastBankBalances(assets,today,source.records,income,deposit,today,work).accounts;
  const next=forecastBankBalances(assets,lastDayOfNextMonth(new Date(`${today}T12:00:00`)),source.records,income,deposit,today,work).accounts;
  const accounts=ASSET_ACCOUNTS.map(({id,name})=>({id,name,snapshot:current[id].baseline,current:current[id].balance,
    predicted:next[id].balance,warning:current[id].warning??next[id].warning}));
  const cardNames=Object.fromEntries(Object.entries(source.assets.cardPreferences??{}).filter(([,preference])=>!!preference.name).map(([id,preference])=>[id,preference.name!]));
  const actions=homeActions(source,report,forecast,today);
  const candidates=pendingCardSubscriptions(source,today.slice(0,7));
  if(candidates.length)actions.push({id:'card-subscription-candidates',kind:'subscription',severity:'low',
    title:`定期支出の候補が${candidates.length}件あります`,target:'subscriptions'});
  return {today,period:report.period,report,coverage,outflow,cardNames,accounts,forecast,actions,priorFundingReport};
}
