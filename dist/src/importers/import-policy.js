import { squish } from './utils.js';
/** A content-based identity for an imported version, independent of file name or pasted HTML format. */
export function statementSignature(s) {
    const entries = s.rows.map(row => [
        row.usedOn,
        squish(row.merchant).toUpperCase(),
        row.amount,
        squish(row.description ?? '').toUpperCase(),
    ]);
    entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return JSON.stringify({
        provider: s.provider,
        billingMonth: s.billingMonth,
        paymentDate: s.paymentDate,
        statedTotal: s.statedTotal,
        confirmation: s.confirmation,
        ...(s.zeroUsage === true ? { zeroUsage: true } : {}),
        rows: entries,
    });
}
/**
 * Exact repeats are ignored. A changed statement is a revision only when both
 * the card and its billing month are known, preventing cross-card replacement.
 * getSignature can return the original import signature to preserve edits.
 */
export function planStatementImport(statements, incoming, getSignature = statementSignature) {
    const incomingSignature = statementSignature(incoming);
    // Two different unselected cards can issue identical empty PDFs. Let the
    // explicit card selection and duplicate-month gate resolve their identity.
    const exactIndex = statements.findIndex(existing => !(incoming.zeroUsage === true && incoming.cardId === null) &&
        existing.provider === incoming.provider &&
        existing.cardId === incoming.cardId &&
        getSignature(existing) === incomingSignature);
    if (exactIndex !== -1)
        return { kind: 'duplicate', index: exactIndex };
    if (incoming.cardId && incoming.billingMonth) {
        const revisionIndex = statements.findIndex(existing => existing.cardId === incoming.cardId &&
            existing.billingMonth === incoming.billingMonth);
        if (revisionIndex !== -1)
            return { kind: 'revision', index: revisionIndex };
    }
    return { kind: 'add' };
}
