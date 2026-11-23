/** Read-only account-level cashflow. Bank balances are projections from a manually
 * observed snapshot, never a bank API balance. No assets or statements are mutated. */
import { ASSET_ACCOUNTS, recurringCoveredByOneTime } from '../cloud/assets.js';
import { recurringInMonth } from '../cloud/recurring-schedule.js';
import { estimatedCardFixedBills } from '../cloud/card-fixed-estimates.js';
import { mizuhoTransferForBill } from '../cloud/mizuho-transfer.js';
import { expectedMainSalaries } from '../cloud/salary-projection.js';
import { changePeriod, monthlyReport } from '../summary/monthly-summary.js';
const payrollName = /給与|給料|salary|payroll/i;
const period = (day) => day.slice(0, 7);
const isDay = (value) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export function shiftedDay(day, days) {
    if (!isDay(day) || !Number.isSafeInteger(days))
        throw new Error('予測日が不正です。');
    const date = new Date(`${day}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
function observedDay(snapshot) {
    const date = new Date(snapshot.observedAt);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function addMonths(from, to) {
    const result = [];
    let current = period(from);
    while (current <= period(to) && result.length < 6) {
        result.push(current);
        current = changePeriod(current, 1);
    }
    return result;
}
function safeAmount(previous, change) {
    const value = previous + change;
    if (!Number.isSafeInteger(value))
        throw new Error('口座の予測金額が大きすぎます。');
    return value;
}
/** Every explicit account movement is evaluated per-account; internal transfers
 * generate equal-and-opposite events and are never household spending. */
export function forecastAccounts(source, today, horizonDays = 45, reportForMonth = (period) => monthlyReport(period, source)) {
    if (!isDay(today) || !Number.isSafeInteger(horizonDays) || horizonDays < 1 || horizonDays > 90)
        throw Error('予測期間が不正です。');
    const until = shiftedDay(today, horizonDays);
    const cutoff = shiftedDay(today, -90);
    const snapshots = source.assets.snapshots ?? [];
    const bankIds = ['rakuten-bank', 'mizuho-bank', 'cash-savings'];
    const observed = new Map();
    for (const accountId of bankIds) {
        const found = snapshots.filter(s => s.accountId === accountId && observedDay(s) <= today)
            .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
        observed.set(accountId, found[0] ?? null);
    }
    const events = [];
    const push = (event) => {
        if (!bankIds.includes(event.accountId) || event.date <= cutoff || event.date > until || !isDay(event.date) || !Number.isSafeInteger(event.amount))
            return;
        events.push(event);
    };
    const addMovement = (id, date, title, amount, kind, from, to) => {
        if (from && from !== 'nisa')
            push({ id: `${id}:from`, date, title, amount: -amount, kind, accountId: from });
        if (to && to !== 'nisa')
            push({ id: `${id}:to`, date, title, amount, kind, accountId: to });
    };
    const missingCardIds = new Set();
    const cardLines = [];
    const overlapMonths = [];
    const invalidMonths = [];
    let unverified = false;
    for (const month of addMonths(cutoff, until)) {
        const report = reportForMonth(month);
        if (report.recurringCardOverlap > 0)
            overlapMonths.push(month);
        if (report.issues.some(issue => issue.month === month || issue.month === null))
            invalidMonths.push(month);
        for (const card of report.cardLines) {
            cardLines.push(card);
            if (card.paymentDate >= today && card.confirmation !== 'confirmed')
                unverified = true;
            const accountId = source.assets.cardDebitAccounts?.[card.cardId];
            if (!accountId || accountId === 'nisa')
                missingCardIds.add(card.cardId);
            else
                push({ id: `card:${card.id}`, date: card.paymentDate, title: card.name, amount: -card.amount, kind: 'card',
                    accountId, recordId: card.id, cardId: card.cardId, confirmation: card.confirmation });
            const funding = mizuhoTransferForBill(card, {
                mizuhoTransferPlan: source.assets.mizuhoTransferPlan,
                cardDebitAccounts: source.assets.cardDebitAccounts,
                recurring: source.assets.recurring,
                oneTime: source.assets.oneTime,
            });
            if (funding)
                addMovement(`fund:${card.id}`, funding.date, 'みずほ銀行へ送金（見込み）', funding.amount, 'transfer', 'rakuten-bank', 'mizuho-bank');
        }
        for (const occurrence of recurringInMonth(month, source.assets.recurring)) {
            const entry = occurrence.entry;
            if (recurringCoveredByOneTime(entry, occurrence.date, source.assets.oneTime))
                continue;
            if (source.payroll.ready && entry.kind === 'income' && entry.toAccountId === source.assets.payrollDepositAccount && payrollName.test(entry.name))
                continue;
            addMovement(`recurring:${occurrence.id}`, occurrence.date, entry.name, entry.amount, 'recurring', entry.fromAccountId, entry.toAccountId);
        }
    }
    const estimates = estimatedCardFixedBills(source.assets, source.records, today, until);
    for (const item of estimates) {
        const assigned = source.assets.cardDebitAccounts?.[item.cardId];
        if (!assigned || assigned === 'nisa') {
            missingCardIds.add(item.cardId);
            continue;
        }
        push({ id: item.id, date: item.paymentDate, accountId: assigned, amount: -item.amount,
            title: item.name, kind: 'card-estimate', cardId: item.cardId, confirmation: 'unknown', estimated: true });
    }
    for (const entry of source.assets.oneTime ?? [])
        addMovement(`once:${entry.id}`, entry.date, entry.name, entry.amount, 'one-time', entry.fromAccountId, entry.toAccountId);
    const payrollAccount = source.assets.payrollDepositAccount;
    if (source.payroll.ready && payrollAccount && payrollAccount !== 'nisa') {
        for (const entry of source.payroll.entries) {
            push({ id: `salary:${entry.id}`, date: entry.paidOn, accountId: payrollAccount,
                title: entry.employerId === 'main' ? '本業給与' : '副業給与', amount: entry.netPay, kind: 'salary' });
        }
        for (const estimate of expectedMainSalaries(source.payroll.entries, today, until)) {
            const scheduled = source.assets.recurring.some(r => r.enabled && r.kind === 'income' && r.toAccountId === payrollAccount && payrollName.test(r.name) &&
                recurringInMonth(period(estimate.date), [r]).some(o => o.date === estimate.date));
            if (!scheduled)
                push({ id: `estimated-salary:${estimate.date}`, date: estimate.date, accountId: payrollAccount,
                    title: '本業給与（見込み）', amount: estimate.amount, kind: 'salary-estimate' });
        }
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const payrollStale = !!source.payroll.syncedAt && Date.parse(`${today}T12:00:00Z`) - source.payroll.syncedAt > 14 * 86400000;
    const forecasts = bankIds.map(accountId => {
        const snapshot = observed.get(accountId) ?? null;
        const name = ASSET_ACCOUNTS.find(a => a.id === accountId).name;
        const start = snapshot ? observedDay(snapshot) : null;
        const unknownAfterBaseline = start && cardLines.some(card => !source.assets.cardDebitAccounts?.[card.cardId] && card.paymentDate > start);
        const affectedOverlap = start && overlapMonths.some(month => month >= period(start));
        const affectedInvalid = start && invalidMonths.some(month => month >= period(start));
        const reason = !start ? 'no-snapshot' : start < cutoff ? 'stale-snapshot' : unknownAfterBaseline ? 'missing-card-account' :
            affectedOverlap ? 'possible-duplicate' : affectedInvalid ? 'invalid-statement' : unverified ? 'unverified-debit' :
                events.some(e => e.accountId === accountId && e.kind === 'card-estimate') ? 'estimated-card-debit' :
                    ((!source.payroll.ready || payrollStale) && (!source.assets.payrollDepositAccount || source.assets.payrollDepositAccount === accountId)) ||
                        (source.payroll.entries.length > 0 && !source.assets.payrollDepositAccount) ? 'payroll-unavailable' : null;
        if (!snapshot || !start || start < cutoff)
            return { accountId, name, observed: snapshot, projected: null, projectedAt: until,
                reliable: false, days: [], reason };
        const days = [];
        let balance = snapshot.balance;
        for (const event of events) {
            if (event.accountId !== accountId || event.date <= start)
                continue;
            balance = safeAmount(balance, event.amount);
            const last = days[days.length - 1];
            if (last?.date === event.date) {
                last.balance = balance;
                last.events.push(event);
            }
            else
                days.push({ date: event.date, balance, events: [event] });
        }
        return { accountId, name, observed: snapshot, projected: balance, projectedAt: until,
            reliable: reason === null, days, reason };
    });
    const predictedCards = estimates.map(e => ({ id: e.id, cardId: e.cardId, name: e.name,
        billingMonth: null, paymentDate: e.paymentDate, amount: e.amount, confirmation: 'unknown' }));
    const debits = [...cardLines, ...predictedCards].filter(card => card.paymentDate >= today && card.paymentDate <= until)
        .map(card => {
        const assigned = source.assets.cardDebitAccounts?.[card.cardId];
        const accountId = assigned && assigned !== 'nisa' ? assigned : null;
        const forecast = forecasts.find(a => a.accountId === accountId);
        const day = forecast?.days.find(d => d.date === card.paymentDate);
        return { id: card.id, cardId: card.cardId, name: card.name, date: card.paymentDate, amount: card.amount,
            confirmation: card.confirmation, accountId, estimated: card.id.startsWith('estimate:'), afterBalance: forecast?.reliable && day ? day.balance : null,
            balanceReliable: !!forecast?.reliable && !!day };
    })
        .sort((a, b) => a.date.localeCompare(b.date) || a.cardId.localeCompare(b.cardId) || a.id.localeCompare(b.id));
    return { accounts: forecasts, debits, missingCardIds: [...missingCardIds], overlap: overlapMonths.length > 0 };
}
