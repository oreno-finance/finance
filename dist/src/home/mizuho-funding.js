/** Manual monthly confirmation for Rakuten -> Mizuho card funding.
 * This is an encrypted CHECKLIST acknowledgement, never a bank transaction.
 * Never modifies cash forecasts, bank balances or the card statement itself. */
import { DEFAULT_MIZUHO_PLAN } from '../cloud/assets.js';
import { estimateMizuhoTransferAmount } from '../cloud/mizuho-transfer.js';
import { shiftedDay } from './account-events.js';
/** The card's recorded payment date is the authority for its transfer deadline.
 * If the bill isn't present, do NOT invent a transfer amount or due date. */
export function mizuhoFundingStatusForMonth(source, report, today) {
    const parsed = new Date(`${today}T00:00:00Z`);
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(today) ||
        !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== today)
        throw new Error('送金確認の日付が不正です。');
    const plan = source.assets.mizuhoTransferPlan ?? DEFAULT_MIZUHO_PLAN;
    if (!plan.enabled || source.assets.cardDebitAccounts?.['rakuten-mizuho'] !== 'mizuho-bank')
        return null;
    const month = report.period;
    if (!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month) || month > today.slice(0, 7))
        throw new Error('送金確認の対象月が不正です。');
    const cards = report.cardLines.filter(c => c.cardId === 'rakuten-mizuho');
    // Multiple different bills in one payment month make the target ambiguous.
    const card = cards.length === 1 ? cards[0] : null;
    const dueDate = card ? shiftedDay(card.paymentDate, -plan.leadDays) : null;
    const amount = card && card.amount > 0 ? estimateMizuhoTransferAmount(card.amount, plan.extraForSmallBills) : null;
    const receipt = source.assets.mizuhoFundingChecks?.[month];
    const billConfirmed = card?.confirmation === 'confirmed' && amount !== null;
    const billSnapshot = billConfirmed && card ? {
        billAmount: card.amount, paymentDate: card.paymentDate, transferAmount: amount, billId: card.id
    } : null;
    // Legacy acknowledgements without a snapshot are intentionally unverified.
    const changedSinceCheck = receipt?.done === true && (!billSnapshot ||
        receipt.billAmount !== billSnapshot.billAmount || receipt.paymentDate !== billSnapshot.paymentDate ||
        receipt.transferAmount !== billSnapshot.transferAmount || receipt.billId !== billSnapshot.billId);
    const completed = receipt?.done === true && !changedSinceCheck;
    const periodOpen = today >= `${month}-12`;
    return { month, dueDate, amount, billConfirmed, billSnapshot, changedSinceCheck,
        completed, updatedAt: receipt?.done ? receipt.updatedAt : null, periodOpen,
        overdue: periodOpen && !completed && dueDate !== null && today > dueDate };
}
/** Current-month UI keeps its original strict month contract. */
export function mizuhoFundingStatus(source, report, today) {
    if (report.period !== today.slice(0, 7))
        throw new Error('送金確認の対象月が一致しません。');
    return mizuhoFundingStatusForMonth(source, report, today);
}
/** Read-only. Confirmation does NOT count as proof of a completed bank transfer. */
export function mizuhoFundingDescription(status) {
    if (status.changedSinceCheck)
        return '請求内容が変更されました。実際の送金額を再確認してください';
    if (status.completed)
        return '送金済みとして記録済み（手動確認）';
    if (!status.periodOpen)
        return '毎月12日から送金確認できます';
    if (status.overdue)
        return '送金期限を過ぎています。実際の振替を確認してください';
    return status.dueDate === null ? '請求明細未取得：送金期限・金額は確認できません' : '送金の完了を確認してください';
}
