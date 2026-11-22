import { showActivity } from './activity-feedback.js';
import { CloudWriteUncertainError } from '../cloud/live-vault.js';
import { detectCardSubscriptions, latestRegisteredCardCharges, matchedCardRecurringDecision, legacyDecisionMigrationCandidate, subscriptionDecision } from '../subscriptions/detect.js';
const yen = (amount) => `${amount.toLocaleString('ja-JP')}円`;
function el(tag, cls = '', text) {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function button(label, click, cls = 'secondary-action') {
    const node = el('button', cls, label);
    node.type = 'button';
    node.addEventListener('click', click);
    return node;
}
export function initSubscriptions(deps) {
    const root = document.getElementById('subscriptions-content');
    if (!root)
        throw new Error('定期支出画面が見つかりません。');
    let filter = 'candidate';
    let busy = false, notice = '';
    function reset() { filter = 'candidate'; busy = false; notice = ''; root.replaceChildren(); }
    async function update(key, decision) {
        const vault = deps.vault();
        if (busy || !vault?.unlocked)
            return;
        busy = true;
        notice = '';
        showActivity('定期支出の設定を保存中…', 'working');
        render();
        try {
            await vault.setCardRecurringDecision(key, decision);
            notice = '';
            showActivity(decision ? '定期支出を保存しました。' : '候補に戻しました。', 'good');
            deps.onSaved();
        }
        catch (error) {
            notice = `${error instanceof CloudWriteUncertainError ? '保存結果未確認' : '保存失敗'}：${error instanceof Error ? error.message : '通信エラー'}`;
            showActivity(notice, 'bad');
        }
        finally {
            busy = false;
            render();
        }
    }
    async function migrateLegacy(fromKey, candidate) {
        const vault = deps.vault(), source = deps.source();
        const old = source?.assets.cardRecurringDecisions?.[fromKey];
        if (busy || !vault?.unlocked || !old || !source)
            return;
        if (!window.confirm(`既存の「${old.label}」を「${candidate.merchant}」に紐付け直しますか？\n登録状態は維持されます。`))
            return;
        busy = true;
        notice = '';
        showActivity('既存の定期支出を紐付け直しています…', 'working');
        render();
        try {
            await vault.migrateCardRecurringDecision(fromKey, candidate.key, old, { ...old, merchant: candidate.key.slice(candidate.cardId.length + 1), label: candidate.merchant });
            deps.onSaved();
            showActivity('既存の登録を引き継ぎました。', 'good');
        }
        catch (error) {
            notice = `移行失敗：${error instanceof Error ? error.message : '通信エラー'}`;
            showActivity(notice, 'bad');
        }
        finally {
            busy = false;
            render();
        }
    }
    function card(name, sub, amount, description, actions) {
        const block = el('article', 'panel subscriptions-card');
        const header = el('div', 'subscriptions-card-heading');
        const title = el('div', 'subscriptions-card-title');
        title.append(el('strong', '', name), el('small', '', sub));
        header.append(title, el('strong', 'subscriptions-amount', amount));
        block.append(header);
        if (description)
            block.append(el('p', 'subscriptions-evidence', description));
        const controls = el('div', 'subscriptions-actions');
        for (const action of actions)
            controls.append(action);
        block.append(controls);
        return block;
    }
    function render() {
        root.replaceChildren();
        const source = deps.source();
        const vault = deps.vault();
        if (!source || !vault?.unlocked) {
            root.append(el('p', 'subscriptions-muted', 'OneDriveに接続してください。'));
            return;
        }
        const candidates = detectCardSubscriptions(source);
        const decisions = source.assets.cardRecurringDecisions ?? {};
        const pending = candidates.filter(item => !matchedCardRecurringDecision(decisions, item));
        const registered = Object.entries(decisions).filter(([, value]) => value.state === 'registered');
        const ignored = Object.entries(decisions).filter(([, value]) => value.state === 'ignored');
        const tabs = el('div', 'subscriptions-tabs');
        for (const [key, label, count] of [['candidate', '候補', pending.length], ['registered', '登録済み', registered.length], ['ignored', '対象外', ignored.length]]) {
            const control = button(`${label} ${count}`, () => { filter = key; render(); }, 'subscriptions-tab' + (filter === key ? ' selected' : ''));
            control.setAttribute('aria-pressed', String(filter === key));
            tabs.append(control);
        }
        root.append(tabs);
        if (notice) {
            const error = el('p', 'subscriptions-notice error', notice);
            error.setAttribute('role', 'alert');
            root.append(error);
        }
        // Failed/uncertain writes remain visible here after the activity card disappears.
        const list = el('div', 'subscriptions-list');
        const details = (item) => `${item.months.length}回 · ${item.months.slice(-4).join(' / ')}${item.months.length > 4 ? ' ほか' : ''} · ${item.minAmount === item.maxAmount ? '同額' : `${yen(item.minAmount)}〜${yen(item.maxAmount)}`}`;
        if (filter === 'candidate') {
            for (const item of pending) {
                const actions = [button('登録', () => { void update(item.key, subscriptionDecision(item, 'registered')); }, 'save-action'),
                    button('候補から除外', () => { void update(item.key, subscriptionDecision(item, 'ignored')); })];
                const legacy = legacyDecisionMigrationCandidate(decisions, candidates, item);
                if (legacy)
                    actions.push(button('既存登録と紐付け', () => { void migrateLegacy(legacy, item); }));
                for (const b of actions)
                    b.disabled = busy;
                list.append(card(item.merchant, `${item.cardName} · ${item.frequency === 'monthly' ? '毎月' : '毎年'}の可能性`, yen(item.amount), details(item), actions));
            }
            if (!pending.length)
                list.append(el('p', 'subscriptions-empty', '確認が必要な候補はありません。'));
        }
        else {
            const selected = filter === 'registered' ? registered : ignored;
            const latestCharges = filter === 'registered' ? latestRegisteredCardCharges(source) : null;
            for (const [key, item] of selected) {
                const control = button('候補に戻す', () => { void update(key, null); });
                control.disabled = busy;
                const cardName = source.assets.cardPreferences?.[item.cardId]?.name ?? item.cardId;
                const current = candidates.find(candidate => matchedCardRecurringDecision(decisions, candidate) === key);
                const latest = latestCharges?.get(current?.key ?? key) ?? null;
                const difference = latest ? latest.amount - item.amount : 0;
                const evidence = filter === 'registered'
                    ? `登録時の推定額：${yen(item.amount)} · 最新の確認済み明細：${latest ? `${yen(latest.amount)}（${latest.month.replace('-', '年')}月支払）${difference ? ` · 登録時との差額 ${difference > 0 ? '+' : '−'}${yen(Math.abs(difference))}` : ' · 変化なし'}` : '確認できません'}`
                    : '候補から除外しています';
                const entry = card(current?.merchant ?? item.label, `${cardName} · ${item.frequency === 'monthly' ? '毎月' : '毎年'}`, yen(latest?.amount ?? item.amount), evidence, [control]);
                if (filter === 'registered' && difference)
                    entry.classList.add('subscriptions-price-changed');
                list.append(entry);
            }
            if (!selected.length)
                list.append(el('p', 'subscriptions-empty', '登録はありません。'));
        }
        root.append(list);
        const bottom = el('div', 'subscriptions-footer');
        bottom.append(el('p', 'subscriptions-muted', 'カード払いは明細に含まれます。'));
        bottom.append(button('銀行の定期入出金を管理', deps.openAccountSettings));
        root.append(bottom);
    }
    return { render, reset, isBusy: () => busy };
}
