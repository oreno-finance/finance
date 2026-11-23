/** Flat card settings: select one card, edit only its actual properties.
 * Card preference writes remain a single encrypted OneDrive assets update. */
import { CARDS } from '../models/types.js';
import { DEFAULT_POINT_RATES } from '../summary/point-benefits.js';
import { validateCardPreferences } from '../cloud/assets.js';
import { CloudWriteUncertainError } from '../cloud/live-vault.js';
import { showActivity, simpleActivity } from './activity-feedback.js';
const CSV_CARDS = new Set(['smbc-nl', 'amazon', 'goldpoint']);
function make(tag, cls = '', text) {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function field(text, input) {
    const label = make('label', 'card-setting-field');
    label.append(make('span', '', text), input);
    return label;
}
function select(options, value) {
    const el = document.createElement('select');
    for (const [key, label] of options)
        el.add(new Option(label, key));
    el.value = value;
    return el;
}
function dayInput(value) {
    const el = document.createElement('input');
    el.type = 'number';
    el.min = '1';
    el.max = '31';
    el.step = '1';
    el.inputMode = 'numeric';
    el.value = value;
    return el;
}
export function initCardSettings(getVault, onSaved) {
    const form = document.getElementById('settings-card-form');
    const list = document.getElementById('settings-card-list');
    const save = document.getElementById('settings-card-save');
    const status = document.getElementById('settings-card-status');
    if (!form || !list || !save || !status)
        throw new Error('カード設定画面を表示できません。');
    let owner = null, busy = false, dirty = false, selectedCardId = CARDS[0].id;
    const rows = new Map();
    function render() {
        const vault = getVault();
        if (owner === vault && dirty)
            return;
        owner = vault;
        dirty = false;
        const prefs = vault?.unlocked ? vault.assetSettings().cardPreferences ?? {} : {};
        const debitAccounts = vault?.unlocked ? vault.assetSettings().cardDebitAccounts ?? {} : {};
        list.replaceChildren();
        rows.clear();
        const picker = make('div', 'settings-card-picker');
        picker.setAttribute('role', 'radiogroup');
        picker.setAttribute('aria-label', '設定するカード');
        const panels = make('div', 'settings-card-panels');
        const tabs = new Map();
        const activate = (id) => {
            selectedCardId = id;
            for (const [key, row] of rows)
                row.panel.hidden = key !== id;
            for (const [key, radio] of tabs)
                radio.checked = key === id;
        };
        for (const card of CARDS) {
            const pref = prefs[card.id];
            const option = make('label', 'card-setting-choice');
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'card-setting-selected';
            radio.value = card.id;
            radio.checked = card.id === selectedCardId;
            const optionLabel = make('span', 'card-setting-choice-name', pref?.name ?? card.name);
            option.append(radio, optionLabel);
            picker.append(option);
            tabs.set(card.id, radio);
            radio.addEventListener('change', () => { if (radio.checked)
                activate(card.id); });
            const panel = make('section', 'card-setting-item');
            panel.hidden = card.id !== selectedCardId;
            panel.setAttribute('aria-label', `${card.name}の設定`);
            const general = make('div', 'card-setting-flat-section');
            general.append(make('h3', 'card-setting-section-heading', '基本設定'));
            const basicFields = make('div', 'card-setting-basic-fields');
            const name = document.createElement('input');
            name.type = 'text';
            name.maxLength = 60;
            name.autocomplete = 'off';
            name.value = pref?.name ?? '';
            name.placeholder = card.name;
            name.addEventListener('input', () => { optionLabel.textContent = name.value.trim() || card.name; });
            const debit = select([['', '未設定'], ['rakuten-bank', '楽天銀行'], ['mizuho-bank', 'みずほ銀行'], ['cash-savings', '現金貯金専用口座']], debitAccounts[card.id] ?? '');
            basicFields.append(field('表示名', name), field('引落口座', debit));
            general.append(basicFields);
            panel.append(general);
            if (CSV_CARDS.has(card.id)) {
                const payment = make('div', 'card-setting-flat-section');
                payment.append(make('h3', 'card-setting-section-heading', 'CSV明細の引落日'));
                const fields = make('div', 'card-setting-payment-fields');
                const paymentMonth = select([['0', '請求月'], ['1', '請求翌月']], String(pref?.payment?.monthOffset ?? 0));
                const paymentDay = dayInput(pref?.payment?.day ? String(pref.payment.day) : '');
                paymentDay.placeholder = '27';
                fields.append(field('引落月', paymentMonth), field('毎月の引落日', paymentDay));
                payment.append(fields);
                panel.append(payment);
                panel.paymentControls = [paymentMonth, paymentDay];
            }
            // Both optional settings share a single compact two-column row.
            const extras = make('div', 'card-setting-secondary-fields');
            const points = make('div', 'card-setting-extra card-setting-points');
            const rate = document.createElement('input');
            rate.type = 'number';
            rate.min = '0';
            rate.max = '100';
            rate.step = '0.01';
            rate.inputMode = 'decimal';
            rate.placeholder = '1.2';
            rate.value = pref?.pointRatePercent === undefined ? '' : String(pref.pointRatePercent);
            points.append(field('還元率（%）', rate));
            const effectiveOn = document.createElement('input');
            effectiveOn.type = 'date';
            const today = new Date();
            effectiveOn.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            effectiveOn.setAttribute('aria-label', `${card.name}の還元率の適用開始日`);
            points.append(field('変更の適用開始日', effectiveOn));
            const reminder = make('div', 'card-setting-extra card-setting-reminder');
            const mode = select([['auto', '自動で案内'], ['custom', '案内日を指定'], ['none', '案内しない']], pref?.review === null ? 'none' : pref?.review ? 'custom' : 'auto');
            reminder.append(field('ホームの明細確定案内', mode));
            const dates = make('div', 'card-setting-review');
            const month = select([['0', '引落月'], ['-1', '引落前月']], String(pref?.review?.monthOffset ?? 0));
            const day = dayInput(String(pref?.review?.day ?? 11));
            dates.append(field('案内する月', month), field('案内する日', day));
            const adjust = () => { const custom = mode.value === 'custom'; dates.hidden = !custom; month.disabled = !custom; day.disabled = !custom; };
            mode.addEventListener('change', adjust);
            adjust();
            reminder.append(dates);
            extras.append(points, reminder);
            panel.append(extras);
            panels.append(panel);
            const pc = panel.paymentControls;
            rows.set(card.id, { name, mode, month, day, paymentMonth: pc?.[0], paymentDay: pc?.[1], rate, effectiveOn, debit, panel });
        }
        list.append(picker, panels);
        if (!CARDS.some(c => c.id === selectedCardId))
            selectedCardId = CARDS[0].id;
        activate(selectedCardId);
        for (const control of panels.querySelectorAll('input,select')) {
            if (!vault?.unlocked)
                control.disabled = true;
        }
        save.disabled = !vault?.unlocked || busy;
    }
    const markDirty = (event) => {
        if (event.target instanceof HTMLInputElement && event.target.matches('.card-setting-choice input[type="radio"]'))
            return;
        dirty = true;
        status.textContent = '';
    };
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
    form.addEventListener('submit', event => {
        event.preventDefault();
        if (busy)
            return;
        void (async () => {
            const vault = getVault();
            if (!vault?.unlocked) {
                simpleActivity('保管庫を解除してください。', true);
                return;
            }
            try {
                const prior = vault.assetSettings().cardPreferences ?? {};
                const next = {};
                const nextDebit = {};
                for (const card of CARDS) {
                    const row = rows.get(card.id);
                    const name = row.name.value.trim();
                    if (row.debit.value)
                        nextDebit[card.id] = row.debit.value;
                    const pref = {};
                    if (name && name !== card.name)
                        pref.name = name;
                    if (prior[card.id]?.issuer)
                        pref.issuer = prior[card.id].issuer;
                    if (row.mode.value === 'none')
                        pref.review = null;
                    else if (row.mode.value === 'custom') {
                        const n = Number(row.day.value);
                        if (!/^\d{1,2}$/.test(row.day.value) || n < 1 || n > 31)
                            throw new Error(`${card.name}の案内日を確認してください。`);
                        pref.review = { monthOffset: Number(row.month.value), day: n };
                    }
                    if (row.paymentMonth && row.paymentDay && row.paymentDay.value.trim()) {
                        const n = Number(row.paymentDay.value);
                        if (!/^\d{1,2}$/.test(row.paymentDay.value) || n < 1 || n > 31)
                            throw new Error(`${card.name}の引落日を1〜31日で入力してください。`);
                        pref.payment = { monthOffset: Number(row.paymentMonth.value), day: n };
                    }
                    const old = prior[card.id];
                    const oldRate = old?.pointRatePercent ?? DEFAULT_POINT_RATES[card.id] ?? 0;
                    const rate = row.rate.value.trim() ? Number(row.rate.value) : (DEFAULT_POINT_RATES[card.id] ?? 0);
                    if (!Number.isFinite(rate) || rate < 0 || rate > 100 || Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-8)
                        throw new Error(`${card.name}の還元率は0〜100%、小数第2位までで入力してください。`);
                    if (old?.pointRateHistory)
                        pref.pointRateHistory = structuredClone(old.pointRateHistory);
                    if (rate !== oldRate) {
                        const effectiveOn = row.effectiveOn.value;
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn))
                            throw new Error(`${card.name}の適用開始日を確認してください。`);
                        const history = pref.pointRateHistory ?? [{ effectiveOn: '1900-01-01', ratePercent: oldRate }];
                        if (effectiveOn < history.at(-1).effectiveOn)
                            throw new Error(`${card.name}の適用日は直近の変更日以降にしてください。`);
                        if (effectiveOn === history.at(-1).effectiveOn)
                            history[history.length - 1] = { effectiveOn, ratePercent: rate };
                        else
                            history.push({ effectiveOn, ratePercent: rate });
                        pref.pointRateHistory = history;
                    }
                    if (row.rate.value.trim() || old?.pointRatePercent !== undefined || rate !== oldRate)
                        pref.pointRatePercent = rate;
                    if (Object.keys(pref).length)
                        next[card.id] = pref;
                }
                validateCardPreferences(next);
                busy = true;
                save.disabled = true;
                status.textContent = '';
                showActivity('カード設定を保存中…', 'working');
                await vault.setCardConfiguration(next, nextDebit);
                dirty = false;
                status.textContent = '';
                showActivity('カード設定を保存しました。', 'good');
                render();
                onSaved();
            }
            catch (error) {
                status.textContent = '';
                simpleActivity(error instanceof CloudWriteUncertainError ? '保存結果を確認できません。最新データを取得してください。' : error instanceof Error ? error.message : '保存できませんでした。', true);
            }
            finally {
                busy = false;
                save.disabled = !getVault()?.unlocked;
            }
        })();
    });
    render();
    return { render, reset: () => { dirty = false; status.textContent = ''; render(); }, isDirty: () => dirty, isBusy: () => busy };
}
