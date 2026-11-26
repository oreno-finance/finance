/** Single connection/locked screen layout for every Finance data menu.
 * All original page bodies, including nested headings, are restored unchanged
 * after the OneDrive vault is unlocked. Settings is never gated. */
export const FINANCE_CLOUD_GATE_PAGES = [
    { id: 'home-view', eyebrow: 'OVERVIEW', title: 'ホーム', subtitle: '今月の状況' },
    { id: 'import-view', eyebrow: 'STATEMENT IMPORT', title: '明細インポート', subtitle: 'カード明細の取り込み・確認' },
    { id: 'manage-view', eyebrow: 'STATEMENT MANAGEMENT', title: '明細管理', subtitle: '取り込んだ明細と取引の確認' },
    { id: 'rules-view', eyebrow: 'MERCHANT ALIASES', title: '利用先ルール', subtitle: 'カード明細の利用先を見やすい表示名に統一' },
    { id: 'assets-page', eyebrow: 'ASSET MANAGEMENT', title: '口座管理', subtitle: '銀行口座・現金・定期入出金の管理' },
    { id: 'future-view', eyebrow: 'SAVINGS FORECAST', title: '資産予測', subtitle: '現金貯金・NISAの将来予測' },
    { id: 'summary-view', eyebrow: 'MONTHLY SUMMARY', title: '月別サマリー', subtitle: '口座引落月を基準とした毎月の収支' },
    { id: 'analysis-view', eyebrow: 'ANALYTICS', title: '収支分析', subtitle: '月次・年間の推移' },
    { id: 'reports-view', eyebrow: 'MONTHLY REPORTS', title: '月次レポート', subtitle: '保存した時点の収支を振り返る記録' },
    { id: 'subscriptions-view', eyebrow: 'SUBSCRIPTIONS', title: '固定費管理', subtitle: 'カード・銀行・現金の継続支出を管理' },
];
function appendAction(target, label, callback, primary = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = primary ? 'save-action' : 'secondary-action';
    button.addEventListener('click', callback);
    target.append(button);
}
export function syncFinanceCloudGates(state) {
    for (const page of FINANCE_CLOUD_GATE_PAGES) {
        const view = document.getElementById(page.id);
        // A missing root means an application/template regression, not an optional menu.
        if (!view)
            throw new Error(`Finance cloud gate target is missing: ${page.id}`);
        let gate = view.querySelector(':scope > .finance-cloud-gate');
        view.classList.toggle('finance-cloud-gated', state.blocked);
        if (!state.blocked) {
            gate?.remove();
            continue;
        }
        if (!gate) {
            gate = document.createElement('div');
            gate.className = 'finance-cloud-gate';
            view.prepend(gate);
        }
        const displayTitle = state.checking ? (state.progress ?? 'OneDriveに接続中…') :
            state.locked ? 'OneDrive保管庫はロックされています' :
                state.notice.kind === 'connected' ? 'OneDrive保管庫が見つかりません' : 'OneDriveに接続できません';
        const displayMessage = state.checking ? '' :
            state.locked ? '保管庫を解除すると、このページのデータを表示できます。' :
                state.notice.kind === 'connected' ? '設定から接続先を確認してください。' : state.notice.message;
        const key = JSON.stringify([page.id, displayTitle, displayMessage, state.locked, state.checking, state.notice.kind]);
        if (gate.dataset.renderKey === key)
            continue;
        gate.dataset.renderKey = key;
        const heading = document.createElement('header');
        heading.className = 'finance-page-heading finance-cloud-gate-heading';
        const eyebrow = document.createElement('div');
        eyebrow.className = 'eyebrow';
        eyebrow.textContent = page.eyebrow;
        const h1 = document.createElement('h1');
        h1.append(document.createTextNode(page.title));
        const dot = document.createElement('span');
        dot.className = 'accent-dot';
        dot.textContent = '.';
        h1.append(dot);
        const lead = document.createElement('p');
        lead.className = 'lead';
        lead.textContent = page.subtitle;
        heading.append(eyebrow, h1, lead);
        const panel = document.createElement('section');
        panel.className = 'finance-cloud-gate-panel';
        panel.setAttribute('aria-label', 'OneDriveの接続状態');
        const title = document.createElement('h2');
        title.textContent = displayTitle;
        if (state.checking) {
            title.setAttribute('role', 'status');
            panel.append(title);
            gate.replaceChildren(heading, panel);
            continue;
        }
        const description = document.createElement('p');
        description.textContent = displayMessage;
        const actions = document.createElement('div');
        actions.className = 'finance-cloud-gate-actions';
        if (state.locked)
            appendAction(actions, '保管庫を解除', state.onUnlock, true);
        else if (state.notice.kind !== 'connected') {
            appendAction(actions, state.notice.kind === 'not-connected' ? 'Microsoftアカウントで接続' : '通信を再試行', state.onRetry, true);
            appendAction(actions, 'Microsoft認証をやり直す', state.onReauthenticate);
        }
        appendAction(actions, '設定を開く', state.onSettings);
        panel.append(title, description, actions);
        gate.replaceChildren(heading, panel);
    }
}
