import { fixedCostsForCalculation } from '../fixed-costs/payment-history.js';
/** Conservative, read-only card debit estimates built from actual fixed-cost contracts.
 * Never creates a statement or persists a bill. An imported payment-month statement
 * takes precedence for the WHOLE card to prevent duplicate bank debits. */
import { DEFAULT_MIZUHO_PLAN } from './assets.js';
import { mizuhoTransferForBill } from './mizuho-transfer.js';
import { fixedCostOccurrences } from '../fixed-costs/contracts.js';
import { cardPaymentDate } from '../importers/payment-date.js';
import { CARDS, statementPeriod } from '../models/types.js';
const month = (day) => day.slice(0, 7);
const index = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const fromIndex = (i) => `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`;
function paymentTiming(cardId, doc, records) {
    const explicit = doc.cardPreferences?.[cardId]?.payment;
    if (explicit)
        return explicit;
    const latest = records.filter(r => r.statement.cardId === cardId && r.statement.paymentDate && r.statement.billingMonth)
        .sort((a, b) => b.statement.paymentDate.localeCompare(a.statement.paymentDate))[0];
    if (!latest)
        return null;
    const payment = latest.statement.paymentDate, billing = latest.statement.billingMonth;
    const offset = index(month(payment)) - index(billing);
    if (offset !== 0 && offset !== 1)
        return null;
    return { monthOffset: offset, day: Number(payment.slice(8, 10)) };
}
/** Future estimate needs a configured/observed payment-day rule and a source contract. */
export function estimatedCardFixedBills(doc, records, fromDay, toDay) {
    if (toDay < fromDay || !/^20\d\d-\d\d-\d\d$/.test(fromDay) || !/^20\d\d-\d\d-\d\d$/.test(toDay))
        return [];
    const months = new Set();
    for (let i = index(month(fromDay)) - 2; i <= index(month(toDay)) && months.size <= 7; i++)
        months.add(fromIndex(i));
    const seen = new Set(records.filter(r => r.statement.cardId && statementPeriod(r.statement))
        .map(r => `${r.statement.cardId}|${statementPeriod(r.statement)}`));
    const observedMonths = new Set(records.flatMap(r => { const p = statementPeriod(r.statement); return p ? [p] : []; }));
    const buckets = new Map();
    for (const contract of fixedCostsForCalculation(doc)) {
        if (contract.payment !== 'card' || !contract.cardId)
            continue;
        if (!doc.cardDebitAccounts?.[contract.cardId])
            continue;
        const timing = paymentTiming(contract.cardId, doc, records);
        if (!timing)
            continue; // Never invent a payment date.
        for (const m of months) {
            for (const occurrence of fixedCostOccurrences(m, [contract])) {
                let due;
                try {
                    due = cardPaymentDate(m, timing);
                }
                catch {
                    continue;
                }
                if (due < fromDay || due > toDay || seen.has(`${contract.cardId}|${month(due)}`) ||
                    (doc.cardNoUseMonths?.includes(month(due)) && !observedMonths.has(month(due))))
                    continue;
                const key = `${contract.cardId}|${due}`;
                const previous = buckets.get(key);
                const next = (previous?.amount ?? 0) + occurrence.amount;
                if (!Number.isSafeInteger(next))
                    throw new Error('カード固定費の請求見込みが大きすぎます。');
                const name = doc.cardPreferences?.[contract.cardId]?.name ?? CARDS.find(c => c.id === contract.cardId)?.name ?? 'カード';
                buckets.set(key, { id: `estimate:${key}`, cardId: contract.cardId, name: `${name}（固定費から推定）`, paymentDate: due,
                    amount: next, contractIds: [...(previous?.contractIds ?? []), contract.id], estimated: true });
            }
        }
    }
    return [...buckets.values()].sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.cardId.localeCompare(b.cardId));
}
/** Only future funding of an estimated bill; actual statements and manual transfers
 * take precedence through the same funding rules as confirmed bills. */
export function estimatedMizuhoFunding(doc, records, today, until) {
    const plan = doc.mizuhoTransferPlan ?? DEFAULT_MIZUHO_PLAN;
    if (!plan.enabled || until < today)
        return [];
    const last = new Date(`${until}T00:00:00Z`);
    if (!Number.isFinite(last.getTime()))
        return [];
    last.setUTCDate(last.getUTCDate() + plan.leadDays);
    const results = [];
    for (const bill of estimatedCardFixedBills(doc, records, today, last.toISOString().slice(0, 10))) {
        const transfer = mizuhoTransferForBill(bill, doc);
        if (transfer && transfer.date >= today && transfer.date <= until)
            results.push({ ...transfer, id: `fund:${bill.id}`, estimated: true });
    }
    return results;
}
