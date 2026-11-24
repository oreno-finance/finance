import { localDay } from '../cloud/asset-projection.js';
/** Archived monthly snapshots. Generated solely from Finance's existing payment-month summary. */
import { ASSET_ACCOUNTS } from '../cloud/assets.js';
import { changePeriod, isValidPeriod, monthlyReport, monthlyCashflow, hasScheduledSalary } from '../summary/monthly-summary.js';
import { monthlyPointBenefits } from '../summary/point-benefits.js';
const integer = (v) => typeof v === 'number' && Number.isSafeInteger(v);
const nullable = (v) => v === null || integer(v);
const string = (v, length) => typeof v === 'string' && v.length <= length;
const amount = (v) => !!v && typeof v === 'object' && string(v.name, 120) && integer(v.amount);
const iso = (v) => string(v, 40) && Number.isFinite(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v) && /(?:Z|[+-]\d\d:\d\d)$/.test(v);
export function validateReportDocument(raw, expectedPeriod) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('レポートの形式が不正です。');
    const doc = raw;
    if (doc.format !== 'finance-monthly-report-v1' || !isValidPeriod(doc.period) || (expectedPeriod && doc.period !== expectedPeriod) ||
        !Array.isArray(doc.history) || doc.history.length > 5)
        throw new Error('レポートの形式が不正です。');
    const revisions = [doc.current, ...doc.history];
    const ids = new Set();
    for (const item of revisions) {
        if (!item || !string(item.id, 80) || !/^[a-f\d-]{36}$/i.test(item.id) || ids.has(item.id) ||
            !iso(item.savedAt) || !string(item.sourceHash, 64) || !/^[0-9a-f]{64}$/.test(item.sourceHash) || !string(item.note, 2000))
            throw new Error('レポートの履歴が不正です。');
        ids.add(item.id);
        const s = item.snapshot;
        if (!s || s.period !== doc.period || ![s.income, s.expense, s.balance, s.cardOutflow, s.livingOutflow, s.previousExpense, s.expenseChange].every(nullable) ||
            !integer(s.nisaOutflow) || !Array.isArray(s.cards) || s.cards.length > 80 || !s.cards.every(amount) ||
            !Array.isArray(s.categories) || s.categories.length > 200 || !s.categories.every(amount) ||
            !Array.isArray(s.merchants) || s.merchants.length > 200 || !s.merchants.every(amount) ||
            (s.points !== undefined && (!s.points || !integer(s.points.total) || s.points.total < 0 || !Array.isArray(s.points.cards) || s.points.cards.length > 80 || !s.points.cards.every(c => string(c.cardId, 50) && string(c.name, 120) && integer(c.amount) && integer(c.points) && c.points >= 0 && typeof c.ratePercent === 'number' && Number.isFinite(c.ratePercent) && c.ratePercent >= 0 && c.ratePercent <= 100 && (c.rateLabel === undefined || (typeof c.rateLabel === 'string' && c.rateLabel.length <= 256 && /^[0-9.%\s/]+$/.test(c.rateLabel)))))) ||
            !Array.isArray(s.reasons) || s.reasons.length > 8 || !s.reasons.every(x => string(x, 200)) ||
            !Array.isArray(s.quality) || s.quality.length > 20 || !s.quality.every(x => string(x, 200)) ||
            !Array.isArray(s.balances) || s.balances.length > 8 || !s.balances.every(x => !!x && string(x.name, 80) && integer(x.balance) && iso(x.observedAt)))
            throw new Error('レポートの内容が不正です。');
    }
    return structuredClone(doc);
}
export function reportSnapshot(period, source) {
    const now = monthlyReport(period, source);
    const prev = monthlyReport(changePeriod(period, -1), source);
    const expense = monthlyCashflow(now).expense;
    const previousExpense = monthlyCashflow(prev).expense;
    // Known subtotals from incomplete months are visible, but cannot establish a change.
    const expenseComparable = now.cardOutflow !== null && prev.cardOutflow !== null;
    const cardMap = new Map();
    for (const card of now.cardLines)
        cardMap.set(card.name, (cardMap.get(card.name) ?? 0) + card.amount);
    const cards = [...cardMap].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'ja'));
    const categories = now.categories.map(item => ({ name: item.name, amount: item.amount }));
    const merchants = now.merchants.map(item => ({ name: item.name, amount: item.amount }));
    const balances = [];
    const end = `${period}-${new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 0)).getUTCDate()}`;
    for (const account of ASSET_ACCOUNTS) {
        const current = [...(source.assets.snapshots ?? [])].filter(s => s.accountId === account.id && localDay(new Date(s.observedAt)) <= end)
            .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
        if (current)
            balances.push({ name: account.name, balance: current.balance, observedAt: current.observedAt });
    }
    const quality = [];
    if (now.cardOutflow === null)
        quality.push('カード明細未取得', '支出は一部判明分のみ');
    if (now.pastUnconfirmedOneTime)
        quality.push(`未実行の過去予定 ${now.pastUnconfirmedOneTime}件`);
    if (now.provisional.length)
        quality.push(`暫定明細 ${now.provisional.length}件`);
    if (now.unknownConfirmationCount)
        quality.push(`確定状態不明 ${now.unknownConfirmationCount}件`);
    if (now.issues.length)
        quality.push(`要修正 ${now.issues.length}件`);
    if (now.unclassifiedCount)
        quality.push(`未分類 ${now.unclassifiedCount}件`);
    if (now.recurringCardOverlap)
        quality.push('定期支出とカード請求の重複候補あり');
    if (now.recurringOneTimeOverlap)
        quality.push('単発入出金と定期予定の対応を要確認');
    if (now.income === null)
        quality.push('収入未取得');
    if (now.incomeEstimates.length)
        quality.push('給与見込みを含む');
    if (hasScheduledSalary(now))
        quality.push('手動の給与入金予定を含む');
    if (!now.payrollReady)
        quality.push('Payroll未同期');
    const reasons = [];
    if (expenseComparable && expense !== null && previousExpense !== null) {
        const difference = expense - previousExpense;
        if (difference !== 0)
            reasons.push(`前月より支出が${Math.abs(difference).toLocaleString('ja-JP')}円${difference > 0 ? '増加' : '減少'}`);
        const old = new Map(prev.categories.map(item => [item.name, item.amount]));
        const candidates = categories.map(item => ({ name: item.name, delta: item.amount - (old.get(item.name) ?? 0) }));
        const direction = difference > 0 ? 1 : -1;
        const major = candidates.filter(item => item.delta * direction > 0).sort((a, b) => b.delta * direction - a.delta * direction)[0];
        if (major)
            reasons.push(`${major.name}：前月比 ${major.delta > 0 ? '+' : ''}${major.delta.toLocaleString('ja-JP')}円`);
    }
    if (categories[0])
        reasons.push(`最大カテゴリー：${categories[0].name}`);
    return { period, income: now.income, expense, balance: now.monthlyBalance,
        cardOutflow: now.cardOutflow, nisaOutflow: now.nisaOutflow, livingOutflow: now.livingOutflow,
        cards, categories, merchants, points: monthlyPointBenefits(period, source), previousExpense, expenseChange: expenseComparable && expense !== null && previousExpense !== null ? expense - previousExpense : null,
        reasons, quality, balances };
}
export async function snapshotHash(snapshot) {
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function reportRevision(snapshot, sourceHash, note, now = new Date()) {
    if (!string(note, 2000))
        throw new Error('メモは2000文字以内にしてください。');
    return { id: crypto.randomUUID(), savedAt: now.toISOString(), sourceHash, note, snapshot: structuredClone(snapshot) };
}
export function revisedDocument(old, revision) {
    if (old && old.period !== revision.snapshot.period)
        throw new Error('レポートの年月が一致しません。');
    if (old?.current.sourceHash === revision.sourceHash && old.current.note === revision.note)
        return old;
    return validateReportDocument({ format: 'finance-monthly-report-v1', period: revision.snapshot.period, current: revision,
        history: old ? [old.current, ...old.history].slice(0, 5) : [] });
}
