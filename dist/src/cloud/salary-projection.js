import { estimateRegularNet, regularSalarySample } from './salary-estimate.js';
/** Read-only bank balance projection including clearly labelled, unconfirmed salary estimates.
 * Neither the monthly estimate nor the input salary is persisted to Finance/OneDrive.
 */
import { forecastAssets, matchingNisaRows } from './asset-projection.js';
import { payrollRole, recurringSalaryRole } from './payroll-income.js';
import { recurringInMonth } from './recurring-schedule.js';
import { monthlyReport, prepareMonthlyReports } from '../summary/monthly-summary.js';
import { estimatedCardFixedBills, estimatedMizuhoFunding } from './card-fixed-estimates.js';
import { mizuhoTransferForBill } from './mizuho-transfer.js';
const period = (date) => date.slice(0, 7);
const monthIndex = (date) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
const monthFromIndex = (value) => `${Math.floor((value - 1) / 12)}-${String(((value - 1) % 12) + 1).padStart(2, '0')}`;
const validDay = (day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day + 'T00:00:00Z')) && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day;
const snapshotDay = (snap) => {
    const d = new Date(snap.observedAt);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const payday = (month, day) => {
    const year = Number(month.slice(0, 4)), mm = Number(month.slice(5, 7));
    const last = new Date(Date.UTC(year, mm, 0)).getUTCDate();
    return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
};
/** Forecast a missing normal main-job salary from an actual recent salary, not from a bonus.
 * Never project more than the current and next month in account balance widgets.
 */
export function expectedMainSalaries(entries, today, until) {
    if (!validDay(today) || !validDay(until) || until < today)
        return [];
    const current = monthIndex(today), last = monthIndex(until);
    const result = [];
    for (let i = current; i <= Math.min(last, current + 1); i++) {
        const month = monthFromIndex(i);
        if (entries.some(item => payrollRole(item) === 'main' && item.kind === 'salary' && period(item.paidOn) === month))
            continue;
        const samplePeriod = i === current ? month : entries.some(e => payrollRole(e) === 'main' && e.kind === 'salary' && period(e.paidOn) === period(today)) ? month : period(today);
        const latest = regularSalarySample(entries, samplePeriod, today);
        if (!latest)
            continue;
        const amount = estimateRegularNet(latest);
        if (amount === null || amount === 0)
            continue;
        const method = latest.grossPay === null || latest.taxablePay === null ? 'previous-net' : 'net-excluding-nontaxable';
        const date = payday(month, Number(latest.paidOn.slice(8, 10)));
        if (date <= until)
            result.push({ date, amount, sourceMonth: period(latest.paidOn), method });
    }
    return result;
}
/** A per-render context: never share across asset edits or cloud refreshes. */
export function prepareBankForecast(records, doc) {
    const prepared = prepareMonthlyReports(records);
    const months = [...new Set(records.map(r => r.statement.paymentDate?.slice(0, 7))
            .filter((p) => !!p && /^\d{4}-(0[1-9]|1[0-2])$/.test(p)))];
    return { records, prepared, reports: new Map(), nisaRows: matchingNisaRows(doc, records), months };
}
export function forecastBankBalances(doc, asOf, records, income, payrollDepositAccount, today, work) {
    if (work && work.records !== records)
        throw new Error('口座予測の明細索引が一致しません。');
    const context = work ?? prepareBankForecast(records, doc);
    const accounts = forecastAssets(doc, asOf, records, income, payrollDepositAccount, context.nisaRows);
    const estimatedByAccount = {};
    const cardDebitByAccount = {};
    const fixedCostCardEstimatesByAccount = {};
    const autoTransferByAccount = {};
    const estimatedTransferByAccount = {};
    for (const month of context.months) {
        if (month > monthFromIndex(monthIndex(asOf) + 1))
            continue;
        let report = context.reports.get(month);
        if (!report) {
            report = monthlyReport(month, { records, rules: [], categories: [], assets: doc,
                payroll: { ready: false, syncedAt: null, entries: [] } }, context.prepared);
            context.reports.set(month, report);
        }
        for (const line of report.cardLines) {
            const transfer = mizuhoTransferForBill(line, doc);
            if (transfer) {
                for (const [id, sign] of [['rakuten-bank', -1], ['mizuho-bank', 1]]) {
                    const forecast = accounts[id];
                    if (forecast.balance === null || !forecast.baseline || transfer.date <= snapshotDay(forecast.baseline) || transfer.date > asOf)
                        continue;
                    forecast.balance += sign * transfer.amount;
                    if (!Number.isSafeInteger(forecast.balance))
                        throw Error('送金予測額が大きすぎます。');
                    autoTransferByAccount[id] = (autoTransferByAccount[id] ?? 0) + sign * transfer.amount;
                }
            }
            const account = doc.cardDebitAccounts?.[line.cardId];
            if (!account)
                continue;
            const balance = accounts[account];
            if (balance.balance === null || !balance.baseline)
                continue;
            if (line.paymentDate > snapshotDay(balance.baseline) && line.paymentDate <= asOf) {
                const after = balance.balance - line.amount;
                if (!Number.isSafeInteger(after))
                    throw Error('カード引落見込み額が大きすぎます。');
                balance.balance = after;
                cardDebitByAccount[account] = (cardDebitByAccount[account] ?? 0) + line.amount;
            }
        }
    }
    // Imported payment-month statements override all estimated contracts for that card.
    for (const estimate of estimatedCardFixedBills(doc, records, today, asOf)) {
        const account = doc.cardDebitAccounts?.[estimate.cardId];
        if (!account)
            continue;
        const bank = accounts[account];
        if (bank.balance === null || !bank.baseline || estimate.paymentDate <= snapshotDay(bank.baseline))
            continue;
        const result = bank.balance - estimate.amount;
        if (!Number.isSafeInteger(result))
            throw new Error('カード固定費の残高予測が大きすぎます。');
        bank.balance = result;
        fixedCostCardEstimatesByAccount[account] = (fixedCostCardEstimatesByAccount[account] ?? 0) + estimate.amount;
        const funding = mizuhoTransferForBill(estimate, doc);
        const note = funding && funding.date < today ? '推定請求の送金予定日が経過しているため、仮の送金は未反映です。' : '';
        bank.warning = [bank.warning, '固定費から推定したカード引落額を含みます（請求額未確定）。', note].filter(Boolean).join(' ');
        if (note) {
            const other = accounts['rakuten-bank'];
            other.warning = [other.warning, note].filter(Boolean).join(' ');
        }
    }
    for (const transfer of estimatedMizuhoFunding(doc, records, today, asOf)) {
        for (const [id, sign] of [['rakuten-bank', -1], ['mizuho-bank', 1]]) {
            const forecast = accounts[id];
            if (forecast.balance === null || !forecast.baseline || transfer.date <= snapshotDay(forecast.baseline))
                continue;
            forecast.balance += sign * transfer.amount;
            if (!Number.isSafeInteger(forecast.balance))
                throw Error('仮の送金予測額が大きすぎます。');
            estimatedTransferByAccount[id] = (estimatedTransferByAccount[id] ?? 0) + sign * transfer.amount;
            forecast.warning = [forecast.warning, '固定費から推定したみずほ送金を含みます（未確定）。'].filter(Boolean).join(' ');
        }
    }
    if (!payrollDepositAccount || !['rakuten-bank', 'cash-savings'].includes(payrollDepositAccount) || asOf < today)
        return { accounts, estimatedByAccount, estimates: [], cardDebitByAccount, fixedCostCardEstimatesByAccount, autoTransferByAccount, estimatedTransferByAccount };
    const balance = accounts[payrollDepositAccount];
    if (balance.balance === null || !balance.baseline)
        return { accounts, estimatedByAccount, estimates: [], cardDebitByAccount, fixedCostCardEstimatesByAccount, autoTransferByAccount, estimatedTransferByAccount };
    const baselineDay = snapshotDay(balance.baseline);
    const estimates = expectedMainSalaries(income, today, asOf).filter(estimate => {
        if (estimate.date <= baselineDay)
            return false;
        return !recurringInMonth(period(estimate.date), doc.recurring).some(event => event.entry.toAccountId === payrollDepositAccount && recurringSalaryRole(event.entry) === 'main');
    });
    let sum = 0;
    for (const item of estimates) {
        sum += item.amount;
        if (!Number.isSafeInteger(sum))
            throw new Error('給与見込みの集計額が大きすぎます。');
    }
    if (sum) {
        const next = balance.balance + sum;
        if (!Number.isSafeInteger(next))
            throw new Error('口座残高の見込み額が大きすぎます。');
        balance.balance = next;
        estimatedByAccount[payrollDepositAccount] = sum;
    }
    return { accounts, estimatedByAccount, estimates, cardDebitByAccount, fixedCostCardEstimatesByAccount, autoTransferByAccount, estimatedTransferByAccount };
}
