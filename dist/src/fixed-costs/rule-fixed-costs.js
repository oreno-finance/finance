/** Read-only projection from encrypted rule metadata and confirmed card rows. */
import { fixedRuleKey, fixedRuleEligible, matchingRule, sortedRules } from '../cloud/merchant-rules.js';
import { fixedCostEvidence } from '../subscriptions/detect.js';
import { fixedCostState, pausedOnDay, withCardForecastPrice } from './contracts.js';
import { fixedCostsForCalculation } from './payment-history.js';
export function latestFixedEvidence(rows, frequency) {
    const sorted = [...rows].sort((a, b) => b.usedOn.localeCompare(a.usedOn) || b.paymentDate.localeCompare(a.paymentDate));
    const latest = sorted[0];
    if (!latest)
        return null;
    // An identical issuer merchant may be used for both ordinary and recurring purchases.
    const peers = sorted.filter(r => frequency === 'weekly' ? r.usedOn === latest.usedOn : frequency === 'yearly' ? r.usedOn.slice(0, 4) === latest.usedOn.slice(0, 4) : r.usedOn.slice(0, 7) === latest.usedOn.slice(0, 7));
    return latest.amount > 0 && peers.length === 1 ? latest : null;
}
export function ruleFixedCharge(source, rule, today, evidence = fixedCostEvidence(source, today)) {
    const fixed = rule.fixedCost;
    if (!fixed)
        return null;
    const history = fixed.previous ?? [];
    const current = (fixed.endOn && fixed.endOn < fixed.startOn ? [] : evidence.get(fixedRuleKey(rule)) ?? []).filter(r => (!history.length || r.usedOn >= fixed.startOn) && (!fixed.endOn || r.usedOn <= fixed.endOn) && !pausedOnDay(fixed.pauses ?? [], r.usedOn));
    if (current.length)
        return latestFixedEvidence(current, fixed.frequency);
    for (let i = history.length - 1; i >= 0; i--) {
        const previous = history[i];
        const lower = previous.startOn ?? history[i - 1]?.through;
        const upper = history[i + 1]?.through ?? fixed.startOn;
        // Legacy history stored the change date inclusively. Exclude that boundary
        // rather than using a potentially unrelated observation as a price.
        const rows = (evidence.get(previous.key) ?? []).filter(r => r.usedOn < previous.through && r.usedOn < upper && (!lower || r.usedOn >= lower) && !pausedOnDay(previous.pauses ?? [], r.usedOn));
        if (rows.length) {
            if (rows.some(row => source.rules.some(other => other.id !== rule.id && ruleOwnsKeyOnDay(other, previous.key, row.usedOn))))
                return null;
            const charge = latestFixedEvidence(rows, previous.frequency ?? fixed.frequency);
            return charge ? { ...charge, previousRoute: true } : null;
        }
    }
    return null;
}
/** Only plain card contracts can be retired into rules without losing dated non-card routes. */
export function migratableCardCost(item) {
    return item.payment === 'card' && !!item.cardId && (!item.merchantKey || item.merchantKey.startsWith(item.cardId + '|')) && !item.paymentHistory;
}
export function migratedCardCostIds(source) {
    return new Set([...(source.fixedCostMigrations ?? []), ...source.rules.flatMap(r => r.fixedCost?.legacyId ? [r.fixedCost.legacyId] : [])]);
}
/** A later non-overlapping contract does not own a former route's observations. */
function ruleOwnsKeyOnDay(rule, key, day) {
    const f = rule.fixedCost;
    if (!f)
        return false;
    if (f.endOn && day > f.endOn)
        return false;
    if (fixedRuleKey(rule) === key && day >= f.startOn)
        return !pausedOnDay(f.pauses ?? [], day);
    return (f.previous ?? []).some((route, i) => route.key === key && day >= (route.startOn ?? f.previous?.[i - 1]?.through ?? '0001-01-01') && day < route.through && !pausedOnDay(route.pauses ?? [], day));
}
/** Compare dated card-route intervals, not a permanent ownership of a key.
 * Unknown legacy start/end boundaries remain conservative. */
export function ruleOverlapsContract(rule, contract) {
    const f = rule.fixedCost;
    if (!f)
        return false;
    const routes = fixedCostsForCalculation({ recurring: 'kind' in contract ? [contract] : [], fixedCosts: 'payment' in contract ? [contract] : [] });
    const previous = f.previous ?? [];
    const ruleRoutes = [...previous.map((p, i) => ({ key: p.key, start: p.startOn ?? previous[i - 1]?.through ?? '0001-01-01', endExclusive: p.through })), { key: fixedRuleKey(rule), start: f.startOn, endExclusive: null }];
    return routes.some(route => route.payment === 'card' && !!route.merchantKey && ruleRoutes.some(r => {
        if (r.key !== route.merchantKey)
            return false;
        const lower = route.startOn > r.start ? route.startOn : r.start;
        return (!route.endOn || lower <= route.endOn) && (!f.endOn || lower <= f.endOn) && (!r.endExclusive || lower < r.endExclusive);
    }));
}
export function legacyCardCostForRule(source, rule) {
    const migrated = migratedCardCostIds(source);
    const matches = (source.assets.fixedCosts ?? []).filter(x => migratableCardCost(x) && !migrated.has(x.id) && x.merchantKey === fixedRuleKey(rule) && (!rule.fixedCost || ruleOverlapsContract(rule, x)));
    return matches.length === 1 ? matches[0] : undefined;
}
export function ruleFixedState(f, today) {
    return f.state === 'active' ? fixedCostState({ startOn: f.startOn, endOn: f.endOn ?? null, pauses: f.pauses ?? [] }, today) : f.state;
}
export function fixedCostRuleViews(source, today) {
    const evidence = fixedCostEvidence(source, today);
    return source.rules.flatMap(rule => {
        const f = rule.fixedCost;
        if (!f)
            return [];
        const charge = ruleFixedCharge(source, rule, today, evidence);
        const categoryId = matchingRule(rule.pattern, rule.cardId, source.rules)?.categoryId ?? null;
        return [{ rule, charge, categoryId, status: ruleFixedState(f, today) }];
    });
}
/** No write, no synthetic actual expense. Only future estimates use the projected price. */
export function fixedCostCalculationAssets(source, today) {
    const migrated = migratedCardCostIds(source), evidence = fixedCostEvidence(source, today);
    const fixedCosts = (source.assets.fixedCosts ?? []).flatMap(item => {
        if (migratableCardCost(item) && (migrated.has(item.id) || source.rules.some(rule => ruleOverlapsContract(rule, item))))
            return [];
        if (!migratableCardCost(item) || !item.merchantKey)
            return [item]; // retain unresolved or mixed historical routes
        const charge = latestFixedEvidence((evidence.get(item.merchantKey) ?? []).filter(r => r.usedOn >= item.startOn && (!item.endOn || r.usedOn <= item.endOn) && !pausedOnDay(item.pauses, r.usedOn)), item.frequency);
        if (!charge)
            return [item]; // preserve the legacy registered price until explicit migration
        return [withCardForecastPrice(item, { effectiveOn: charge.usedOn, amount: charge.amount })];
    });
    for (const { rule, charge, categoryId } of fixedCostRuleViews(source, today)) {
        const f = rule.fixedCost;
        const registered = source.assets.fixedCosts?.find(x => x.id === f.legacyId);
        const append = (key, startOn, endOn, frequency, pauses, price) => {
            if (endOn && endOn < startOn)
                return;
            const cardId = key.slice(0, key.indexOf('|')), day = Number(price.usedOn.slice(8, 10));
            fixedCosts.push(withCardForecastPrice({ id: f.legacyId ?? rule.id, name: rule.displayName, payment: 'card', cardId, merchantKey: key, categoryId,
                frequency, dayOfMonth: frequency === 'weekly' ? null : day, monthOfYear: frequency === 'yearly' ? Number(price.usedOn.slice(5, 7)) : null,
                weekday: frequency === 'weekly' ? new Date(price.usedOn + 'T00:00:00Z').getUTCDay() : null, startOn, endOn, amount: price.amount,
                priceKind: 'fixed', pricing: registered?.pricing ?? [], pauses, note: '', updatedAt: '1970-01-01T00:00:00.000Z' }, { effectiveOn: price.usedOn, amount: price.amount }));
        };
        // Undated legacy stops have no trustworthy active interval.
        if (charge && !(f.state === 'ended' && !f.endOn || f.state === 'paused' && !f.pauses?.some(p => p.endOn === null)))
            append(fixedRuleKey(rule), f.startOn, f.endOn ?? null, f.frequency, f.pauses ?? [], charge);
        for (const previous of f.previous ?? []) {
            // Older histories lack lifecycle information. Never manufacture a past contract.
            if (!previous.startOn || !previous.frequency || !previous.pauses)
                continue;
            const end = new Date(Date.parse(previous.through + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
            const lower = previous.startOn;
            const candidates = (evidence.get(previous.key) ?? []).filter(r => r.usedOn >= lower && r.usedOn <= end && !pausedOnDay(previous.pauses, r.usedOn));
            const oldCharge = latestFixedEvidence(candidates, previous.frequency);
            if (oldCharge && !candidates.some(row => source.rules.some(other => other.id !== rule.id && ruleOwnsKeyOnDay(other, previous.key, row.usedOn))))
                append(previous.key, lower, end, previous.frequency, previous.pauses, oldCharge);
        }
    }
    return { ...source.assets, snapshots: source.assets.snapshots ?? [], fixedCosts };
}
export function legacyRuleFixedCost(item) {
    return { frequency: item.frequency, state: item.endOn !== null && item.endOn < item.startOn ? 'ended' : 'active', startOn: item.startOn, endOn: item.endOn, pauses: item.pauses, legacyId: item.id };
}
/** Draft creation shares the existing exact rule; broader classification is inherited by a dedicated exact rule. */
export function prepareCardFixedRule(source, today, target = {}) {
    const { candidate, legacy } = target, key = candidate?.key ?? legacy?.merchantKey ?? undefined;
    const cardId = candidate?.cardId ?? legacy?.cardId ?? null, pattern = key?.slice(key.indexOf('|') + 1) ?? '';
    const exact = key ? sortedRules(source.rules).find(r => r.enabled && fixedRuleEligible(r) && fixedRuleKey(r) === key) ?? sortedRules(source.rules).find(r => r.fixedCost && fixedRuleKey(r) === key) : undefined;
    const existing = exact ?? (key ? matchingRule(pattern, cardId, source.rules) : undefined);
    const rule = exact ?? { id: 'preview-rule', pattern, mode: 'exact', displayName: existing?.displayName ?? candidate?.merchant ?? legacy?.name ?? '', cardId, enabled: true, priority: existing?.priority ?? 100, categoryId: existing?.categoryId ?? null };
    const fixed = exact?.fixedCost ?? (legacy && migratableCardCost(legacy) ? legacyRuleFixedCost(legacy) : { frequency: candidate?.frequency ?? 'monthly', state: 'active', startOn: today });
    if (!legacy && !exact?.fixedCost && key) {
        const charge = ruleFixedCharge(source, { ...rule, fixedCost: fixed }, today);
        if (charge)
            fixed.startOn = charge.usedOn;
    }
    return { rule, fixed, key, isNew: !exact };
}
/** A route change uses the prior actual only until the new card has its own observation. */
export function editRuleFixedDraft(rule, draft, oldKey, state, frequency, today, source) {
    const key = fixedRuleKey(rule), changed = !!oldKey && oldKey !== key && oldKey.indexOf('|') > 0 && !!oldKey.slice(oldKey.indexOf('|') + 1) && oldKey.split('|')[0] !== 'null';
    const previous = [...(draft?.previous ?? [])];
    // Same-day intermediate routes have no effective usage period.
    if (changed && (!previous.length || draft?.startOn !== today)) {
        // Retain the actual known interval, including its original frequency and pauses.
        const lastBeforeChange = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
        const oldEnd = draft?.endOn && draft.endOn < lastBeforeChange ? draft.endOn : lastBeforeChange;
        if (draft && draft.startOn <= oldEnd && !(draft.state === 'ended' && !draft.endOn) && !(draft.state === 'paused' && !draft.pauses?.some(p => p.endOn === null))) {
            const pauses = (draft.pauses ?? []).filter(p => p.startOn <= oldEnd).map(p => ({ ...p, endOn: p.endOn === null || p.endOn > oldEnd ? oldEnd : p.endOn }));
            const through = new Date(Date.parse(oldEnd + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
            previous.push({ key: oldKey, through, startOn: draft.startOn, frequency: draft.frequency, pauses });
        }
        else
            previous.push({ key: oldKey, through: today });
    }
    const oldState = draft ? ruleFixedState(draft, today) : 'active';
    const stateChanged = !!draft && state !== (oldState === 'scheduled' ? 'active' : oldState);
    const result = { ...draft, frequency, state: stateChanged ? state : draft?.state ?? state, startOn: changed ? today : draft?.startOn ?? today, ...(previous.length ? { previous } : { previous: undefined }) };
    const shift = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    if (changed) {
        result.pauses = (result.pauses ?? []).flatMap(p => p.endOn !== null && p.endOn < today ? [] : [{ ...p, startOn: p.startOn < today ? today : p.startOn }]);
        if (result.endOn && result.endOn < today && state !== 'ended')
            result.endOn = null;
    }
    if (stateChanged || !draft && state !== 'active') {
        const pauses = (result.pauses ?? []).map(p => ({ ...p }));
        if (state === 'ended') {
            result.endOn = today;
            result.pauses = pauses.filter(p => p.startOn <= today).map(p => ({ ...p, endOn: p.endOn === null || p.endOn > today ? today : p.endOn }));
        }
        else if (state === 'paused') {
            const start = shift(today, 1) > result.startOn ? shift(today, 1) : result.startOn;
            const overlapping = pauses.find(p => p.endOn === null || p.endOn >= start);
            const openStart = overlapping && overlapping.startOn < start ? overlapping.startOn : start;
            result.pauses = [...pauses.filter(p => p.endOn !== null && p.endOn < openStart), { startOn: openStart, endOn: null }];
            result.endOn = null;
        }
        else {
            if (draft && (draft.state === 'ended' && !draft.endOn || draft.state === 'paused' && !draft.pauses?.some(p => p.endOn === null))) {
                // No known stop date: resume prospectively without manufacturing one.
                result.startOn = today;
                result.pauses = [];
            }
            else {
                result.pauses = pauses.flatMap(p => p.endOn !== null && p.endOn < today ? [p] : p.startOn >= today ? [] : [{ ...p, endOn: shift(today, -1) }]);
                if (result.endOn && result.endOn < today) {
                    const after = shift(result.endOn, 1), start = after < result.startOn ? result.startOn : after;
                    if (start < today)
                        result.pauses.push({ startOn: start, endOn: shift(today, -1) });
                }
            }
            result.endOn = null;
        }
    }
    if (!draft && !changed && source && fixedRuleEligible(rule)) {
        const evidence = ruleFixedCharge(source, { ...rule, fixedCost: result }, today);
        if (evidence)
            result.startOn = evidence.usedOn;
    }
    return result;
}
