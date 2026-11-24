import { requestConfirmation, confirmationPending, cancelConfirmation } from './modal.js';
import { formatYen as sharedYen, formatSignedYen, formatMonth, formatDate, formatShortDate, formatDateTime } from './formatters.js';
import { bindMonthNavigator, localMonth, monthInRange } from './period-navigator.js';
/** Monthly summary view. DOM updates only; all financial figures are computed from vault snapshots. */
import { monthlyReport, prepareMonthlyReports, changePeriod } from '../summary/monthly-summary.js';
import { payrollRoleLabel } from '../cloud/payroll-income.js';
import { PALETTE } from '../cloud/merchant-rules.js';
import { pointBenefitsFromMonthlyReport } from '../summary/point-benefits.js';
import { pointBenefitsSection, pointCoverage } from './point-benefits.js';
import { bankTimeline } from '../summary/bank-timeline.js';
import { bankChartData } from './bank-chart-data.js';
import { ASSET_ACCOUNTS } from '../cloud/assets.js';
function element(tag, cls = '', text) {
    const node = document.createElement(tag);
    if (cls)
        node.className = cls;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
const yen = (value) => sharedYen(value, 0, '未取得');
const localPeriod = localMonth;
const periodDisplay = formatMonth;
const kindName = (kind) => kind === 'bonus' ? '賞与' : kind === 'salary' ? '給与' : kind === 'adjustment' ? '調整' : kind;
const accountName = (id) => ASSET_ACCOUNTS.find(a => a.id === id)?.name ?? '口座未設定';
function line(parent, name, value, action) {
    const holder = element('div', 'monthly-line');
    const title = action ? document.createElement('button') : document.createElement('span');
    title.textContent = name;
    if (action) {
        title.className = 'monthly-link';
        title.type = 'button';
        title.addEventListener('click', action);
    }
    const sum = element('strong', '', value);
    title.title = name;
    holder.append(title, sum);
    parent.append(holder);
}
function scheduledLine(parent, date, name, route, amount) {
    const row = element('div', 'monthly-schedule-row');
    row.append(element('time', 'monthly-schedule-date', formatShortDate(date)));
    const description = element('div', 'monthly-schedule-description');
    description.append(element('strong', '', name), element('small', 'monthly-muted', route));
    row.append(description, element('b', 'monthly-schedule-amount', yen(amount)));
    parent.append(row);
}
function empty(parent, text) { parent.append(element('p', 'monthly-muted', text)); }
function cardRows(root, items, open) {
    if (!items.length) {
        empty(root, 'この月に該当するカード明細はありません。');
        return;
    }
    for (const item of items) {
        const title = `${item.name} · ${formatDate(item.paymentDate)}（請求月 ${item.billingMonth ?? '不明'}）${item.confirmation === 'provisional' ? ' · 暫定' : ''}`;
        line(root, title, yen(item.amount), () => open(item.id));
    }
}
function statusText(report) {
    if (!report.payrollReady)
        return 'Payroll未同期です。給与実績・前月給与の見込みを取得できません。設定からPayroll連携を確認してください。';
    if (report.incomeMissingRegular)
        return '本業給与の実績がなく、直近の通常給与からも見込みを算出できません。';
    if (report.income === null)
        return '給与実績・給与見込みがありません。収支額は算出できません。';
    return '';
}
/** Interactive, read-only projection. No bank event or snapshot is modified here. */
function bankEventType(item) {
    if (item.provisional)
        return '暫定';
    switch (item.kind) {
        case 'card': return 'カード引落';
        case 'salary': return 'Payroll登録';
        case 'salary-estimate': return '給与見込み';
        case 'recurring': return '定期予定';
        case 'transfer': return '送金予測';
        case 'one-time': return '単発入出金';
    }
}
function bankChart(timeline, period) {
    const chart = bankChartData(timeline, period);
    if (!chart)
        return null;
    const points = chart.series, selectable = chart.selectable;
    const values = points.map(point => point.balance);
    let low = Math.min(0, ...values), high = Math.max(0, ...values);
    if (low === high) {
        low -= 10000;
        high += 10000;
    }
    const range = high - low, W = 630, H = 142, L = 60, R = 13, T = 10, B = 23;
    const x = (day) => L + (day - 1) / Math.max(1, chart.lastDay - 1) * (W - L - R);
    const y = (value) => T + (high - value) / range * (H - T - B);
    const ns = 'http://www.w3.org/2000/svg';
    const node = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs))
        e.setAttribute(k, v); return e; };
    const svg = node('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '楽天銀行の月内予測残高。点をタップ、または日付選択を開いて詳細を選べます。', class: 'monthly-balance-svg' });
    for (let i = 0; i <= 2; i++) {
        const val = low + range * i / 2, yy = y(val);
        svg.append(node('line', { x1: String(L), x2: String(W - R), y1: String(yy), y2: String(yy), class: Math.abs(val) < range / 8 ? 'monthly-chart-zero' : 'monthly-chart-grid' }));
        const t = node('text', { x: String(L - 9), y: String(yy + 4), 'text-anchor': 'end', class: 'monthly-chart-label' });
        t.textContent = `${Math.round(val / 10000).toLocaleString('ja-JP')}万`;
        svg.append(t);
    }
    const path = [`M${x(points[0].day).toFixed(2)} ${y(points[0].balance).toFixed(2)}`];
    for (let i = 1; i < points.length; i++) {
        const point = points[i];
        path.push(`H${x(point.day).toFixed(2)}`, `V${y(point.balance).toFixed(2)}`);
    }
    svg.append(node('path', { d: path.join(' '), class: 'monthly-chart-path', fill: 'none' }));
    const markers = [], buttons = [];
    const section = element('div', 'monthly-chart');
    const plot = element('div', 'monthly-chart-plot');
    plot.append(svg);
    section.append(plot);
    const dateList = element('div', 'monthly-chart-dates');
    dateList.setAttribute('role', 'group');
    dateList.setAttribute('aria-label', 'グラフの日付を選択');
    const dateControls = element('details', 'monthly-bank-all monthly-chart-date-controls');
    dateControls.append(element('summary', '', '日付を選択'), dateList);
    section.append(dateControls);
    const detail = element('section', 'monthly-chart-detail');
    detail.setAttribute('aria-label', '選択日の残高と入出金内訳');
    section.append(detail);
    function dateText(p) { return `${Number(period.slice(0, 4))}年${Number(period.slice(5))}月${p.day}日`; }
    function paintDetail(point) {
        detail.replaceChildren();
        const isConfirmedBaseline = point.kind === 'opening' && point.date === timeline.startDay;
        const name = point.kind === 'opening' ? (isConfirmedBaseline ? '確認済み残高の基準日' : '月初時点の予測') : point.kind === 'month-end' ? '月末の予測' : '登録済みの入出金反映後';
        const header = element('div', 'monthly-chart-detail-heading');
        header.append(element('strong', '', dateText(point)), element('span', 'monthly-chart-detail-status', name));
        detail.append(header);
        const totals = element('div', 'monthly-chart-detail-totals');
        const total = (title, value, tone = '') => {
            const item = element('div', 'monthly-chart-detail-total');
            item.append(element('span', 'monthly-muted', title), element('strong', tone, value));
            totals.append(item);
        };
        total('この日の増減', formatSignedYen(point.delta));
        total(isConfirmedBaseline ? '登録した基準残高' : '日末の予測残高', yen(point.balance), point.balance < 0 ? 'monthly-negative' : '');
        detail.append(totals);
        if (point.items.length) {
            const list = element('div', 'monthly-chart-detail-events');
            for (const item of point.items) {
                const row = element('div', 'monthly-chart-detail-event');
                const description = element('div', 'monthly-chart-detail-event-name');
                description.append(element('strong', '', item.title), element('small', 'monthly-muted', bankEventType(item)));
                row.append(description, element('b', '', formatSignedYen(item.amount)));
                list.append(row);
            }
            detail.append(list);
        }
        else {
            detail.append(element('p', 'monthly-muted', isConfirmedBaseline ? 'この日は登録済みの残高を基準にしています。' : 'この日付に登録された入出金はありません。'));
        }
    }
    function choose(index, focus = false) {
        if (index < 0 || index >= selectable.length)
            return;
        for (let i = 0; i < markers.length; i++) {
            markers[i].classList.toggle('is-selected', i === index);
        }
        for (let i = 0; i < buttons.length; i++) {
            buttons[i].setAttribute('aria-pressed', String(i === index));
            if (i === index && focus)
                buttons[i].focus();
        }
        paintDetail(selectable[index]);
    }
    for (const [index, point] of selectable.entries()) {
        const group = node('g', { class: 'monthly-chart-marker' });
        group.append(node('circle', { cx: String(x(point.day)), cy: String(y(point.balance)), r: '4', class: 'monthly-chart-point' }));
        const hit = node('circle', { cx: String(x(point.day)), cy: String(y(point.balance)), r: '17', class: 'monthly-chart-hit' });
        const title = node('title', {});
        title.textContent = `${dateText(point)}：${yen(point.balance)}。タップして詳細を表示`;
        group.append(hit, title);
        group.addEventListener('click', () => choose(index));
        svg.append(group);
        markers.push(group);
        const button = element('button', 'monthly-chart-date');
        button.type = 'button';
        button.textContent = `${point.day}日`;
        button.setAttribute('aria-label', `${dateText(point)}の入出金内訳`);
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => choose(index));
        button.addEventListener('keydown', (event) => {
            const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
            if (next !== null) {
                event.preventDefault();
                choose(Math.max(0, Math.min(buttons.length - 1, next)), true);
            }
        });
        dateList.append(button);
        buttons.push(button);
    }
    for (const day of [1, Math.ceil(chart.lastDay / 2), chart.lastDay]) {
        const t = node('text', { x: String(x(day)), y: String(H - 10), 'text-anchor': day === 1 ? 'start' : day === chart.lastDay ? 'end' : 'middle', class: 'monthly-chart-label' });
        t.textContent = `${day}日`;
        svg.append(t);
    }
    // Prefer a real event over the synthetic month-end marker on first display.
    const defaultIndex = selectable.map(p => p.kind).lastIndexOf('event');
    choose(defaultIndex >= 0 ? defaultIndex : selectable.length - 1);
    return section;
}
export function initMonthlySummary(deps) {
    const reportOpen = document.getElementById('monthly-report-open');
    reportOpen?.addEventListener('click', () => deps.openReport?.(period));
    let period = localPeriod();
    const confirmationOwner = {};
    let epoch = 0, cardCheckBusy = false, cardCheckError = null, cardCheckErrorPeriod = null;
    const picker = document.getElementById('monthly-period');
    const main = document.getElementById('monthly-content');
    const label = document.getElementById('monthly-heading-period');
    const $ = (id) => document.getElementById(id);
    const options = () => ({ label: '集計年月', min: '1900-02', today: localPeriod() });
    const go = (next) => { if (!monthInRange(next, options()))
        throw new Error('年月が不正です。'); period = next; syncPeriod(); render(); };
    const syncPeriod = bindMonthNavigator($('monthly-period-controls'), { picker, previous: $('monthly-prev'), next: $('monthly-next'), current: $('monthly-today') }, () => period, go, options);
    function metric(grid, title, value, detail, tone = '') {
        const box = element('section', `monthly-metric ${tone}`);
        box.append(element('span', 'monthly-metric-label', title), element('strong', 'monthly-metric-value', value));
        if (detail)
            box.append(element('small', 'monthly-muted', detail));
        grid.append(box);
    }
    function section(title) {
        const box = element('section', 'panel monthly-panel');
        box.append(element('h2', 'monthly-section-heading', title));
        const body = element('div', 'monthly-section-body');
        box.append(body);
        main.append(box);
        return { box, body };
    }
    function render() {
        syncPeriod();
        label.textContent = periodDisplay(period);
        main.replaceChildren();
        const source = deps.source();
        if (source === null) {
            main.append(element('div', 'panel monthly-lock', '月別サマリーを見るにはOneDrive保管庫のロック解除が必要です。'));
            return;
        }
        let report, prev, prepared;
        try {
            prepared = prepareMonthlyReports(source.records);
            report = monthlyReport(period, source, prepared);
            prev = monthlyReport(changePeriod(period, -1), source, prepared);
        }
        catch (err) {
            main.append(element('div', 'panel monthly-lock', `集計できませんでした：${err instanceof Error ? err.message : 'データエラー'}`));
            return;
        }
        const grid = element('div', 'monthly-metrics');
        main.append(grid);
        metric(grid, (report.incomeEstimates.length || report.recurringIncome > 0) ? '月間収入（入金予定含む）' : '月間収入', yen(report.income), [report.recurringIncome ? `定期入金 ${yen(report.recurringIncome)}` : '', report.oneTimeIncome ? `単発入金 ${yen(report.oneTimeIncome)}` : ''].filter(Boolean).join(' · '));
        metric(grid, 'カード引落予定額', yen(report.cardOutflow), report.cardNoUseConfirmed ? '利用なし確認済み' : report.provisional.length ? '暫定明細を含む' : report.cardOutflow === null ? '明細未取得' : '');
        metric(grid, '定期・単発支出', yen(report.recurringExpense + report.oneTimeExpense), [report.recurringExpense ? `定期予定 ${yen(report.recurringExpense)}` : '', report.oneTimeExpense ? `単発実行済み ${yen(report.oneTimeExpense)}` : ''].filter(Boolean).join(' · '));
        const delta = report.monthlyBalance === null || prev.monthlyBalance === null ? null : report.monthlyBalance - prev.monthlyBalance;
        metric(grid, '月間収支', report.monthlyBalance === null ? '算出不可' : yen(report.monthlyBalance), `前月比：${delta === null ? '比較不可' : formatSignedYen(delta)}`, report.monthlyBalance !== null ? (report.monthlyBalance >= 0 ? 'monthly-positive' : 'monthly-negative') : '');
        const alert = element('div', 'monthly-alert');
        const status = statusText(report);
        if (status)
            alert.append(element('p', '', status));
        if (report.cardOutflow === null)
            alert.append(element('p', '', 'カード明細が未取得です。登録済みの銀行定期支出・単発支出は別に確認できますが、月の支出総額は確定していません。'));
        if (report.pastUnconfirmedOneTime) {
            const warning = element('p', 'monthly-overlap-warning', `過去の未実行予定が${report.pastUnconfirmedOneTime}件あります。実績には含めていません。単発入出金の記録を確認してください。`);
            warning.setAttribute('role', 'alert');
            alert.append(warning);
        }
        if (deps.saveCardNoUseMonth && period <= localPeriod() && (report.cardOutflow === null || report.cardNoUseConfirmed) && report.issues.every(issue => issue.month !== period)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'secondary-action';
            button.textContent = report.cardNoUseConfirmed ? '「カード利用なし」を取り消す' : 'この月はカード利用なしと確認';
            button.disabled = cardCheckBusy;
            button.addEventListener('click', async () => {
                if (cardCheckBusy || confirmationPending())
                    return;
                const target = report.period, started = epoch, confirmed = report.cardNoUseConfirmed;
                // The selected month is pinned, and fresh data must still permit the action.
                const eligible = () => {
                    const latest = deps.source();
                    if (!latest || period !== target || target > localPeriod())
                        return false;
                    try {
                        const current = monthlyReport(target, latest);
                        return current.cardNoUseConfirmed === confirmed && (current.cardOutflow === null || current.cardNoUseConfirmed) &&
                            current.issues.every(issue => issue.month !== target) &&
                            (!confirmed ? !latest.records.some(record => record.statement.paymentDate?.slice(0, 7) === target) : true);
                    }
                    catch {
                        return false;
                    }
                };
                if (!eligible())
                    return;
                if (!await requestConfirmation({ owner: confirmationOwner, title: confirmed ? 'カード利用なし確認を取り消しますか？' : 'カード利用なしと確認しますか？',
                    message: confirmed ? `${formatMonth(target)}の利用なし確認を取り消します。` : `${formatMonth(target)}の全カードについて、利用・引落がなかったことを確認しましたか？`,
                    acceptLabel: confirmed ? '取り消す' : '確認を記録', destructive: confirmed }))
                    return;
                if (started !== epoch || cardCheckBusy || !deps.source())
                    return;
                if (!eligible()) {
                    cardCheckError = '明細または表示年月が変更されました。再確認してください。';
                    cardCheckErrorPeriod = period;
                    render();
                    return;
                }
                cardCheckBusy = true;
                cardCheckError = null;
                cardCheckErrorPeriod = null;
                render();
                try {
                    await deps.saveCardNoUseMonth(target, !confirmed);
                }
                catch (error) {
                    if (started === epoch) {
                        cardCheckError = error instanceof Error ? error.message : '確認を保存できませんでした。';
                        cardCheckErrorPeriod = target;
                    }
                }
                finally {
                    cardCheckBusy = false;
                    if (started === epoch)
                        render();
                }
            });
            alert.append(button);
        }
        if (cardCheckError && cardCheckErrorPeriod === period) {
            const warning = element('p', 'monthly-overlap-warning', cardCheckError);
            warning.setAttribute('role', 'alert');
            alert.append(warning);
        }
        if (report.recurringOneTimeOverlap)
            alert.append(element('p', '', `単発入出金と定期予定の対応が曖昧な項目が${report.recurringOneTimeOverlap}件あります。自動除外せず表示しています。`));
        if (report.recurringCardOverlap) {
            alert.prepend(element('strong', 'monthly-overlap-warning', '要確認：カードと定期支出が重複している可能性があります。収支は両方を含む暫定的な登録額です。'));
            alert.append(element('p', '', `名称・金額が一致する定期支出が${report.recurringCardOverlap}件あります。実際の支払いを照合し、二重登録なら支出の登録内容を修正してください。`));
            for (const entry of report.recurringLines.filter(item => item.cardOverlap)) {
                const open = entry.entryId.startsWith('cash:')
                    ? (deps.openFixedCost ? () => deps.openFixedCost(entry.entryId.slice(5)) : undefined)
                    : (deps.openRecurring ? () => deps.openRecurring(entry.entryId) : undefined);
                line(alert, `確認・修正：${entry.name}（${entry.date}）`, yen(entry.amount), open);
            }
        }
        if (alert.childElementCount)
            main.append(alert);
        if (report.oneTimePlannedExpense || report.oneTimePlannedIncome) {
            const planned = section('単発入出金予定');
            if (report.oneTimePlannedIncome)
                line(planned.body, '入金予定', yen(report.oneTimePlannedIncome));
            if (report.oneTimePlannedExpense)
                line(planned.body, '支出予定', yen(report.oneTimePlannedExpense));
            line(planned.body, '予定反映後の収支', report.monthlyBalance === null ? '算出不可' : yen(report.monthlyBalance + report.oneTimePlannedIncome - report.oneTimePlannedExpense));
        }
        main.append(pointBenefitsSection('推定ポイント', pointBenefitsFromMonthlyReport(report, source), pointCoverage([report])));
        // Bank cash flow is separate from whole-household monthly income/expense.
        // It starts from a manually confirmed bank balance, never a fabricated zero.
        const bank = section('楽天銀行の残高推移');
        const localDate = new Date();
        const localToday = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;
        const timeline = bankTimeline(period, source, localToday, { prepared, reports: new Map([[report.period, report], [prev.period, prev]]) });
        const bankroll = element('div', 'monthly-bank-overview');
        bank.body.append(bankroll);
        const bankMetric = (title, value, tone) => {
            const card = element('div', `monthly-bank-metric ${tone}`);
            card.append(element('span', 'monthly-muted', title), element('strong', '', value));
            bankroll.append(card);
        };
        bankMetric('月末の予測残高', yen(timeline.endBalance), timeline.endBalance !== null && timeline.endBalance < 0 ? 'monthly-negative' : '');
        bankMetric('期間内の最低残高', yen(timeline.minimum), timeline.minimum !== null && timeline.minimum < 0 ? 'monthly-negative' : '');
        const chart = bankChart(timeline, period);
        if (chart)
            bank.body.append(chart);
        if (timeline.warning)
            bank.body.append(element('p', 'monthly-bank-notice', timeline.warning));
        if (timeline.missingCardAccounts.length) {
            const notice = element('p', 'monthly-bank-notice', `引落口座未設定：${timeline.missingCardAccounts.join('、')}。`);
            if (deps.openCardSettings) {
                const button = element('button', 'monthly-link', 'カード設定を開く');
                button.type = 'button';
                button.addEventListener('click', deps.openCardSettings);
                notice.append(button);
            }
            else
                notice.append('カード設定で設定できます。');
            bank.body.append(notice);
        }
        if (timeline.minimum !== null && timeline.minimum < 0)
            bank.body.append(element('p', 'monthly-bank-danger', '引落予定に対して残高不足となる日があります。'));
        if (timeline.days.length) {
            const allDays = element('details', 'monthly-bank-all');
            allDays.append(element('summary', '', 'すべての入出金予定を表示'));
            const timelineList = element('div', 'monthly-bank-days');
            allDays.append(timelineList);
            bank.body.append(allDays);
            for (const day of timeline.days) {
                const item = element('div', 'monthly-bank-day');
                const date = element('div', 'monthly-bank-day-date', formatShortDate(day.date));
                const descriptions = element('div', 'monthly-bank-events');
                for (const event of day.items) {
                    const line = element('div', 'monthly-bank-event');
                    line.append(element('span', '', event.title + (event.provisional ? '（暫定）' : '')), element('b', event.amount < 0 ? 'monthly-bank-minus' : '', formatSignedYen(event.amount)));
                    descriptions.append(line);
                }
                const balance = element('strong', day.balance < 0 ? 'monthly-bank-balance monthly-negative' : 'monthly-bank-balance', yen(day.balance));
                item.append(date, descriptions, balance);
                timelineList.append(item);
            }
        }
        else if (timeline.startDay)
            empty(bank.body, '基準残高以降、この月末までの登録済み入出金はありません。');
        const grid2 = element('div', 'monthly-paired monthly-triptych');
        main.append(grid2);
        const addPair = (title) => {
            const box = element('section', 'panel monthly-panel');
            box.append(element('h2', 'monthly-section-heading', title));
            const body = element('div', 'monthly-section-body');
            box.append(body);
            grid2.append(box);
            return body;
        };
        const incomes = addPair('収入内訳');
        if (!report.payrollReady)
            empty(incomes, 'Payroll未同期。設定から連携状態を確認してください。');
        else if (!report.incomeLines.length && !report.incomeEstimates.length)
            empty(incomes, 'この月の公開済み給与実績はありません。');
        else
            for (const row of [...report.incomeLines].sort((a, b) => a.date.localeCompare(b.date))) {
                line(incomes, `${payrollRoleLabel(row.job)} · ${kindName(row.kind)} · ${formatDate(row.date)}`, yen(row.amount));
            }
        for (const estimate of report.incomeEstimates) { /* finance-v149 */
            line(incomes, `本業 · 給与見込み（${estimate.sourcePeriod.slice(5)}月実績）`, yen(estimate.amount));
        }
        for (const item of report.oneTimeLines.filter(e => e.kind === 'income'))
            line(incomes, `${item.name} · ${formatDate(item.date)} · ${item.status === 'planned' ? '予定' : '実行済み'}`, yen(item.amount));
        for (const item of report.recurringLines.filter(e => e.kind === 'income'))
            line(incomes, `${item.name} · ${accountName(item.toAccountId)}入金予定 · ${formatDate(item.date)}`, yen(item.amount));
        if (report.payrollReady && report.payrollSyncedAt)
            incomes.append(element('p', 'monthly-muted', `Payroll最終同期：${formatDateTime(report.payrollSyncedAt, true)}`));
        const cards = addPair('カード別引落額');
        if (report.cardNoUseConfirmed)
            empty(cards, '利用なし確認済み');
        else if (report.cardOutflow === null)
            empty(cards, '明細未取得');
        else
            cardRows(cards, [...report.cardLines].sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.name.localeCompare(b.name, 'ja')), deps.openRecord);
        if (report.cardOutflow !== null) {
            line(cards, 'カード合計', yen(report.cardOutflow));
            line(cards, 'うちNISA積立（資産移動）', yen(report.nisaOutflow));
            line(cards, 'NISA積立を除いた金額', yen(report.livingOutflow));
        }
        const debits = { body: addPair('入出金予定') };
        const expenseItems = report.recurringLines.filter(e => e.kind === 'expense');
        if (!report.recurringLines.some(e => e.kind !== 'income') && !report.oneTimeLines.some(e => e.kind !== 'income'))
            empty(debits.body, 'この月の支出・振替予定はありません。');
        for (const item of expenseItems)
            scheduledLine(debits.body, item.date, item.name, item.entryId.startsWith('cash:') ? '現金支出予定' : `${accountName(item.fromAccountId)} → 支出`, item.amount);
        if (expenseItems.length)
            line(debits.body, '定期支出合計', yen(report.recurringExpense));
        const transfers = report.recurringLines.filter(e => e.kind === 'transfer');
        for (const item of transfers)
            scheduledLine(debits.body, item.date, item.name, `${accountName(item.fromAccountId)} → ${accountName(item.toAccountId)}`, item.amount);
        for (const item of report.oneTimeLines.filter(e => e.kind !== 'income')) {
            const route = item.kind === 'transfer' ? `${accountName(item.fromAccountId)} → ${accountName(item.toAccountId)}` :
                `${accountName(item.fromAccountId)} · ${item.kind === 'withdrawal' ? '現金引出' : '支出'}`;
            scheduledLine(debits.body, item.date, `${item.name}（${item.status === 'planned' ? '予定' : '実行済み'}）`, route, item.amount);
        }
        // Keep the two insights in one responsive row. /* finance-v147 */
        const insightGrid = element('div', 'monthly-insights');
        main.append(insightGrid);
        const insightSection = (title) => {
            const result = section(title);
            insightGrid.append(result.box);
            return result;
        };
        const category = insightSection('カテゴリー別支出');
        if (!report.categories.length)
            empty(category.body, '分類できる支出はありません。');
        const largest = Math.max(1, ...report.categories.map(item => Math.max(0, item.amount)));
        for (const item of report.categories) {
            const wrapper = element('div', 'monthly-bar-line');
            const head = element('div', 'monthly-bar-head');
            const categoryLink = element('button', 'monthly-link monthly-ranking-link', `${item.name}（${item.count}件）`);
            categoryLink.type = 'button';
            categoryLink.title = `${item.name}の明細と定期支出内訳を見る`;
            categoryLink.addEventListener('click', () => deps.openDrilldown({ dimension: 'category', value: item.id, label: item.name, periods: [period] }));
            head.append(categoryLink, element('strong', '', yen(item.amount)));
            const track = element('div', 'monthly-bar-track'), fill = element('div', 'monthly-bar-fill');
            fill.style.width = `${Math.max(0, item.amount) / largest * 100}%`;
            const color = item.id === '__nisa' ? '#43A778' : PALETTE.find(p => p.id === item.color)?.hex;
            if (color)
                fill.style.backgroundColor = color;
            track.append(fill);
            wrapper.append(head, track);
            category.body.append(wrapper);
        }
        const merchants = insightSection(report.merchants.length > 10 ? 'カード利用先ランキング（上位10件）' : 'カード利用先ランキング');
        if (!report.merchants.length)
            empty(merchants.body, '対象となる利用先はありません。');
        else
            for (const [index, item] of report.merchants.slice(0, 10).entries()) {
                line(merchants.body, `${index + 1}. ${item.name}（${item.count}件）`, yen(item.amount), () => deps.openDrilldown({ dimension: 'merchant', value: item.name, label: item.name, periods: [period] }));
            }
        const problemCount = report.issues.filter(item => item.month === period).length;
        const counts = [['集計対象外の明細', problemCount], ['支払日が不明な明細（全期間）', report.issues.filter(item => item.month === null).length], ['暫定明細（集計に含む）', report.provisional.length], ['確定状態が不明な明細', report.unknownConfirmationCount], ['未分類の取引', report.unclassifiedCount], ['カードとの重複要確認', report.recurringCardOverlap]];
        if (!counts.some(([, count]) => count > 0) && !report.issues.length)
            return;
        const quality = section('データの確認');
        for (const [name, count] of counts)
            if (count > 0)
                line(quality.body, name, `${count}件`);
        if (report.provisional.length) {
            quality.body.append(element('h3', 'monthly-subheading', '暫定明細（集計済み・後で金額が変動する可能性あり）'));
            cardRows(quality.body, report.provisional, deps.openRecord);
        }
        if (report.issues.length) {
            quality.body.append(element('h3', 'monthly-subheading', '修正が必要な明細'));
            for (const issue of report.issues) {
                const row = element('div', 'monthly-issue');
                const action = document.createElement('button');
                action.type = 'button';
                action.className = 'monthly-link';
                action.textContent = issue.title;
                action.addEventListener('click', () => deps.openRecord(issue.id));
                row.append(action, element('small', 'monthly-muted', issue.reason));
                quality.body.append(row);
            }
        }
    }
    return { render, isBusy: () => cardCheckBusy || confirmationPending(confirmationOwner), setPeriod: (next) => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(next))
            throw new Error("年月が不正です。"); go(next); }, reset: () => { epoch++; cancelConfirmation(confirmationOwner); cardCheckError = null; cardCheckErrorPeriod = null; period = localPeriod(); syncPeriod(); main.replaceChildren(); label.textContent = periodDisplay(period); } };
}
