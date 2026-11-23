/** One management screen for card subscriptions, bank standing orders, and cash commitments. */
import { CARDS } from '../models/types.js';
import { ASSET_ACCOUNTS, cardRecurringKey } from '../cloud/assets.js';
import { CloudWriteUncertainError } from '../cloud/live-vault.js';
import { detectCardSubscriptions, latestRegisteredCardCharges, matchedCardRecurringDecision, subscriptionDecision } from '../subscriptions/detect.js';
import { fixedCostState, monthlyEquivalent, priceOnDay } from '../fixed-costs/contracts.js';
import { showActivity } from './activity-feedback.js';
const yen = (n) => `${Math.round(n).toLocaleString('ja-JP')}円`;
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayBefore = (value) => new Date(Date.parse(`${value}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const dayAfter = (value) => new Date(Date.parse(`${value}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
function el(name, cls = '', text) { const node = document.createElement(name); if (cls)
    node.className = cls; if (text !== undefined)
    node.textContent = text; return node; }
function btn(text, click, cls = 'secondary-action') { const x = el('button', cls, text); x.type = 'button'; x.addEventListener('click', click); return x; }
function stateName(state) { return state === 'active' ? '利用中' : state === 'paused' ? '一時停止' : state === 'scheduled' ? '開始予定' : '終了済み'; }
function freqName(freq) { return freq === 'yearly' ? '毎年' : freq === 'weekly' ? '毎週' : '毎月'; }
function enrichHistory(history, startOn, oldAmount, newAmount, effectiveOn) {
    const prior = history.length ? [...history] : [{ effectiveOn: startOn, amount: oldAmount }];
    if (newAmount === prior.at(-1).amount)
        return prior;
    if (effectiveOn < startOn)
        throw new Error('料金適用日は契約開始日以降にしてください。');
    if (effectiveOn < prior.at(-1).effectiveOn)
        throw new Error('過去の料金履歴を変更できません。直近の料金適用日以降を指定してください。');
    if (effectiveOn === prior.at(-1).effectiveOn)
        prior[prior.length - 1] = { effectiveOn, amount: newAmount };
    else
        prior.push({ effectiveOn, amount: newAmount });
    return prior;
}
function changePauses(old, previous, next, effectiveOn) {
    const result = old.map(x => ({ ...x }));
    if (previous === next)
        return result;
    if (next === 'paused') {
        if (result.some(x => effectiveOn >= x.startOn && (x.endOn === null || effectiveOn <= x.endOn)))
            return result;
        const last = result.at(-1);
        if (last?.endOn === null)
            throw new Error('先に前回の停止期間を終了してください。');
        if (last?.endOn && effectiveOn <= last.endOn)
            throw new Error('停止期間が重複しています。');
        result.push({ startOn: effectiveOn, endOn: null });
    }
    else if (previous === 'paused') {
        const current = [...result].reverse().find(x => x.endOn === null);
        if (current) {
            if (effectiveOn < current.startOn)
                throw new Error('再開日を停止開始日以降にしてください。');
            if (effectiveOn === current.startOn)
                result.splice(result.indexOf(current), 1);
            else
                current.endOn = dayBefore(effectiveOn);
        }
    }
    return result;
}
export function initSubscriptions(deps) {
    const root = document.getElementById('subscriptions-content');
    if (!root)
        throw new Error('固定費管理画面が見つかりません。');
    let tab = 'registered', busy = false, notice = '';
    let editing = null;
    let baseline = '';
    const dialog = el('dialog', 'fixed-cost-dialog');
    dialog.setAttribute('aria-label', '固定支出の登録と編集');
    const form = el('form', 'fixed-cost-form');
    form.noValidate = true;
    const title = el('h2', '', '固定支出を追加');
    form.append(title);
    const field = (name, label, kind, options) => {
        const box = el('label', 'fixed-cost-field');
        box.append(el('span', '', label));
        let input;
        if (kind === 'select') {
            const x = el('select');
            for (const [value, name] of options ?? [])
                x.add(new Option(name, value));
            input = x;
        }
        else if (kind === 'textarea') {
            const x = el('textarea');
            x.rows = 2;
            x.maxLength = 500;
            input = x;
        }
        else {
            const x = el('input');
            x.type = kind;
            if (kind === 'number') {
                x.min = '1';
                x.step = '1';
                x.inputMode = 'numeric';
            }
            input = x;
        }
        input.name = name;
        box.append(input);
        form.append(box);
        return box;
    };
    field('name', '名前', 'text');
    field('category', 'カテゴリー', 'select');
    field('method', '支払方法', 'select', [['card', 'クレジットカード'], ['bank', '銀行口座'], ['cash', '現金']]);
    const cardField = field('cardId', '支払カード', 'select');
    const merchantField = field('merchant', '明細の利用先（任意・カード払いのみ）', 'text');
    const accountField = field('accountId', '引落口座', 'select', ASSET_ACCOUNTS.filter(a => a.id !== 'nisa').map(a => [a.id, a.name]));
    field('priceKind', '金額の種類', 'select', [['fixed', '固定額'], ['variable', '変動額（登録額は予算）']]);
    field('amount', '登録額（円）', 'number');
    field('priceDate', '料金変更の適用日', 'date');
    field('frequency', '支払周期', 'select', [['monthly', '毎月'], ['yearly', '毎年'], ['weekly', '毎週']]);
    field('startOn', '契約開始日', 'date');
    const monthField = field('month', '支払月（毎年の場合）', 'select', Array.from({ length: 12 }, (_, i) => [String(i + 1), `${i + 1}月`]));
    const dayField = field('day', '支払日', 'select', [['0', '末日'], ...Array.from({ length: 31 }, (_, i) => [String(i + 1), `${i + 1}日`])]);
    const weekField = field('weekday', '支払曜日', 'select', [['0', '日曜日'], ['1', '月曜日'], ['2', '火曜日'], ['3', '水曜日'], ['4', '木曜日'], ['5', '金曜日'], ['6', '土曜日']]);
    field('status', '契約状態', 'select', [['active', '利用中'], ['paused', '一時停止'], ['ended', '終了済み']]);
    field('statusDate', '停止・終了・再開の適用日', 'date');
    field('note', 'メモ', 'textarea');
    const error = el('p', 'fixed-cost-form-error');
    error.setAttribute('role', 'alert');
    form.append(error);
    const buttons = el('div', 'fixed-cost-form-actions');
    const cancel = btn('キャンセル', () => closeDialog());
    const save = el('button', 'save-action', '保存');
    save.type = 'submit';
    buttons.append(cancel, save);
    form.append(buttons);
    dialog.append(form);
    document.body.append(dialog);
    const detailDialog = el('dialog', 'fixed-cost-dialog');
    detailDialog.setAttribute('aria-label', '固定支出の詳細');
    document.body.append(detailDialog);
    function openDetails(item) {
        if (busy)
            return;
        detailDialog.replaceChildren();
        const body = el('div', 'fixed-cost-detail');
        body.append(el('h2', '', item.name));
        const info = el('div', 'fixed-cost-detail-grid');
        for (const [name, value] of [['状態', stateName(item.status)], ['支払方法', item.payment], ['周期', freqName(item.frequency)],
            ['登録額', yen(item.currentAmount ?? item.amount)], ['月額換算', yen(monthlyEquivalent({ ...item, amount: item.currentAmount ?? item.amount }))], ['金額の種類', item.priceKind === 'fixed' ? '固定額' : '変動額・予算']]) {
            const pair = el('div', 'fixed-cost-detail-pair');
            pair.append(el('span', '', name), el('strong', '', value));
            info.append(pair);
        }
        body.append(info);
        const history = item.contract?.pricing ?? item.bank?.pricing ?? [];
        if (history.length) {
            body.append(el('h3', '', '料金変更履歴'));
            for (const price of [...history].reverse().slice(0, 20)) {
                const line = el('div', 'fixed-cost-detail-line');
                line.append(el('span', '', price.effectiveOn), el('strong', '', yen(price.amount)));
                body.append(line);
            }
        }
        const source = deps.source();
        const key = item.contract?.merchantKey ?? item.candidate?.key ?? item.decisionKey;
        if (item.kind === 'card' && source && key) {
            const charges = source.records.flatMap(({ statement }) => {
                if (statement.confirmation !== 'confirmed' || !statement.paymentDate || statement.cardId !==
                    (item.contract?.cardId ?? item.decision?.cardId ?? item.candidate?.cardId))
                    return [];
                return statement.rows.filter(row => cardRecurringKey(statement.cardId, row.merchant) === key)
                    .map(row => ({ date: statement.paymentDate, amount: row.amount }));
            }).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
            if (charges.length) {
                body.append(el('h3', '', '確認済み明細の請求履歴'));
                for (const charge of charges) {
                    const line = el('div', 'fixed-cost-detail-line');
                    line.append(el('span', '', charge.date), el('strong', '', yen(charge.amount)));
                    body.append(line);
                }
            }
        }
        body.append(el('p', 'subscriptions-muted', '銀行・現金の予定は支払実績ではありません。契約額の変更は履歴として保存されます。'));
        const buttons = el('div', 'fixed-cost-form-actions');
        buttons.append(btn('閉じる', () => detailDialog.close()), btn('編集', () => { detailDialog.close(); startEdit(item); }, 'save-action'));
        if (item.contract || item.bank) {
            buttons.append(btn('誤登録を削除', () => {
                const vault = deps.vault();
                if (!vault?.unlocked || busy)
                    return;
                if (!window.confirm(`「${item.name}」の固定費登録を完全に削除しますか？過去の登録履歴も取り消されます。`))
                    return;
                busy = true;
                showActivity('固定費の削除をOneDriveに保存中…', 'working');
                void (async () => {
                    try {
                        if (item.contract)
                            await vault.deleteFixedCost(item.contract.id);
                        else if (item.bank)
                            await vault.deleteRecurring(item.bank.id);
                        detailDialog.close();
                        deps.onSaved();
                        render();
                        showActivity('誤登録した固定費を削除しました。', 'good');
                    }
                    catch (e) {
                        notice = e instanceof Error ? e.message : '削除できませんでした。';
                        showActivity(notice, 'bad');
                    }
                    finally {
                        busy = false;
                        render();
                    }
                })();
            }));
        }
        body.append(buttons);
        detailDialog.append(body);
        detailDialog.showModal();
    }
    detailDialog.addEventListener('cancel', event => { event.preventDefault(); detailDialog.close(); });
    const input = (name) => form.elements.namedItem(name);
    const set = (name, value) => { input(name).value = value; };
    const get = (name) => input(name).value;
    const isDirty = () => dialog.open && JSON.stringify([...form.elements].filter(e => e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement).map(e => e.value)) !== baseline;
    const resetDirty = () => { baseline = JSON.stringify([...form.elements].filter(e => e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement).map(e => e.value)); };
    function updateConditional() {
        const method = get('method'), frequency = get('frequency');
        cardField.hidden = method !== 'card';
        merchantField.hidden = method !== 'card';
        accountField.hidden = method !== 'bank';
        monthField.hidden = frequency !== 'yearly';
        dayField.hidden = frequency === 'weekly';
        weekField.hidden = frequency !== 'weekly';
        // Candidate registrations keep their card and merchant identity unchanged.
        input('method').disabled = !!editing?.candidate || !!editing?.decision;
        input('cardId').disabled = !!editing?.candidate || !!editing?.decision;
    }
    input('method').addEventListener('change', updateConditional);
    input('frequency').addEventListener('change', updateConditional);
    function closeDialog(force = false) {
        if (busy)
            return;
        if (!force && isDirty() && !window.confirm('保存していない変更を破棄しますか？'))
            return;
        if (dialog.open)
            dialog.close();
        editing = null;
        error.textContent = '';
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    dialog.addEventListener('click', event => { if (event.target === dialog)
        closeDialog(); });
    function startEdit(item) {
        const source = deps.source();
        if (busy || !source)
            return;
        editing = item;
        error.textContent = '';
        title.textContent = item?.candidate && !item.contract && !item.decision ? '検出候補の内容を確認して登録' : item ? '固定支出を編集' : '固定支出を追加';
        const today = localDate();
        const data = item?.contract, bank = item?.bank;
        const legacy = item?.decision;
        const originalCard = item?.candidate?.cardId ?? legacy?.cardId ?? null;
        const cards = CARDS.map(c => [c.id, source.assets.cardPreferences?.[c.id]?.name ?? c.name]);
        const c = input('cardId');
        c.replaceChildren();
        for (const [id, name] of cards)
            c.add(new Option(name, id));
        const cats = input('category');
        cats.replaceChildren();
        cats.add(new Option('未分類', ''));
        for (const category of source.categories)
            cats.add(new Option(category.name, category.id));
        set('name', item?.name ?? '');
        set('category', data?.categoryId ?? bank?.categoryId ?? '');
        set('method', item?.kind ?? 'card');
        set('cardId', data?.cardId ?? originalCard ?? cards[0]?.[0] ?? '');
        const knownKey = data?.merchantKey ?? item?.candidate?.key ?? item?.decisionKey ?? null;
        set('merchant', knownKey ? knownKey.slice(knownKey.indexOf('|') + 1) : '');
        set('accountId', bank?.fromAccountId ?? 'rakuten-bank');
        set('priceKind', data?.priceKind ?? bank?.priceKind ?? 'fixed');
        set('amount', item ? String(item.amount) : '');
        set('priceDate', today);
        set('frequency', item?.frequency ?? 'monthly');
        set('startOn', data?.startOn ?? bank?.startOn ?? today);
        set('month', String(data?.monthOfYear ?? bank?.monthOfYear ?? 1));
        set('day', String(data?.dayOfMonth ?? bank?.dayOfMonth ?? new Date().getDate()));
        set('weekday', String(data?.weekday ?? bank?.weekday ?? new Date().getDay()));
        set('status', item?.status === 'scheduled' ? 'active' : item?.status ?? 'active');
        set('statusDate', today);
        set('note', data?.note ?? bank?.note ?? '');
        input('startOn').readOnly = !!item && !item.candidate;
        input('merchant').readOnly = !!knownKey;
        updateConditional();
        resetDirty();
        if (!dialog.open)
            dialog.showModal();
        input('name').focus();
    }
    function itemsFromSource(source, candidates = detectCardSubscriptions(source), latest = latestRegisteredCardCharges(source)) {
        const today = localDate();
        const contracts = source.assets.fixedCosts ?? [];
        const list = [];
        for (const bank of source.assets.recurring) {
            if (bank.kind !== 'expense')
                continue;
            const status = bank.endOn !== null && bank.endOn < today ? 'ended' : bank.startOn > today ? 'scheduled' : !bank.enabled ||
                (bank.pauses ?? []).some(p => today >= p.startOn && (p.endOn === null || today <= p.endOn)) ? 'paused' : 'active';
            list.push({ kind: 'bank', id: bank.id, name: bank.name, amount: bank.amount, currentAmount: priceOnDay(bank.pricing ?? [], today, bank.amount), frequency: bank.frequency, payment: ASSET_ACCOUNTS.find(x => x.id === bank.fromAccountId)?.name ?? '銀行口座',
                status, priceKind: bank.priceKind ?? 'fixed', bank });
        }
        const decisions = source.assets.cardRecurringDecisions ?? {};
        for (const contract of contracts) {
            const found = contract.merchantKey ? candidates.find(c => c.key === contract.merchantKey) : undefined;
            const last = contract.merchantKey ? latest.get(contract.merchantKey) : null;
            list.push({ kind: contract.payment, id: contract.id, name: contract.name, amount: contract.amount, currentAmount: priceOnDay(contract.pricing, today, contract.amount), frequency: contract.frequency,
                payment: contract.payment === 'cash' ? '現金' : source.assets.cardPreferences?.[contract.cardId ?? '']?.name ?? CARDS.find(c => c.id === contract.cardId)?.name ?? 'クレジットカード',
                status: fixedCostState(contract, today), priceKind: contract.priceKind, contract, candidate: found, lastAmount: last?.amount, lastMonth: last?.month });
        }
        for (const [key, decision] of Object.entries(decisions)) {
            if (decision.state !== 'registered' || contracts.some(x => x.merchantKey === key || candidates.some(c => matchedCardRecurringDecision(decisions, c) === key && c.key === x.merchantKey)))
                continue;
            const found = candidates.find(c => matchedCardRecurringDecision(decisions, c) === key);
            const last = latest.get(found?.key ?? key);
            list.push({ kind: 'card', id: `legacy:${key}`, name: decision.label, amount: decision.amount, frequency: decision.frequency,
                payment: source.assets.cardPreferences?.[decision.cardId]?.name ?? CARDS.find(c => c.id === decision.cardId)?.name ?? 'クレジットカード',
                status: 'active', priceKind: 'fixed', decision, decisionKey: key, candidate: found, lastAmount: last?.amount, lastMonth: last?.month });
        }
        return list.sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name, 'ja'));
    }
    const legacyContract = (item) => {
        if (!item.decision)
            return null;
        const d = item.decision;
        const first = item.candidate?.months[0];
        const startOn = first ? `${first}-01` : localDate();
        const match = item.decisionKey ?? cardRecurringKey(d.cardId, d.merchant);
        return { id: crypto.randomUUID(), name: d.label, payment: 'card', cardId: d.cardId, merchantKey: match, categoryId: null,
            frequency: d.frequency, dayOfMonth: 1, monthOfYear: d.frequency === 'yearly' ? Number(startOn.slice(5)) : null, weekday: null,
            startOn, endOn: null, amount: d.amount, priceKind: 'fixed', pricing: [{ effectiveOn: startOn, amount: d.amount }], pauses: [], note: '', updatedAt: new Date().toISOString() };
    };
    async function persist(event) {
        event.preventDefault();
        if (busy)
            return;
        const vault = deps.vault();
        if (!vault?.unlocked) {
            error.textContent = '保管庫の解除が必要です。';
            return;
        }
        try {
            const amount = Number(get('amount')), name = get('name').trim(), startOn = get('startOn'), statusDate = get('statusDate'), effectiveOn = get('priceDate');
            const frequency = get('frequency'), method = get('method');
            if (!name || name.length > 80 || !Number.isSafeInteger(amount) || amount <= 0 || !startOn || !effectiveOn || !statusDate)
                throw new Error('名前・金額・日付を正しく入力してください。');
            if (editing && (editing.kind === 'bank' ? 'bank' : editing.kind) !== method)
                throw new Error('既存契約の支払方法は変更できません。新規登録してください。');
            const original = editing?.contract ?? (editing?.decision ? legacyContract(editing) : null);
            const previousStatus = editing?.status === 'scheduled' ? 'active' : editing?.status ?? 'active', nextStatus = get('status');
            let pauses = changePauses(original?.pauses ?? editing?.bank?.pauses ?? [], previousStatus, nextStatus, statusDate);
            let endOn = original?.endOn ?? editing?.bank?.endOn ?? null;
            if (nextStatus === 'ended' && previousStatus !== 'ended') {
                endOn = statusDate;
                pauses = pauses.filter(p => p.startOn <= statusDate).map(p => ({ ...p, endOn: p.endOn === null || p.endOn > statusDate ? statusDate : p.endOn }));
            }
            if (previousStatus === 'ended' && nextStatus !== 'ended') {
                if (endOn && dayAfter(endOn) < statusDate)
                    pauses = [...pauses, { startOn: dayAfter(endOn), endOn: dayBefore(statusDate) }];
                endOn = null;
            }
            if (nextStatus === 'paused' && statusDate < startOn)
                throw new Error('停止日は契約開始日以降にしてください。');
            const day = get('day'), weekday = get('weekday');
            const monthOfYear = frequency === 'yearly' ? Number(get('month')) : null;
            const dayOfMonth = frequency === 'weekly' ? null : Number(day);
            const weekdayNumber = frequency === 'weekly' ? Number(weekday) : null;
            const categoryId = get('category') || null, priceKind = get('priceKind');
            const note = get('note').trim();
            busy = true;
            save.disabled = true;
            showActivity('固定費の設定をOneDriveに保存中…', 'working');
            if (method === 'bank') {
                const previous = editing?.bank;
                const history = enrichHistory(previous?.pricing ?? [], previous?.startOn ?? startOn, previous?.amount ?? amount, amount, effectiveOn);
                let enabled = true;
                if (previous && !previous.enabled) {
                    if (nextStatus === 'paused' || nextStatus === 'ended')
                        enabled = false;
                    else if (statusDate > previous.startOn)
                        pauses = [{ startOn: previous.startOn, endOn: dayBefore(statusDate) }, ...pauses];
                }
                const entry = { id: previous?.id ?? crypto.randomUUID(), name, kind: 'expense', amount, fromAccountId: get('accountId'), toAccountId: null,
                    frequency, dayOfMonth, monthOfYear, weekday: weekdayNumber, startOn: previous?.startOn ?? startOn, endOn,
                    categoryId, enabled, pricing: history, pauses, priceKind, note };
                await vault.upsertRecurring(entry);
            }
            else {
                const history = enrichHistory(original?.pricing ?? [], original?.startOn ?? startOn, original?.amount ?? amount, amount, effectiveOn);
                const contract = { id: original?.id ?? crypto.randomUUID(), name, payment: method, cardId: method === 'card' ? get('cardId') : null,
                    merchantKey: editing?.decision ? (editing.candidate?.key ?? original?.merchantKey ?? null) : (original?.merchantKey ?? editing?.candidate?.key ?? (get('merchant').trim() ? cardRecurringKey(get('cardId'), get('merchant').trim()) : null)), categoryId, frequency, dayOfMonth, monthOfYear, weekday: weekdayNumber,
                    startOn: original?.startOn ?? startOn, endOn, amount, priceKind, pricing: history, pauses, note, updatedAt: new Date().toISOString() };
                const decision = contract.payment === 'card' && contract.merchantKey && editing?.candidate
                    ? subscriptionDecision(editing.candidate, 'registered') : undefined;
                await vault.upsertFixedCost(contract, decision);
            }
            busy = false;
            save.disabled = false;
            closeDialog(true);
            notice = '';
            deps.onSaved();
            render();
            showActivity('固定費の設定を保存しました。', 'good');
        }
        catch (e) {
            busy = false;
            save.disabled = false;
            const msg = e instanceof Error ? e.message : '保存できませんでした。';
            error.textContent = e instanceof CloudWriteUncertainError ? '保存結果未確認です。最新データを取得してから再編集してください。' : msg;
            showActivity(error.textContent, 'bad');
        }
    }
    form.addEventListener('submit', event => { void persist(event); });
    async function markCandidate(candidate, ignore) {
        const vault = deps.vault();
        if (!vault?.unlocked || busy)
            return;
        if (!ignore) {
            // A detection hint is not a registered contract. Review the estimated
            // amount, recurrence and start date before an encrypted cloud write.
            startEdit({ kind: 'card', id: `candidate:${candidate.key}`, name: candidate.merchant, amount: candidate.amount,
                frequency: candidate.frequency, payment: candidate.cardName, status: 'active', priceKind: 'fixed', candidate });
            return;
        }
        busy = true;
        try {
            await vault.setCardRecurringDecision(candidate.key, subscriptionDecision(candidate, 'ignored'));
            deps.onSaved();
            render();
            showActivity('候補から除外しました。', 'good');
        }
        catch (e) {
            notice = e instanceof Error ? e.message : '保存に失敗しました。';
            showActivity(notice, 'bad');
        }
        finally {
            busy = false;
            render();
        }
    }
    function render() {
        root.replaceChildren();
        const source = deps.source();
        if (!source || !deps.vault()?.unlocked) {
            root.append(el('p', 'subscriptions-muted', 'OneDriveに接続してください。'));
            return;
        }
        const candidates = detectCardSubscriptions(source);
        const latest = latestRegisteredCardCharges(source);
        const items = itemsFromSource(source, candidates, latest), today = localDate(), active = items.filter(x => x.status !== 'ended');
        const total = active.filter(x => x.status === 'active').reduce((sum, x) => sum + monthlyEquivalent({ ...x, amount: x.currentAmount ?? x.amount }), 0);
        const metrics = el('div', 'fixed-cost-metrics');
        for (const [name, value] of [['月額換算', yen(total)], ['年間換算', yen(total * 12)], ['登録件数', `${active.length}件`]]) {
            const box = el('div', 'fixed-cost-metric');
            box.append(el('span', '', name), el('strong', '', value));
            metrics.append(box);
        }
        root.append(metrics);
        const toolbar = el('div', 'fixed-cost-toolbar');
        const tabs = el('div', 'subscriptions-tabs');
        const decisions = source.assets.cardRecurringDecisions ?? {};
        const pending = candidates.filter(c => !matchedCardRecurringDecision(decisions, c) && !source.assets.fixedCosts?.some(x => x.merchantKey === c.key));
        const ignored = Object.entries(decisions).filter(([, d]) => d.state === 'ignored');
        for (const [value, label, count] of [['registered', '登録済み', items.filter(x => x.status !== 'ended').length], ['candidate', '検出候補', pending.length], ['ended', '終了済み', items.filter(x => x.status === 'ended').length], ['ignored', '対象外', ignored.length]]) {
            const button = btn(`${label} ${count}`, () => { tab = value; render(); }, 'subscriptions-tab' + (tab === value ? ' selected' : ''));
            button.setAttribute('aria-pressed', String(tab === value));
            tabs.append(button);
        }
        toolbar.append(tabs, btn('＋ 新規登録', () => startEdit(null), 'save-action'));
        root.append(toolbar);
        if (notice)
            root.append(el('p', 'subscriptions-notice error', notice));
        const list = el('div', 'subscriptions-list');
        if (tab === 'candidate') {
            for (const candidate of pending) {
                const card = el('article', 'panel fixed-cost-item');
                const left = el('div', 'fixed-cost-item-info');
                left.append(el('strong', '', candidate.merchant), el('small', '', `${candidate.cardName} · ${freqName(candidate.frequency)}の候補 · ${candidate.months.length}回の請求`));
                const right = el('div', 'fixed-cost-item-price');
                right.append(el('strong', '', yen(candidate.amount)));
                const actions = el('div', 'fixed-cost-item-actions');
                actions.append(btn('内容を確認して登録', () => { void markCandidate(candidate, false); }, 'save-action'), btn('候補から除外', () => { void markCandidate(candidate, true); }));
                card.append(left, right, actions);
                list.append(card);
            }
            if (!pending.length)
                list.append(el('p', 'subscriptions-empty', '未確認の候補はありません。'));
        }
        else if (tab === 'ignored') {
            for (const [key, decision] of ignored) {
                const card = el('article', 'panel fixed-cost-item');
                card.append(el('strong', '', decision.label), el('small', '', `${decision.cardId} · ${freqName(decision.frequency)}`), btn('候補に戻す', () => { void (async () => { const vault = deps.vault(); if (!vault || busy)
                    return; busy = true; try {
                    await vault.setCardRecurringDecision(key, null);
                    deps.onSaved();
                }
                catch (e) {
                    notice = e instanceof Error ? e.message : '保存できませんでした。';
                }
                finally {
                    busy = false;
                    render();
                } })(); }));
                list.append(card);
            }
            if (!ignored.length)
                list.append(el('p', 'subscriptions-empty', '対象外にした候補はありません。'));
        }
        else {
            const selected = items.filter(x => tab === 'ended' ? x.status === 'ended' : x.status !== 'ended');
            for (const item of selected) {
                const card = el('article', 'panel fixed-cost-item');
                const info = el('div', 'fixed-cost-item-info');
                info.append(el('strong', '', item.name), el('small', '', `${freqName(item.frequency)} · ${item.payment} · ${stateName(item.status)}`));
                const price = el('div', 'fixed-cost-item-price');
                price.append(el('strong', '', yen(item.currentAmount ?? item.amount)), el('small', '', item.priceKind === 'variable' ? '登録予算' : '登録額'));
                const actions = el('div', 'fixed-cost-item-actions');
                actions.append(btn('詳細・編集', () => openDetails(item)));
                if (item.lastAmount !== undefined) {
                    const delta = item.lastAmount - (item.currentAmount ?? item.amount);
                    info.append(el('small', '', `登録時の推定額：${yen(item.currentAmount ?? item.amount)} · 最新の確認済み明細：${yen(item.lastAmount)}（${item.lastMonth ?? '年月不明'}） · 登録時との差額 ${delta > 0 ? '+' : ''}${yen(delta)}`));
                }
                if (item.decision && !item.contract)
                    info.append(el('small', '', '旧形式の簡易登録です。詳細・編集から正式な契約情報を保存してください。'));
                if (item.kind === 'bank' && !item.bank?.enabled)
                    info.append(el('small', '', `口座管理で停止された予定です。編集時に過去分も含めて有効状態へ移行します。`));
                card.append(info, price, actions);
                list.append(card);
            }
            if (!selected.length)
                list.append(el('p', 'subscriptions-empty', 'この状態の固定支出はありません。'));
        }
        root.append(list);
        const footer = el('p', 'subscriptions-muted fixed-cost-guidance', `登録額は契約・予算、請求実績は確定済み明細です。カード払いは明細に計上済みのため別途加算しません。銀行は口座管理の定期支出と連動します。確認基準日：${today}`);
        root.append(footer);
    }
    function reset() { tab = 'registered'; busy = false; notice = ''; if (dialog.open)
        dialog.close(); if (detailDialog.open)
        detailDialog.close(); editing = null; root.replaceChildren(); }
    const openFixedCost = (id) => { const source = deps.source(); const item = source ? itemsFromSource(source).find(x => x.id === id) : undefined; if (item)
        openDetails(item); };
    return { render, reset, isBusy: () => busy, isDirty, openFixedCost };
}
