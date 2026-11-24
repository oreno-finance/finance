/** Read-only cross-period analysis. Finance's payment-date monthlyReport remains the source of truth.
 * Never turn absent statements, income or future projections into verified zeroes. */
import { changePeriod, monthlyReport, monthlyCashflow, hasScheduledSalary, isValidPeriod, prepareMonthlyReports } from '../summary/monthly-summary.js';
const add = (a, b) => {
    const result = a + b;
    if (!Number.isSafeInteger(result))
        throw new Error('分析金額が安全な整数範囲を超えました。');
    return result;
};
function sum(values) {
    const valid = values.filter((v) => v !== null);
    return valid.length ? valid.reduce(add, 0) : null;
}
function asMonth(period, source, prepared) {
    const report = monthlyReport(period, source, prepared);
    const { coverage, expense, livingExpense, balance } = monthlyCashflow(report);
    return { period, report, coverage, income: report.income, expense, livingExpense, balance,
        nisa: report.cardOutflow === null ? null : report.nisaOutflow };
}
function createGroups(months, dimension) {
    const groups = new Map();
    const records = months.map(item => dimension === 'card' ? item.report.cardLines.map(card => ({ id: card.cardId, label: card.name, amount: card.amount })) :
        dimension === 'category' ? item.report.categories.map(category => ({ id: category.id, label: category.name, amount: category.amount })) :
            item.report.merchants.map(merchant => ({ id: merchant.name, label: merchant.name, amount: merchant.amount })));
    records.forEach((items, index) => {
        for (const item of items) {
            const group = groups.get(item.id) ?? { id: item.id, label: item.label, amounts: months.map(m => m.report.cardOutflow === null ? null : 0) };
            group.label = item.label; // Latest configured display name.
            group.amounts[index] = add(group.amounts[index] ?? 0, item.amount);
            groups.set(item.id, group);
        }
    });
    return [...groups.values()].map(group => {
        const values = group.amounts;
        const total = sum(values) ?? 0;
        const before = values.at(-2), after = values.at(-1);
        return { ...group, total, delta: before !== undefined && after !== undefined && before !== null && after !== null ? after - before : null,
            observedMonths: values.filter(value => value !== null).length };
    }).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, 'ja'));
}
function changes(groups) {
    return groups.filter(group => group.delta !== null && group.delta !== 0)
        .map(group => ({ id: group.id, name: group.label, delta: group.delta }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name, 'ja')).slice(0, 8);
}
export function analyzePeriods(source, periods, currentPeriod) {
    if (!isValidPeriod(currentPeriod) || periods.length < 1 || periods.length > 24 ||
        periods.some((period, i) => !isValidPeriod(period) || period > currentPeriod || (i > 0 && period !== changePeriod(periods[i - 1], 1)))) {
        throw new Error('分析対象の年月が不正です。');
    }
    const adjusted = { ...source, currentPeriod };
    // Previously this recreated the global duplicate-index and scanned every
    // saved statement for EACH month, including a 12-month analysis.
    const prepared = prepareMonthlyReports(source.records);
    const months = periods.map(period => asMonth(period, adjusted, prepared));
    const knownExpenses = months.filter(month => month.expense !== null && month.coverage !== 'partial').map(month => ({ period: month.period, amount: month.expense }));
    const income = sum(months.map(month => month.income)), expense = sum(months.map(month => month.expense));
    const livingExpense = sum(months.map(month => month.livingExpense)), balance = sum(months.map(month => month.balance));
    const nisa = sum(months.map(month => month.nisa));
    const validExpenses = knownExpenses.map(item => item.amount);
    const comparable = months.every(month => month.coverage === 'registered' && month.income !== null && month.balance !== null && month.report.incomeEstimates.length === 0 && !hasScheduledSalary(month.report));
    const totals = { income, expense, livingExpense, balance, nisa,
        knownIncomeMonths: months.filter(month => month.income !== null).length,
        knownExpenseMonths: knownExpenses.length,
        missingMonths: months.filter(month => month.coverage === 'missing').length,
        provisionalMonths: months.filter(month => month.coverage === 'provisional').length,
        reviewMonths: months.filter(month => month.coverage === 'review').length,
        avgExpense: validExpenses.length ? validExpenses.reduce(add, 0) / validExpenses.length : null,
        maxExpense: knownExpenses.length ? knownExpenses.reduce((a, b) => b.amount > a.amount ? b : a) : null,
        minExpense: knownExpenses.length ? knownExpenses.reduce((a, b) => b.amount < a.amount ? b : a) : null,
        comparable };
    const groups = { card: createGroups(months, 'card'), category: createGroups(months, 'category'), merchant: createGroups(months, 'merchant') };
    return { months, totals, groups, categoryChanges: changes(groups.category), merchantChanges: changes(groups.merchant) };
}
export function rollingAnalytics(source, endPeriod, count, currentPeriod) {
    if (!isValidPeriod(endPeriod) || endPeriod > currentPeriod)
        throw new Error('未来の月は選択できません。');
    const periods = Array.from({ length: count }, (_, i) => changePeriod(endPeriod, i + 1 - count));
    return analyzePeriods(source, periods, currentPeriod);
}
export function annualAnalytics(source, year, currentPeriod) {
    const todayYear = Number(currentPeriod.slice(0, 4));
    if (!Number.isInteger(year) || year < 1900 || year > todayYear)
        throw new Error('分析できない年です。');
    const months = year === todayYear ? Number(currentPeriod.slice(5)) : 12;
    return analyzePeriods(source, Array.from({ length: months }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`), currentPeriod);
}
/** Like-for-like year-on-year period, not a full previous year when this year is ongoing. */
export function priorYearAnalytics(source, year, currentPeriod) {
    if (year <= 1900)
        return null;
    const endMonth = year === Number(currentPeriod.slice(0, 4)) ? Number(currentPeriod.slice(5)) : 12;
    return analyzePeriods(source, Array.from({ length: endMonth }, (_, index) => `${year - 1}-${String(index + 1).padStart(2, '0')}`), currentPeriod);
}
/** Missing periods make net year-on-year rates undefined, rather than treating missing as zero.
 * A comparable result is a comparison of registered records, not proof every provider was imported. */
export function comparableDelta(current, previous, metric) {
    if (!previous || current.months.length !== previous.months.length)
        return null;
    const ready = (item) => item.months.every(month => metric === 'income'
        ? month.income !== null && month.report.incomeEstimates.length === 0 && !hasScheduledSalary(month.report)
        : metric === 'expense' ? month.coverage === 'registered' && month.expense !== null
            : month.coverage === 'registered' && month.balance !== null && month.report.incomeEstimates.length === 0 && !hasScheduledSalary(month.report));
    if (!ready(current) || !ready(previous))
        return null;
    const a = current.totals[metric], b = previous.totals[metric];
    if (a === null || b === null)
        return null;
    return { amount: a - b, percent: b === 0 ? null : (a - b) / Math.abs(b) * 100 };
}
