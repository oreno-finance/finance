import { recurringForCalculation } from '../fixed-costs/payment-history.js';
/** Read-only, event-by-event projection for the explicitly selected bank account.
 * No transaction is marked as bank-confirmed, and no debit account is inferred. */
import { recurringCoveredByOneTime } from '../cloud/assets.js';
import { payrollRole, payrollRoleLabel, payrollCoversRecurringSalary, recurringSalaryRole } from '../cloud/payroll-income.js';
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
    const add = (event) => { if (event.date > start && event.date <= end && Number.isSafeInteger(event.amount))
        all.push(event); };
    // Explicit account assignments prevent unrelated card payments from being deducted.
    const recurring = recurringForCalculation(assets);
    for (let month = start.slice(0, 7); month <= nextMonth(period); month = nextMonth(month)) {
        const report = work?.reports.get(month) ?? monthlyReport(month, source, work?.prepared);
        for (const card of report.cardLines) {
            const account = assets.cardDebitAccounts?.[card.cardId];
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
            if (recurringCoveredByOneTime(r, occurrence.date, assets.oneTime, undefined, recurring))
                continue;
            // Payroll-sourced salaries take priority over duplicate manually scheduled income.
            if (source.payroll.ready && payrollCoversRecurringSalary(r, occurrence.date, source.payroll.entries, assets.payrollDepositAccount))
                continue;
            const delta = (r.toAccountId === 'rakuten-bank' ? r.amount : 0) - (r.fromAccountId === 'rakuten-bank' ? r.amount : 0);
            if (delta !== 0)
                add({ date: occurrence.date, title: r.name, amount: delta, kind: 'recurring' });
        }
    }
    const estimatedBills = estimatedCardFixedBills(assets, source.records, today, end);
    for (const bill of estimatedBills) {
        if (assets.cardDebitAccounts?.[bill.cardId] === 'rakuten-bank')
            add({ date: bill.paymentDate, title: bill.name, amount: -bill.amount, kind: 'card', provisional: true });
    }
    for (const funding of estimatedMizuhoFunding(assets, source.records, today, end))
        add({ date: funding.date, title: 'みずほ銀行へ送金（固定費から推定・未確定）', amount: -funding.amount, kind: 'transfer', provisional: true });
    for (const entry of assets.oneTime ?? []) {
        const delta = (entry.toAccountId === 'rakuten-bank' ? entry.amount : 0) - (entry.fromAccountId === 'rakuten-bank' ? entry.amount : 0);
        if (delta)
            add({ date: entry.date, title: `${entry.name}${entry.status === 'planned' ? '（予定）' : ''}`, amount: delta, kind: 'one-time' });
    }
    if (source.payroll.ready && assets.payrollDepositAccount === 'rakuten-bank') {
        for (const entry of source.payroll.entries) {
            if (entry.paidOn > start && entry.paidOn <= end)
                add({ date: entry.paidOn, title: `${payrollRoleLabel(payrollRole(entry))} · ${entry.kind === 'bonus' ? '賞与' : entry.kind === 'adjustment' ? '調整' : '給与'}`, amount: entry.netPay, kind: 'salary' });
        }
        for (const item of expectedMainSalaries(source.payroll.entries, today, end)) {
            if (assets.recurring.some(r => r.toAccountId === 'rakuten-bank' && recurringSalaryRole(r) === 'main' &&
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
    return { startDay: start, startBalance: baseline.balance, endBalance: current, minimum, days,
        missingCardAccounts: [...missing], warning: [assets.payrollDepositAccount !== 'rakuten-bank' ? '給与振込先が楽天銀行以外、または未設定です。' : !source.payroll.ready ? 'Payroll未連携のため給与は含みません。' : null,
            estimatedBills.some(b => { const funding = mizuhoTransferForBill(b, assets); return !!funding && funding.date < today; }) ? '推定請求の送金予定日が経過しているため、仮の送金は未反映です。' : null].filter(Boolean).join(' ') || null };
}
