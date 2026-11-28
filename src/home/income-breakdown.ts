import type {MonthlyReport} from '../summary/monthly-summary.js';
import {manualSalaryRole,recurringSalaryRole} from '../cloud/payroll-income.js';

/** Display only: reuse the already reconciled monthly lines, never recalculate the total. */
export function homeIncomeBreakdown(report:MonthlyReport):{main:number|null;side:number|null;other:number|null}{
  if(!report.payrollReady)return {main:null,side:null,other:null};
  const sums={main:0,side:0,other:0};
  for(const line of [...report.incomeLines,...report.incomeEstimates])sums[line.job??'other']+=line.amount;
  for(const line of report.recurringLines)if(line.kind==='income')sums[recurringSalaryRole(line)??'other']+=line.amount;
  for(const line of report.oneTimeLines)if(line.kind==='income'&&line.status==='done')sums[manualSalaryRole(line)??'other']+=line.amount;
  return {...sums,main:report.incomeMissingRegular||(report.income===null&&!sums.main)?null:sums.main};
}
