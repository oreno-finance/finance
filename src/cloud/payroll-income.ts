/** Read-only, minimal bridge contract for Payroll -> Finance.
 * The producer belongs in Payroll. Finance must never need payroll PDFs,
 * line items or Payroll's internal storage schema to calculate income.
 * No raw income documents or decryption keys are persisted by this module.
 */
export const PAYROLL_INCOME_FORMAT = 'payroll-income-v1' as const;
export type PayrollJob = 'main' | 'side';
/** Stable employer identity is not a work role. Legacy entries have no job. */
export function payrollRole(item: Pick<PayrollIncomeEntry,'job'|'employerId'>):PayrollJob|null {
  return item.job??(item.employerId==='main'?'main':item.employerId==='side'?'side':null);
}
export function payrollRoleLabel(role:PayrollJob|null):string {
  return role==='main'?'本業':role==='side'?'副業':'勤務区分不明';
}
/** Existing salary-name convention: explicit side-job schedules stay separate. */
export function recurringSalaryRole(entry:{kind:string;name:string}):PayrollJob|null {
  if(entry.kind!=='income'||!/給与|給料|salary|payroll/i.test(entry.name))return null;
  return /副業|兼業|side[ -]?job/i.test(entry.name)?'side':'main';
}
/** Actual regular pay replaces a same-role, same-payment-month manual schedule
 * on the explicitly assigned account. A bonus or side job never hides main pay. */
export function payrollCoversRecurringSalary(entry:{kind:string;name:string;toAccountId:string|null},day:string,
  entries:readonly PayrollIncomeEntry[],depositAccount:string|null|undefined|((paidOn:string)=>string|null|undefined)):boolean {
  const role=recurringSalaryRole(entry);
  return !!role&&entries.some(item=>{
    const account=typeof depositAccount==='function'?depositAccount(item.paidOn):depositAccount;
    return !!account&&entry.toAccountId===account&&payrollRole(item)===role&&item.kind==='salary'&&item.paidOn.slice(0,7)===day.slice(0,7);
  });
}
/** A manual one-off explicitly named regular salary is a candidate, not proof
 * of another payment. Do not confuse bonus/adjustment entries with regular pay. */
export function manualSalaryRole(entry:{kind:string;name:string}):PayrollJob|null {
  return /賞与|ボーナス|調整|bonus|adjustment/i.test(entry.name)?null:recurringSalaryRole(entry);
}
type ManualSalaryEntry={id:string;kind:string;name:string;date:string;status:'planned'|'done';toAccountId:string|null};
export function manualMainSalaryInMonth(entries:readonly ManualSalaryEntry[]|undefined,day:string,account:string|null):boolean {
  return !!account&&!!entries?.some(e=>manualSalaryRole(e)==='main'&&e.toAccountId===account&&e.date.slice(0,7)===day.slice(0,7));
}
/** Only a unique unexecuted plan is superseded by a published regular salary.
 * Preserve executed and ambiguous entries and expose their quality to callers. */
export function reconcileManualSalary(entries:readonly ManualSalaryEntry[]|undefined,payroll:readonly PayrollIncomeEntry[],accountOnDay:(day:string)=>string|null|undefined){
  const key=(role:PayrollJob,day:string,account:string)=>JSON.stringify([role,day.slice(0,7),account]);
  const actual=new Map<string,number>();
  const plans=new Map<string,ManualSalaryEntry[]>();
  for(const item of payroll){const role=payrollRole(item),account=accountOnDay(item.paidOn);if(!role||!account||item.kind!=='salary')continue;
    const k=key(role,item.paidOn,account);actual.set(k,(actual.get(k)??0)+1);}
  for(const e of entries??[]){const role=manualSalaryRole(e);if(!role||!e.toAccountId)continue;
    const k=key(role,e.date,e.toAccountId);if(!actual.has(k))continue;const list=plans.get(k)??[];list.push(e);plans.set(k,list);}
  const excluded=new Set<string>(),ambiguous:ManualSalaryEntry[]=[];
  for(const [k,list] of plans){if(actual.get(k)===1&&list.length===1&&list[0]!.status==='planned')excluded.add(list[0]!.id);else ambiguous.push(...list);}
  return {excludes:(id:string)=>excluded.has(id),ambiguous};
}
export type IncomeKind = 'salary' | 'bonus' | 'adjustment';
export interface PayrollIncomeEntry {
  id: string;
  employerId: string;
  /** Optional stable work role: employerId is no longer synonymous with main/side. */
  job?: PayrollJob;
  payPeriod: string; // YYYY-MM of work, may differ from paidOn month
  paidOn: string; // YYYY-MM-DD of actual bank deposit
  grossPay: number | null; // null when Payroll only published its net amount
  netPay: number; // JPY integer (actual transfer amount)
  taxablePay: number | null;
  currency: 'JPY';
  kind: IncomeKind;
  revision: number;
}
export interface PayrollIncomeDocument {
  format: typeof PAYROLL_INCOME_FORMAT;
  year: number; // calendar year of paidOn, not payPeriod
  updatedAt: string;
  entries: PayrollIncomeEntry[];
  deletedIds: string[];
}
export interface IncomeSummary {grossPay:number;netPay:number;count:number}
const idPattern = /^[a-zA-Z0-9_-]{3,100}$/;
function isObject(v:unknown):v is Record<string,unknown> {return !!v&&typeof v==='object'&&!Array.isArray(v);}
function validDate(value:unknown):value is string {
  if(typeof value!=='string'||!/^(19|20|21)\d{2}-\d\d-\d\d$/.test(value))return false;
  const d=new Date(value+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value;
}
function money(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
function safeAdd(a:number,b:number):number {
  const n=a+b;if(!Number.isSafeInteger(n))throw new Error('給与集計額が数値の上限を超えています。');return n;
}
export function validatePayrollIncome(raw:unknown):PayrollIncomeDocument {
  if(!isObject(raw)||raw.format!==PAYROLL_INCOME_FORMAT||!Number.isInteger(raw.year)||
    (raw.year as number)<1900||(raw.year as number)>2199||typeof raw.updatedAt!=='string'||
    !Number.isFinite(Date.parse(raw.updatedAt))||!Array.isArray(raw.entries)||raw.entries.length>5000||
    (raw.deletedIds!==undefined&&(!Array.isArray(raw.deletedIds)||raw.deletedIds.length>10000)))
    throw new Error('Payrollの収入公開データ形式が不正です。');
  const tombstones=new Set<string>();
  for(const id of raw.deletedIds??[]){
    if(typeof id!=='string'||!idPattern.test(id))throw new Error('Payrollの削除履歴が不正です。');
    tombstones.add(id);
  }
  const seen=new Set<string>();const entries:PayrollIncomeEntry[]=[];
  for(const item of raw.entries){
    if(!isObject(item)||typeof item.id!=='string'||!idPattern.test(item.id)||
      typeof item.employerId!=='string'||!idPattern.test(item.employerId)||
      (item.job!==undefined&&item.job!=='main'&&item.job!=='side')||
      typeof item.payPeriod!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(item.payPeriod)||
      !validDate(item.paidOn)||(item.grossPay!==null&&!money(item.grossPay))||!money(item.netPay)||item.currency!=='JPY'||
      (item.taxablePay!==null&&item.taxablePay!==undefined&&!money(item.taxablePay))||
      (item.kind!==undefined&&!['salary','bonus','adjustment'].includes(String(item.kind)))||
      !Number.isSafeInteger(item.revision)||(item.revision as number)<1||
      item.paidOn.slice(0,4)!==String(raw.year)||seen.has(item.id))
      throw new Error('Payrollの収入明細に不正または重複した値があります。');
    seen.add(item.id);
    if(tombstones.has(item.id))continue;
    entries.push({id:item.id,employerId:item.employerId,...(item.job?{job:item.job as 'main'|'side'}:{}),payPeriod:item.payPeriod,paidOn:item.paidOn,
      grossPay:item.grossPay,netPay:item.netPay,taxablePay:item.taxablePay??null,currency:'JPY',
      kind:(item.kind??'salary') as IncomeKind,revision:item.revision as number});
  }
  return {format:PAYROLL_INCOME_FORMAT,year:raw.year as number,updatedAt:raw.updatedAt,
    entries,deletedIds:[...tombstones]};
}
/** Fail rather than double-count the same payroll ID from different yearly files. */
export function combinePayrollIncome(documents:PayrollIncomeDocument[]):PayrollIncomeEntry[] {
  const byId=new Map<string,PayrollIncomeEntry>();
  for(const doc of documents){
    for(const item of validatePayrollIncome(doc).entries){
      if(byId.has(item.id))throw new Error('Payrollの収入データIDが年度をまたいで重複しています。');
      byId.set(item.id,item);
    }
  }
  return [...byId.values()].sort((a,b)=>a.paidOn.localeCompare(b.paidOn)||a.id.localeCompare(b.id));
}
export function incomeByMonth(entries:PayrollIncomeEntry[]):Map<string,IncomeSummary> {
  const summary=new Map<string,IncomeSummary>();
  for(const item of entries){
    if(!validDate(item.paidOn)||(item.grossPay!==null&&!money(item.grossPay))||!money(item.netPay))throw new Error('給与集計対象が不正です。');
    const month=item.paidOn.slice(0,7),old=summary.get(month)??{grossPay:0,netPay:0,count:0};
    summary.set(month,{grossPay:safeAdd(old.grossPay,item.grossPay??0),netPay:safeAdd(old.netPay,item.netPay),count:old.count+1});
  }
  return summary;
}
export function incomeByYear(entries:PayrollIncomeEntry[]):Map<string,IncomeSummary> {
  const summary=new Map<string,IncomeSummary>();
  for(const item of entries){
    if(!validDate(item.paidOn)||(item.grossPay!==null&&!money(item.grossPay))||!money(item.netPay))throw new Error('給与集計対象が不正です。');
    const year=item.paidOn.slice(0,4),old=summary.get(year)??{grossPay:0,netPay:0,count:0};
    summary.set(year,{grossPay:safeAdd(old.grossPay,item.grossPay??0),netPay:safeAdd(old.netPay,item.netPay),count:old.count+1});
  }
  return summary;
}
/** For bank projections use paidOn/netPay. Never infer a bank account from employer or salary type. */
export function depositedIncomeBetween(entries:PayrollIncomeEntry[],startExclusive:string,endInclusive:string):number {
  if(!validDate(startExclusive)||!validDate(endInclusive))throw new Error('収入の集計期間が不正です。');
  let sum=0;const seen=new Set<string>();
  for(const item of entries){
    if(seen.has(item.id))throw new Error('給与IDが重複しています。');
    seen.add(item.id);
    if(!validDate(item.paidOn)||!money(item.netPay))throw new Error('給与支給日または手取り額が不正です。');
    if(item.paidOn>startExclusive&&item.paidOn<=endInclusive)sum=safeAdd(sum,item.netPay);
  }
  return sum;
}
