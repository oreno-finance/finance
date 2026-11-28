import { statementMonthKey, planStatementImport, statementSignature } from './import-policy.js';
import type { CloudRecord } from '../cloud/merge.js';
import { CARDS, isZeroUsage, type ParsedStatement } from '../models/types.js';

function realDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function importErrors(statement: ParsedStatement, hasPdf: boolean): string[] {
  const issues: string[] = [];
  if (!CARDS.some(c => c.id === statement.cardId && c.provider === statement.provider)) issues.push('カード種別が不明です');
  if (!statement.billingMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(statement.billingMonth)) issues.push('請求月が不正です');
  const zero=isZeroUsage(statement);
  if(statement.zeroUsage!==undefined&&!zero)issues.push('利用なし明細の形式が不正です');
  if (!zero&&(!statement.paymentDate || !realDate(statement.paymentDate))) issues.push('支払日が不明または不正です');
  if (statement.statedTotal === null || !Number.isSafeInteger(statement.statedTotal)) issues.push('請求総額が不正です');
  if (!zero&&!statement.rows.length) issues.push('取引がありません');
  if (statement.rows.some(row => !realDate(row.usedOn) || !row.merchant.trim() || !Number.isSafeInteger(row.amount))) issues.push('利用日・利用先・金額に不備があります');
  if (statement.rows.some(row=>typeof row.id!=='string'||!row.id)||new Set(statement.rows.map(row=>row.id)).size!==statement.rows.length) issues.push('取引行IDが重複または不正です');
  if (statement.rows.every(row=>Number.isSafeInteger(row.amount)) && (statement.statedTotal === null || !Number.isSafeInteger(statement.statedTotal) || statement.rows.reduce((sum,row)=>sum+BigInt(row.amount),0n)!==BigInt(statement.statedTotal))) issues.push('請求総額と明細合計が一致しません');
  if (statement.sourceKind === 'pdf' && !hasPdf) issues.push('PDF原本がありません');
  return issues;
}

/** Ambiguous PDF/paste card identity is a normal user choice, not an error.
 * CSV imports have issuer metadata and must never silently become a pending choice. */
export function cardSelectionPending(statement: ParsedStatement): boolean {
  return statement.cardId === null && (
    statement.provider === 'rakuten' ||
    (statement.provider === 'smbc' && statement.sourceKind !== 'csv')
  );
}

/** Only genuine validation problems belong in red error messaging.
 * Full importErrors stays strict so an unselected card can NEVER be saved. */
export function importDisplayErrors(statement: ParsedStatement, hasPdf: boolean): string[] {
  const errors = importErrors(statement, hasPdf);
  return cardSelectionPending(statement)
    ? errors.filter(error => error !== 'カード種別が不明です')
    : errors;
}

export function duplicateMonths(statements: ParsedStatement[]): Set<number> {
  const seen = new Map<string, number>();
  const conflicts = new Set<number>();
  for (const [index, statement] of statements.entries()) {
    const key = statementMonthKey(statement);
    if (!key) continue;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, index);
    else { conflicts.add(first); conflicts.add(index); }
  }
  return conflicts;
}

/** Only discard redundant drafts. Keep one usable original per card/month;
 * never choose a winner among mixed versions, unknown states or edited drafts. */
export function redundantImportDrafts(
  statements: readonly ParsedStatement[],
  isDraft: (s: ParsedStatement) => boolean,
  isEligible: (s: ParsedStatement) => boolean,
): ParsedStatement[] {
  const groups = new Map<string, ParsedStatement[]>();
  for (const s of statements) {
    const key = statementMonthKey(s);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(s); groups.set(key, group);
  }
  const redundant: ParsedStatement[] = [];
  for (const group of groups.values()) {
    if (group.length < 2 || group.some(s => s.confirmation === 'unknown' || !isEligible(s))) continue;
    const saved = group.filter(s => !isDraft(s));
    if (saved.length > 1) continue;
    // The queue is newest-first: retain the earlier import when none is stored.
    const keep = saved[0] ?? group.at(-1)!;
    const signature = statementSignature(keep);
    const extras = group.filter(s => s !== keep);
    if (extras.every(s => isDraft(s) && s.sourceKind === keep.sourceKind &&
      planStatementImport([keep], s, () => signature).kind === 'duplicate')) redundant.push(...extras);
  }
  return redundant;
}

/** One read-only validation context per exact record snapshot. Both sides of any
 * duplicate are ineligible; no ordering is used to select a winner. */
export function statementConflicts(records:readonly CloudRecord[]) {
  const ids=new Map<string,number>(),months=new Map<string,number>();
  for(const record of records){
    if(!record?.statement)continue;
    ids.set(record.id,(ids.get(record.id)??0)+1);
    const key=statementMonthKey(record.statement);
    if(key)months.set(key,(months.get(key)??0)+1);
  }
  return {ids:new Set([...ids].filter(([,n])=>n>1).map(([id])=>id)),months:new Set([...months].filter(([,n])=>n>1).map(([id])=>id))};
}
export function recordIssues(record:CloudRecord,conflicts:ReturnType<typeof statementConflicts>):string[] {
  const s=record.statement, key=statementMonthKey(s);
  return [
    ...(conflicts.ids.has(record.id)?['保存済み明細IDが重複しています']:[]),
    ...('storageYear' in record?['年度間明細の保存位置に競合があります']:[]),
    ...(key&&conflicts.months.has(key)?['同じカード・請求月の明細が複数あります']:[]),
    ...(record.originalMonth!=null&&!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(record.originalMonth)?['PDF原本保存月が不正です']:[]),
    ...importErrors(s,s.sourceKind!=='pdf'||!!record.originalId),
  ];
}
export function confirmedRecords(records:readonly CloudRecord[]):CloudRecord[] {
  const conflicts=statementConflicts(records);
  return records.filter(record=>record.statement.confirmation==='confirmed'&&!recordIssues(record,conflicts).length);
}
