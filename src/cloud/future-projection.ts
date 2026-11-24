import {recurringForCalculation} from '../fixed-costs/payment-history.js';
/** Long-term savings outlook. Scenario changes are read-only and never written to assets.enc.
 * Existing balance snapshots remain the financial baseline; card/recurring inputs
 * are *scheduled*, not bank-confirmed. No actual NISA returns are inferred. */
import { recurringCoveredByOneTime, type AssetsDocument, type RecurringEntry } from './assets.js';
import { forecastAssets, matchingNisaRows } from './asset-projection.js';
import { recurringInMonth } from './recurring-schedule.js';
import type { CloudRecord } from './merge.js';

export interface FutureOptions {
  today: string;           // local YYYY-MM-DD
  targetMonth: string;     // YYYY-MM
  changeMonth: string;     // YYYY-MM
  savingsRuleId: string | null;
  savingsAmount: number;   // scenario amount per occurrence
  nisaMonthly: number;     // future card-funded NISA amount, not an account transfer
  nisaAnnualReturn: number; // annual rate, e.g. 0.03
  /** Optional override of monthly cash deposits. null means no cash change. */
  cashScenarioMonthly?: number | null;
  /** Optional override of monthly NISA principal contributions. null means no NISA change. */
  nisaScenarioMonthly?: number | null;
}
export interface FuturePoint {
  month: string;
  cash: number | null;
  cashScenario: number | null;
  nisa: number | null;
  nisaScenario: number | null;
  combined: number | null;
  combinedScenario: number | null;
}
export interface FutureResult {
  points: FuturePoint[];
  cashStart: number | null;
  nisaStart: number | null;
  savingRules: RecurringEntry[];
  hasNisaSchedule: boolean;
  conflictingNisaSources: boolean;
  target: FuturePoint;
}
function period(value:string):boolean {return /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value);}
function money(value:number):boolean {return Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000_000;}
function sum(a:number|null,b:number|null):number|null {
  if(a===null||b===null)return null;
  const result=a+b;
  if(!Number.isFinite(result)||Math.abs(result)>Number.MAX_SAFE_INTEGER)throw Error('将来予測額が数値の上限を超えました。');
  return result;
}
function stepMonth(month:string):string {
  const year=Number(month.slice(0,4)),mm=Number(month.slice(5));
  return `${year+(mm===12?1:0)}-${String(mm===12?1:mm+1).padStart(2,'0')}`;
}
/** Monthly NISA card purchases are evidence of past contributions only.
 * When no recurring transfer to NISA exists, the latest recent month can be
 * offered as an editable assumption for future card contributions. */
export function suggestedNisaMonthly(doc:AssetsDocument,records:readonly CloudRecord[],today:string,
  nisaMatches?:readonly ReturnType<typeof matchingNisaRows>[number][]):{amount:number;source:string} {
  const matches=(nisaMatches??matchingNisaRows(doc,records)).filter(row=>row.date<=today);
  const perMonth=new Map<string,number>();
  for(const row of matches)perMonth.set(row.date.slice(0,7),(perMonth.get(row.date.slice(0,7))??0)+row.amount);
  const last=[...perMonth].sort((a,b)=>b[0].localeCompare(a[0]))[0];
  if(!last)return {amount:0,source:'NISA積立の実績がなく、将来積立額は未設定です'};
  const nowIdx=Number(today.slice(0,4))*12+Number(today.slice(5,7));
  const lastIdx=Number(last[0].slice(0,4))*12+Number(last[0].slice(5,7));
  if(nowIdx-lastIdx>6)return {amount:0,source:'最新のNISAカード積立実績が6か月より前のため自動推定しません'};
  return {amount:last[1],source:`${last[0]}のNISAカード積立実績を仮置き（編集可能）`};
}
export function futureProjection(doc:AssetsDocument,records:readonly CloudRecord[],options:FutureOptions,
  nisaMatches?:readonly ReturnType<typeof matchingNisaRows>[number][]):FutureResult {
  const {today,targetMonth,changeMonth,savingsRuleId,savingsAmount,nisaMonthly,nisaAnnualReturn,
    cashScenarioMonthly=null,nisaScenarioMonthly=null}=options;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(today)||!period(today.slice(0,7))||!period(targetMonth)||!period(changeMonth)||
     targetMonth<today.slice(0,7)||!money(savingsAmount)||!money(nisaMonthly)||
     (cashScenarioMonthly!==null&&!money(cashScenarioMonthly))||
     (nisaScenarioMonthly!==null&&!money(nisaScenarioMonthly))||
     !Number.isFinite(nisaAnnualReturn)||nisaAnnualReturn<0||nisaAnnualReturn>0.3)
    throw Error('将来予測の年月・積立額・利回り設定が不正です。');
  const months=(Number(targetMonth.slice(0,4))-Number(today.slice(0,4)))*12+Number(targetMonth.slice(5))-Number(today.slice(5,7));
  if(months>600)throw Error('将来予測は50年以内にしてください。');
  const savingRules=doc.recurring.filter(e=>e.enabled && e.toAccountId==='cash-savings' && e.fromAccountId!=='cash-savings' && (e.kind==='income'||e.kind==='transfer'));
  if(savingsRuleId!==null&&!savingRules.some(e=>e.id===savingsRuleId))throw Error('試算対象の貯金ルールが見つかりません。');
  const hasNisaSchedule=doc.recurring.some(e=>e.enabled&&e.toAccountId==='nisa'&&(e.kind==='income'||e.kind==='transfer'));
  if(hasNisaSchedule&&nisaMonthly!==0)throw Error('NISAの定期入金が登録されています。カード積立の仮入力を重ねられません。');
  const matches=nisaMatches??matchingNisaRows(doc,records);
  const conflictingNisaSources=hasNisaSchedule&&matches.some(row=>row.date<=today);
  const starting=forecastAssets(doc,today,records,[],null,matches);
  // forecastAssets returns null when a confirmed balance snapshot is unavailable.
  // If no snapshot is present, never manufacture a 0-yen starting balance.
  const cashStart=starting['cash-savings'].balance;
  const nisaStart=starting.nisa.balance;
  let cash=cashStart,cashScenario=cashStart,nisa=nisaStart,nisaScenario=nisaStart;
  const growth=(1+nisaAnnualReturn)**(1/12);
  const points:FuturePoint[]=[];
  const addPoint=(month:string)=>points.push({month,cash,cashScenario,nisa,nisaScenario,
    combined:sum(cash,nisa),combinedScenario:sum(cashScenario,nisaScenario)});
  // Do not apply a hypothetical monthly replacement to a partially elapsed month.
  // Any remaining events in the current month retain their original amounts.
  const currentPeriod=today.slice(0,7);
  let current=currentPeriod;
  const recurring=recurringForCalculation(doc);
  for(let i=0;i<=months;i++){
    const replacingCash=cashScenarioMonthly!==null&&current>=changeMonth&&current>currentPeriod;
    const replacingNisa=nisaScenarioMonthly!==null&&current>=changeMonth&&current>currentPeriod;
    const events=recurringInMonth(current,recurring);
    for(const event of events){
      if(event.date<=today)continue;
      const e=event.entry;
      if(recurringCoveredByOneTime(e,event.date,doc.oneTime,undefined,recurring))continue;
      const cashDelta=(e.toAccountId==='cash-savings'?e.amount:0)-(e.fromAccountId==='cash-savings'?e.amount:0);
      // Legacy single-rule scenario remains supported for prior saved/test integrations.
      const legacyChanged=cashScenarioMonthly===null&&e.id===savingsRuleId&&current>=changeMonth;
      const scenarioCashDelta=replacingCash&&cashDelta>0?0:legacyChanged?
        (e.toAccountId==='cash-savings'?savingsAmount:0)-(e.fromAccountId==='cash-savings'?savingsAmount:0):cashDelta;
      const nisaDelta=(e.toAccountId==='nisa'?e.amount:0)-(e.fromAccountId==='nisa'?e.amount:0);
      const scenarioNisaDelta=replacingNisa&&nisaDelta>0?0:nisaDelta;
      if(cash!==null)cash=sum(cash,cashDelta);
      if(cashScenario!==null)cashScenario=sum(cashScenario,scenarioCashDelta);
      if(nisa!==null)nisa=sum(nisa,nisaDelta);
      if(nisaScenario!==null)nisaScenario=sum(nisaScenario,scenarioNisaDelta);
    }
    // One-off future transfers contribute once. They are not recurring principal,
    // so a hypothetical change to monthly saving never alters these records.
    for(const entry of doc.oneTime??[]){
      if(entry.date<=today||entry.date.slice(0,7)!==current)continue;
      const cashDelta=(entry.toAccountId==='cash-savings'?entry.amount:0)-(entry.fromAccountId==='cash-savings'?entry.amount:0);
      const nisaDelta=(entry.toAccountId==='nisa'?entry.amount:0)-(entry.fromAccountId==='nisa'?entry.amount:0);
      if(cash!==null)cash=sum(cash,cashDelta);
      if(cashScenario!==null)cashScenario=sum(cashScenario,cashDelta);
      if(nisa!==null)nisa=sum(nisa,nisaDelta);
      if(nisaScenario!==null)nisaScenario=sum(nisaScenario,nisaDelta);
    }
    // Apply replacement monthly principal once, regardless of the number or
    // frequency of underlying recurring instructions. No bank transfers occur.
    if(replacingCash&&cashScenario!==null)cashScenario=sum(cashScenario,cashScenarioMonthly);
    if(current>currentPeriod){
      if(nisa!==null)nisa=Math.round((nisa+(hasNisaSchedule?0:nisaMonthly))*growth);
      if(nisaScenario!==null)nisaScenario=Math.round((nisaScenario+(replacingNisa?nisaScenarioMonthly:(hasNisaSchedule?0:nisaMonthly)))*growth);
      if((nisa!==null&&!Number.isSafeInteger(nisa))||(nisaScenario!==null&&!Number.isSafeInteger(nisaScenario)))
        throw Error('NISAの将来予測額が大きすぎます。');
    }
    addPoint(current);
    current=stepMonth(current);
  }
  return {points,cashStart,nisaStart,savingRules,hasNisaSchedule,conflictingNisaSources,target:points[points.length-1]!};
}
/** Age is a calendar-month approximation: the 40th birthday month is birth year+40. */
export function targetMonthForAge(birthMonth:string,age:number):string|null {
  if(!period(birthMonth)||!Number.isInteger(age)||age<1||age>110)return null;
  const y=Number(birthMonth.slice(0,4))+age;
  if(y>2199)return null;
  return `${y}-${birthMonth.slice(5)}`;
}

/** Select only birthday months that the projection engine can actually calculate. */
export function projectionAgeBounds(birthMonth:string,todayMonth:string):{min:number;max:number}|null {
  if(!period(birthMonth)||!period(todayMonth))return null;
  const birth=Number(birthMonth.slice(0,4))*12+Number(birthMonth.slice(5,7))-1;
  const today=Number(todayMonth.slice(0,4))*12+Number(todayMonth.slice(5,7))-1;
  const min=Math.max(18,Math.ceil((today-birth)/12));
  const max=Math.min(80,Math.floor((today+600-birth)/12));
  return min<=max?{min,max}:null;
}
