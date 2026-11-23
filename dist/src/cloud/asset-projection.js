/** Read-only asset forecast: no remote writes, guessed debit accounts, or future salary estimates. */
import { ASSET_ACCOUNTS, oneTimeAccountDelta, recurringCoveredByOneTime, nisaRuleOnDay } from './assets.js';
import { recurringOccursOn, recurringEffectiveAmount } from './recurring-schedule.js'; /* finance-monthly-v142 */
import { depositedIncomeBetween } from './payroll-income.js';
function dayString(date) {
    const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
export function localDay(date) { return dayString(date); }
export function lastDayOfNextMonth(date) {
    return dayString(new Date(date.getFullYear(), date.getMonth() + 2, 0));
}
function validDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
        return false;
    const date = new Date(`${day}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
function snapshotDay(s) { return dayString(new Date(s.observedAt)); }
function accountDelta(entry, account) {
    if (entry.fromAccountId === account)
        return -entry.amount;
    if (entry.toAccountId === account)
        return entry.amount;
    return 0;
}
export function matchingNisaRows(doc, records) {
    const seen = new Set();
    const matches = [];
    for (const record of records) {
        for (const row of record.statement.rows) {
            const date = row.usedOn;
            if (!validDay(date) || !Number.isSafeInteger(row.amount) || row.amount <= 0)
                continue;
            const rule = nisaRuleOnDay(doc, date);
            if (!rule?.enabled || record.statement.cardId !== rule.cardId ||
                !row.merchant.normalize('NFKC').toLocaleLowerCase().includes(rule.merchantContains.normalize('NFKC').toLocaleLowerCase()))
                continue;
            const id = `${record.id}:${row.id}`;
            if (seen.has(id))
                continue;
            seen.add(id);
            matches.push({ date, amount: row.amount, recordId: record.id, rowId: row.id });
        }
    }
    return matches;
}
/**
 * Project from the latest snapshot on/before the target date.
 * All events on a snapshot's calendar day are excluded, because a manually
 * confirmed balance may already include them. Future entries are included up
 * to and including the selected target date. Card rows are never bank debits.
 */
export function forecastAssets(doc, asOf, records = [], payrollIncome = [], payrollDepositAccount = null, nisaMatches) {
    if (!validDay(asOf))
        throw new Error('予測対象日が不正です。');
    const cardRows = nisaMatches ?? matchingNisaRows(doc, records);
    const result = {};
    for (const account of ASSET_ACCOUNTS) {
        const found = doc.snapshots.filter(s => s.accountId === account.id && snapshotDay(s) <= asOf);
        found.sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id));
        const baseline = found[0] ?? null;
        if (!baseline) {
            result[account.id] = { accountId: account.id, baseline: null, balance: null, recurringDelta: 0, oneTimeDelta: 0, cardNisaDelta: 0, payrollDelta: 0, forecastEvents: 0, warning: '基準残高を登録してください。' };
            continue;
        }
        const start = snapshotDay(baseline);
        const from = Date.parse(`${start}T00:00:00Z`), to = Date.parse(`${asOf}T00:00:00Z`);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 366 * 10 * 86400000) {
            result[account.id] = { accountId: account.id, baseline, balance: null, recurringDelta: 0, oneTimeDelta: 0, cardNisaDelta: 0, payrollDelta: 0, forecastEvents: 0, warning: '基準残高が古いため、確認済み残高を更新してください。' };
            continue;
        }
        let recurringDelta = 0, forecastEvents = 0;
        // Iterate at most 3,660 days. Using UTC days keeps DST away from recurrence scheduling.
        for (let t = from + 86400000; t <= to; t += 86400000) {
            const day = new Date(t).toISOString().slice(0, 10);
            for (const entry of doc.recurring) {
                if (entry.fromAccountId !== account.id && entry.toAccountId !== account.id)
                    continue;
                if (!recurringOccursOn(entry, day))
                    continue;
                const historic = { ...entry, amount: recurringEffectiveAmount(entry, day) };
                const delta = accountDelta(historic, account.id);
                if (delta !== 0 && !recurringCoveredByOneTime(historic, day, doc.oneTime)) {
                    recurringDelta += delta;
                    forecastEvents++;
                }
            }
        }
        // Do not replay movements already incorporated in a manually checked balance.
        let oneTimeDelta = 0;
        for (const entry of doc.oneTime ?? []) {
            if (entry.date <= start || entry.date > asOf)
                continue;
            const delta = oneTimeAccountDelta(entry, account.id);
            if (delta !== 0) {
                oneTimeDelta += delta;
                forecastEvents++;
            }
        }
        let cardNisaDelta = 0;
        if (account.id === 'nisa')
            for (const row of cardRows) {
                if (row.date > start && row.date <= asOf)
                    cardNisaDelta += row.amount;
            }
        // Opt-in only. The producer must provide confirmed salary payments;
        // never infer projected pay or the deposit account. No card debit here.
        const payrollDelta = payrollDepositAccount === account.id
            ? depositedIncomeBetween(payrollIncome, start, asOf) : 0;
        const balance = baseline.balance + recurringDelta + oneTimeDelta + cardNisaDelta + payrollDelta;
        if (!Number.isSafeInteger(balance))
            throw new Error('残高予測の金額が上限を超えています。');
        result[account.id] = { accountId: account.id, baseline, balance, recurringDelta, oneTimeDelta, cardNisaDelta, payrollDelta, forecastEvents,
            warning: account.id === 'nisa' ? '評価額の変動は含まず、積立額のみを加算した参考値です。' : null };
    }
    return result;
}
