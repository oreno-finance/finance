import { reconcileNisaMovements } from '../cloud/nisa-movements.js';
import { matchingNisaRows } from '../cloud/asset-projection.js';
import { fixedCostCalculationAssets, fixedCostRuleViews } from '../fixed-costs/rule-fixed-costs.js';
import { recurringForCalculation } from '../fixed-costs/payment-history.js';
/** Read-only, event-by-event projection for the explicitly selected bank account.
 * No transaction is marked as bank-confirmed, and no debit account is inferred. */
import { isOverdueOneTime, overdueAccountImpact, cardDebitAccountOnDay, payrollDepositAccountOnDay, recurringOneTimeMatch } from '../cloud/assets.js';
import { payrollRole, payrollRoleLabel, payrollCoversRecurringSalary, recurringSalaryRole, reconcileManualSalary, manualMainSalaryInMonth } from '../cloud/payroll-income.js';
import { expectedMainSalaries } from '../cloud/salary-projection.js';
import { recurringInMonth } from '../cloud/recurring-schedule.js';
import { monthlyReport } from './monthly-summary.js';
import { estimatedCardFixedBills, estimatedMizuhoFunding } from '../cloud/card-fixed-estimates.js';
import { mizuhoTransferForBill } from '../cloud/mizuho-transfer.js';
const dateOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nextMonth = (period) => { const y = Number(period.slice(0, 4)), m = Number(period.slice(5)); return `${y + (m === 12 ? 1 : 0)}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`; };
const lastDay = (period) => `${period}-${String(new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 0)).getUTCDate()).padStart(2, '0')}`;
export function bankTimeline(period, source, today, work) {
    if (work && work.prepared.records !== source.records)
        throw new Error('口座推移の明細索引が一致しません。');
    const assets = source.assets;
    const empty = (message) => ({ startDay: null, startBalance: null, endBalance: null, minimum: null, days: [], missingCardAccounts: [], warning: message });
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
        throw new Error('対象年月が不正です。');
    const end = lastDay(period);
    const snapshots = assets.snapshots ?? [];
    const baseline = snapshots.filter(s => s.accountId === 'rakuten-bank' && dateOf(s.observedAt) <= end)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    if (!baseline)
        return empty('楽天銀行の確認済み残高を登録してください。');
    const start = dateOf(baseline.observedAt);
    if (start > end)
        return empty('この月以前の確認済み残高がありません。');
    const months = (Number(period.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(period.slice(5)) - Number(start.slice(5, 7));
    if (months > 24)
        return empty('確認済み残高が古いため、口座管理で最新の残高を登録してください。');
    const all = [];
    const missing = new Set();
    let ambiguousRecurring = false;
    const add = (event) => { if (event.date > start && event.date <= end && Number.isSafeInteger(event.amount))
        all.push(event); };
    // Explicit account assignments prevent unrelated card payments from being deducted.
    const recurring = recurringForCalculation(assets);
    const nisaPlan = reconcileNisaMovements(assets, matchingNisaRows(assets, source.records), end < today ? end : today, recurring);
    for (let month = start.slice(0, 7); month <= nextMonth(period); month = nextMonth(month)) {
        const report = work?.reports.get(month) ?? monthlyReport(month, { ...source, currentDay: today, currentPeriod: today.slice(0, 7) }, work?.prepared);
        for (const card of report.cardLines) {
            if (!card.paymentDate)
                continue;
            const account = cardDebitAccountOnDay(assets, card.cardId, card.paymentDate);
            if (!account) {
                missing.add(card.name);
                continue;
            }
            if (account === 'rakuten-bank')
                add({ date: card.paymentDate, title: card.name, amount: -card.amount, kind: 'card', provisional: card.confirmation === 'provisional' });
            const transfer = mizuhoTransferForBill(card, assets);
            if (transfer)
                add({ date: transfer.date, title: 'みずほ銀行へ送金（予測）', amount: -transfer.amount, kind: 'transfer' });
        }
        for (const occurrence of recurringInMonth(month, recurring)) {
            const r = occurrence.entry;
            if (nisaPlan.excludesRecurring(r.id, occurrence.date))
                continue;
            const match = recurringOneTimeMatch(r, occurrence.date, assets.oneTime, undefined, recurring);
            if (match === 'unique')
                continue;
            if (match === 'ambiguous' && occurrence.date > start && occurrence.date <= end && (r.fromAccountId === 'rakuten-bank' || r.toAccountId === 'rakuten-bank'))
                ambiguousRecurring = true;
            // Payroll-sourced salaries take priority over duplicate manually scheduled income.
            if (source.payroll.ready && payrollCoversRecurringSalary(r, occurrence.date, source.payroll.entries, paidOn => payrollDepositAccountOnDay(assets, paidOn)))
                continue;
            const delta = (r.toAccountId === 'rakuten-bank' ? r.amount : 0) - (r.fromAccountId === 'rakuten-bank' ? r.amount : 0);
            if (delta !== 0)
                add({ date: occurrence.date, title: r.name, amount: delta, kind: 'recurring' });
        }
    }
    const fixedAssets = fixedCostCalculationAssets(source, today);
    const estimatedBills = estimatedCardFixedBills(fixedAssets, source.records, today, end);
    for (const bill of estimatedBills) {
        if (cardDebitAccountOnDay(assets, bill.cardId, bill.paymentDate) === 'rakuten-bank')
            add({ date: bill.paymentDate, title: bill.name, amount: -bill.amount, kind: 'card', provisional: true });
    }
    for (const funding of estimatedMizuhoFunding(fixedAssets, source.records, today, end))
        add({ date: funding.date, title: 'みずほ銀行へ送金（見込み）', amount: -funding.amount, kind: 'transfer', provisional: true });
    const salaryPlan = reconcileManualSalary(assets.oneTime, source.payroll.ready ? source.payroll.entries : [], day => payrollDepositAccountOnDay(assets, day));
    for (const entry of assets.oneTime ?? []) {
        if (salaryPlan.excludes(entry.id))
            continue;
        if (isOverdueOneTime(entry, today) || nisaPlan.excludesOneTime(entry.id))
            continue;
        const delta = (entry.toAccountId === 'rakuten-bank' ? entry.amount : 0) - (entry.fromAccountId === 'rakuten-bank' ? entry.amount : 0);
        if (delta)
            add({ date: entry.date, title: `${entry.name}${entry.status === 'planned' ? '（予定）' : ''}`, amount: delta, kind: 'one-time' });
    }
    if (source.payroll.ready) {
        for (const entry of source.payroll.entries) {
            if (entry.paidOn > start && entry.paidOn <= end && payrollDepositAccountOnDay(assets, entry.paidOn) === 'rakuten-bank')
                add({ date: entry.paidOn, title: `${payrollRoleLabel(payrollRole(entry))} · ${entry.kind === 'bonus' ? '賞与' : entry.kind === 'adjustment' ? '調整' : '給与'}`, amount: entry.netPay, kind: 'salary' });
        }
        for (const item of expectedMainSalaries(source.payroll.entries, today, end)) {
            if (payrollDepositAccountOnDay(assets, item.date) !== 'rakuten-bank')
                continue;
            if (manualMainSalaryInMonth(assets.oneTime, item.date, 'rakuten-bank') || assets.recurring.some(r => r.toAccountId === 'rakuten-bank' && recurringSalaryRole(r) === 'main' &&
                recurringInMonth(item.date.slice(0, 7), [r]).length > 0))
                continue;
            add({ date: item.date, title: '本業給与（見込み）', amount: item.amount, kind: 'salary-estimate' });
        }
    }
    all.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title, 'ja'));
    let current = baseline.balance, minimum = current;
    const days = [];
    for (const item of all) {
        let last = days[days.length - 1];
        if (!last || last.date !== item.date) {
            last = { date: item.date, items: [], delta: 0, balance: current };
            days.push(last);
        }
        last.items.push(item);
        last.delta += item.amount;
        const next = current + item.amount;
        if (!Number.isSafeInteger(next))
            throw Error('楽天銀行の予測残高が大きすぎます。');
        last.balance = next;
        current = next;
    }
    for (const day of days)
        minimum = Math.min(minimum, day.balance);
    const unsuppressed = (assets.oneTime ?? []).filter(e => !nisaPlan.excludesOneTime(e.id) && !salaryPlan.excludes(e.id));
    const overdue = overdueAccountImpact(unsuppressed, 'rakuten-bank', start, end, today);
    // The lowest point may occur before later income arrives. Include overdue
    // debits on their own dates, never credit overdue income in this scenario.
    let conservativeShortage = false;
    if (overdue.count) {
        const conservativeDays = new Map(days.map(d => [d.date, d.delta]));
        for (const item of unsuppressed) {
            if (item.date <= start || item.date > end || !isOverdueOneTime(item, today) || item.fromAccountId !== 'rakuten-bank')
                continue;
            const delta = (conservativeDays.get(item.date) ?? 0) - item.amount;
            if (!Number.isSafeInteger(delta))
                throw Error('未確認予定を含む予測額が大きすぎます。');
            conservativeDays.set(item.date, delta);
        }
        let conservative = baseline.balance;
        for (const [, delta] of [...conservativeDays].sort(([a], [b]) => a.localeCompare(b))) {
            conservative += delta;
            if (!Number.isSafeInteger(conservative))
                throw Error('未確認予定を含む予測額が大きすぎます。');
            if (conservative < 0)
                conservativeShortage = true;
        }
    }
    if (!Number.isSafeInteger(current + overdue.delta) || !Number.isSafeInteger(current + overdue.debit))
        throw Error('未確認予定を含む予測額が大きすぎます。');
    return { startDay: start, startBalance: baseline.balance, endBalance: current, minimum, days,
        missingCardAccounts: [...missing], warning: [salaryPlan.ambiguous.some(e => e.toAccountId === 'rakuten-bank' && e.date > start && e.date <= end) ? '単発給与とPayrollの対応が不明です。重複候補を含む参考値です。' : null, ambiguousRecurring ? '単発入出金と定期予定の対応が不明です。重複候補を含む参考値です。' : null, nisaPlan.ambiguousFor('rakuten-bank', start, end).length ? 'NISA積立の対応が不明なため、両方の経路を含む参考値です。' : null, conservativeShortage ? '未確認入金を除き、未確認出金を考慮すると残高が不足する可能性があります。' : null, overdue.count ? `期限経過・未確認 ${overdue.count}件。すべて実行された場合の月末参考値：${(current + overdue.delta).toLocaleString('ja-JP')}円` : null, payrollDepositAccountOnDay(assets, end) !== 'rakuten-bank' ? '給与振込先が楽天銀行以外、または未設定です。' : !source.payroll.ready ? 'Payroll未連携のため給与は含みません。' : null,
            (end >= today && fixedCostRuleViews(source, today).some(x => x.status === 'active' && !x.charge)) ? '一部のカード固定費は明細未取得・照合不可のため、予測に含まれていません。' : null,
            estimatedBills.some(b => { const funding = mizuhoTransferForBill(b, assets); return !!funding && funding.date < today; }) ? '推定請求の送金予定日が経過しているため、仮の送金は未反映です。' : null].filter(Boolean).join(' ') || null };
}
