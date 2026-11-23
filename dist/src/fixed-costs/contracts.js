/** Unified fixed-cost metadata. Bank standing orders remain canonical in assets.recurring. */
import { CARDS } from '../models/types.js';
const validDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const amountOk = (value) => Number.isSafeInteger(value) && value > 0;
export function validatePricing(value, startOn, max = 256) {
    if (!Array.isArray(value) || value.length < 1 || value.length > max)
        throw new Error('料金履歴の形式が不正です。');
    let previous = '';
    return value.map(raw => {
        if (!raw || typeof raw !== 'object' || !validDay(raw.effectiveOn) || raw.effectiveOn < startOn || raw.effectiveOn <= previous || !amountOk(raw.amount))
            throw new Error('料金履歴の日付または金額を確認してください。');
        previous = raw.effectiveOn;
        return { effectiveOn: raw.effectiveOn, amount: raw.amount };
    });
}
export function validatePauses(raw, startOn, endOn) {
    if (!Array.isArray(raw) || raw.length > 128)
        throw new Error('停止期間の形式が不正です。');
    let last = '';
    return raw.map(x => {
        if (!x || typeof x !== 'object' || !validDay(x.startOn) || x.startOn < startOn || x.startOn <= last ||
            (x.endOn !== null && (!validDay(x.endOn) || x.endOn < x.startOn)) ||
            (endOn !== null && x.startOn > endOn))
            throw new Error('停止期間が重複または不正です。');
        last = x.endOn ?? '9999-12-31';
        return { startOn: x.startOn, endOn: x.endOn };
    });
}
export function validateFixedCosts(raw) {
    if (raw === undefined)
        return undefined;
    if (!Array.isArray(raw) || raw.length > 500)
        throw new Error('固定費の保存形式が不正です。');
    const ids = new Set(), merchantKeys = new Set();
    return raw.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('固定費の登録内容が不正です。');
        const x = value;
        if (typeof x.id !== 'string' || !/^[a-zA-Z0-9-]{6,80}$/.test(x.id) || ids.has(x.id) ||
            typeof x.name !== 'string' || !x.name.trim() || x.name.length > 80 ||
            !['card', 'cash'].includes(x.payment) ||
            (x.payment === 'card' ? !CARDS.some(c => c.id === x.cardId) : x.cardId !== null) ||
            (x.merchantKey !== null && (typeof x.merchantKey !== 'string' || x.merchantKey.length > 250 || !x.merchantKey.trim())) ||
            (x.payment === 'cash' && x.merchantKey !== null) ||
            (x.categoryId !== null && (typeof x.categoryId !== 'string' || !/^[-a-z0-9]{1,90}$/.test(x.categoryId))) ||
            !['monthly', 'yearly', 'weekly'].includes(x.frequency) || !validDay(x.startOn) ||
            (x.endOn !== null && (!validDay(x.endOn) || x.endOn < x.startOn)) || !amountOk(x.amount) ||
            !['fixed', 'variable'].includes(x.priceKind) || typeof x.note !== 'string' || x.note.length > 500 ||
            typeof x.updatedAt !== 'string' || !Number.isFinite(Date.parse(x.updatedAt)))
            throw new Error('固定費の登録内容が不正です。');
        if ((x.frequency === 'weekly' ? (x.weekday === null || !Number.isInteger(x.weekday) || x.weekday < 0 || x.weekday > 6 || x.dayOfMonth !== null || x.monthOfYear !== null) :
            (x.dayOfMonth === null || !Number.isInteger(x.dayOfMonth) || x.dayOfMonth < 0 || x.dayOfMonth > 31 || x.weekday !== null ||
                (x.frequency === 'monthly' ? x.monthOfYear !== null : !Number.isInteger(x.monthOfYear) || x.monthOfYear === null || x.monthOfYear < 1 || x.monthOfYear > 12))))
            throw new Error('固定費の支払周期が不正です。');
        const pricing = validatePricing(x.pricing, x.startOn);
        const pauses = validatePauses(x.pauses, x.startOn, x.endOn);
        if (x.amount !== pricing.at(-1).amount)
            throw new Error('最新料金と料金履歴が一致しません。');
        if (x.merchantKey) {
            const key = `${x.cardId}|${x.merchantKey}`;
            if (merchantKeys.has(key))
                throw new Error('同じカードの固定支出が重複しています。');
            merchantKeys.add(key);
        }
        ids.add(x.id);
        return { ...x, name: x.name.trim(), pricing, pauses };
    });
}
export function priceOnDay(pricing, day, defaultAmount) {
    let result = pricing.length ? pricing[0].amount : defaultAmount;
    for (const item of pricing) {
        if (item.effectiveOn > day)
            break;
        result = item.amount;
    }
    return result;
}
export function pausedOnDay(pauses, day) {
    return pauses.some(x => day >= x.startOn && (x.endOn === null || day <= x.endOn));
}
export function fixedCostOccurrences(period, items) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
        throw new Error('固定費の対象月が不正です。');
    const year = Number(period.slice(0, 4)), month = Number(period.slice(5)), days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const result = [];
    for (const item of items) {
        for (let d = 1; d <= days; d++) {
            const date = `${period}-${String(d).padStart(2, '0')}`;
            if (date < item.startOn || (item.endOn !== null && date > item.endOn) || pausedOnDay(item.pauses, date))
                continue;
            const matches = item.frequency === 'weekly'
                ? new Date(`${date}T00:00:00Z`).getUTCDay() === item.weekday
                : (item.frequency === 'monthly' || month === item.monthOfYear) && d === (item.dayOfMonth === 0 ? days : Math.min(item.dayOfMonth, days));
            if (matches)
                result.push({ item, date, amount: priceOnDay(item.pricing, date, item.amount) });
        }
    }
    return result;
}
export function monthlyEquivalent(item) {
    return item.frequency === 'yearly' ? item.amount / 12 : item.frequency === 'weekly' ? item.amount * 52 / 12 : item.amount;
}
export function fixedCostState(item, day) {
    if (item.endOn !== null && item.endOn < day)
        return 'ended';
    if (pausedOnDay(item.pauses, day))
        return 'paused';
    return 'active';
}
export function costFromAssets(doc) { return doc.fixedCosts ?? []; }
