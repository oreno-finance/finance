/** Read-only drill-down for analysis. Source of truth is the same monthlyReport used by analytics.
 * The payment month (not billing/usage month) decides membership. No cloud mutation occurs. */
import { displayMerchant, matchingRule } from '../cloud/merchant-rules.js';
import { monthlyReport, prepareMonthlyReports, isNisaCardRow, isValidPeriod, type MonthlyReport, type MonthlySource, type SummaryRecurring } from '../summary/monthly-summary.js';
import type { AnalysisDimension } from '../analysis/period-analytics.js';
import {formatMonth} from './formatters.js';

export type DrilldownDimension = AnalysisDimension;
/** A single click/render snapshot. Never persist across vault updates. */
export interface AnalysisReportContext {source:MonthlySource;reports:ReadonlyMap<string,MonthlyReport>}
export interface AnalysisDrilldown {
  periods: readonly string[];
  dimension: DrilldownDimension;
  value: string;
  label: string;
}

export function validateAnalysisDrilldown(request: AnalysisDrilldown): void {
  if (!request || !['card','category','merchant'].includes(request.dimension) ||
    !Array.isArray(request.periods) || !request.periods.length || request.periods.length > 24 ||
    new Set(request.periods).size !== request.periods.length ||
    request.periods.some(p => typeof p !== 'string' || !isValidPeriod(p)) ||
    typeof request.value !== 'string' || !request.value.trim() || request.value.length > 200 ||
    typeof request.label !== 'string' || !request.label.trim() || request.label.length > 200) {
    throw new Error('明細の絞り込み条件が不正です。');
  }
}

/** Remote record ID => original row IDs. A record with no matching rows is absent.
 * Invalid/duplicate statements are excluded exactly as in monthlyReport. */
export function analysisDrilldownMatches(source: MonthlySource, request: AnalysisDrilldown,
  reports?:ReadonlyMap<string,MonthlyReport>): Map<string, Set<string>> {
  validateAnalysisDrilldown(request);
  const prepared=reports?null:prepareMonthlyReports(source.records);
  const result = new Map<string, Set<string>>();
  const recordsById = new Map(source.records.map(record => [record.id, record]));
  for (const period of request.periods) {
    const report = reports?.get(period)??monthlyReport(period,source,prepared??undefined);
    for (const card of report.cardLines) {
      if (request.dimension === 'card' && card.cardId !== request.value) continue;
      const record = recordsById.get(card.id);
      if (!record) continue;
      const statement = record.statement;
      for (const row of statement.rows) {
        const nisa=isNisaCardRow(row, statement, source.assets);
        if (request.dimension !== 'card' && nisa && request.value !== '__nisa') continue;
        if (request.dimension === 'category') {
          const resolved = nisa?'__nisa':matchingRule(row.merchant, statement.cardId, source.rules)?.categoryId;
          const categoryId = nisa?'__nisa':source.categories.some(c => c.id === resolved) ? resolved : '__unclassified';
          if (categoryId !== request.value) continue;
        } else if (request.dimension === 'merchant' &&
          displayMerchant(row.merchant, statement.cardId, source.rules, row.merchantOverride) !== request.value) {
          continue;
        }
        const matches = result.get(card.id) ?? new Set<string>();
        matches.add(row.id);
        result.set(card.id, matches);
      }
    }
  }
  return result;
}

export function drilldownPeriodLabel(periods: readonly string[]): string {
  if (periods.length === 1) return formatMonth(periods[0]);
  return `${formatMonth(periods[0])}〜${formatMonth(periods[periods.length - 1])}`;
}


export interface DrilldownRecurringOccurrence extends SummaryRecurring { period: string }
export interface DrilldownOneTime {id:string;name:string;date:string;amount:number;period:string}
export interface AnalysisDrilldownBreakdown {
  /** Card statement rows that belong to the same source-month calculation. */
  cardAmount: number;
  /** Scheduled bank expenses, not verified bank debits. */
  recurringAmount: number;
  /** Executed one-off expenses, never draft planned expenses. */
  oneTimeAmount: number;
  total: number;
  recurring: DrilldownRecurringOccurrence[];
  oneTime: DrilldownOneTime[];
  /** Historical comparison, grouped by calendar year of the payment month. */
  byYear:ReadonlyArray<{year:string;cardAmount:number;recurringAmount:number;oneTimeAmount:number;total:number}>;
}
/** The category aggregate includes scheduled bank recurrences; show them alongside card rows.
 * Merchant and card aggregates contain card rows only. No mutation and no heuristic matching. */
export function analysisDrilldownBreakdown(source: MonthlySource, request: AnalysisDrilldown,
  reports?:ReadonlyMap<string,MonthlyReport>): AnalysisDrilldownBreakdown {
  validateAnalysisDrilldown(request);
  // Direct callers also get one shared prepared index and one report per month.
  const byPeriod=reports??(()=>{
    const prepared=prepareMonthlyReports(source.records);
    return new Map(request.periods.map(period=>[period,monthlyReport(period,source,prepared)]));
  })();
  const matches=analysisDrilldownMatches(source,request,byPeriod);
  const safeAdd=(a:number,b:number):number=>{
    const n=a+b;
    if(!Number.isSafeInteger(n))throw new Error('分析金額が安全な整数範囲を超えました。');
    return n;
  };
  let cardAmount=0,recurringAmount=0,oneTimeAmount=0;
  const byYear=new Map<string,{year:string;cardAmount:number;recurringAmount:number;oneTimeAmount:number;total:number}>();
  const yearRow=(period:string)=>{
    const year=period.slice(0,4);
    let row=byYear.get(year);
    if(!row){row={year,cardAmount:0,recurringAmount:0,oneTimeAmount:0,total:0};byYear.set(year,row);}
    return row;
  };
  for(const period of request.periods)yearRow(period);
  const periodByRecord=new Map<string,string>();
  for(const [period,report] of byPeriod){for(const card of report.cardLines)periodByRecord.set(card.id,period);}
  for(const record of source.records){
    const rowIds=matches.get(record.id);
    if(!rowIds)continue;
    const period=periodByRecord.get(record.id);
    if(!period)continue;
    const year=yearRow(period);
    for(const row of record.statement.rows)if(rowIds.has(row.id)){
      cardAmount=safeAdd(cardAmount,row.amount);
      year.cardAmount=safeAdd(year.cardAmount,row.amount);
      year.total=safeAdd(year.total,row.amount);
    }
  }
  const recurring:DrilldownRecurringOccurrence[]=[],oneTime:DrilldownOneTime[]=[];
  if(request.dimension==='category'){
    for(const period of request.periods){
      const report=byPeriod.get(period)??monthlyReport(period,source);
      const year=yearRow(period);
      for(const line of report.recurringLines){
        if(line.kind!=='expense')continue;
        const category=source.categories.some(item=>item.id===line.categoryId)?line.categoryId:'__unclassified';
        if(category!==request.value)continue;
        recurringAmount=safeAdd(recurringAmount,line.amount);
        year.recurringAmount=safeAdd(year.recurringAmount,line.amount);
        year.total=safeAdd(year.total,line.amount);
        recurring.push({...line,period});
      }
      for(const entry of report.oneTimeLines){
        if(entry.kind!=='expense'||entry.status!=='done')continue;
        const category=source.categories.some(item=>item.id===entry.categoryId)?entry.categoryId:'__unclassified';
        if(category!==request.value)continue;
        oneTimeAmount=safeAdd(oneTimeAmount,entry.amount);
        year.oneTimeAmount=safeAdd(year.oneTimeAmount,entry.amount);
        year.total=safeAdd(year.total,entry.amount);
        oneTime.push({id:entry.id,name:entry.name,date:entry.date,amount:entry.amount,period});
      }
    }
  }
  recurring.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
  oneTime.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
  return {cardAmount,recurringAmount,oneTimeAmount,
    total:safeAdd(safeAdd(cardAmount,recurringAmount),oneTimeAmount),recurring,oneTime,
    byYear:[...byYear.values()].sort((a,b)=>a.year.localeCompare(b.year))};
}
