/** Historic point estimates are keyed to transaction date, never the current settings alone. */
import { CARDS } from '../models/types.js';
import { monthlyReport } from './monthly-summary.js';
export const DEFAULT_POINT_RATES = {
    'rakuten-mizuho': 2, 'rakuten-etc': 1, 'recruit-jcb': 1.2,
    'bic-suica': 0.5, 'smbc-nl': 0.5, 'amazon': 1, 'goldpoint': 1,
};
const validDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export function pointRate(cardId, preferences, day) {
    const pref = preferences?.[cardId];
    const configured = pref?.pointRatePercent ?? DEFAULT_POINT_RATES[cardId] ?? 0;
    const history = pref?.pointRateHistory;
    if (!day || !history?.length)
        return configured;
    // The first historic rate is a prior baseline, not a future-only setting.
    let rate = history[0].ratePercent;
    for (const entry of history) {
        if (entry.effectiveOn > day)
            break;
        rate = entry.ratePercent;
    }
    return rate;
}
/** Only the latest not-yet-effective entry may be revised or removed. */
export function editPointRate(cardId, old, mode, rate, effectiveOn, today, expectedFuture) {
    const oldRate = old?.pointRatePercent ?? DEFAULT_POINT_RATES[cardId] ?? 0;
    const history = structuredClone(old?.pointRateHistory ?? [{ effectiveOn: '1900-01-01', ratePercent: oldRate }]);
    const latest = history.at(-1);
    if (!validDay(today))
        throw new Error('現在日が不正です。');
    if (mode === 'replace' || mode === 'cancel' || mode === 'append') {
        if (history.length < 2 || latest.effectiveOn !== expectedFuture || latest.effectiveOn <= today)
            throw new Error('還元率の変更予定が更新されたか、適用が開始されました。最新情報を確認してください。');
    }
    if (mode === 'cancel') {
        history.pop();
        return { pointRatePercent: history.at(-1).ratePercent, pointRateHistory: history };
    }
    if (!Number.isFinite(rate) || rate < 0 || rate > 100 || Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-8)
        throw new Error('還元率は0〜100%、小数第2位までで入力してください。');
    if (!validDay(effectiveOn) || effectiveOn < today)
        throw new Error('還元率の適用日は今日以降にしてください。');
    if (mode === 'replace') {
        if (effectiveOn <= history.at(-2).effectiveOn)
            throw new Error('適用日は一つ前の変更日より後にしてください。');
        history[history.length - 1] = { effectiveOn, ratePercent: rate };
    }
    else if (mode === 'append') {
        if (effectiveOn <= latest.effectiveOn)
            throw new Error('追加する適用日は直近の変更日より後にしてください。');
        if (rate === latest.ratePercent)
            throw new Error('追加する還元率が直近の還元率と同じです。');
        history.push({ effectiveOn, ratePercent: rate });
    }
    else {
        if (effectiveOn < latest.effectiveOn)
            throw new Error('適用日は直近の変更日以降にしてください。');
        if (rate === oldRate)
            return { ...(old?.pointRatePercent !== undefined ? { pointRatePercent: old.pointRatePercent } : {}), ...(old?.pointRateHistory ? { pointRateHistory: history } : {}) };
        if (effectiveOn === latest.effectiveOn)
            history[history.length - 1] = { effectiveOn, ratePercent: rate };
        else
            history.push({ effectiveOn, ratePercent: rate });
    }
    if (history.length > 256)
        throw new Error('還元率の履歴が上限に達しています。');
    return { pointRatePercent: history.at(-1).ratePercent, pointRateHistory: history };
}
export function pointsForAmount(amount, ratePercent) {
    if (!Number.isSafeInteger(amount) || !Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100)
        throw new Error('ポイント計算に不正な数値があります。');
    return Math.max(0, Math.floor(amount * ratePercent / 100));
}
/** Preserve issuer-level monthly rounding when a single statement spans multiple rates. */
function groupPoints(charges) {
    const groups = new Map();
    for (const { amount, rate } of charges) {
        const updated = (groups.get(rate) ?? 0) + amount;
        if (!Number.isSafeInteger(updated))
            throw new Error('カード金額の合計が大きすぎます。');
        groups.set(rate, updated);
    }
    return [...groups].reduce((total, [rate, amount]) => total + pointsForAmount(amount, rate), 0);
}
export function statementPoints(statement, preferences) {
    if (!statement.cardId)
        return 0;
    return groupPoints(statement.rows.map(row => ({ amount: row.amount, rate: pointRate(statement.cardId, preferences, validDay(row.usedOn) ? row.usedOn : undefined) })));
}
export function pointBenefitsFromCards(cards, preferences) {
    const byCard = new Map();
    for (const card of cards) {
        const previous = byCard.get(card.cardId);
        const ratePercent = pointRate(card.cardId, preferences);
        const amount = (previous?.amount ?? 0) + card.amount;
        if (!Number.isSafeInteger(amount))
            throw new Error('カード請求の合計が大きすぎます。');
        byCard.set(card.cardId, { cardId: card.cardId, name: preferences?.[card.cardId]?.name ?? CARDS.find(c => c.id === card.cardId)?.name ?? card.name,
            amount, ratePercent, points: 0 });
    }
    const items = [...byCard.values()].map(card => ({ ...card, points: pointsForAmount(card.amount, card.ratePercent) }));
    items.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'ja'));
    return { total: items.reduce((sum, item) => sum + item.points, 0), cards: items };
}
/** Use an already-validated month without recomputing it for the points panel. */
export function pointBenefitsFromMonthlyReport(report, source, byId = new Map(source.records.map(record => [record.id, record]))) {
    const cards = report.cardLines;
    const summary = new Map();
    for (const card of cards) {
        const record = byId.get(card.id);
        if (!record)
            continue;
        let entry = summary.get(card.cardId);
        if (!entry) {
            entry = { base: { cardId: card.cardId, name: source.assets.cardPreferences?.[card.cardId]?.name ?? CARDS.find(c => c.id === card.cardId)?.name ?? card.name,
                    amount: 0, ratePercent: pointRate(card.cardId, source.assets.cardPreferences), points: 0 }, charges: [], rates: new Set() };
            summary.set(card.cardId, entry);
        }
        entry.base.amount += card.amount;
        for (const row of record.statement.rows) {
            const date = validDay(row.usedOn) ? row.usedOn : card.paymentDate;
            const rate = pointRate(card.cardId, source.assets.cardPreferences, date);
            entry.charges.push({ amount: row.amount, rate });
            entry.rates.add(rate);
        }
    }
    const items = [...summary.values()].map(entry => {
        const rates = [...entry.rates];
        return { ...entry.base, points: groupPoints(entry.charges),
            ratePercent: rates.length === 1 ? rates[0] : entry.base.ratePercent,
            ...(rates.length > 1 ? { rateLabel: rates.sort((a, b) => a - b).map(x => `${x}%`).join(' / ') } : {}) };
    });
    items.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'ja'));
    return { total: items.reduce((total, item) => total + item.points, 0), cards: items };
}
export function monthlyPointBenefits(period, source) {
    return pointBenefitsFromMonthlyReport(monthlyReport(period, source), source);
}
/** Per-month rounding is preserved. Reuse the renderer's reports and one ID map. */
export function periodPointBenefitsFromReports(reports, source) {
    const byId = new Map(source.records.map(record => [record.id, record]));
    const totals = new Map();
    let total = 0;
    for (const report of reports) {
        const month = pointBenefitsFromMonthlyReport(report, source, byId);
        total += month.total;
        for (const card of month.cards) {
            const old = totals.get(card.cardId);
            const combined = old ? [old.rateLabel ?? `${old.ratePercent}%`, card.rateLabel ?? `${card.ratePercent}%`] : [];
            const rates = new Set(combined.flatMap(text => text.split(' / ')));
            totals.set(card.cardId, { ...card, amount: (old?.amount ?? 0) + card.amount, points: (old?.points ?? 0) + card.points,
                ...(rates.size > 1 ? { rateLabel: [...rates].join(' / ') } : {}) });
        }
    }
    return { total, cards: [...totals.values()].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'ja')) };
}
/** Compatibility for other consumers; analysis passes already built reports. */
export function periodPointBenefits(periods, source) {
    return periodPointBenefitsFromReports(periods.map(period => monthlyReport(period, source)), source);
}
