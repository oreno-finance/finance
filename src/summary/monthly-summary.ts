/** Finance monthly report. All periods are assigned from the statement's paymentDate,
 * never from a statement's billingMonth or a transaction's usedOn.
 * This module is pure and has no persistence or bank-balance side effects. */
import { getCard, type ImportRow, type ParsedStatement } from '../models/types.js';
import type { CloudRecord } from '../cloud/merge.js';
import { importErrors } from '../importers/batch-policy.js';
import { displayMerchant, matchingRule, type CategoryDefinition, type MerchantRule } from '../cloud/merchant-rules.js';
import { recurringCoveredByOneTime, nisaRuleOnDay, type AssetAccountId, type AssetsDocument, type OneTimeEntry } from '../cloud/assets.js';
import { recurringInMonth } from '../cloud/recurring-schedule.js';
import { fixedCostOccurrences } from '../fixed-costs/contracts.js';
import type { PayrollIncomeEntry } from '../cloud/payroll-income.js';

export interface SummaryIncome { id: string; employer: string; kind: string; date: string; amount: number }
export interface SummaryIncomeEstimate { employer: 'main'; kind: 'salary'; sourcePeriod: string; amount: number; method: 'previous-regular-net-excluding-nontaxable' | 'previous-regular-net-fallback' }
export interface SummaryCard { id: string; cardId: string; name: string; billingMonth: string | null; paymentDate: string; amount: number; confirmation: ParsedStatement['confirmation'] }
export interface SummaryCategory { id: string; name: string; color: string | null; amount: number; count: number }
export interface SummaryMerchant { name: string; amount: number; count: number }
export interface SummaryRecurring { id:string; entryId:string; name:string; date:string; kind:'expense'|'income'|'transfer'; amount:number; fromAccountId:AssetAccountId|null; toAccountId:AssetAccountId|null; categoryId:string|null; payrollOverlap:boolean; cardOverlap:boolean }
export interface SummaryIssue { id: string; title: string; reason: string; month: string | null }
export interface MonthlyReport {
  period: string;
  income: number | null;
  actualIncome: number | null;
  estimatedIncome: number | null;
  incomeEstimates: SummaryIncomeEstimate[];
  incomeMissingRegular: boolean;
  incomeLines: SummaryIncome[];
  cardOutflow: number | null;
  cardLines: SummaryCard[];
  livingOutflow: number | null;
  nisaOutflow: number;
  referenceBalance: number | null; // retained for existing test/consumer compatibility
  monthlyBalance: number | null;
  recurringIncome: number;
  oneTimeIncome:number;
  oneTimeExpense:number;
  oneTimeLines:OneTimeEntry[];
  recurringExpense: number;
  recurringTransfers: number;
  recurringLines: SummaryRecurring[];
  recurringSalaryExcluded: number;
  recurringCardOverlap: number;
  categories: SummaryCategory[];
  merchants: SummaryMerchant[];
  issues: SummaryIssue[];
  provisional: SummaryCard[];
  unclassifiedCount: number;
  excludedCount: number;
  unknownConfirmationCount: number;
  payrollReady: boolean;
  payrollSyncedAt: number | null;
}
export interface PayrollSnapshot { ready: boolean; syncedAt: number | null; entries: readonly PayrollIncomeEntry[] }
export interface MonthlySource { records: readonly CloudRecord[]; rules: readonly MerchantRule[]; categories: readonly CategoryDefinition[]; assets: Pick<AssetsDocument,'nisaCardRule'|'recurring'> & Partial<Pick<AssetsDocument,'nisaCardRuleHistory'>> & Partial<Pick<AssetsDocument,'snapshots'|'payrollDepositAccount'|'cardDebitAccounts'|'cardPreferences'|'cardRecurringDecisions'|'mizuhoTransferPlan'|'oneTime'|'fixedCosts'|'mizuhoFundingChecks'>>; payroll: PayrollSnapshot; /** Optional injected local month for deterministic tests. */ currentPeriod?:string }
const validPeriod = (value: string): boolean => /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value);
export function isValidPeriod(value:string): boolean {return validPeriod(value);}
function validDay(value: string | null | undefined): value is string {
  if (!value || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
function add(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new Error('月別集計の金額が安全な整数範囲を超えました。');
  return sum;
}
function normalized(value: string): string { return value.normalize('NFKC').toLocaleLowerCase(); }
function localPeriod():string {const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;}
/** The producer's verified taxable amount can represent basic salary + fixed overtime.
 * Using last month's deductions and excluding non-taxable benefits is an estimate,
 * not a verified future deposit. Never fall back to unqualified total net pay. */
export function estimateRegularNet(previous:PayrollIncomeEntry):number|null {
  if(previous.employerId!=='main'||previous.kind!=='salary'||
    !Number.isSafeInteger(previous.netPay)||previous.netPay<0||
    (previous.grossPay!==null&&(!Number.isSafeInteger(previous.grossPay)||previous.grossPay<0))||
    (previous.taxablePay!==null&&(!Number.isSafeInteger(previous.taxablePay)||previous.taxablePay<0)))return null;
  if(previous.grossPay===null||previous.taxablePay===null)return previous.netPay;
  if(previous.taxablePay>previous.grossPay)return null;
  const nonTaxable=previous.grossPay-previous.taxablePay;
  if(nonTaxable>previous.netPay)return null;
  return previous.netPay-nonTaxable;
}
export function isNisaCardRow(row: ImportRow, stmt: ParsedStatement, assets: MonthlySource['assets']):boolean {
  const config=validDay(row.usedOn)?nisaRuleOnDay(assets,row.usedOn):null;
  return !!config?.enabled && stmt.cardId===config.cardId &&
    normalized(row.merchant).includes(normalized(config.merchantContains)) &&
    validDay(row.usedOn);
}
function categoryFor(row: ImportRow, statement: ParsedStatement, rules: readonly MerchantRule[], categories: readonly CategoryDefinition[]):CategoryDefinition|null {
  const categoryId=matchingRule(row.merchant,statement.cardId,rules)?.categoryId;
  return categories.find(c=>c.id===categoryId)??null;
}
function cardTitle(record:CloudRecord,source:MonthlySource):string {
  const id=record.statement.cardId??'';
  return source.assets.cardPreferences?.[id]?.name??getCard(id)?.name??'カード不明';
}
/** Reusable within a single analysis/render operation. Never retain across edits. */
export interface PreparedMonthlyReports {
  readonly records:readonly CloudRecord[];
  readonly months:ReadonlyMap<string,readonly {position:number;record:CloudRecord}[]>;
  readonly undated:readonly {position:number;record:CloudRecord}[];
  readonly duplicates:ReadonlySet<string>;
}
/** Build global duplicate information once, preserving each original record position. */
export function prepareMonthlyReports(records:readonly CloudRecord[]):PreparedMonthlyReports {
  const months=new Map<string,{position:number;record:CloudRecord}[]>();
  const undated:{position:number;record:CloudRecord}[]=[];
  const counts=new Map<string,number>();
  for(let position=0;position<records.length;position++){
    const record=records[position];
    if(!record||!record.statement)continue;
    const statement=record.statement;
    const key=statement.cardId&&statement.billingMonth?`${statement.cardId}|${statement.billingMonth}`:null;
    if(key)counts.set(key,(counts.get(key)??0)+1);
    const period=validDay(statement.paymentDate)?statement.paymentDate.slice(0,7):null;
    const ref={position,record};
    if(period){const month=months.get(period)??[];month.push(ref);months.set(period,month);}
    else undated.push(ref);
  }
  const duplicates=new Set([...counts].filter(([,count])=>count>1).map(([key])=>key));
  return {records,months,undated,duplicates};
}
/** Unknown payment dates are listed globally since they cannot be attributed to a month. */
export function monthlyReport(period: string, source: MonthlySource, prepared?:PreparedMonthlyReports):MonthlyReport {
  if(!validPeriod(period))throw new Error('集計年月が不正です。');
  const issues:SummaryIssue[]=[];
  const cardLines:SummaryCard[]=[];
  const provisional:SummaryCard[]=[];
  const categoryTotals=new Map<string,SummaryCategory>();
  const merchantTotals=new Map<string,SummaryMerchant>();
  const cardRowsForOverlap:Array<{name:string;amount:number}>=[];
  const usedIds=new Set<string>();
  let excludedCount=0,unclassifiedCount=0,unknownConfirmationCount=0;
  let included=0, sum=0, nisa=0;
  // An index belongs to its exact statement-array snapshot. Never accept an index
  // from a different source, which could silently hide newly received records.
  if(prepared&&prepared.records!==source.records)throw new Error('月別集計の索引が現在の明細と一致しません。');
  const indexed=prepared
    ?[...(prepared.months.get(period)??[]),...prepared.undated]
      .sort((a,b)=>a.position-b.position).map(item=>item.record)
    :source.records.filter(record=>record && record.statement);
  const duplicateKeys=prepared?.duplicates??(()=>{
    const counts=new Map<string,number>();
    for(const record of source.records){
      if(!record?.statement)continue;
      const s=record.statement;
      const key=s.cardId&&s.billingMonth?`${s.cardId}|${s.billingMonth}`:null;
      if(key)counts.set(key,(counts.get(key)??0)+1);
    }
    return new Set([...counts].filter(([,count])=>count>1).map(([key])=>key));
  })();
  for(const record of indexed) {
    const s=record.statement;
    const month=validDay(s.paymentDate)?s.paymentDate.slice(0,7):null;
    // Undated records are visible as unresolved data quality issues in every month.
    if(month!==period && month!==null)continue;
    const identity=s.cardId && s.billingMonth?`${s.cardId}|${s.billingMonth}`:null;
    const reasons:string[]=[];
    if(usedIds.has(record.id))reasons.push('保存済み明細IDが重複しています');
    else usedIds.add(record.id);
    if(identity && duplicateKeys.has(identity))reasons.push('同じカード・請求月の明細が複数あります');
    const validation=importErrors(s,s.sourceKind!=='pdf'||!!record.originalId);
    reasons.push(...validation);
    // Set-based validation: a single linear walk, preserving duplicate-ID errors.
    if(s.rows.length!==new Set(s.rows.map(row=>row.id)).size)reasons.push('取引行IDが重複しています');
    if(month===null)reasons.push('支払日が不明または不正です');
    const reason=[...new Set(reasons)].join(' / ');
    if(reason){issues.push({id:record.id,title:cardTitle(record,source),reason,month});if(month===period)excludedCount++;continue;}
    if(month!==period)continue;
    const amt=s.rows.reduce((acc,row)=>add(acc,row.amount),0);
    const line:SummaryCard={id:record.id,cardId:s.cardId!,name:cardTitle(record,source),billingMonth:s.billingMonth,paymentDate:s.paymentDate!,amount:amt,confirmation:s.confirmation};
    if(s.confirmation==='provisional')provisional.push(line);
    included++;sum=add(sum,amt);cardLines.push(line);
    if(s.confirmation==='unknown')unknownConfirmationCount++;
    for(const row of s.rows){
      if(isNisaCardRow(row,s,source.assets)) {nisa=add(nisa,row.amount);continue;}
      const category=categoryFor(row,s,source.rules,source.categories);
      const id=category?.id??'__unclassified';
      const old=categoryTotals.get(id)??{id,name:category?.name??'未分類',color:category?.color??null,amount:0,count:0};
      old.amount=add(old.amount,row.amount);old.count++;
      categoryTotals.set(id,old);
      if(!category)unclassifiedCount++;
      const name=displayMerchant(row.merchant,s.cardId,source.rules,row.merchantOverride);
      cardRowsForOverlap.push({name:normalized(name).trim(),amount:row.amount});
      const merchant=merchantTotals.get(name)??{name,amount:0,count:0};
      merchant.amount=add(merchant.amount,row.amount);merchant.count++;
      merchantTotals.set(name,merchant);
    }
  }
  const incomeLines: SummaryIncome[]=[];
  if(source.payroll.ready){
    const seen=new Set<string>();
    for(const entry of source.payroll.entries){
      if(seen.has(entry.id))throw new Error('Payrollの給与IDが重複しています。');
      seen.add(entry.id);
      if(!validDay(entry.paidOn) || !Number.isSafeInteger(entry.netPay) || entry.netPay<0)
        throw new Error('Payrollの収入データに不正な日付または金額があります。');
      if(entry.paidOn.slice(0,7)===period)incomeLines.push({id:entry.id,employer:entry.employerId,kind:entry.kind,date:entry.paidOn,amount:entry.netPay});
    }
  }
  const actualIncome=source.payroll.ready&&incomeLines.length>0
    ?incomeLines.reduce((acc,line)=>add(acc,line.amount),0):null;
  const incomeEstimates:SummaryIncomeEstimate[]=[];
  const currentPeriod=source.currentPeriod??localPeriod();
  // Forecast only for the actual current month. The prior regular salary must be published.
  // Prefer prior payment month; allow one older payment month when salaries arrive late.
  if(source.payroll.ready && period===currentPeriod &&
    !incomeLines.some(line=>line.employer==='main'&&line.kind==='salary')) {
    const previous=changePeriod(period,-1),older=changePeriod(period,-2);
    const recent=source.payroll.entries.filter(entry=>entry.employerId==='main'&&entry.kind==='salary'&&
      validDay(entry.paidOn)&&[previous,older].includes(entry.paidOn.slice(0,7)))
      .sort((a,b)=>b.paidOn.localeCompare(a.paidOn));
    // If there are multiple regular salaries in a payment month, selecting one is unsafe.
    if(recent.length && recent.filter(entry=>entry.paidOn.slice(0,7)===recent[0]!.paidOn.slice(0,7)).length===1){
      const sample=recent[0]!;
      const estimated=estimateRegularNet(sample);
      if(estimated!==null)incomeEstimates.push({employer:'main',kind:'salary',sourcePeriod:sample.paidOn.slice(0,7),
        amount:estimated,method:sample.grossPay===null||sample.taxablePay===null?'previous-regular-net-fallback':'previous-regular-net-excluding-nontaxable'});
    }
  }
  const estimatedIncome=incomeEstimates.length?incomeEstimates.reduce((acc,e)=>add(acc,e.amount),0):null;
  const incomeMissingRegular=source.payroll.ready && period===currentPeriod &&
    !incomeLines.some(line=>line.employer==='main'&&line.kind==='salary') && estimatedIncome===null &&
    source.payroll.entries.some(entry=>entry.employerId==='main'&&entry.kind==='salary'&&validDay(entry.paidOn)&&entry.paidOn.slice(0,7)<period);
  const payrollIncome=incomeMissingRegular?null:actualIncome===null?estimatedIncome:estimatedIncome===null?actualIncome:add(actualIncome,estimatedIncome);

  // Recurrences are scheduled entries, *including future dates*. They are not verified bank debits.
  const recurringLines:SummaryRecurring[]=[];
  let recurringIncome=0,recurringExpense=0,recurringTransfers=0,recurringSalaryExcluded=0,recurringCardOverlap=0;
  const payrollName=/給与|給料|salary|payroll/i;
  for(const occurrence of recurringInMonth(period,source.assets.recurring??[])){
    const e=occurrence.entry;
    if(recurringCoveredByOneTime(e,occurrence.date,source.assets.oneTime))continue;
    const payrollOverlap=e.kind==='income'&&payrollName.test(e.name) && source.payroll.ready;
    if(payrollOverlap){recurringSalaryExcluded++;continue;}
    const line:SummaryRecurring={id:occurrence.id,entryId:e.id,name:e.name,date:occurrence.date,kind:e.kind,
      amount:e.amount,fromAccountId:e.fromAccountId,toAccountId:e.toAccountId,categoryId:e.categoryId,payrollOverlap:false,
      cardOverlap:e.kind==='expense'&&cardRowsForOverlap.some(row=>row.name===normalized(e.name).trim()&&row.amount===e.amount)};
    recurringLines.push(line);
    if(e.kind==='income')recurringIncome=add(recurringIncome,e.amount);
    if(e.kind==='expense'){
      recurringExpense=add(recurringExpense,e.amount);
      const category=source.categories.find(c=>c.id===e.categoryId);
      const id=category?.id??'__unclassified';
      const old=categoryTotals.get(id)??{id,name:category?.name??'未分類',color:category?.color??null,amount:0,count:0};
      old.amount=add(old.amount,e.amount);old.count++;
      categoryTotals.set(id,old);
      if(!category)unclassifiedCount++;
      // A possible duplicate is a review warning, not grounds to silently discard expenses.
      if(line.cardOverlap)recurringCardOverlap++;
    }
    if(e.kind==='transfer')recurringTransfers=add(recurringTransfers,e.amount);
  }
  // Cash standing commitments affect household planned expenses but never a bank balance.
  // Card contracts are already included in their issuer statements and never enter this loop.
  for(const occurrence of fixedCostOccurrences(period,(source.assets.fixedCosts??[]).filter(x=>x.payment==='cash'))){
    const {item,date,amount}=occurrence;
    if(source.assets.oneTime?.some(one=>one.kind==='expense'&&one.date===date&&one.name===item.name&&one.amount===amount))continue;
    const duplicate=cardRowsForOverlap.some(row=>row.name===normalized(item.name).trim()&&row.amount===amount);
    recurringLines.push({id:`cash:${item.id}:${date}`,entryId:`cash:${item.id}`,name:item.name,date,kind:'expense',amount,
      fromAccountId:null,toAccountId:null,categoryId:item.categoryId,payrollOverlap:false,cardOverlap:duplicate});
    recurringExpense=add(recurringExpense,amount);
    if(duplicate)recurringCardOverlap++;
    const category=source.categories.find(c=>c.id===item.categoryId);
    const key=category?.id??'__unclassified';
    const old=categoryTotals.get(key)??{id:key,name:category?.name??'未分類',color:category?.color??null,amount:0,count:0};
    old.amount=add(old.amount,amount);old.count++;categoryTotals.set(key,old);
    if(!category)unclassifiedCount++;
  }
  const oneTimeLines=[...(source.assets.oneTime??[])].filter(e=>e.date.slice(0,7)===period)
    .sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
  let oneTimeIncome=0,oneTimeExpense=0;
  for(const entry of oneTimeLines){
    if(entry.kind==='income')oneTimeIncome=add(oneTimeIncome,entry.amount);
    if(entry.kind==='expense')oneTimeExpense=add(oneTimeExpense,entry.amount);
  }
  const income=payrollIncome===null?null:add(add(payrollIncome,recurringIncome),oneTimeIncome);
  const cardOutflow=included>0?sum:null;
  const livingOutflow=cardOutflow===null?null:add(cardOutflow,-nisa);
  // No card statement is *observed* as 0 in cashflow; the UI warns when none is registered.
  // Internal transfers are never household revenue or expenses.
  const monthlyBalance=income===null||(excludedCount>0&&included===0)?null:add(add(add(income,-(cardOutflow??0)),-recurringExpense),-oneTimeExpense);
  const referenceBalance=monthlyBalance;
  return {period,income,actualIncome,estimatedIncome,incomeEstimates,incomeMissingRegular,incomeLines,cardOutflow,cardLines,livingOutflow,nisaOutflow:nisa,
    referenceBalance,monthlyBalance,recurringIncome,recurringExpense,recurringTransfers,recurringLines,oneTimeIncome,oneTimeExpense,oneTimeLines,recurringSalaryExcluded,recurringCardOverlap,categories:[...categoryTotals.values()].sort((a,b)=>b.amount-a.amount||a.name.localeCompare(b.name,'ja')),
    merchants:[...merchantTotals.values()].sort((a,b)=>b.amount-a.amount||a.name.localeCompare(b.name,'ja')),
    issues,provisional,unclassifiedCount,excludedCount,unknownConfirmationCount,
    payrollReady:source.payroll.ready,payrollSyncedAt:source.payroll.ready?source.payroll.syncedAt:null};
}
export function changePeriod(period:string,delta:number):string {
  if(!validPeriod(period)||!Number.isSafeInteger(delta))throw new Error('年月が不正です。');
  const year=Number(period.slice(0,4)),month=Number(period.slice(5));
  const value=year*12+month-1+delta;
  const nextYear=Math.floor(value/12),nextMonth=value%12+1;
  const next=`${nextYear}-${String(nextMonth).padStart(2,'0')}`;
  if(!validPeriod(next))throw new Error('表示できる年月の範囲外です。');
  return next;
}
