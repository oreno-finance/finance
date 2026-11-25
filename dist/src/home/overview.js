/** Home uses the unchanged monthlyReport as its only household cashflow source. */
import { ASSET_ACCOUNTS } from '../cloud/assets.js';
import { changePeriod, monthlyReport, monthlyCashflow } from '../summary/monthly-summary.js';
import { lastDayOfNextMonth } from '../cloud/asset-projection.js';
import { prepareBankForecast, forecastBankBalances } from '../cloud/salary-projection.js';
import { forecastAccounts } from './account-events.js';
import { homeActions } from './action-items.js';
import { pendingCardSubscriptions } from '../subscriptions/detect.js';
export function homeOverview(source, today) {
    const currentPeriod = today.slice(0, 7);
    const assets = { ...source.assets, snapshots: source.assets.snapshots ?? [] };
    const work = prepareBankForecast(source.records, assets);
    const prepared = work.prepared;
    const adjusted = { ...source, currentPeriod };
    const byMonth = new Map();
    const reportForMonth = (period) => {
        let report = byMonth.get(period);
        if (!report) {
            report = monthlyReport(period, adjusted, prepared);
            byMonth.set(period, report);
        }
        return report;
    };
    const report = reportForMonth(currentPeriod);
    const forecast = forecastAccounts(source, today, 45, reportForMonth);
    const previousPeriod = changePeriod(currentPeriod, -1);
    // Even a prior 'done' needs revalidation after a bill has changed.
    const priorFundingReport = source.assets.mizuhoTransferPlan?.enabled &&
        source.assets.cardDebitAccounts?.['rakuten-mizuho'] === 'mizuho-bank'
        ? reportForMonth(previousPeriod) : null;
    const cashflow = monthlyCashflow(report);
    const coverage = cashflow.coverage === 'review' ? 'needs-review' : cashflow.coverage;
    const outflow = cashflow.expense;
    // Same projection as account management, including NISA and opted-in Payroll.
    const income = source.payroll.ready ? [...source.payroll.entries] : [];
    const deposit = assets.payrollDepositAccount ?? null;
    const current = forecastBankBalances(assets, today, source.records, income, deposit, today, work).accounts;
    const next = forecastBankBalances(assets, lastDayOfNextMonth(new Date(`${today}T12:00:00`)), source.records, income, deposit, today, work).accounts;
    const accounts = ASSET_ACCOUNTS.map(({ id, name }) => ({ id, name, snapshot: current[id].baseline, current: current[id].balance,
        predicted: next[id].balance, warning: current[id].warning ?? next[id].warning }));
    const cardNames = Object.fromEntries(Object.entries(source.assets.cardPreferences ?? {}).filter(([, preference]) => !!preference.name).map(([id, preference]) => [id, preference.name]));
    const actions = homeActions(source, report, forecast, today);
    const candidates = pendingCardSubscriptions(source, today.slice(0, 7));
    if (candidates.length)
        actions.push({ id: 'card-subscription-candidates', kind: 'subscription', severity: 'low',
            title: `定期支出の候補が${candidates.length}件あります`, target: 'subscriptions' });
    return { today, period: report.period, report, coverage, outflow, cardNames, accounts, forecast, actions, priorFundingReport };
}
