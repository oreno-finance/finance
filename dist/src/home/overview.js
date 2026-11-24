import { changePeriod, monthlyReport, monthlyCashflow, prepareMonthlyReports } from '../summary/monthly-summary.js';
import { forecastAccounts } from './account-events.js';
import { homeActions } from './action-items.js';
import { pendingCardSubscriptions } from '../subscriptions/detect.js';
export function homeOverview(source, today) {
    const currentPeriod = today.slice(0, 7);
    const prepared = prepareMonthlyReports(source.records);
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
    const bankAccountIds = ['rakuten-bank', 'mizuho-bank', 'cash-savings', 'nisa'];
    const labels = { 'rakuten-bank': '楽天銀行', 'mizuho-bank': 'みずほ銀行',
        'cash-savings': '貯金口座', 'nisa': 'NISA' };
    const accounts = bankAccountIds.map(id => {
        const snapshot = source.assets.snapshots?.filter(s => s.accountId === id &&
            new Date(s.observedAt).getTime() <= new Date(`${today}T23:59:59Z`).getTime())
            .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0] ?? null;
        const bank = forecast.accounts.find(item => item.accountId === id);
        return { id, name: labels[id], snapshot, predicted: bank?.projected ?? null,
            predictedReliable: bank?.reliable ?? false, projectedAt: bank?.projectedAt ?? null };
    });
    const cardNames = Object.fromEntries(Object.entries(source.assets.cardPreferences ?? {}).filter(([, preference]) => !!preference.name).map(([id, preference]) => [id, preference.name]));
    const actions = homeActions(source, report, forecast, today);
    const candidates = pendingCardSubscriptions(source, today.slice(0, 7));
    if (candidates.length)
        actions.push({ id: 'card-subscription-candidates', kind: 'subscription', severity: 'low',
            title: `定期支出の候補が${candidates.length}件あります`, target: 'subscriptions' });
    return { today, period: report.period, report, coverage, outflow, cardNames, accounts, forecast, actions, priorFundingReport };
}
