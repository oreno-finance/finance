/** P0 notices are derived, never persisted and never modify financial records. */
import { CARDS, getCard, statementPeriod } from '../models/types.js';
import { BALANCE_WARNING_ACCOUNTS } from '../cloud/assets.js';
import { changePeriod } from '../summary/monthly-summary.js';
import { shiftedDay } from './account-events.js';
const dayValid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
/** Issuer dates are approximate action thresholds, never online confirmation.
 * A 1-day buffer avoids asserting availability on a date described as "around".
 * All rules use the payment month so moved business-day payments remain usable. */
function previousMonthDay(paymentDate, day) {
    const first = new Date(`${paymentDate.slice(0, 7)}-01T00:00:00Z`);
    first.setUTCMonth(first.getUTCMonth() - 1);
    first.setUTCDate(day);
    return first.toISOString().slice(0, 10);
}
function issuerReviewDate(issuer, paymentDate) {
    if (issuer === 'rakuten')
        return `${paymentDate.slice(0, 7)}-12`;
    if (issuer === 'smbc') {
        if (Number(paymentDate.slice(8)) >= 20)
            return `${paymentDate.slice(0, 7)}-11`;
        if (Number(paymentDate.slice(8)) <= 15)
            return previousMonthDay(paymentDate, 26);
        return null;
    }
    if (issuer === 'jcb')
        return previousMonthDay(paymentDate, 25);
    if (issuer === 'view')
        return previousMonthDay(paymentDate, 17);
    if (issuer === 'goldpoint')
        return `${paymentDate.slice(0, 7)}-11`;
    return null;
}
export function statementReviewDate(cardId, paymentDate, preference) {
    if (preference?.review === null)
        return null;
    if (preference?.review) {
        if (!dayValid(paymentDate))
            return null;
        const { monthOffset, day } = preference.review;
        if ((monthOffset !== 0 && monthOffset !== -1) || !Number.isInteger(day) || day < 1 || day > 31)
            return null;
        const date = new Date(`${paymentDate.slice(0, 7)}-01T00:00:00Z`);
        date.setUTCMonth(date.getUTCMonth() + monthOffset);
        const limit = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        date.setUTCDate(Math.min(day, limit));
        return date.toISOString().slice(0, 10);
    }
    if (preference?.issuer)
        return dayValid(paymentDate) ? issuerReviewDate(preference.issuer, paymentDate) : null;
    if (!dayValid(paymentDate))
        return null;
    if (cardId === 'rakuten-mizuho' || cardId === 'rakuten-etc')
        return `${paymentDate.slice(0, 7)}-12`;
    if (cardId === 'smbc-nl' || cardId === 'amazon') {
        if (Number(paymentDate.slice(8)) >= 20)
            return `${paymentDate.slice(0, 7)}-11`;
        if (Number(paymentDate.slice(8)) <= 15)
            return previousMonthDay(paymentDate, 26);
        return null;
    }
    if (cardId === 'recruit-jcb')
        return previousMonthDay(paymentDate, 25);
    if (cardId === 'bic-suica')
        return previousMonthDay(paymentDate, 17);
    if (cardId === 'goldpoint')
        return `${paymentDate.slice(0, 7)}-11`;
    return null;
}
const severityRank = { high: 0, medium: 1, low: 2 };
export function homeActions(source, report, forecast, today) {
    const actions = [];
    const add = (item) => { if (!actions.some(x => x.id === item.id))
        actions.push(item); };
    // Use the existing daily net cashflow (including direct debits and transfers).
    // Never invent a balance when the baseline is unavailable or too old.
    for (const account of forecast.accounts) {
        if (!account.observed || account.projected === null)
            continue;
        const limit = BALANCE_WARNING_ACCOUNTS.some(id => id === account.accountId)
            ? source.assets.balanceWarningLimits?.[account.accountId] ?? 0 : 0;
        const current = account.days.filter(day => day.date <= today).at(-1)?.balance ?? account.observed.balance;
        const overdueDebit = account.overdue?.debit ?? 0;
        if (account.overdue?.count)
            add({ id: `overdue:${account.accountId}`, kind: 'overdue-movement', severity: 'medium', title: `${account.name}の期限経過・未確認の入出金を確認`, detail: `${account.overdue.count}件 · 残高を確認してください`, target: 'assets' });
        const days = [{ date: today, balance: current + overdueDebit }, ...account.days.filter(day => day.date > today).map(day => ({ ...day, balance: day.balance + overdueDebit }))];
        // One action per account. A real negative prediction takes priority over a reserve warning.
        const danger = days.find(day => day.balance < 0) ?? days.find(day => day.balance < limit);
        if (!danger)
            continue;
        const uncertain = !account.reliable || account.days.some(day => day.date <= danger.date && day.events.some(e => e.kind === 'salary-estimate' || e.estimated || e.movementStatus === 'estimated' || (e.kind === 'card' && e.confirmation !== 'confirmed')));
        const negative = danger.balance < 0;
        const yen = (amount) => `${amount.toLocaleString('ja-JP')}円`;
        add({ id: `shortage:${account.accountId}:${danger.date}`, kind: 'shortage', severity: negative && !uncertain ? 'high' : 'medium',
            title: negative ? `${account.name}の残高が不足する${uncertain ? '可能性' : '見込み'}` : `${account.name}の残高が設定下限を下回る${uncertain ? '可能性' : '見込み'}`,
            detail: `${danger.date.slice(5).replace('-', '/')} · 推定 ${yen(danger.balance)}${negative ? `（不足 ${yen(-danger.balance)}）` : ` / 下限 ${yen(limit)}`}${uncertain ? ' · 暫定・未取得等を含む概算' : ''}`, target: 'assets' });
    }
    for (const cardId of forecast.missingCardIds) {
        if (!forecast.debits.some(card => card.cardId === cardId))
            continue;
        add({ id: `missing-account:${cardId}`, kind: 'card-account', severity: 'high',
            title: `${source.assets.cardPreferences?.[cardId]?.name ?? getCard(cardId)?.name ?? 'カード'}の引落口座が未設定です`, target: 'settings' });
    }
    for (const issue of report.issues) {
        add({ id: `invalid:${issue.id}`, kind: 'invalid-statement', severity: 'high', title: `${issue.title}の明細を確認`,
            detail: issue.reason, target: 'manage', recordId: issue.id });
    }
    for (const card of report.cardLines.filter(card => card.confirmation === 'unknown')) {
        add({ id: `unknown:${card.id}`, kind: 'unknown-confirmation', severity: 'medium',
            title: `${card.name}の確定状態を確認`, detail: `${card.billingMonth ?? report.period}の明細`, target: 'manage', recordId: card.id });
    }
    // Inspect actual records for provisional by card × billingMonth to avoid duplicates.
    const confirmed = new Set(source.records.filter(r => r.statement.confirmation === 'confirmed')
        .map(r => `${r.statement.cardId ?? ''}|${r.statement.billingMonth ?? ''}`));
    for (const record of source.records) {
        const s = record.statement;
        if (s.confirmation !== 'provisional' || !s.cardId || !s.billingMonth || !dayValid(s.paymentDate ?? ''))
            continue;
        const key = `${s.cardId}|${s.billingMonth}`;
        if (confirmed.has(key))
            continue;
        const preference = source.assets.cardPreferences?.[s.cardId];
        if (preference?.review === null)
            continue;
        const threshold = statementReviewDate(s.cardId, s.paymentDate, preference);
        // Unknown schedules are only suggested after the recorded payment date.
        const checkDate = threshold ?? shiftedDay(s.paymentDate, 1);
        if (today < checkDate)
            continue;
        add({ id: `provisional:${key}`, kind: 'provisional', severity: 'medium',
            title: `${preference?.name ?? getCard(s.cardId)?.name ?? 'カード'} ${Number(s.paymentDate.slice(5, 7))}月支払分の確定明細を登録`,
            detail: '確定明細の公開時期の目安に達しました · 暫定明細あり', target: 'import' });
    }
    // Missing statements need a payment-month schedule, even when no PDF/CSV exists.
    // Only cards with evidence of use or explicit configuration are candidates.
    const observed = new Map();
    const registered = new Set();
    const observedPeriods = new Set();
    for (const { statement: s } of source.records) {
        if (!s.cardId)
            continue;
        const date = dayValid(s.paymentDate ?? '') ? s.paymentDate : '';
        if (!observed.has(s.cardId) || date > observed.get(s.cardId))
            observed.set(s.cardId, date);
        const period = statementPeriod(s);
        if (period) {
            registered.add(`${s.cardId}|${period}`);
            observedPeriods.add(period);
        }
    }
    const periods = [today.slice(0, 7), changePeriod(today.slice(0, 7), 1)];
    for (const card of CARDS) {
        const preference = source.assets.cardPreferences?.[card.id];
        if (preference?.review === null)
            continue;
        if (!observed.has(card.id) && !source.assets.cardDebitAccounts?.[card.id] && !preference?.review && !preference?.payment)
            continue;
        for (const period of periods) {
            if (registered.has(`${card.id}|${period}`))
                continue;
            // A month explicitly confirmed as having no card charges needs no reminders.
            if (source.assets.cardNoUseMonths?.includes(period) && !observedPeriods.has(period))
                continue;
            // Only SMBC's automatic rule depends on the payment day. Prefer the
            // contractual day, otherwise use the observed day, or the later standard
            // review threshold (26-day payment) when neither is available.
            const latest = observed.get(card.id);
            const day = preference?.payment?.day ?? (latest ? Number(latest.slice(8)) : 26);
            const last = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 0)).getUTCDate();
            const nominal = `${period}-${String(Math.min(day, last)).padStart(2, '0')}`;
            const threshold = statementReviewDate(card.id, nominal, preference);
            if (!threshold || today < threshold)
                continue;
            add({ id: `missing-statements:${card.id}|${period}`, kind: 'missing-statements', severity: 'medium',
                title: `${preference?.name ?? card.name} ${Number(period.slice(5))}月支払分の確定明細を登録`,
                detail: '確定明細の公開時期の目安に達しました · 未登録', target: 'import' });
        }
    }
    for (const account of forecast.accounts) {
        if (!account.observed)
            continue; // A never-registered account is not necessarily in use.
        const stamp = account.observed.observedAt;
        const days = Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(stamp)) / 86400000);
        if (days >= 30)
            add({ id: `stale:${account.accountId}`, kind: 'stale-balance', severity: 'medium',
                title: `${account.name}の残高を更新`, detail: `最終確認から${days}日`, target: 'assets' });
    }
    if (!source.payroll.ready)
        add({ id: 'payroll:not-ready', kind: 'payroll', severity: 'medium', title: 'Payrollの同期を確認', target: 'settings' });
    return actions.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.id.localeCompare(b.id));
}
