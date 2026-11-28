import type {MonthlyReport} from '../summary/monthly-summary.js';
import {homeIncomeBreakdown} from '../home/income-breakdown.js';
import {DATA_STATUS,formatYen} from './formatters.js';

/** Shared display of the reconciled monthly income; no extra aggregation or reads. */
export function incomeMetricBreakdown(report:MonthlyReport):HTMLElement {
  const parts=document.createElement('div');parts.className='income-metric-parts';
  const breakdown=homeIncomeBreakdown(report);
  for(const [label,amount] of [['本業',breakdown.main],['副業',breakdown.side],['その他・区分不明',breakdown.other]] as const){
    if(label==='その他・区分不明'&&(!amount||!report.payrollReady))continue;
    const row=document.createElement('div');row.className='income-metric-part';
    const name=document.createElement('span');name.className='income-metric-label';name.textContent=label;
    const value=document.createElement('span');value.className='income-metric-amount';value.textContent=formatYen(amount,0,DATA_STATUS.missing);
    row.append(name,value);parts.append(row);
  }
  return parts;
}
