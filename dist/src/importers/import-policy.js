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
/** A known card and billing month identify a bill across import and storage. */
export function statementMonthKey(s) {
    return s.cardId && s.billingMonth ? `${s.cardId}|${s.billingMonth}` : null;
}
export function isConfirmationRegression(previous, incoming) {
    return previous?.confirmation === 'confirmed' && incoming.confirmation !== 'confirmed';
}
/** Decide once for both preview and acceptance. Never choose an ambiguous target. */
export function planStatementImport(statements, incoming, getSignature = statementSignature) {
    if (!incoming.cardId)
        return { kind: 'add' };
    const key = statementMonthKey(incoming);
    let revisionIndex = -1;
    if (key) {
        for (const [index, existing] of statements.entries()) {
            if (statementMonthKey(existing) !== key)
                continue;
            if (revisionIndex !== -1)
                return { kind: 'blocked', index: revisionIndex };
            revisionIndex = index;
        }
        if (revisionIndex === -1)
            return { kind: 'add' };
        if (isConfirmationRegression(statements[revisionIndex], incoming))
            return { kind: 'blocked', index: revisionIndex };
    }
    const sameIdentity = (existing) => existing.provider === incoming.provider && existing.cardId === incoming.cardId &&
        existing.billingMonth === incoming.billingMonth && existing.confirmation === incoming.confirmation;
    // Delay the (sorted) signature until a possible identical bill is found.
    let signature;
    const exact = (existing) => sameIdentity(existing) &&
        getSignature(existing) === (signature ??= statementSignature(incoming));
    const exactIndex = revisionIndex !== -1
        ? (exact(statements[revisionIndex]) ? revisionIndex : -1)
        : statements.findIndex(exact);
    if (exactIndex !== -1) {
        // Preserve the existing CSV source-promotion workflow.
        if (revisionIndex !== -1 && incoming.sourceKind === 'csv' && statements[exactIndex].sourceKind !== 'csv')
            return { kind: 'revision', index: exactIndex };
        return { kind: 'duplicate', index: exactIndex };
    }
    return revisionIndex === -1 ? { kind: 'add' } : { kind: 'revision', index: revisionIndex };
}
