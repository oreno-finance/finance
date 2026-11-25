export function normalize(text) {
    return text.normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
}
export function squish(text) {
    return normalize(text).replace(/[\t ]+/g, ' ').trim();
}
export function parseYen(value) {
    if (value === undefined)
        return null;
    const text = normalize(value).trim().replace(/円|[\s,]/g, '').replace(/−/g, '-');
    return /^[-+]?\d+$/.test(text) ? Number(text) : null;
}
export function isoDate(year, month, day) {
    if (year < 100)
        year += 2000;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day)
        return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function paymentMonth(iso) { return iso?.slice(0, 7) ?? null; }
export function matchPaymentDate(text) {
    const n = normalize(text);
    // The date precedes the payment label on SMBC / Gold Point statements.
    const m = /(20\d{2})年(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?(?:の)?お支払い(?:分|明細)/.exec(n)
        // JCB / View: date follows a payment-date field label.
        ?? /(?:今回のお支払日|お支払日|お支払い日)[^\d]{0,60}(20\d{2})[年/](\d{1,2})[月/](\d{1,2})日?/.exec(n);
    return m ? isoDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}
export function findAmountFollowing(text, label) {
    const match = label.exec(normalize(text));
    return parseYen(match?.[1]);
}
export function lineList(text) {
    return normalize(text).split('\n').map(line => line.trim()).filter(Boolean);
}
export function rowId(i) { return `row-${i + 1}`; }
export function classifyStatus(text) {
    if (/確定前|現在判明分|支払い予定分|ご請求金額確定前/.test(normalize(text)))
        return 'provisional';
    if (/WEB明細書|今回のお支払金額|お支払額|お支払い合計額/.test(normalize(text)))
        return 'confirmed';
    return 'unknown';
}
