import { CARDS, calculatedTotal, isZeroUsage } from '../models/types.js';
function realDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
export function importErrors(statement, hasPdf) {
    const issues = [];
    if (!CARDS.some(c => c.id === statement.cardId && c.provider === statement.provider))
        issues.push('カード種別が不明です');
    if (!statement.billingMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(statement.billingMonth))
        issues.push('請求月が不正です');
    const zero = isZeroUsage(statement);
    if (statement.zeroUsage !== undefined && !zero)
        issues.push('利用なし明細の形式が不正です');
    if (!zero && (!statement.paymentDate || !realDate(statement.paymentDate)))
        issues.push('支払日が不明または不正です');
    if (statement.statedTotal === null || !Number.isSafeInteger(statement.statedTotal))
        issues.push('請求総額が不正です');
    if (!zero && !statement.rows.length)
        issues.push('取引がありません');
    if (statement.rows.some(row => !realDate(row.usedOn) || !row.merchant.trim() || !Number.isSafeInteger(row.amount)))
        issues.push('利用日・利用先・金額に不備があります');
    if (statement.statedTotal !== null && calculatedTotal(statement) !== statement.statedTotal)
        issues.push('請求総額と明細合計が一致しません');
    if (statement.sourceKind === 'pdf' && !hasPdf)
        issues.push('PDF原本がありません');
    return issues;
}
/** Ambiguous PDF/paste card identity is a normal user choice, not an error.
 * CSV imports have issuer metadata and must never silently become a pending choice. */
export function cardSelectionPending(statement) {
    return statement.cardId === null && (statement.provider === 'rakuten' ||
        (statement.provider === 'smbc' && statement.sourceKind !== 'csv'));
}
/** Only genuine validation problems belong in red error messaging.
 * Full importErrors stays strict so an unselected card can NEVER be saved. */
export function importDisplayErrors(statement, hasPdf) {
    const errors = importErrors(statement, hasPdf);
    return cardSelectionPending(statement)
        ? errors.filter(error => error !== 'カード種別が不明です')
        : errors;
}
export function duplicateMonths(statements) {
    const seen = new Map();
    const conflicts = new Set();
    for (const [index, statement] of statements.entries()) {
        if (!statement.cardId || !statement.billingMonth)
            continue;
        const key = `${statement.cardId}|${statement.billingMonth}`;
        const first = seen.get(key);
        if (first === undefined)
            seen.set(key, index);
        else {
            conflicts.add(first);
            conflicts.add(index);
        }
    }
    return conflicts;
}
