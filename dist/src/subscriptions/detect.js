/** P1-C: read-only detection of card-paid recurring charges.
 * Payment month is the ONLY period axis. A suggestion never changes household cashflow. */
import { CARDS } from '../models/types.js';
import { displayMerchant, normalizeMerchant, fixedRuleKey } from '../cloud/merchant-rules.js';
import { cardRecurringKey, nisaRuleOnDay } from '../cloud/assets.js';
import { contractMerchantKeys, contractPaymentHistory, paymentTermsOn } from '../fixed-costs/payment-history.js';
import { importErrors } from '../importers/batch-policy.js';
const periodNumber = (p) => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7)) - 1;
const validDate = (d) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const close = (a, b) => Math.abs(a - b) <= Math.max(100, Math.round(Math.min(a, b) * 0.08));
const median = (items) => [...items].sort((a, b) => a - b)[Math.floor(items.length / 2)];
const todayPeriod = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
/** A single evidence pipeline for suggestions and registered charge comparisons.
 * This never edits a saved decision and excludes unsafe/ambiguous source records. */
function eligibleCardChargeGroups(source, asOf, allowFuturePayment = false) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(asOf))
        throw new Error('検出対象の年月が不正です。');
    const permittedCards = new Set(CARDS.map(item => item.id));
    const duplicate = new Map();
    for (const { statement: s } of source.records) {
        if (!s.cardId || !s.billingMonth)
            continue;
        const id = `${s.cardId}|${s.billingMonth}`;
        duplicate.set(id, (duplicate.get(id) ?? 0) + 1);
    }
    const groups = new Map();
    for (const record of source.records) {
        const s = record.statement;
        if (!s.cardId || !permittedCards.has(s.cardId) || s.confirmation !== 'confirmed' || !validDate(s.paymentDate) ||
            !s.billingMonth || duplicate.get(`${s.cardId}|${s.billingMonth}`) !== 1 ||
            importErrors(s, s.sourceKind !== 'pdf' || !!record.originalId).length)
            continue;
        const period = s.paymentDate.slice(0, 7);
        if ((!allowFuturePayment && period > asOf) || periodNumber(asOf) - periodNumber(period) > 37)
            continue;
        for (const row of s.rows) {
            if (!Number.isSafeInteger(row.amount) || row.amount === 0 || (!allowFuturePayment && row.amount < 0) || !validDate(row.usedOn))
                continue;
            const nisa = nisaRuleOnDay(source.assets, row.usedOn);
            if (nisa?.enabled && nisa.cardId === s.cardId && normalizeMerchant(row.merchant).includes(normalizeMerchant(nisa.merchantContains)))
                continue;
            const merchant = displayMerchant(row.merchant, s.cardId, source.rules, row.merchantOverride).trim();
            if (!merchant || merchant.length > 100 || normalizeMerchant(row.merchant).length > 160 || cardRecurringKey(s.cardId, row.merchant).length > 240)
                continue;
            // The issuer's original merchant survives display-rule renames.
            const key = cardRecurringKey(s.cardId, row.merchant);
            const group = groups.get(key) ?? { cardId: s.cardId, merchant, values: [] };
            group.values.push({ period, amount: row.amount, usedOn: row.usedOn, paymentDate: s.paymentDate });
            groups.set(key, group);
        }
    }
    return groups;
}
/** Actual usage, not a manually maintained contract price. Include imported future-debit statements. */
export function fixedCostEvidence(source, today) {
    return new Map([...eligibleCardChargeGroups(source, today.slice(0, 7), true)].map(([key, group]) => [key, group.values.filter(x => x.usedOn <= today)]));
}
export function fixedRuleRegisteredKeys(source) {
    return new Set(source.rules.flatMap(r => r.fixedCost ? [fixedRuleKey(r), ...(r.fixedCost.previous ?? []).map(x => x.key)] : []));
}
export function latestRegisteredCardCharges(source, asOf = todayPeriod()) {
    const result = new Map();
    for (const [key, group] of eligibleCardChargeGroups(source, asOf)) {
        const month = group.values.reduce((latest, item) => item.period > latest ? item.period : latest, '');
        const latest = group.values.filter(item => item.period === month);
        result.set(key, latest.length === 1 ? { month, amount: latest[0].amount } : null);
    }
    return result;
}
export function latestRegisteredCardCharge(source, key, asOf = todayPeriod()) {
    return latestRegisteredCardCharges(source, asOf).get(key) ?? null;
}
/** Match the actual usage date to the contract's routing history. */
export function contractCardEvidence(source, today) {
    const groups = eligibleCardChargeGroups(source, today.slice(0, 7));
    return item => {
        const observations = [];
        if ('kind' in item && !item.enabled)
            return observations;
        const keys = new Set(contractPaymentHistory(item).flatMap(x => x.merchantKey ? [x.merchantKey] : []));
        for (const key of keys) {
            const group = groups.get(key);
            if (!group)
                continue;
            for (const value of group.values) {
                if (value.usedOn < item.startOn || value.usedOn > today || value.paymentDate > today || (item.endOn !== null && value.usedOn > item.endOn))
                    continue;
                const terms = paymentTermsOn(item, value.usedOn);
                if (terms.payment === 'card' && terms.cardId === group.cardId && terms.merchantKey === key)
                    observations.push({ ...value, cardId: group.cardId });
            }
        }
        return observations.sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || b.usedOn.localeCompare(a.usedOn));
    };
}
export function latestContractCardCharge(observations) {
    const month = observations.reduce((latest, x) => x.period > latest ? x.period : latest, '');
    const latest = observations.filter(x => x.period === month);
    return latest.length === 1 ? { month, amount: latest[0].amount } : null;
}
/** Detection accepts only valid, confirmed, uniquely-billed statements. */
export function detectCardSubscriptions(source, asOf = todayPeriod()) {
    const groups = eligibleCardChargeGroups(source, asOf);
    const results = [];
    for (const [key, group] of groups) {
        // Multiple charges on the same card / merchant / payment month are ambiguous.
        const byMonth = new Map();
        for (const item of group.values) {
            const values = byMonth.get(item.period) ?? [];
            values.push(item);
            byMonth.set(item.period, values);
        }
        const distinct = [...byMonth.values()].filter(items => items.length === 1).map(items => items[0]).sort((a, b) => a.period.localeCompare(b.period));
        if (distinct.length < 2)
            continue;
        let winner = null;
        // Treat each observed amount as a possible price tier, then pick the most recent substantial pattern.
        for (const anchor of distinct) {
            const closeRows = distinct.filter(o => close(o.amount, anchor.amount));
            const run = [];
            let running = [];
            for (const obs of closeRows) {
                if (running.length && periodNumber(obs.period) - periodNumber(running.at(-1).period) > 1) {
                    run.push(running);
                    running = [];
                }
                running.push(obs);
            }
            if (running.length)
                run.push(running);
            for (const values of run) {
                const recency = periodNumber(asOf) - periodNumber(values.at(-1).period);
                if (values.length >= 3 && recency <= 3 && (!winner || winner.frequency === 'yearly' || values.length > winner.values.length ||
                    (values.length === winner.values.length && values.at(-1).period > winner.values.at(-1).period)))
                    winner = { frequency: 'monthly', values };
            }
            // Yearly: two different years, roughly twelve months apart, never inferred from one charge.
            if (!winner) {
                for (let i = 1; i < closeRows.length; i++) {
                    const a = closeRows[i - 1], b = closeRows[i];
                    if (periodNumber(b.period) - periodNumber(a.period) !== 12 || periodNumber(asOf) - periodNumber(b.period) > 14)
                        continue;
                    winner = { frequency: 'yearly', values: [a, b] };
                }
            }
        }
        if (!winner)
            continue;
        const { frequency, values } = winner;
        // An already registered bank-side recurring expense is not proposed as a new card charge.
        if (source.assets.recurring.some(item => item.enabled && item.kind === 'expense' && item.frequency === frequency &&
            normalizeMerchant(item.name) === normalizeMerchant(group.merchant) && close(item.amount, median(values.map(v => v.amount)))))
            continue;
        const amount = median(values.map(v => v.amount));
        results.push({ key, cardId: group.cardId, cardName: source.assets.cardPreferences?.[group.cardId]?.name ?? CARDS.find(c => c.id === group.cardId)?.name ?? 'カード',
            merchant: group.merchant, frequency, amount, minAmount: Math.min(...values.map(v => v.amount)), maxAmount: Math.max(...values.map(v => v.amount)),
            months: values.map(v => v.period), confidence: frequency === 'monthly' && values.length >= 4 ? 'high' : 'medium' });
    }
    return results.sort((a, b) => b.months.at(-1).localeCompare(a.months.at(-1)) || b.months.length - a.months.length || a.merchant.localeCompare(b.merchant, 'ja'));
}
export function pendingCardSubscriptions(source, asOf) {
    const decisions = source.assets.cardRecurringDecisions ?? {};
    const registered = contractMerchantKeys(source.assets);
    for (const key of fixedRuleRegisteredKeys(source))
        registered.add(key);
    return detectCardSubscriptions(source, asOf).filter(candidate => !matchedCardRecurringDecision(decisions, candidate) && !registered.has(candidate.key));
}
export function subscriptionDecision(candidate, state, now = new Date().toISOString()) {
    return { cardId: candidate.cardId, merchant: candidate.key.slice(candidate.cardId.length + 1), label: candidate.merchant, amount: candidate.amount,
        frequency: candidate.frequency, state, updatedAt: now };
}
/** Read old display-name-keyed decisions without changing encrypted storage.
 * A renamed legacy alias cannot be mapped reliably without user confirmation. */
export function matchedCardRecurringDecision(decisions, candidate) {
    if (decisions[candidate.key])
        return candidate.key;
    const legacy = cardRecurringKey(candidate.cardId, candidate.merchant);
    return decisions[legacy] ? legacy : null;
}
/** Offer *manual* migration only when the old decision and new candidate form
 * an unambiguous one-to-one pair for the same card and recurrence frequency. */
export function legacyDecisionMigrationCandidate(decisions, candidates, candidate) {
    if (matchedCardRecurringDecision(decisions, candidate))
        return null;
    const unlinked = candidates.filter(c => !matchedCardRecurringDecision(decisions, c) && c.cardId === candidate.cardId);
    const linked = new Set(candidates.flatMap(c => {
        const key = matchedCardRecurringDecision(decisions, c);
        return key ? [key] : [];
    }));
    const orphaned = Object.entries(decisions).filter(([key, item]) => !linked.has(key) && item.cardId === candidate.cardId && item.frequency === candidate.frequency);
    const peers = unlinked.filter(c => c.frequency === candidate.frequency);
    return orphaned.length === 1 && peers.length === 1 ? orphaned[0][0] : null;
}
