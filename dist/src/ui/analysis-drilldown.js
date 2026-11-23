/** Read-only drill-down for analysis. Source of truth is the same monthlyReport used by analytics.
 * The payment month (not billing/usage month) decides membership. No cloud mutation occurs. */
import { displayMerchant, matchingRule } from '../cloud/merchant-rules.js';
import { monthlyReport, prepareMonthlyReports, isNisaCardRow, isValidPeriod } from '../summary/monthly-summary.js';
export function validateAnalysisDrilldown(request) {
    if (!request || !['card', 'category', 'merchant'].includes(request.dimension) ||
        !Array.isArray(request.periods) || !request.periods.length || request.periods.length > 12 ||
        new Set(request.periods).size !== request.periods.length ||
        request.periods.some(p => typeof p !== 'string' || !isValidPeriod(p)) ||
        typeof request.value !== 'string' || !request.value.trim() || request.value.length > 200 ||
        typeof request.label !== 'string' || !request.label.trim() || request.label.length > 200) {
        throw new Error('明細の絞り込み条件が不正です。');
    }
}
/** Remote record ID => original row IDs. A record with no matching rows is absent.
 * Invalid/duplicate statements are excluded exactly as in monthlyReport. */
export function analysisDrilldownMatches(source, request, reports) {
    validateAnalysisDrilldown(request);
    const prepared = reports ? null : prepareMonthlyReports(source.records);
    const result = new Map();
    const recordsById = new Map(source.records.map(record => [record.id, record]));
    for (const period of request.periods) {
        const report = reports?.get(period) ?? monthlyReport(period, source, prepared ?? undefined);
        for (const card of report.cardLines) {
            if (request.dimension === 'card' && card.cardId !== request.value)
                continue;
            const record = recordsById.get(card.id);
            if (!record)
                continue;
            const statement = record.statement;
            for (const row of statement.rows) {
                if (request.dimension !== 'card' && isNisaCardRow(row, statement, source.assets))
                    continue;
                if (request.dimension === 'category') {
                    const resolved = matchingRule(row.merchant, statement.cardId, source.rules)?.categoryId;
                    const categoryId = source.categories.some(c => c.id === resolved) ? resolved : '__unclassified';
                    if (categoryId !== request.value)
                        continue;
                }
                else if (request.dimension === 'merchant' &&
                    displayMerchant(row.merchant, statement.cardId, source.rules, row.merchantOverride) !== request.value) {
                    continue;
                }
                const matches = result.get(card.id) ?? new Set();
                matches.add(row.id);
                result.set(card.id, matches);
            }
        }
    }
    return result;
}
export function drilldownPeriodLabel(periods) {
    if (periods.length === 1)
        return periods[0];
    return `${periods[0]}〜${periods[periods.length - 1]}`;
}
/** The category aggregate includes scheduled bank recurrences; show them alongside card rows.
 * Merchant and card aggregates contain card rows only. No mutation and no heuristic matching. */
export function analysisDrilldownBreakdown(source, request, reports) {
    validateAnalysisDrilldown(request);
    // Direct callers also get one shared prepared index and one report per month.
    const byPeriod = reports ?? (() => {
        const prepared = prepareMonthlyReports(source.records);
        return new Map(request.periods.map(period => [period, monthlyReport(period, source, prepared)]));
    })();
    const matches = analysisDrilldownMatches(source, request, byPeriod);
    const safeAdd = (a, b) => {
        const n = a + b;
        if (!Number.isSafeInteger(n))
            throw new Error('分析金額が安全な整数範囲を超えました。');
        return n;
    };
    let cardAmount = 0, recurringAmount = 0;
    for (const record of source.records) {
        const rowIds = matches.get(record.id);
        if (!rowIds)
            continue;
        for (const row of record.statement.rows)
            if (rowIds.has(row.id))
                cardAmount = safeAdd(cardAmount, row.amount);
    }
    const recurring = [];
    if (request.dimension === 'category') {
        for (const period of request.periods) {
            const report = byPeriod.get(period) ?? monthlyReport(period, source);
            for (const line of report.recurringLines) {
                if (line.kind !== 'expense')
                    continue;
                const category = source.categories.some(item => item.id === line.categoryId) ? line.categoryId : '__unclassified';
                if (category !== request.value)
                    continue;
                recurringAmount = safeAdd(recurringAmount, line.amount);
                recurring.push({ ...line, period });
            }
        }
    }
    recurring.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    return { cardAmount, recurringAmount, total: safeAdd(cardAmount, recurringAmount), recurring };
}
