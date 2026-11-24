import { estimateRegularNet, regularSalarySample } from '../cloud/salary-estimate.js';
import { recurringForCalculation, fixedCostsForCalculation } from '../fixed-costs/payment-history.js';
/** Finance monthly report. Real debits follow paymentDate, never transaction usedOn.
 * A verified no-charge PDF has no debit; its explicit billing month is the evidence period.
 * This module is pure and has no persistence or bank-balance side effects. */
import { getCard, isZeroUsage, statementPeriod } from '../models/types.js';
import { importErrors } from '../importers/batch-policy.js';
import { displayMerchant, matchingRule } from '../cloud/merchant-rules.js';
import { recurringOneTimeMatch, nisaRuleOnDay } from '../cloud/assets.js';
import { recurringInMonth } from '../cloud/recurring-schedule.js';
import { fixedCostOccurrences } from '../fixed-costs/contracts.js';
import { payrollRole, payrollCoversRecurringSalary, recurringSalaryRole } from '../cloud/payroll-income.js';
/** A manual salary schedule is a plan, never confirmed Payroll income. */
export function hasScheduledSalary(report) {
    return report.recurringLines.some(line => recurringSalaryRole(line) !== null);
}
const validPeriod = (value) => /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value);
export function isValidPeriod(value) { return validPeriod(value); }
function validDay(value) {
    if (!value || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value))
        return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function add(a, b) {
    const sum = a + b;
    if (!Number.isSafeInteger(sum))
        throw new Error('月別集計の金額が安全な整数範囲を超えました。');
    return sum;
}
function normalized(value) { return value.normalize('NFKC').toLocaleLowerCase(); }
function localPeriod() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; }
export { estimateRegularNet } from '../cloud/salary-estimate.js';
export function isNisaCardRow(row, stmt, assets) {
    const config = validDay(row.usedOn) ? nisaRuleOnDay(assets, row.usedOn) : null;
    return !!config?.enabled && stmt.cardId === config.cardId &&
        normalized(row.merchant).includes(normalized(config.merchantContains)) &&
        validDay(row.usedOn);
}
function categoryFor(row, statement, rules, categories) {
    const categoryId = matchingRule(row.merchant, statement.cardId, rules)?.categoryId;
    return categories.find(c => c.id === categoryId) ?? null;
}
function cardTitle(record, source) {
    const id = record.statement.cardId ?? '';
    return source.assets.cardPreferences?.[id]?.name ?? getCard(id)?.name ?? 'カード不明';
}
/** Build global duplicate information once, preserving each original record position. */
export function prepareMonthlyReports(records) {
    const months = new Map();
    const undated = [];
    const counts = new Map();
    for (let position = 0; position < records.length; position++) {
        const record = records[position];
        if (!record || !record.statement)
            continue;
        const statement = record.statement;
        const key = statement.cardId && statement.billingMonth ? `${statement.cardId}|${statement.billingMonth}` : null;
        if (key)
            counts.set(key, (counts.get(key) ?? 0) + 1);
        const period = statementPeriod(statement);
        const ref = { position, record };
        if (period) {
            const month = months.get(period) ?? [];
            month.push(ref);
            months.set(period, month);
        }
        else
            undated.push(ref);
    }
    const duplicates = new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
    return { records, months, undated, duplicates };
}
/** Unknown payment dates are listed globally since they cannot be attributed to a month. */
export function monthlyReport(period, source, prepared) {
    if (!validPeriod(period))
        throw new Error('集計年月が不正です。');
    const issues = [];
    const cardLines = [];
    const provisional = [];
    const categoryTotals = new Map();
    const merchantTotals = new Map();
    const cardRowsForOverlap = [];
    const usedIds = new Set();
    let excludedCount = 0, unclassifiedCount = 0, unknownConfirmationCount = 0;
    let included = 0, sum = 0, nisa = 0;
    // An index belongs to its exact statement-array snapshot. Never accept an index
    // from a different source, which could silently hide newly received records.
    if (prepared && prepared.records !== source.records)
        throw new Error('月別集計の索引が現在の明細と一致しません。');
    const indexed = prepared
        ? [...(prepared.months.get(period) ?? []), ...prepared.undated]
            .sort((a, b) => a.position - b.position).map(item => item.record)
        : source.records.filter(record => record && record.statement);
    const duplicateKeys = prepared?.duplicates ?? (() => {
        const counts = new Map();
        for (const record of source.records) {
            if (!record?.statement)
                continue;
            const s = record.statement;
            const key = s.cardId && s.billingMonth ? `${s.cardId}|${s.billingMonth}` : null;
            if (key)
                counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
    })();
    for (const record of indexed) {
        const s = record.statement;
        const month = statementPeriod(s);
        // Undated records are visible as unresolved data quality issues in every month.
        if (month !== period && month !== null)
            continue;
        const identity = s.cardId && s.billingMonth ? `${s.cardId}|${s.billingMonth}` : null;
        const reasons = [];
        if (usedIds.has(record.id))
            reasons.push('保存済み明細IDが重複しています');
        else
            usedIds.add(record.id);
        if (identity && duplicateKeys.has(identity))
            reasons.push('同じカード・請求月の明細が複数あります');
        const validation = importErrors(s, s.sourceKind !== 'pdf' || !!record.originalId);
        reasons.push(...validation);
        // Set-based validation: a single linear walk, preserving duplicate-ID errors.
        if (s.rows.length !== new Set(s.rows.map(row => row.id)).size)
            reasons.push('取引行IDが重複しています');
        if (month === null)
            reasons.push('支払日が不明または不正です');
        const reason = [...new Set(reasons)].join(' / ');
        if (reason) {
            issues.push({ id: record.id, title: cardTitle(record, source), reason, month });
            if (month === period)
                excludedCount++;
            continue;
        }
        if (month !== period)
            continue;
        const amt = s.rows.reduce((acc, row) => add(acc, row.amount), 0);
        const line = { id: record.id, cardId: s.cardId, name: cardTitle(record, source), billingMonth: s.billingMonth, paymentDate: s.paymentDate, amount: amt, confirmation: s.confirmation };
        if (s.confirmation === 'provisional')
            provisional.push(line);
        if (!isZeroUsage(s))
            included++;
        sum = add(sum, amt);
        cardLines.push(line);
        if (s.confirmation === 'unknown')
            unknownConfirmationCount++;
        for (const row of s.rows) {
            if (isNisaCardRow(row, s, source.assets)) {
                nisa = add(nisa, row.amount);
                const old = categoryTotals.get('__nisa') ?? { id: '__nisa', name: 'NISA積立（資産移動）', color: null, amount: 0, count: 0 };
                old.amount = add(old.amount, row.amount);
                old.count++;
                categoryTotals.set('__nisa', old);
                continue;
            }
            const category = categoryFor(row, s, source.rules, source.categories);
            const id = category?.id ?? '__unclassified';
            const old = categoryTotals.get(id) ?? { id, name: category?.name ?? '未分類', color: category?.color ?? null, amount: 0, count: 0 };
            old.amount = add(old.amount, row.amount);
            old.count++;
            categoryTotals.set(id, old);
            if (!category)
                unclassifiedCount++;
            const name = displayMerchant(row.merchant, s.cardId, source.rules, row.merchantOverride);
            cardRowsForOverlap.push({ name: normalized(name).trim(), amount: row.amount });
            const merchant = merchantTotals.get(name) ?? { name, amount: 0, count: 0 };
            merchant.amount = add(merchant.amount, row.amount);
            merchant.count++;
            merchantTotals.set(name, merchant);
        }
    }
    const incomeLines = [];
    if (source.payroll.ready) {
        const seen = new Set();
        for (const entry of source.payroll.entries) {
            if (seen.has(entry.id))
                throw new Error('Payrollの給与IDが重複しています。');
            seen.add(entry.id);
            if (!validDay(entry.paidOn) || !Number.isSafeInteger(entry.netPay) || entry.netPay < 0)
                throw new Error('Payrollの収入データに不正な日付または金額があります。');
            if (entry.paidOn.slice(0, 7) === period)
                incomeLines.push({ id: entry.id, employerId: entry.employerId, job: payrollRole(entry), kind: entry.kind, date: entry.paidOn, amount: entry.netPay });
        }
    }
    const actualIncome = source.payroll.ready && incomeLines.length > 0
        ? incomeLines.reduce((acc, line) => add(acc, line.amount), 0) : null;
    const scheduled = recurringForCalculation(source.assets);
    const occurrences = recurringInMonth(period, scheduled);
    // Household income does not require a configured bank account. When there is
    // one, use the same account/role/month match as the bank forecasts. Otherwise
    // keep the legacy household-only role match without inventing a bank route.
    const salaryAccount = source.assets.payrollDepositAccount;
    const manualMain = source.payroll.ready && occurrences.some(({ entry }) => recurringSalaryRole(entry) === 'main' && (!salaryAccount || entry.toAccountId === salaryAccount));
    const incomeEstimates = [];
    const currentPeriod = source.currentPeriod ?? localPeriod();
    // Forecast only for the actual current month. The prior regular salary must be published.
    // Prefer prior payment month; allow one older payment month when salaries arrive late.
    if (source.payroll.ready && period === currentPeriod && !manualMain &&
        !incomeLines.some(line => line.job === 'main' && line.kind === 'salary')) {
        const sample = regularSalarySample(source.payroll.entries, period);
        if (sample) {
            const estimated = estimateRegularNet(sample);
            if (estimated !== null)
                incomeEstimates.push({ employerId: sample.employerId, job: 'main', kind: 'salary', sourcePeriod: sample.paidOn.slice(0, 7),
                    amount: estimated, method: sample.grossPay === null || sample.taxablePay === null ? 'previous-regular-net-fallback' : 'previous-regular-net-excluding-nontaxable' });
        }
    }
    const estimatedIncome = incomeEstimates.length ? incomeEstimates.reduce((acc, e) => add(acc, e.amount), 0) : null;
    const incomeMissingRegular = source.payroll.ready && period === currentPeriod && !manualMain &&
        !incomeLines.some(line => line.job === 'main' && line.kind === 'salary') && estimatedIncome === null &&
        source.payroll.entries.some(entry => payrollRole(entry) === 'main' && entry.kind === 'salary' && validDay(entry.paidOn) && entry.paidOn.slice(0, 7) < period);
    const payrollIncome = incomeMissingRegular ? null : actualIncome === null ? estimatedIncome : estimatedIncome === null ? actualIncome : add(actualIncome, estimatedIncome);
    // Recurrences are scheduled entries, *including future dates*. They are not verified bank debits.
    const recurringLines = [];
    let recurringIncome = 0, recurringExpense = 0, recurringTransfers = 0, recurringSalaryExcluded = 0, recurringCardOverlap = 0, recurringOneTimeOverlap = 0;
    for (const occurrence of occurrences) {
        const e = occurrence.entry;
        const oneTimeMatch = recurringOneTimeMatch(e, occurrence.date, source.assets.oneTime, 'done', scheduled);
        if (oneTimeMatch === 'unique')
            continue;
        if (oneTimeMatch === 'ambiguous')
            recurringOneTimeOverlap++;
        const payrollOverlap = source.payroll.ready && payrollCoversRecurringSalary(e, occurrence.date, source.payroll.entries, salaryAccount ?? e.toAccountId);
        if (payrollOverlap) {
            recurringSalaryExcluded++;
            continue;
        }
        const line = { id: occurrence.id, entryId: e.id, name: e.name, date: occurrence.date, kind: e.kind,
            amount: e.amount, fromAccountId: e.fromAccountId, toAccountId: e.toAccountId, categoryId: e.categoryId, payrollOverlap: false,
            cardOverlap: e.kind === 'expense' && cardRowsForOverlap.some(row => row.name === normalized(e.name).trim() && row.amount === e.amount) };
        recurringLines.push(line);
        if (e.kind === 'income')
            recurringIncome = add(recurringIncome, e.amount);
        if (e.kind === 'expense') {
            recurringExpense = add(recurringExpense, e.amount);
            const category = source.categories.find(c => c.id === e.categoryId);
            const id = category?.id ?? '__unclassified';
            const old = categoryTotals.get(id) ?? { id, name: category?.name ?? '未分類', color: category?.color ?? null, amount: 0, count: 0 };
            old.amount = add(old.amount, e.amount);
            old.count++;
            categoryTotals.set(id, old);
            if (!category)
                unclassifiedCount++;
            // A possible duplicate is a review warning, not grounds to silently discard expenses.
            if (line.cardOverlap)
                recurringCardOverlap++;
        }
        if (e.kind === 'transfer')
            recurringTransfers = add(recurringTransfers, e.amount);
    }
    // Cash standing commitments affect household planned expenses but never a bank balance.
    // Card contracts are already included in their issuer statements and never enter this loop.
    for (const occurrence of fixedCostOccurrences(period, fixedCostsForCalculation(source.assets).filter(x => x.payment === 'cash'))) {
        const { item, date, amount } = occurrence;
        // One-time expenses always have a bank source. Never erase a cash contract based on one.
        const duplicate = cardRowsForOverlap.some(row => row.name === normalized(item.name).trim() && row.amount === amount);
        recurringLines.push({ id: `cash:${item.id}:${date}`, entryId: `cash:${item.id}`, name: item.name, date, kind: 'expense', amount,
            fromAccountId: null, toAccountId: null, categoryId: item.categoryId, payrollOverlap: false, cardOverlap: duplicate });
        recurringExpense = add(recurringExpense, amount);
        if (duplicate)
            recurringCardOverlap++;
        const category = source.categories.find(c => c.id === item.categoryId);
        const key = category?.id ?? '__unclassified';
        const old = categoryTotals.get(key) ?? { id: key, name: category?.name ?? '未分類', color: category?.color ?? null, amount: 0, count: 0 };
        old.amount = add(old.amount, amount);
        old.count++;
        categoryTotals.set(key, old);
        if (!category)
            unclassifiedCount++;
    }
    const oneTimeLines = [...(source.assets.oneTime ?? [])].filter(e => e.date.slice(0, 7) === period)
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    let oneTimeIncome = 0, oneTimeExpense = 0, oneTimePlannedExpense = 0, oneTimePlannedIncome = 0, pastUnconfirmedOneTime = 0;
    const thisPeriod = source.currentPeriod ?? localPeriod();
    for (const entry of oneTimeLines) {
        if (entry.status === 'planned') {
            if (entry.kind === 'income')
                oneTimePlannedIncome = add(oneTimePlannedIncome, entry.amount);
            if (entry.kind === 'expense')
                oneTimePlannedExpense = add(oneTimePlannedExpense, entry.amount);
            if (period < thisPeriod)
                pastUnconfirmedOneTime++;
            continue; // A past plan never silently becomes a paid expense.
        }
        if (entry.kind === 'income')
            oneTimeIncome = add(oneTimeIncome, entry.amount);
        if (entry.kind === 'expense') {
            oneTimeExpense = add(oneTimeExpense, entry.amount);
            const category = source.categories.find(c => c.id === entry.categoryId);
            const key = category?.id ?? '__unclassified';
            const old = categoryTotals.get(key) ?? { id: key, name: category?.name ?? '未分類', color: category?.color ?? null, amount: 0, count: 0 };
            old.amount = add(old.amount, entry.amount);
            old.count++;
            categoryTotals.set(key, old);
            if (!category)
                unclassifiedCount++;
        }
    }
    // An explicit main salary schedule supplies a planned amount, not an actual
    // Payroll observation. Without any main evidence, preserve the unknown total.
    const incomeBase = payrollIncome === null && manualMain ? 0 : payrollIncome;
    const income = incomeBase === null ? null : add(add(incomeBase, recurringIncome), oneTimeIncome);
    const cardNoUseConfirmed = cardLines.length === 0 && source.assets.cardNoUseMonths?.includes(period) === true && excludedCount === 0;
    const cardOutflow = included > 0 ? sum : cardNoUseConfirmed ? 0 : null;
    const livingOutflow = cardOutflow === null ? null : add(cardOutflow, -nisa);
    // Unknown card spending is not zero. Only explicit no-use or a registered
    // statement supplies a card total; internal transfers remain neutral.
    const monthlyBalance = income === null || cardOutflow === null ? null : add(add(add(income, -cardOutflow), -recurringExpense), -oneTimeExpense);
    const referenceBalance = monthlyBalance;
    return { period, income, actualIncome, estimatedIncome, incomeEstimates, incomeMissingRegular, incomeLines, cardOutflow, cardLines, livingOutflow, nisaOutflow: nisa,
        referenceBalance, monthlyBalance, recurringIncome, recurringExpense, recurringTransfers, recurringLines, oneTimeIncome, oneTimeExpense, oneTimePlannedExpense, oneTimePlannedIncome, pastUnconfirmedOneTime, cardNoUseConfirmed, oneTimeLines, recurringSalaryExcluded, recurringCardOverlap, recurringOneTimeOverlap, categories: [...categoryTotals.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'ja')),
        merchants: [...merchantTotals.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'ja')),
        issues, provisional, unclassifiedCount, excludedCount, unknownConfirmationCount,
        payrollReady: source.payroll.ready, payrollSyncedAt: source.payroll.ready ? source.payroll.syncedAt : null };
}
export function monthlyCashflow(report) {
    const nonCard = add(report.recurringExpense, report.oneTimeExpense);
    const coverage = report.cardOutflow === null ? (nonCard > 0 || report.cardLines.some(card => card.paymentDate === null) ? 'partial' : 'missing') :
        report.issues.length || report.unknownConfirmationCount || report.recurringCardOverlap ? 'review' : report.provisional.length ? 'provisional' : 'registered';
    return { coverage, expense: report.cardOutflow === null ? (nonCard || null) : add(report.cardOutflow, nonCard),
        livingExpense: report.livingOutflow === null ? (nonCard || null) : add(report.livingOutflow, nonCard), balance: report.monthlyBalance };
}
export function changePeriod(period, delta) {
    if (!validPeriod(period) || !Number.isSafeInteger(delta))
        throw new Error('年月が不正です。');
    const year = Number(period.slice(0, 4)), month = Number(period.slice(5));
    const value = year * 12 + month - 1 + delta;
    const nextYear = Math.floor(value / 12), nextMonth = value % 12 + 1;
    const next = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
    if (!validPeriod(next))
        throw new Error('表示できる年月の範囲外です。');
    return next;
}
