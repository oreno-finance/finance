import { requestConfirmation, confirmationPending, cancelConfirmation } from './modal.js';
import { monthlyReport, changePeriod } from '../summary/monthly-summary.js';
import { DATA_STATUS, financialStatusClass, formatYen as sharedYen, formatSignedYen, formatShortDate, formatDateTime, formatMonth, formatDate } from './formatters.js';
import { showActivity, finishActivity } from './activity-feedback.js';
import { incomeMetricBreakdown } from './income-breakdown.js';
import { pointBenefitsFromMonthlyReport } from '../summary/point-benefits.js';
import { pointBenefitsSection, pointCoverage } from './point-benefits.js';
import { homeOverview } from '../home/overview.js';
import { mizuhoFundingStatus, mizuhoFundingStatusForMonth } from '../home/mizuho-funding.js';
import { measureFinanceSync } from '../cloud/performance-diagnostics.js';
function element(tag, className = '', content) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (content !== undefined)
        node.textContent = content;
    return node;
}
function link(label, handler, cls = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = cls;
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
}
const yen = (value) => sharedYen(value, 0, DATA_STATUS.missing);
const shortDay = formatShortDate;
function todayLocal() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function confirmationLabel(value) {
    return value === 'provisional' ? DATA_STATUS.provisional : value === 'confirmed' ? '確定' : '未確認';
}
function metric(title, value, sub, go, tone = '') {
    const button = link('', go, `home-metric ${tone}`);
    button.append(element('span', 'home-muted', title), element('strong', financialStatusClass(value), value));
    if (sub)
        button.append(element('small', 'home-muted', sub));
    return button;
}
function section(title) {
    const box = element('section', 'panel home-section');
    box.append(element('h2', 'home-section-title', title));
    const body = element('div', 'home-section-body');
    box.append(body);
    return { section: box, body };
}
export function initHome(deps) {
    const root = document.getElementById('home-content');
    if (!root)
        throw new Error('ホーム画面が見つかりません。');
    let showAllActions = false, showAllMovements = false;
    let fundingBusy = false;
    const confirmationOwner = {};
    let epoch = 0;
    const go = (destination, recordId) => deps.navigate(destination, recordId);
    function fundingPanel(status) {
        const section = element('div', 'home-funding' + (status.overdue && status.billConfirmed ? ' home-funding-overdue' : ''));
        const head = element('div', 'home-funding-heading');
        const state = status.changedSinceCheck ? '再確認' : status.completed ? '確認済み' : !status.periodOpen ? '12日から確認' : !status.billConfirmed ? '明細確定待ち' : status.overdue ? '期限超過' : '未確認';
        head.append(element('strong', '', 'みずほ送金'), element('small', 'home-funding-state', state));
        const body = element('div', 'home-funding-body'), copy = element('div', 'home-funding-copy');
        section.append(head, body);
        body.append(copy);
        copy.append(element('p', 'home-muted home-funding-facts', `${formatMonth(status.month)}分 · ${status.dueDate ? shortDay(status.dueDate) + 'まで' : '期限未取得'}${!status.billConfirmed && state !== '明細確定待ち' ? ' · 明細確定待ち' : ''}`), element('strong', `home-funding-amount ${financialStatusClass(yen(status.amount))}`, yen(status.amount)));
        if (status.changedSinceCheck) {
            const warning = element('p', 'home-funding-error', '以前の「送金済み」確認は無効です。請求額・支払日・送金予定額を確認し、不足額があれば送金してください。');
            warning.setAttribute('role', 'alert');
            section.append(warning);
        }
        if (status.completed && status.updatedAt)
            copy.append(element('p', 'home-muted home-funding-facts', `確認日時：${formatDateTime(status.updatedAt, true)}`));
        const controls = element('div', 'home-funding-controls');
        if (status.periodOpen && deps.saveMizuhoFunding && (status.completed || status.billConfirmed)) {
            const button = link(fundingBusy ? '保存中…' : status.completed ? '確認を取り消す' : status.changedSinceCheck ? '再確認' : '送金済み', async () => {
                if (fundingBusy || confirmationPending())
                    return;
                if (!status.completed && (!status.billConfirmed || !status.billSnapshot))
                    return;
                const started = epoch, baseline = JSON.stringify(status);
                const current = () => {
                    const source = deps.source();
                    if (!source)
                        return null;
                    const today = todayLocal();
                    try {
                        return mizuhoFundingStatusForMonth(source, monthlyReport(status.month, source), today);
                    }
                    catch {
                        return null;
                    }
                };
                if (JSON.stringify(current()) !== baseline)
                    return;
                const snapshot = status.billSnapshot;
                if (!await requestConfirmation({ owner: confirmationOwner, title: status.completed ? '送金済み記録の取り消し' : 'みずほ送金の確認',
                    message: status.completed ? `${formatMonth(status.month)}分の送金済み記録を取り消します。よろしいですか？` :
                        `${formatMonth(status.month)}分の確定請求額：${yen(snapshot.billAmount)}\n支払日：${formatDate(snapshot.paymentDate)}\n送金目安：${yen(snapshot.transferAmount)}\n\n実際の送金は行いません。送金済みとして記録します。よろしいですか？`,
                    acceptLabel: status.completed ? '取り消す' : 'はい', destructive: status.completed }))
                    return;
                if (started !== epoch || fundingBusy || !deps.source())
                    return;
                if (JSON.stringify(current()) !== baseline) {
                    showActivity('請求内容または送金記録が変更されました。再確認してください。', 'warn');
                    render();
                    renderFundingHistory();
                    return;
                }
                const progress = 'みずほ送金の確認を保存中…';
                fundingBusy = true;
                showActivity(progress, 'working');
                render();
                renderFundingHistory();
                try {
                    await deps.saveMizuhoFunding(status.month, !status.completed, status.completed ? undefined : snapshot ?? undefined);
                    if (started === epoch) {
                        // A vault mutation may have reported a release warning; do not replace it.
                        if (document.getElementById('toast')?.dataset.kind !== 'warn')
                            showActivity(status.completed ? '送金済み記録を取り消しました。' : '送金済みとして記録しました。', 'good');
                    }
                }
                catch (error) {
                    if (started === epoch)
                        showActivity(error instanceof Error ? error.message : '送金済み記録を保存できませんでした。', 'bad');
                }
                finally {
                    fundingBusy = false;
                    if (started === epoch) {
                        finishActivity(progress);
                        render();
                        renderFundingHistory();
                    }
                }
            }, status.completed ? 'secondary-action home-funding-revoke' : 'save-action home-funding-save');
            button.disabled = fundingBusy || (!status.completed && !status.billConfirmed);
            controls.append(button);
        }
        if (status.periodOpen && !status.billConfirmed && !status.completed) {
            const source = deps.source();
            const bills = source?.records.filter(record => record.statement.cardId === 'rakuten-mizuho' && record.statement.paymentDate?.slice(0, 7) === status.month) ?? [];
            controls.append(link(bills.length === 1 ? '明細を確認' : bills.length ? '明細管理' : '明細を取り込む', () => go(bills.length ? 'manage' : 'import', bills.length === 1 ? bills[0].id : undefined), 'secondary-action home-funding-review'));
            copy.append(element('p', 'home-muted home-funding-facts', '請求明細の確定後に送金済みを記録できます。'));
        }
        if (status.billSnapshot && deps.openFundingMovement) {
            const movement = link('実際の送金を記録・編集', () => { if (!fundingBusy)
                deps.openFundingMovement(status.billSnapshot); }, 'secondary-action home-funding-review');
            movement.disabled = fundingBusy;
            controls.append(movement);
            copy.append(element('p', 'home-muted home-funding-facts', '予定日・金額と異なる場合は、実際の送金を記録してください。'));
        }
        if (controls.childElementCount)
            body.append(controls);
        return section;
    }
    // Reuse the same confirmation controls, busy state and stale-target checks.
    function renderFundingHistory() {
        const history = document.getElementById('assets-funding-history');
        const panel = document.getElementById('assets-funding-history-panel');
        if (!history || !panel)
            return;
        history.replaceChildren();
        panel.classList.add('hidden');
        const source = deps.source();
        if (!source) {
            panel.open = false;
            return;
        }
        const today = todayLocal(), month = today.slice(0, 7), prior = changePeriod(month, -1);
        for (const period of [month, prior]) {
            if (!source.assets.mizuhoFundingChecks?.[period]?.done)
                continue;
            try {
                const status = mizuhoFundingStatusForMonth(source, monthlyReport(period, source), today);
                if (status?.completed)
                    history.append(fundingPanel(status));
            }
            catch {
                history.append(element('p', 'home-muted', '送金確認済み記録を表示できません。最新データを取得してください。'));
            }
        }
        panel.classList.toggle('hidden', !history.childElementCount);
    }
    function renderOverview(model, source) {
        const { report, forecast, accounts, actions } = model;
        const metrics = element('div', 'home-metrics');
        const dataNotice = model.coverage === 'missing' ? 'カード明細未取得' : model.coverage === 'partial' ? (report.cardLines.length ? '一部カードのみ確認済み' : '一部未取得・銀行支出は反映') : model.coverage === 'needs-review' ? '明細要確認' :
            model.coverage === 'provisional' ? '暫定明細を含む' : '';
        const incomeMetric = metric('収入', yen(report.income), source.payroll.loading ? '給与を読み込み中…' : [report.recurringIncome > 0 ? '入金予定含む' : '', report.incomeEstimates.length ? '給与見込みを含む' : ''].filter(Boolean).join(' · '), () => go('summary'));
        incomeMetric.append(incomeMetricBreakdown(report));
        metrics.append(incomeMetric, metric('支出', report.cardOutflow === null ? DATA_STATUS.unavailable : yen(model.outflow), [dataNotice, report.cardOutflow === null && model.outflow !== null ? `判明分 ${yen(model.outflow)}` : '', report.nisaOutflow > 0 ? `NISA積立 ${yen(report.nisaOutflow)} を含む` : ''].filter(Boolean).join(' · '), () => go('summary')), metric('収支', report.monthlyBalance === null ? DATA_STATUS.unavailable : yen(report.monthlyBalance), [`前月比：${model.balanceDelta === null ? '比較不可' : formatSignedYen(model.balanceDelta)}`, source.payroll.loading ? '給与を読み込み中…' : report.cardOutflow === null ? 'カード明細未取得' : report.income === null ? '収入未取得' : dataNotice].filter(Boolean).join(' · '), () => go('summary'), report.monthlyBalance === null ? '' : report.monthlyBalance < 0 ? 'cashflow-negative' : 'cashflow-positive'));
        root.append(metrics);
        const funding = mizuhoFundingStatus(source, report, model.today);
        const fundingItems = [];
        // An unpaid previous month must remain visible after the calendar rolls
        // over. Only show this warning when there really was a card bill.
        if (model.priorFundingReport?.cardLines.some(card => card.cardId === 'rakuten-mizuho')) {
            const previous = mizuhoFundingStatusForMonth(source, model.priorFundingReport, model.today);
            if (previous?.periodOpen && !previous.completed) {
                const item = fundingPanel(previous);
                item.classList.add('home-funding-prior');
                fundingItems.push(item);
            }
        }
        if (funding?.periodOpen && !funding.completed)
            fundingItems.push(fundingPanel(funding));
        {
            const actionSection = section('確認すること');
            actionSection.body.append(...fundingItems);
            const visible = showAllActions ? actions : actions.slice(0, 6);
            for (const action of visible) {
                const item = link('', () => { if (action.kind === 'card-account' && deps.openCardSettings)
                    deps.openCardSettings();
                else
                    go(action.target, action.recordId); }, `home-action home-${action.severity}`);
                const contents = element('span', 'home-action-copy');
                contents.append(element('strong', '', action.title));
                if (action.detail)
                    contents.append(element('small', 'home-muted', action.detail));
                item.append(element('span', 'home-action-dot'), contents, element('span', 'home-action-arrow', '›'));
                actionSection.body.append(item);
            }
            if (actions.length > 6)
                actionSection.body.append(link(showAllActions ? '表示を減らす' : `他${actions.length - 6}件を表示`, () => {
                    showAllActions = !showAllActions;
                    render();
                }, 'home-more'));
            if (!actions.length && !fundingItems.length)
                actionSection.body.append(element('p', 'home-empty', '現在、確認することはありません。'));
            root.append(actionSection.section);
        }
        const debitSection = section('次の入出金');
        const movementRows = [];
        const next = forecast.debits;
        for (const debit of next) {
            const item = debit.estimated ? element('div', 'home-list-row home-debit') : link('', () => go('manage', debit.id), 'home-list-row home-debit');
            const left = element('span', 'home-debit-main');
            left.append(element('strong', '', debit.estimated ? debit.name : (model.cardNames[debit.cardId] ?? debit.name)), element('small', 'home-muted', `${shortDay(debit.date)} · ${debit.estimated ? '見込み' : confirmationLabel(debit.confirmation)}`));
            const right = element('span', 'home-debit-amount');
            right.append(element('b', '', formatSignedYen(-debit.amount)), element('small', 'home-muted', debit.accountId ?
                debit.balanceReliable ? `引落後 ${yen(debit.afterBalance)}` : `引落後残高：${DATA_STATUS.unavailable}` : '引落口座未設定'));
            item.append(left, right);
            movementRows.push({ date: debit.date, node: item });
        }
        // Keep the original per-account events for calculations; collapse only the display.
        const seenTransfers = new Set();
        for (const event of forecast.upcomingMovements) {
            if (event.transferId) {
                if (seenTransfers.has(event.transferId))
                    continue;
                seenTransfers.add(event.transferId);
            }
            const item = link('', () => go('assets'), 'home-list-row home-debit');
            const left = element('span', 'home-debit-main');
            const account = accounts.find(a => a.id === event.accountId);
            left.append(element('strong', '', event.title), element('small', 'home-muted', `${shortDay(event.date)} · ${event.route ?? account?.name ?? '口座'} · ${event.kind === 'salary' ? '給与実績' : event.kind === 'salary-estimate' || event.movementStatus === 'estimated' ? '見込み' : event.movementStatus === 'done' ? '実行済み' : '予定'}`));
            const right = element('span', 'home-debit-amount');
            right.append(element('b', '', event.transferId ? yen(Math.abs(event.amount)) : formatSignedYen(event.amount)));
            item.append(left, right);
            movementRows.push({ date: event.date, node: item });
        }
        if (!movementRows.length)
            debitSection.body.append(element('p', 'home-empty', '直近の登録済み入出金予定はありません。'));
        movementRows.sort((a, b) => a.date.localeCompare(b.date));
        debitSection.body.append(...(showAllMovements ? movementRows : movementRows.slice(0, 6)).map(row => row.node));
        if (movementRows.length > 6)
            debitSection.body.append(link(showAllMovements ? '折りたたむ' : 'すべて表示', () => { showAllMovements = !showAllMovements; render(); }, 'home-more'));
        root.append(debitSection.section);
        const accountSection = section('口座と資産');
        const list = element('div', 'home-account-grid');
        for (const account of accounts) {
            const row = link('', () => go('assets'), 'home-account');
            const title = element('div', 'home-account-title');
            const currentLabel = account.current === null ? (account.snapshot ? DATA_STATUS.unavailable : DATA_STATUS.unregistered) : yen(account.current);
            title.append(element('strong', '', account.name), element('span', `home-account-balance ${financialStatusClass(currentLabel)}`, currentLabel));
            const date = account.snapshot ? formatDateTime(account.snapshot.observedAt).split(' ')[0] : null;
            row.append(title, element('small', 'home-muted', `現在の推定残高`), element('small', 'home-muted', date ? `最終確認：${yen(account.snapshot.balance)}（${date}）` : '残高未登録'));
            if (account.warning && account.snapshot)
                row.append(element('small', 'home-muted', account.warning));
            list.append(row);
        }
        accountSection.body.append(list);
        const end = model.monthEnd;
        const endCard = link('', () => go('assets'), 'home-account home-month-end');
        const endTitle = element('div', 'home-account-title');
        endTitle.append(element('strong', '', '月末の銀行残高見込み'), element('span', `home-account-balance ${end.total === null ? 'data-status-muted' : ''}`, end.total === null ? DATA_STATUS.unavailable : yen(end.total)));
        endCard.append(endTitle, element('small', 'home-muted', `楽天銀行 ${yen(end.rakuten)} · みずほ銀行 ${yen(end.mizuho)}`), element('small', 'home-muted', `${formatDate(end.date)}時点 · ${end.total === null ? '両口座の最新残高を確認してください' : end.reference ? '予定・未確認等を含む参考値' : '登録済み入出金からの見込み'} · 貯金・NISAは対象外`));
        if (end.sameDayEvents)
            endCard.append(element('small', 'home-muted', '残高確認日と同日の入出金は残高に含まれる前提です。入出金後に残高を再確認してください。'));
        accountSection.body.append(endCard);
        root.append(accountSection.section);
        root.append(pointBenefitsSection('今月の推定ポイント', measureFinanceSync('ui.home.points', () => pointBenefitsFromMonthlyReport(report, source)), pointCoverage([report])));
    }
    function render() {
        return measureFinanceSync('ui.home.render', () => {
            root.replaceChildren();
            const title = document.getElementById('home-period-label');
            const today = todayLocal();
            if (title)
                title.textContent = `${Number(today.slice(5, 7))}月の状況`;
            const source = deps.source();
            if (!source) {
                const locked = element('section', 'panel home-locked');
                locked.append(element('h2', '', 'OneDrive保管庫を開く'), element('p', 'home-muted', '接続・ロック解除後にホームを表示します。'), link('設定を開く', () => go('settings'), 'save-action home-primary'));
                root.append(locked);
                return;
            }
            try {
                renderOverview(measureFinanceSync('ui.home.overview', () => homeOverview(source, today)), source);
            }
            catch (error) {
                const failed = element('section', 'panel home-locked');
                failed.append(element('h2', '', 'ホームを表示できません'), element('p', 'home-muted', error instanceof Error ? error.message : 'データを確認してください。'), link('月別サマリー', () => go('summary'), 'save-action home-primary'));
                root.append(failed);
            }
        });
    }
    return { render, renderFundingHistory, isBusy: () => fundingBusy || confirmationPending(confirmationOwner), reset: () => { epoch++; cancelConfirmation(confirmationOwner); showAllActions = false; showAllMovements = false; render(); renderFundingHistory(); } };
}
