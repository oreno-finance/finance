import { fixedCostCalculationAssets } from '../fixed-costs/rule-fixed-costs.js';
/** Home uses the unchanged monthlyReport as its only household cashflow source. */
import { ASSET_ACCOUNTS } from '../cloud/assets.js';
import { changePeriod, monthlyReport, monthlyCashflow } from '../summary/monthly-summary.js';
import { prepareBankForecast, forecastBankBalances } from '../cloud/salary-projection.js';
import { forecastAccounts } from './account-events.js';
import { homeActions } from './action-items.js';
import { pendingCardSubscriptions } from '../subscriptions/detect.js';
export function homeOverview(source, today) {
    const currentPeriod = today.slice(0, 7);
    const assets = fixedCostCalculationAssets(source, today);
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
    const previousReport = reportForMonth(previousPeriod);
    const balanceDelta = report.monthlyBalance === null || previousReport.monthlyBalance === null ? null : report.monthlyBalance - previousReport.monthlyBalance;
    // Even a prior 'done' needs revalidation after a bill has changed.
    const priorFundingReport = source.assets.mizuhoTransferPlan?.enabled &&
        source.assets.cardDebitAccounts?.['rakuten-mizuho'] === 'mizuho-bank'
        ? previousReport : null;
    const cashflow = monthlyCashflow(report);
    const coverage = cashflow.coverage === 'review' ? 'needs-review' : cashflow.coverage;
    const outflow = cashflow.expense;
    // Same projection as account management, including NISA and opted-in Payroll.
    const income = source.payroll.ready ? [...source.payroll.entries] : [];
    const deposit = assets.payrollDepositAccount ?? null;
    const current = forecastBankBalances(assets, today, source.records, income, deposit, today, work).accounts;
    const accounts = ASSET_ACCOUNTS.map(({ id, name }) => ({ id, name, snapshot: current[id].baseline, current: current[id].balance,
        warning: current[id].warning }));
    // Use the very same daily events as the Home debit warnings. Do not add the
    // monthly household balance to observed money (that would count past flows twice).
    const monthEndDate = `${currentPeriod}-${String(new Date(Date.UTC(Number(currentPeriod.slice(0, 4)), Number(currentPeriod.slice(5)), 0)).getUTCDate()).padStart(2, '0')}`;
    const bankEnd = (id) => {
        const account = forecast.accounts.find(a => a.accountId === id);
        if (!account?.observed || account.projected === null)
            return null;
        return account.days.filter(day => day.date <= monthEndDate).at(-1)?.balance ?? account.observed.balance;
    };
    const rakuten = bankEnd('rakuten-bank'), mizuho = bankEnd('mizuho-bank');
    const sum = rakuten === null || mizuho === null ? null : rakuten + mizuho;
    const monthEnd = { date: monthEndDate, rakuten, mizuho, total: sum !== null && Number.isSafeInteger(sum) ? sum : null,
        sameDayEvents: forecast.accounts.some(a => a.accountId !== 'cash-savings' && a.sameDayEvents),
        reference: coverage !== 'registered' || forecast.accounts.some(a => a.accountId !== 'cash-savings' && (!a.reliable || a.sameDayEvents)) ||
            forecast.accounts.some(a => a.accountId !== 'cash-savings' && a.days.some(d => d.date <= monthEndDate && d.events.some(e => e.kind === 'salary-estimate' || e.estimated || e.movementStatus === 'estimated' || e.movementStatus === 'planned'))) };
    const cardNames = Object.fromEntries(Object.entries(source.assets.cardPreferences ?? {}).filter(([, preference]) => !!preference.name).map(([id, preference]) => [id, preference.name]));
    const actions = homeActions(source, report, forecast, today);
    const candidates = pendingCardSubscriptions(source, today.slice(0, 7));
    if (candidates.length)
        actions.push({ id: 'card-subscription-candidates', kind: 'subscription', severity: 'low',
            title: `定期支出の候補が${candidates.length}件あります`, target: 'subscription-candidates' });
    return { today, period: report.period, report, coverage, outflow, balanceDelta, cardNames, accounts, forecast, actions, monthEnd, priorFundingReport };
}
