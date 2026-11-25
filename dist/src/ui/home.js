import { requestConfirmation, confirmationPending, cancelConfirmation } from './modal.js';
import { monthlyReport } from '../summary/monthly-summary.js';
import { DATA_STATUS, financialStatusClass, formatYen as sharedYen, formatSignedYen, formatShortDate, formatDateTime } from './formatters.js';
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
    let showAllActions = false, showAllMovements = false, showCompletedFunding = false;
    let fundingBusy = false, fundingError = '';
    const confirmationOwner = {};
    let epoch = 0;
    const go = (destination, recordId, drilldown) => deps.navigate(destination, recordId, drilldown);
    function fundingPanel(status) {
        const section = element('div', 'home-funding' + (status.overdue && status.billConfirmed ? ' home-funding-overdue' : ''));
        const head = element('div', 'home-funding-heading');
        const state = status.changedSinceCheck ? '再確認' : status.completed ? '確認済み' : !status.periodOpen ? '12日から確認' : !status.billConfirmed ? '明細確定待ち' : status.overdue ? '期限超過' : '未確認';
        head.append(element('strong', '', 'みずほ送金'), element('strong', 'home-funding-state', state));
        section.append(head, element('p', 'home-muted home-funding-facts', `${Number(status.month.slice(5))}月分 · ${status.dueDate ? shortDay(status.dueDate) + 'まで' : '期限未取得'}${!status.billConfirmed && state !== '明細確定待ち' ? ' · 明細確定待ち' : ''}`), element('strong', 'home-funding-amount', yen(status.amount)));
        if (status.changedSinceCheck) {
            const warning = element('p', 'home-funding-error', '以前の「送金済み」確認は無効です。請求額・支払日・送金予定額を確認し、不足額があれば送金してください。');
            warning.setAttribute('role', 'alert');
            section.append(warning);
        }
        if (status.completed && status.updatedAt)
            section.append(element('p', 'home-muted home-funding-facts', `確認日時：${formatDateTime(status.updatedAt, true)}`));
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
                if (!await requestConfirmation({ owner: confirmationOwner, title: status.completed ? '送金済み記録を取り消しますか？' : '送金済みとして記録しますか？',
                    message: status.completed ? `${status.month}分の送金済み記録を取り消します。` :
                        `${status.month}分の確定請求額 ${yen(snapshot.billAmount)}、支払日 ${snapshot.paymentDate}、送金目安 ${yen(snapshot.transferAmount)}。\n実際の送金完了後に記録してください。残高や振替実績は変更されません。`,
                    acceptLabel: status.completed ? '取り消す' : '送金済み', destructive: status.completed }))
                    return;
                if (started !== epoch || fundingBusy || !deps.source())
                    return;
                if (JSON.stringify(current()) !== baseline) {
                    fundingError = '請求内容または送金記録が変更されました。再確認してください。';
                    render();
                    return;
                }
                fundingBusy = true;
                fundingError = '';
                render();
                try {
                    await deps.saveMizuhoFunding(status.month, !status.completed, status.completed ? undefined : snapshot ?? undefined);
                }
                catch (error) {
                    if (started === epoch)
                        fundingError = error instanceof Error ? error.message : '保存できませんでした。';
                }
                finally {
                    fundingBusy = false;
                    if (started === epoch)
                        render();
                }
            }, status.completed ? 'home-funding-revoke' : 'home-funding-save');
            button.disabled = fundingBusy || (!status.completed && !status.billConfirmed);
            controls.append(button);
        }
        if (status.periodOpen && !status.billConfirmed && !status.completed) {
            const source = deps.source();
            const bills = source?.records.filter(record => record.statement.cardId === 'rakuten-mizuho' && record.statement.paymentDate?.slice(0, 7) === status.month) ?? [];
            controls.append(link(bills.length === 1 ? '明細を確認' : bills.length ? '明細管理' : '明細を取り込む', () => go(bills.length ? 'manage' : 'import', bills.length === 1 ? bills[0].id : undefined), 'home-funding-review'));
            section.append(element('p', 'home-muted home-funding-facts', '請求明細の確定後に送金済みを記録できます。'));
        }
        if (controls.childElementCount)
            section.append(controls);
        if (fundingError) {
            const error = element('p', 'home-funding-error', fundingError);
            error.setAttribute('role', 'alert');
            section.append(error);
        }
        return section;
    }
    function renderOverview(model, source) {
        const { report, forecast, accounts, actions } = model;
        const metrics = element('div', 'home-metrics');
        const dataNotice = model.coverage === 'missing' ? 'カード明細未取得' : model.coverage === 'partial' ? (report.cardLines.length ? '一部カードのみ確認済み' : '一部未取得・銀行支出は反映') : model.coverage === 'needs-review' ? '明細要確認' :
            model.coverage === 'provisional' ? '暫定明細を含む' : '';
        metrics.append(metric('収入', yen(report.income), [report.recurringIncome > 0 ? '入金予定含む' : '', report.incomeEstimates.length ? '給与見込みを含む' : ''].filter(Boolean).join(' · '), () => go('summary')), metric('支出', report.cardOutflow === null ? DATA_STATUS.unavailable : yen(model.outflow), [dataNotice, report.cardOutflow === null && model.outflow !== null ? `判明分 ${yen(model.outflow)}` : '', report.nisaOutflow > 0 ? `NISA積立 ${yen(report.nisaOutflow)} を含む` : ''].filter(Boolean).join(' · '), () => go('summary')), metric('収支', report.monthlyBalance === null ? DATA_STATUS.unavailable : yen(report.monthlyBalance), report.cardOutflow === null ? 'カード明細未取得' : report.income === null ? '収入未取得' : dataNotice, () => go('summary'), report.monthlyBalance === null ? '' : report.monthlyBalance < 0 ? 'cashflow-negative' : 'cashflow-positive'));
        root.append(metrics);
        const funding = mizuhoFundingStatus(source, report, model.today);
        const fundingItems = [], completedItems = [];
        // An unpaid previous month must remain visible after the calendar rolls
        // over. Only show this warning when there really was a card bill.
        if (model.priorFundingReport?.cardLines.some(card => card.cardId === 'rakuten-mizuho')) {
            const previous = mizuhoFundingStatusForMonth(source, model.priorFundingReport, model.today);
            if (previous) {
                const item = fundingPanel(previous);
                if (previous.completed)
                    completedItems.push(item);
                else {
                    item.classList.add('home-funding-prior');
                    fundingItems.push(item);
                }
            }
        }
        if (funding)
            (funding.completed ? completedItems : fundingItems).push(fundingPanel(funding));
        if (actions.length || fundingItems.length || completedItems.length) {
            const actionSection = section('確認すること');
            actionSection.body.append(...fundingItems);
            const visible = showAllActions ? actions : actions.slice(0, 6);
            for (const action of visible) {
                const drilldown = action.kind === 'unclassified'
                    ? { periods: [report.period], dimension: 'category', value: '__unclassified', label: '未分類' } : undefined;
                const item = link('', () => { if (action.kind === 'card-account' && deps.openCardSettings)
                    deps.openCardSettings();
                else
                    go(action.target, action.recordId, drilldown); }, `home-action home-${action.severity}`);
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
            if (completedItems.length) {
                const done = element('details', 'home-funding-completed');
                done.open = showCompletedFunding;
                done.append(element('summary', 'home-muted', 'みずほ送金 · 確認済み'), ...completedItems);
                done.addEventListener('toggle', () => { showCompletedFunding = done.open; });
                actionSection.body.append(done);
            }
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
            row.append(element('small', `home-account-forecast ${account.predicted === null ? 'data-status-muted' : ''}`, `来月末の予測：${account.predicted === null ? DATA_STATUS.unavailable : yen(account.predicted)}`));
            if (account.warning && account.snapshot)
                row.append(element('small', 'home-muted', account.warning));
            list.append(row);
        }
        accountSection.body.append(list);
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
                locked.append(element('h2', '', 'OneDrive保管庫を開く'), element('p', 'home-muted', '接続・ロック解除後にホームを表示します。'), link('設定を開く', () => go('settings'), 'home-primary'));
                root.append(locked);
                return;
            }
            try {
                renderOverview(measureFinanceSync('ui.home.overview', () => homeOverview(source, today)), source);
            }
            catch (error) {
                const failed = element('section', 'panel home-locked');
                failed.append(element('h2', '', 'ホームを表示できません'), element('p', 'home-muted', error instanceof Error ? error.message : 'データを確認してください。'), link('月別サマリー', () => go('summary'), 'home-primary'));
                root.append(failed);
            }
        });
    }
    return { render, isBusy: () => fundingBusy || confirmationPending(confirmationOwner), reset: () => { epoch++; cancelConfirmation(confirmationOwner); showAllActions = false; showAllMovements = false; showCompletedFunding = false; fundingError = ''; render(); } };
}
