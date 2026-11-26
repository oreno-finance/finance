/** Optional, read-only prediction of transfers from Rakuten Bank to Mizuho Bank.
 * A forecast is never marked completed and never written as a recurring entry. */
import { DEFAULT_MIZUHO_PLAN } from './assets.js';
import { recurringOccursOn } from './recurring-schedule.js';
export function estimateMizuhoTransferAmount(bill, extraForSmallBills = true) {
    if (!Number.isSafeInteger(bill) || bill < 0)
        throw Error('カード請求額が不正です。');
    if (bill === 0)
        return 0;
    const amount = Math.ceil(bill / 5000) * 5000 + (extraForSmallBills && bill <= 50000 ? 5000 : 0);
    if (!Number.isSafeInteger(amount))
        throw Error('送金予定額が大きすぎます。');
    return amount;
}
export function mizuhoTransferForBill(bill, assets) {
    const plan = assets.mizuhoTransferPlan ?? DEFAULT_MIZUHO_PLAN;
    if (!plan.enabled || bill.cardId !== 'rakuten-mizuho' || assets.cardDebitAccounts?.[bill.cardId] !== 'mizuho-bank' || bill.amount <= 0 || !bill.paymentDate)
        return null;
    const day = new Date(`${bill.paymentDate}T00:00:00Z`);
    if (Number.isNaN(day.getTime()))
        return null;
    day.setUTCDate(day.getUTCDate() - plan.leadDays);
    const date = day.toISOString().slice(0, 10);
    // An explicitly registered bank-to-bank transfer on this date takes priority.
    const userTransfer = assets.recurring.some(item => item.enabled && item.kind === 'transfer' &&
        item.fromAccountId === 'rakuten-bank' && item.toAccountId === 'mizuho-bank' && recurringOccursOn(item, date));
    const isFunding = manualMizuhoFundingEntries(bill, assets).length > 0;
    if (userTransfer || isFunding)
        return null;
    const amount = estimateMizuhoTransferAmount(bill.amount, plan.extraForSmallBills);
    return amount ? { date, paymentDate: bill.paymentDate, amount, cardId: bill.cardId } : null;
}
/** Use the same matching window for the forecast and the manual record editor.
 * Do not infer funding outside this window or from unrelated transfers. */
export function mizuhoFundingWindow(paymentDate, leadDays) {
    const day = new Date(`${paymentDate}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== paymentDate)
        return null;
    const before = (days) => { const d = new Date(day); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); };
    return { first: before(Math.max(14, leadDays)), last: paymentDate, scheduled: before(leadDays) };
}
export function manualMizuhoFundingEntries(bill, assets) {
    if (bill.cardId !== 'rakuten-mizuho' || !bill.paymentDate)
        return [];
    const window = mizuhoFundingWindow(bill.paymentDate, (assets.mizuhoTransferPlan ?? DEFAULT_MIZUHO_PLAN).leadDays);
    if (!window)
        return [];
    return (assets.oneTime ?? []).filter(e => e.kind === 'transfer' && e.fromAccountId === 'rakuten-bank' && e.toAccountId === 'mizuho-bank' &&
        ((e.cardFunding === true && e.date >= window.first && e.date <= window.last) || e.date === window.scheduled));
}
