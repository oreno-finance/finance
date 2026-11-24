/** Read-only, minimal bridge contract for Payroll -> Finance.
 * The producer belongs in Payroll. Finance must never need payroll PDFs,
 * line items or Payroll's internal storage schema to calculate income.
 * No raw income documents or decryption keys are persisted by this module.
 */
export const PAYROLL_INCOME_FORMAT = 'payroll-income-v1';
const idPattern = /^[a-zA-Z0-9_-]{3,100}$/;
function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function validDate(value) {
    if (typeof value !== 'string' || !/^(19|20|21)\d{2}-\d\d-\d\d$/.test(value))
        return false;
    const d = new Date(value + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function money(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function safeAdd(a, b) {
    const n = a + b;
    if (!Number.isSafeInteger(n))
        throw new Error('給与集計額が数値の上限を超えています。');
    return n;
}
export function validatePayrollIncome(raw) {
    if (!isObject(raw) || raw.format !== PAYROLL_INCOME_FORMAT || !Number.isInteger(raw.year) ||
        raw.year < 1900 || raw.year > 2199 || typeof raw.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(raw.updatedAt)) || !Array.isArray(raw.entries) || raw.entries.length > 5000 ||
        (raw.deletedIds !== undefined && (!Array.isArray(raw.deletedIds) || raw.deletedIds.length > 10000)))
        throw new Error('Payrollの収入公開データ形式が不正です。');
    const tombstones = new Set();
    for (const id of raw.deletedIds ?? []) {
        if (typeof id !== 'string' || !idPattern.test(id))
            throw new Error('Payrollの削除履歴が不正です。');
        tombstones.add(id);
    }
    const seen = new Set();
    const entries = [];
    for (const item of raw.entries) {
        if (!isObject(item) || typeof item.id !== 'string' || !idPattern.test(item.id) ||
            typeof item.employerId !== 'string' || !idPattern.test(item.employerId) ||
            (item.job !== undefined && item.job !== 'main' && item.job !== 'side') ||
            typeof item.payPeriod !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(item.payPeriod) ||
            !validDate(item.paidOn) || (item.grossPay !== null && !money(item.grossPay)) || !money(item.netPay) || item.currency !== 'JPY' ||
            (item.taxablePay !== null && item.taxablePay !== undefined && !money(item.taxablePay)) ||
            (item.kind !== undefined && !['salary', 'bonus', 'adjustment'].includes(String(item.kind))) ||
            !Number.isSafeInteger(item.revision) || item.revision < 1 ||
            item.paidOn.slice(0, 4) !== String(raw.year) || seen.has(item.id))
            throw new Error('Payrollの収入明細に不正または重複した値があります。');
        seen.add(item.id);
        if (tombstones.has(item.id))
            continue;
        entries.push({ id: item.id, employerId: item.employerId, ...(item.job ? { job: item.job } : {}), payPeriod: item.payPeriod, paidOn: item.paidOn,
            grossPay: item.grossPay, netPay: item.netPay, taxablePay: item.taxablePay ?? null, currency: 'JPY',
            kind: (item.kind ?? 'salary'), revision: item.revision });
    }
    return { format: PAYROLL_INCOME_FORMAT, year: raw.year, updatedAt: raw.updatedAt,
        entries, deletedIds: [...tombstones] };
}
/** Fail rather than double-count the same payroll ID from different yearly files. */
export function combinePayrollIncome(documents) {
    const byId = new Map();
    for (const doc of documents) {
        for (const item of validatePayrollIncome(doc).entries) {
            if (byId.has(item.id))
                throw new Error('Payrollの収入データIDが年度をまたいで重複しています。');
            byId.set(item.id, item);
        }
    }
    return [...byId.values()].sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.id.localeCompare(b.id));
}
export function incomeByMonth(entries) {
    const summary = new Map();
    for (const item of entries) {
        if (!validDate(item.paidOn) || (item.grossPay !== null && !money(item.grossPay)) || !money(item.netPay))
            throw new Error('給与集計対象が不正です。');
        const month = item.paidOn.slice(0, 7), old = summary.get(month) ?? { grossPay: 0, netPay: 0, count: 0 };
        summary.set(month, { grossPay: safeAdd(old.grossPay, item.grossPay ?? 0), netPay: safeAdd(old.netPay, item.netPay), count: old.count + 1 });
    }
    return summary;
}
export function incomeByYear(entries) {
    const summary = new Map();
    for (const item of entries) {
        if (!validDate(item.paidOn) || (item.grossPay !== null && !money(item.grossPay)) || !money(item.netPay))
            throw new Error('給与集計対象が不正です。');
        const year = item.paidOn.slice(0, 4), old = summary.get(year) ?? { grossPay: 0, netPay: 0, count: 0 };
        summary.set(year, { grossPay: safeAdd(old.grossPay, item.grossPay ?? 0), netPay: safeAdd(old.netPay, item.netPay), count: old.count + 1 });
    }
    return summary;
}
/** For bank projections use paidOn/netPay. Never infer a bank account from employer or salary type. */
export function depositedIncomeBetween(entries, startExclusive, endInclusive) {
    if (!validDate(startExclusive) || !validDate(endInclusive))
        throw new Error('収入の集計期間が不正です。');
    let sum = 0;
    const seen = new Set();
    for (const item of entries) {
        if (seen.has(item.id))
            throw new Error('給与IDが重複しています。');
        seen.add(item.id);
        if (!validDate(item.paidOn) || !money(item.netPay))
            throw new Error('給与支給日または手取り額が不正です。');
        if (item.paidOn > startExclusive && item.paidOn <= endInclusive)
            sum = safeAdd(sum, item.netPay);
    }
    return sum;
}
