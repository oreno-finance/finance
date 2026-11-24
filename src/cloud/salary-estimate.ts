import {payrollRole,type PayrollIncomeEntry} from './payroll-income.js';
/** The producer's verified taxable amount can represent basic salary + fixed overtime.
 * Using last month's deductions and excluding non-taxable benefits is an estimate,
 * not a verified future deposit. Never fall back to unqualified total net pay. */
export function estimateRegularNet(previous:PayrollIncomeEntry):number|null {
  if(payrollRole(previous)!=='main'||previous.kind!=='salary'||
    !Number.isSafeInteger(previous.netPay)||previous.netPay<0||
    (previous.grossPay!==null&&(!Number.isSafeInteger(previous.grossPay)||previous.grossPay<0))||
    (previous.taxablePay!==null&&(!Number.isSafeInteger(previous.taxablePay)||previous.taxablePay<0)))return null;
  if(previous.grossPay===null||previous.taxablePay===null)return previous.netPay;
  if(previous.taxablePay>previous.grossPay)return null;
  const nonTaxable=previous.grossPay-previous.taxablePay;
  if(nonTaxable>previous.netPay)return null;
  return previous.netPay-nonTaxable;
}
/** A missing month may use one unambiguous recent regular salary. */
export function regularSalarySample(entries:readonly PayrollIncomeEntry[],period:string,through?:string):PayrollIncomeEntry|null {
  const index=(v:string)=>Number(v.slice(0,4))*12+Number(v.slice(5,7));
  const recent=entries.filter(e=>payrollRole(e)==='main'&&e.kind==='salary'&&/^\d{4}-\d{2}-\d{2}$/.test(e.paidOn)&&Number.isFinite(Date.parse(e.paidOn+'T00:00:00Z'))&&new Date(e.paidOn+'T00:00:00Z').toISOString().slice(0,10)===e.paidOn&&e.paidOn.slice(0,7)<period&&index(period)-index(e.paidOn)<=2&&(!through||e.paidOn<=through)).sort((a,b)=>b.paidOn.localeCompare(a.paidOn));
  const latest=recent[0];
  return latest&&recent.filter(e=>e.paidOn.slice(0,7)===latest.paidOn.slice(0,7)).length===1&&estimateRegularNet(latest)!==null?latest:null;
}
