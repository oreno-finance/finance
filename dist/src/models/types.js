export const CARDS = [
    { id: 'rakuten-mizuho', name: 'みずほ楽天カード', provider: 'rakuten' },
    { id: 'rakuten-etc', name: '楽天カード', provider: 'rakuten' },
    { id: 'recruit-jcb', name: 'リクルートカード（JCB）', provider: 'jcb' },
    { id: 'bic-suica', name: 'ビックカメラSuicaカード', provider: 'view' },
    { id: 'smbc-nl', name: '三井住友カード NL', provider: 'smbc' },
    { id: 'amazon', name: 'Amazonカード', provider: 'smbc' },
    { id: 'goldpoint', name: 'GOLD POINT CARD+', provider: 'goldpoint' },
];
export function getCard(id) {
    return CARDS.find(card => card.id === id);
}
export function calculatedTotal(statement) {
    return statement.rows.reduce((sum, row) => sum + row.amount, 0);
}
/** Only the strict issuer-verified empty PDF shape represents a zero-usage statement. */
export function isZeroUsage(s) {
    return s.zeroUsage === true && Array.isArray(s.rows) && s.provider === 'rakuten' && s.sourceKind === 'pdf' && s.confirmation === 'confirmed' &&
        s.statedTotal === 0 && s.paymentDate === null && !!s.billingMonth && /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(s.billingMonth) && s.rows.length === 0;
}
/** Payment month for real debits; explicit empty statements use their billed month. */
export function statementPeriod(s) {
    if (isZeroUsage(s))
        return s.billingMonth;
    if (!s.paymentDate || !/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(s.paymentDate))
        return null;
    const d = new Date(`${s.paymentDate}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s.paymentDate ? s.paymentDate.slice(0, 7) : null;
}
