import { recurringForCalculation } from '../fixed-costs/payment-history.js';
/** Long-term savings outlook. Scenario changes are read-only and never written to assets.enc.
 * Existing balance snapshots remain the financial baseline; card/recurring inputs
 * are *scheduled*, not bank-confirmed. No actual NISA returns are inferred. */
import { recurringCoveredByOneTime } from './assets.js';
import { forecastAssets, matchingNisaRows } from './asset-projection.js';
import { recurringEffectiveAmount, recurringInMonth } from './recurring-schedule.js';
import { fixedCostState, monthlyEquivalent } from '../fixed-costs/contracts.js';
function period(value) { return /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value); }
function money(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000; }
function sum(a, b) {
    if (a === null || b === null)
        return null;
    const result = a + b;
    if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER)
        throw Error('将来予測額が数値の上限を超えました。');
    return result;
}
function stepMonth(month) {
    const year = Number(month.slice(0, 4)), mm = Number(month.slice(5));
    return `${year + (mm === 12 ? 1 : 0)}-${String(mm === 12 ? 1 : mm + 1).padStart(2, '0')}`;
}
function savingRulesFor(doc, account) {
    return recurringForCalculation(doc).filter(e => e.enabled && e.toAccountId === account && e.fromAccountId !== account && (e.kind === 'income' || e.kind === 'transfer'));
}
function overlaps(entry, start, end) {
    return entry.startOn <= end && (entry.endOn === null || entry.endOn >= start);
}
/** A configured bank schedule takes precedence while its validity overlaps a month.
 * A pause or an annual schedule's non-payment month is not a switch to card funding. */
function nisaScheduleInMonth(rules, month) {
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
    return rules.some(e => overlaps(e, `${month}-01`, `${month}-${lastDay}`));
}
/** Current monthly pace uses the effective amount, not the latest saved revision. */
export function currentSavingMonthly(doc, today, cardMonthly) {
    const cashRules = savingRulesFor(doc, 'cash-savings'), nisaRules = savingRulesFor(doc, 'nisa');
    const monthly = (rules) => Math.round(rules.reduce((sum, e) => sum + (fixedCostState({ ...e, pauses: e.pauses ?? [] }, today) === 'active' ? monthlyEquivalent({ frequency: e.frequency, amount: recurringEffectiveAmount(e, today) }) : 0), 0));
    return { cash: monthly(cashRules), nisa: nisaRules.some(e => overlaps(e, today, today)) ? monthly(nisaRules) : cardMonthly };
}
/** Historic classification is preserved; only samples in the current active
 * card-rule period may seed future contributions. */
export function suggestedNisaMonthly(doc, records, today, nisaMatches) {
    if (!doc.nisaCardRule?.enabled)
        return { amount: 0, source: 'NISAカード積立が未設定または無効です' };
    const cutoff = doc.nisaCardRuleHistory?.at(-1)?.effectiveOn;
    const matches = (nisaMatches ?? matchingNisaRows(doc, records)).filter(row => row.date <= today && (!cutoff || row.date >= cutoff));
    const perMonth = new Map();
    for (const row of matches)
        perMonth.set(row.date.slice(0, 7), (perMonth.get(row.date.slice(0, 7)) ?? 0) + row.amount);
    const last = [...perMonth].sort((a, b) => b[0].localeCompare(a[0]))[0];
    if (!last)
        return { amount: 0, source: 'NISA積立の実績がなく、将来積立額は未設定です' };
    const nowIdx = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7));
    const lastIdx = Number(last[0].slice(0, 4)) * 12 + Number(last[0].slice(5, 7));
    if (nowIdx - lastIdx > 6)
        return { amount: 0, source: '最新のNISAカード積立実績が6か月より前のため自動推定しません' };
    return { amount: last[1], source: `${last[0]}のNISAカード積立実績を仮置き（編集可能）` };
}
export function futureProjection(doc, records, options, nisaMatches) {
    const { today, targetMonth, changeMonth, savingsRuleId, savingsAmount, nisaMonthly, nisaAnnualReturn, cashScenarioMonthly = null, nisaScenarioMonthly = null } = options;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !period(today.slice(0, 7)) || !period(targetMonth) || !period(changeMonth) ||
        targetMonth < today.slice(0, 7) || !money(savingsAmount) || !money(nisaMonthly) ||
        (cashScenarioMonthly !== null && !money(cashScenarioMonthly)) ||
        (nisaScenarioMonthly !== null && !money(nisaScenarioMonthly)) ||
        !Number.isFinite(nisaAnnualReturn) || nisaAnnualReturn < 0 || nisaAnnualReturn > 0.3)
        throw Error('将来予測の年月・積立額・利回り設定が不正です。');
    const months = (Number(targetMonth.slice(0, 4)) - Number(today.slice(0, 4))) * 12 + Number(targetMonth.slice(5)) - Number(today.slice(5, 7));
    if (months > 600)
        throw Error('将来予測は50年以内にしてください。');
    const savingRules = savingRulesFor(doc, 'cash-savings');
    if (savingsRuleId !== null && !savingRules.some(e => e.id === savingsRuleId))
        throw Error('試算対象の貯金ルールが見つかりません。');
    const nisaRules = savingRulesFor(doc, 'nisa');
    const hasNisaSchedule = nisaRules.some(e => overlaps(e, today, today));
    const matches = nisaMatches ?? matchingNisaRows(doc, records);
    let conflictingNisaSources = hasNisaSchedule && nisaMonthly > 0;
    const starting = forecastAssets(doc, today, records, [], null, matches);
    // forecastAssets returns null when a confirmed balance snapshot is unavailable.
    // If no snapshot is present, never manufacture a 0-yen starting balance.
    const cashStart = starting['cash-savings'].balance;
    const nisaStart = starting.nisa.balance;
    let cash = cashStart, cashScenario = cashStart, nisa = nisaStart, nisaScenario = nisaStart;
    const growth = (1 + nisaAnnualReturn) ** (1 / 12);
    const points = [];
    const addPoint = (month) => points.push({ month, cash, cashScenario, nisa, nisaScenario,
        combined: sum(cash, nisa), combinedScenario: sum(cashScenario, nisaScenario) });
    // Do not apply a hypothetical monthly replacement to a partially elapsed month.
    // Any remaining events in the current month retain their original amounts.
    const currentPeriod = today.slice(0, 7);
    let current = currentPeriod;
    const recurring = recurringForCalculation(doc);
    for (let i = 0; i <= months; i++) {
        const replacingCash = cashScenarioMonthly !== null && current >= changeMonth && current > currentPeriod;
        const replacingNisa = nisaScenarioMonthly !== null && current >= changeMonth && current > currentPeriod;
        const events = recurringInMonth(current, recurring);
        for (const event of events) {
            if (event.date <= today)
                continue;
            const e = event.entry;
            if (recurringCoveredByOneTime(e, event.date, doc.oneTime, undefined, recurring))
                continue;
            const cashDelta = (e.toAccountId === 'cash-savings' ? e.amount : 0) - (e.fromAccountId === 'cash-savings' ? e.amount : 0);
            // Legacy single-rule scenario remains supported for prior saved/test integrations.
            const legacyChanged = cashScenarioMonthly === null && e.id === savingsRuleId && current >= changeMonth;
            const scenarioCashDelta = replacingCash && cashDelta > 0 ? 0 : legacyChanged ?
                (e.toAccountId === 'cash-savings' ? savingsAmount : 0) - (e.fromAccountId === 'cash-savings' ? savingsAmount : 0) : cashDelta;
            const nisaDelta = (e.toAccountId === 'nisa' ? e.amount : 0) - (e.fromAccountId === 'nisa' ? e.amount : 0);
            const scenarioNisaDelta = replacingNisa && nisaDelta > 0 ? 0 : nisaDelta;
            if (cash !== null)
                cash = sum(cash, cashDelta);
            if (cashScenario !== null)
                cashScenario = sum(cashScenario, scenarioCashDelta);
            if (nisa !== null)
                nisa = sum(nisa, nisaDelta);
            if (nisaScenario !== null)
                nisaScenario = sum(nisaScenario, scenarioNisaDelta);
        }
        // One-off future transfers contribute once. They are not recurring principal,
        // so a hypothetical change to monthly saving never alters these records.
        for (const entry of doc.oneTime ?? []) {
            if (entry.date <= today || entry.date.slice(0, 7) !== current)
                continue;
            const cashDelta = (entry.toAccountId === 'cash-savings' ? entry.amount : 0) - (entry.fromAccountId === 'cash-savings' ? entry.amount : 0);
            const nisaDelta = (entry.toAccountId === 'nisa' ? entry.amount : 0) - (entry.fromAccountId === 'nisa' ? entry.amount : 0);
            if (cash !== null)
                cash = sum(cash, cashDelta);
            if (cashScenario !== null)
                cashScenario = sum(cashScenario, cashDelta);
            if (nisa !== null)
                nisa = sum(nisa, nisaDelta);
            if (nisaScenario !== null)
                nisaScenario = sum(nisaScenario, nisaDelta);
        }
        // Apply replacement monthly principal once, regardless of the number or
        // frequency of underlying recurring instructions. No bank transfers occur.
        if (replacingCash && cashScenario !== null)
            cashScenario = sum(cashScenario, cashScenarioMonthly);
        if (current > currentPeriod) {
            const scheduled = nisaScheduleInMonth(nisaRules, current);
            const cardPrincipal = scheduled ? 0 : nisaMonthly;
            if (scheduled && nisaMonthly > 0)
                conflictingNisaSources = true;
            if (nisa !== null)
                nisa = Math.round((nisa + cardPrincipal) * growth);
            if (nisaScenario !== null)
                nisaScenario = Math.round((nisaScenario + (replacingNisa ? nisaScenarioMonthly : cardPrincipal)) * growth);
            if ((nisa !== null && !Number.isSafeInteger(nisa)) || (nisaScenario !== null && !Number.isSafeInteger(nisaScenario)))
                throw Error('NISAの将来予測額が大きすぎます。');
        }
        addPoint(current);
        current = stepMonth(current);
    }
    return { points, cashStart, nisaStart, savingRules, hasNisaSchedule, conflictingNisaSources, target: points[points.length - 1] };
}
/** Age is a calendar-month approximation: the 40th birthday month is birth year+40. */
export function targetMonthForAge(birthMonth, age) {
    if (!period(birthMonth) || !Number.isInteger(age) || age < 1 || age > 110)
        return null;
    const y = Number(birthMonth.slice(0, 4)) + age;
    if (y > 2199)
        return null;
    return `${y}-${birthMonth.slice(5)}`;
}
/** Select only birthday months that the projection engine can actually calculate. */
export function projectionAgeBounds(birthMonth, todayMonth) {
    if (!period(birthMonth) || !period(todayMonth))
        return null;
    const birth = Number(birthMonth.slice(0, 4)) * 12 + Number(birthMonth.slice(5, 7)) - 1;
    const today = Number(todayMonth.slice(0, 4)) * 12 + Number(todayMonth.slice(5, 7)) - 1;
    const min = Math.max(18, Math.ceil((today - birth) / 12));
    const max = Math.min(80, Math.floor((today + 600 - birth) / 12));
    return min <= max ? { min, max } : null;
}
