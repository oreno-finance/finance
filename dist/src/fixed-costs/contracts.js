/** Unified fixed-cost metadata. Bank standing orders remain canonical in assets.recurring. */
import { CARDS } from '../models/types.js';
import { validatePaymentHistory } from './payment-history.js';
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
export function validateFixedCosts(raw, historicalRoutes = false) {
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
        if (x.merchantKey && !historicalRoutes) {
            const key = `${x.cardId}|${x.merchantKey}`;
            if (merchantKeys.has(key))
                throw new Error('同じカードの固定支出が重複しています。');
            merchantKeys.add(key);
        }
        ids.add(x.id);
        const paymentHistory = validatePaymentHistory(x.paymentHistory, x);
        return { ...x, name: x.name.trim(), pricing, pauses, ...(paymentHistory ? { paymentHistory } : {}) };
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
/** Next contractual occurrence, not evidence of a paid bill or a card debit date.
 * Skip whole suspension periods; use the same month-end/weekday rules as reports. */
export function nextFixedCostDate(item, fromDay) {
    if (item.enabled === false || !validDay(fromDay))
        return null;
    let cursor = fromDay < item.startOn ? item.startOn : fromDay;
    const pauses = item.pauses ?? [];
    for (let attempt = 0; attempt <= pauses.length; attempt++) {
        if (item.endOn !== null && cursor > item.endOn)
            return null;
        const start = new Date(`${cursor}T00:00:00Z`);
        let date = null;
        // The next eligible calendar day is no more than one year away.
        for (let i = 0; i <= 366; i++) {
            const d = new Date(start.getTime() + i * 86400000), day = d.toISOString().slice(0, 10);
            if (!validDay(day) || (item.endOn !== null && day > item.endOn))
                return null;
            const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
            const match = item.frequency === 'weekly' ? d.getUTCDay() === item.weekday :
                (item.frequency === 'monthly' || d.getUTCMonth() + 1 === item.monthOfYear) && d.getUTCDate() === (item.dayOfMonth === 0 ? last : Math.min(item.dayOfMonth, last));
            if (match) {
                date = day;
                break;
            }
        }
        if (!date)
            return null;
        const pause = pauses.find(p => date >= p.startOn && (p.endOn === null || date <= p.endOn));
        if (!pause)
            return date;
        if (pause.endOn === null || pause.endOn === '9999-12-31')
            return null;
        cursor = new Date(Date.parse(`${pause.endOn}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    }
    return null;
}
/** Lifecycle changes preserve completed pauses and do not rewrite unrelated fields.
 * A legacy disabled bank entry had no dated active history; restore only from the requested date. */
export function changeFixedCostState(item, action, day) {
    if (!validDay(day) || day < item.startOn || !['active', 'paused', 'ended'].includes(action))
        throw new Error('契約状態と適用日を確認してください。');
    const before = (value) => new Date(Date.parse(`${value}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const after = (value) => new Date(Date.parse(`${value}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    let pauses = (item.pauses ?? []).map(p => ({ ...p })), endOn = item.endOn;
    let enabled = item.enabled;
    if (action === 'ended') {
        if (endOn !== null && endOn < day)
            throw new Error('終了済みの契約は先に再開してください。');
        endOn = day;
        pauses = pauses.filter(p => p.startOn <= day).map(p => ({ ...p, endOn: p.endOn === null || p.endOn > day ? day : p.endOn }));
    }
    else if (action === 'paused') {
        if (enabled === false || (endOn !== null && day > endOn))
            throw new Error('停止・終了済みの契約は先に再開してください。');
        if (pauses.some(p => day >= p.startOn && (p.endOn === null || day <= p.endOn)))
            throw new Error('指定日はすでに停止期間です。');
        const last = pauses.at(-1);
        if (last && (last.endOn === null || day <= last.endOn))
            throw new Error('既存の停止予定と重複しています。');
        pauses.push({ startOn: day, endOn });
    }
    else {
        if (enabled === false) {
            // The previous flag excluded the entire contract. Retain that effect before the resume date.
            // Preserve any later pre-existing pause rather than silently discard it.
            const later = pauses.filter(p => p.startOn >= day);
            pauses = day > item.startOn ? [{ startOn: item.startOn, endOn: before(day) }, ...later] : later;
            enabled = true;
        }
        else {
            const open = pauses.find(p => p.startOn <= day && (p.endOn === null || p.endOn >= day)) ?? pauses.find(p => p.endOn === null && p.startOn > day);
            if (open) {
                if (open.startOn >= day)
                    pauses.splice(pauses.indexOf(open), 1);
                else
                    open.endOn = before(day);
            }
        }
        if (endOn !== null && endOn < day && item.enabled !== false) {
            const gapStart = after(endOn);
            if (gapStart < day)
                pauses.push({ startOn: gapStart, endOn: before(day) });
        }
        endOn = null;
    }
    pauses.sort((a, b) => a.startOn.localeCompare(b.startOn));
    return { endOn, pauses: validatePauses(pauses, item.startOn, endOn), ...(enabled === undefined ? {} : { enabled }) };
}
export function monthlyEquivalent(item) {
    return item.frequency === 'yearly' ? item.amount / 12 : item.frequency === 'weekly' ? item.amount * 52 / 12 : item.amount;
}
export function fixedCostState(item, day) {
    if (item.endOn !== null && item.endOn < day)
        return 'ended';
    if (item.startOn > day)
        return 'scheduled';
    if (pausedOnDay(item.pauses, day))
        return 'paused';
    return 'active';
}
