import { traceFinanceOperation } from '../cloud/performance-diagnostics.js';
import { fixedCostCalculationAssets } from '../fixed-costs/rule-fixed-costs.js';
import { bindModalDismiss, requestConfirmation, confirmationPending, cancelConfirmation } from './modal.js';
import { DATA_STATUS, formatYen as sharedYen, formatDate, formatDateTime } from './formatters.js';
import { ASSET_ACCOUNTS, validateRecurring, validateSnapshot, validateNisaCardRule, validateOneTime } from '../cloud/assets.js';
import { CloudWriteUncertainError } from '../cloud/live-vault.js';
import { CARDS } from '../models/types.js';
import { localDay } from '../cloud/asset-projection.js';
import { forecastBankBalances, prepareBankForecast } from '../cloud/salary-projection.js';
import { reconcileBalance } from '../cloud/balance-reconciliation.js';
import { estimateMizuhoTransferAmount, manualMizuhoFundingEntries, mizuhoFundingWindow, mizuhoTransferForBill } from '../cloud/mizuho-transfer.js';
import { DEFAULT_MIZUHO_PLAN, BALANCE_WARNING_ACCOUNTS, validateBalanceWarningLimits } from '../cloud/assets.js'; /* finance-v148 */
import { PayrollReadSession } from '../cloud/payroll-bridge.js';
import { recurringSalaryRole, payrollRole } from '../cloud/payroll-income.js';
import { simpleActivity } from './activity-feedback.js';
const $ = (id) => {
    const value = document.getElementById(id);
    if (!value)
        throw new Error(`Missing assets UI #${id}`);
    return value;
};
const accountName = (id) => ASSET_ACCOUNTS.find(a => a.id === id)?.name ?? DATA_STATUS.unset;
const yen = (value) => sharedYen(value, 0, '—');
const localDate = (date = new Date()) => {
    const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return adjusted.toISOString().slice(0, 10);
};
function make(tag, className, content) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (content !== undefined)
        node.textContent = content;
    return node;
}
export function status(node, message, error = false) {
    // A risk that affects financial projections must remain visible beside its form.
    const important = /二重計上|注意：|登録されています/.test(message);
    // Native modal validation must stay visible above the modal backdrop.
    // Outside dialogs, ordinary operation feedback belongs to the shared toast.
    const inline = important || error && !!node.closest('dialog[open]');
    node.textContent = inline ? message : '';
    node.classList.toggle('bad', error);
    if (error && inline)
        node.setAttribute('role', 'alert');
    else
        node.removeAttribute('role');
    if (message && (error || !important))
        simpleActivity(message, error);
}
/** An ambiguous Graph write must never be described as a definite save failure. */
function mutationError(error, action = '保存') {
    const message = error instanceof Error ? error.message : '通信エラー';
    return error instanceof CloudWriteUncertainError
        ? `${action}結果未確認：${message}`
        : `${action}失敗：${message}`;
}
function addButton(label, handler, remove = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = remove ? 'assets-item-button danger danger-action' : 'assets-item-button';
    button.addEventListener('click', handler);
    return button;
}
const weekdayLabels = ['日', '月', '火', '水', '木', '金', '土'];
function frequencyLabel(e) {
    if (e.frequency === 'weekly')
        return `毎週${weekdayLabels[e.weekday ?? 0]}曜日`;
    const day = e.dayOfMonth === 0 ? '末日' : `${e.dayOfMonth}日`;
    return e.frequency === 'monthly' ? `毎月${day}` : `毎年${e.monthOfYear}月${day}`;
}
/** Snapshot the actual form values, not whether a field received an input event. */
export function recurringDraftSnapshot(fields) {
    return JSON.stringify(fields.map(field => [field.id, (field.type === 'checkbox' || field.type === 'radio') ? !!field.checked : field.value]));
}
/** Switching to a different item needs confirmation only when a draft really changed. */
export function recurringSwitchNeedsConfirmation(changed, editingId, nextId) {
    return editingId !== nextId && changed;
}
/** Credential updates persist for automatic refresh; empty input preserves saved credentials. */
export function payrollPassphraseUpdate(entered, saved) {
    return entered && entered !== saved ? entered : undefined;
}
export function initAssetsSettings(getVault, getCategories, onSaved, onPayrollChange = () => { }, openFixedCosts = () => { }) {
    let busy = false, nisaDirty = false, birthDirty = false, editingId = null;
    let recurringBaseline = '';
    let payrollSession = null;
    let payrollIncome = [];
    let payrollSynced = false, payrollAccountDirty = false, payrollAccountBaseline = '';
    let payrollBusy = false;
    let payrollStale = false, payrollUseStale = false;
    let payrollSyncedAt = 0, lastPayrollAttemptAt = 0;
    let payrollOwner = null;
    let payrollCredential, observedLocalCredential;
    let payrollEpoch = 0, payrollSessionGuard = null;
    function clearPayroll() {
        payrollSession = null;
        payrollSessionGuard = null;
        payrollIncome = [];
        payrollSynced = false;
        payrollOwner = null;
        payrollSyncedAt = 0;
        payrollStale = false;
        payrollUseStale = false;
        // Never retain a success message for a discarded session or revoked credential.
        status($('assets-payroll-status'), '');
    }
    function observeLocalPayroll(vault) {
        if (payrollOwner) {
            try {
                if (payrollOwner !== vault || !payrollSessionGuard)
                    throw new Error('保管庫が変更されました。');
                payrollSessionGuard();
            }
            catch {
                payrollEpoch++;
                payrollBusy = false;
                clearPayroll();
                payrollCredential = undefined;
                observedLocalCredential = undefined;
                lastPayrollAttemptAt = 0;
            }
        }
        const credential = vault.assetSettings().payrollAutoPassphrase;
        if (observedLocalCredential !== undefined && observedLocalCredential !== credential && payrollCredential !== credential) {
            payrollEpoch++;
            payrollBusy = false;
            clearPayroll();
            payrollCredential = undefined;
            lastPayrollAttemptAt = 0;
        }
        observedLocalCredential = credential;
    }
    function observeVerifiedPayroll(credential) {
        if (payrollCredential !== undefined && payrollCredential !== credential) {
            clearPayroll();
            lastPayrollAttemptAt = 0;
        }
        payrollCredential = credential;
    }
    const amounts = new Map();
    const latestTexts = new Map();
    const reconciliationViews = new Map();
    const histories = new Map();
    const accountDetails = new Map();
    let mizuhoPlanDirty = false, balanceWarningDirty = false;
    let onceEditingId = null, onceShowAll = false;
    let onceBaseline = '';
    let fundingDraft = null;
    const confirmationOwner = {};
    let onceEpoch = 0;
    const confirming = () => confirmationPending(confirmationOwner);
    const value = (id) => $(id).value;
    const choices = (select, options) => {
        select.replaceChildren(...options.map(o => new Option(o.label, o.value)));
    };
    const requireVault = () => {
        const vault = getVault();
        if (!vault?.unlocked)
            throw new Error('OneDrive保管庫を解除してください。');
        return vault;
    };
    function toggleBusy(next) {
        busy = next;
        for (const button of document.querySelectorAll('#assets-workspace button, #settings-nisa-panel button'))
            button.disabled = busy;
        for (const input of document.querySelectorAll('#balance-warning-form input'))
            input.disabled = busy;
        if (!busy) {
            renderBirthMonth();
            const linkButton = document.getElementById('assets-nisa-disable');
            if (linkButton)
                linkButton.disabled = !getVault()?.unlocked || !getVault()?.assetSettings().nisaCardRule;
        }
    }
    function recurringSnapshot() {
        const fields = $('assets-recurring-form')
            .querySelectorAll('input,select,textarea');
        return recurringDraftSnapshot(Array.from(fields));
    }
    const recurringHasChanges = () => recurringSnapshot() !== recurringBaseline;
    function resetForm() {
        editingId = null;
        $('assets-recurring-form').reset();
        $('assets-recurring-start').value = localDate();
        $('assets-recurring-end').value = '';
        $('assets-recurring-frequency').value = 'monthly';
        $('assets-recurring-month').value = String(new Date().getMonth() + 1);
        $('assets-recurring-weekday').value = String(new Date().getDay());
        $('assets-recurring-day').value = String(new Date().getDate());
        $('assets-recurring-kind').value = 'income';
        $('assets-recurring-from').value = 'rakuten-bank';
        $('assets-recurring-to').value = 'cash-savings';
        $('assets-recurring-enabled').checked = true;
        $('assets-recurring-form-title').textContent = '定期入金・振替を追加';
        $('assets-recurring-save').textContent = '保存';
        updateFormFields();
        recurringBaseline = recurringSnapshot();
    }
    function updateFormFields() {
        const frequency = value('assets-recurring-frequency');
        const kind = value('assets-recurring-kind');
        $('assets-month-wrap').classList.toggle('hidden', frequency !== 'yearly');
        $('assets-weekday-wrap').classList.toggle('hidden', frequency !== 'weekly');
        $('assets-recurring-day').closest('label').classList.toggle('hidden', frequency === 'weekly');
        $('assets-recurring-from').closest('label').classList.toggle('hidden', kind === 'income');
        $('assets-recurring-to').closest('label').classList.remove('hidden');
    }
    function readEntry() {
        const frequency = value('assets-recurring-frequency');
        const kind = value('assets-recurring-kind');
        const from = value('assets-recurring-from');
        const to = value('assets-recurring-to');
        if (kind !== 'income' && kind !== 'transfer')
            throw new Error('銀行引落は固定費管理で登録してください。');
        if (editingId && requireVault().assetSettings().recurring.find(x => x.id === editingId)?.kind === 'expense')
            throw new Error('銀行引落は固定費管理で編集してください。');
        const amount = Number(value('assets-recurring-amount'));
        const entry = {
            id: editingId ?? crypto.randomUUID(), name: value('assets-recurring-name').trim(), amount, kind,
            fromAccountId: kind === 'income' ? null : from, toAccountId: to,
            frequency, dayOfMonth: frequency === 'weekly' ? null : Number(value('assets-recurring-day')),
            monthOfYear: frequency === 'yearly' ? Number(value('assets-recurring-month')) : null,
            weekday: frequency === 'weekly' ? Number(value('assets-recurring-weekday')) : null,
            startOn: value('assets-recurring-start'), endOn: value('assets-recurring-end') || null,
            categoryId: null,
            enabled: $('assets-recurring-enabled').checked,
        };
        return validateRecurring(entry);
    }
    async function openRecurringEditor(item) {
        const vault = getVault(), epoch = onceEpoch;
        if (busy || confirming() || !vault?.unlocked)
            return false;
        const unchanged = () => getVault() === vault && vault.unlocked && onceEpoch === epoch && !busy &&
            JSON.stringify(vault.assetSettings().recurring.find(x => x.id === item.id)) === JSON.stringify(item);
        if (!unchanged())
            return false;
        if (item.kind === 'expense') {
            openFixedCosts(item.id);
            return true;
        }
        // Re-selecting the current entry must not overwrite its in-progress draft.
        if (editingId === item.id)
            return true;
        const draft = recurringSnapshot(), previousId = editingId;
        if (recurringSwitchNeedsConfirmation(recurringHasChanges(), editingId, item.id)) {
            if (!await requestConfirmation({ owner: confirmationOwner, title: '未保存の変更を破棄しますか？',
                message: `編集中の入力を破棄して「${item.name}」を開きます。`, acceptLabel: '破棄して開く', cancelLabel: '編集を続ける', destructive: true }))
                return false;
            if (!unchanged() || editingId !== previousId || recurringSnapshot() !== draft)
                return false;
        }
        populateForm(item);
        return true;
    }
    function populateForm(item) {
        editingId = item.id;
        $('assets-recurring-name').value = item.name;
        $('assets-recurring-amount').value = String(item.amount);
        $('assets-recurring-kind').value = item.kind;
        $('assets-recurring-from').value = item.fromAccountId ?? 'rakuten-bank';
        $('assets-recurring-to').value = item.toAccountId ?? 'cash-savings';
        $('assets-recurring-frequency').value = item.frequency;
        $('assets-recurring-day').value = String(item.dayOfMonth ?? 27);
        $('assets-recurring-month').value = String(item.monthOfYear ?? 1);
        $('assets-recurring-weekday').value = String(item.weekday ?? 1);
        $('assets-recurring-start').value = item.startOn;
        $('assets-recurring-end').value = item.endOn ?? '';
        $('assets-recurring-enabled').checked = item.enabled;
        $('assets-recurring-form-title').textContent = `「${item.name}」を編集`;
        $('assets-recurring-save').textContent = '保存';
        updateFormFields();
        recurringBaseline = recurringSnapshot();
    }
    async function saveSnapshot(accountId) {
        if (busy || confirming())
            return;
        const node = $('assets-balances-status');
        const amount = amounts.get(accountId);
        if (!amount.reportValidity())
            return;
        const entered = amount.value;
        try {
            const snapshot = validateSnapshot({ id: crypto.randomUUID(), accountId, balance: Number(entered), observedAt: new Date().toISOString() });
            toggleBusy(true);
            status(node, `${accountName(accountId)}の残高を保存中…`);
            await requireVault().addBalanceSnapshots([snapshot]);
            if (amount.value === entered)
                amount.value = '';
            onSaved(`${accountName(accountId)}の残高を保存しました。`);
            render();
        }
        catch (error) {
            status(node, mutationError(error), true);
        }
        finally {
            toggleBusy(false);
        }
    }
    async function deleteSnapshot(item) {
        const vault = getVault(), epoch = onceEpoch, { id, accountId } = item;
        if (busy || confirming() || !vault?.unlocked)
            return;
        const unchanged = () => JSON.stringify(vault.assetSettings().snapshots.find(x => x.id === id)) === JSON.stringify(item);
        if (!unchanged())
            return;
        if (!await requestConfirmation({ owner: confirmationOwner, title: '残高記録を削除しますか？',
            message: `${accountName(accountId)}：${formatDateTime(item.observedAt, true)} ${yen(item.balance)}\n最新残高の基準が変わる場合があります。`, acceptLabel: '削除する', destructive: true }))
            return;
        if (epoch !== onceEpoch || busy || getVault() !== vault || !vault.unlocked)
            return;
        if (!unchanged()) {
            status($('assets-balances-status'), '残高記録が更新されました。最新情報から確認してください。', true);
            return;
        }
        const node = $('assets-balances-status');
        toggleBusy(true);
        status(node, `${accountName(accountId)}の残高記録を削除しています…`);
        try {
            await vault.deleteBalanceSnapshot(id);
            onSaved('残高記録をOneDriveから削除しました。');
            render();
        }
        catch (error) {
            status(node, mutationError(error, '削除'), true);
        }
        finally {
            toggleBusy(false);
        }
    }
    const onceKinds = { expense: '支出', income: '入金', transfer: '振替', withdrawal: '現金引出' };
    const onceDialog = $('assets-once-dialog');
    let previousBodyPosition = '';
    let previousBodyTop = '';
    let previousBodyWidth = '';
    let previousBodyOverflow = '';
    let modalScrollY = 0;
    function lockOncePage() {
        // Fixed-body scroll lock also works in iOS Safari while the dialog itself scrolls.
        if (document.documentElement.classList.contains('assets-once-page-locked'))
            return;
        modalScrollY = window.scrollY;
        previousBodyPosition = document.body.style.position;
        previousBodyTop = document.body.style.top;
        previousBodyWidth = document.body.style.width;
        previousBodyOverflow = document.body.style.overflow;
        document.documentElement.classList.add('assets-once-page-locked');
        document.body.style.position = 'fixed';
        document.body.style.top = `-${modalScrollY}px`;
        document.body.style.width = '100%';
        document.body.style.overflow = 'hidden';
    }
    function unlockOncePage() {
        if (onceDialog.open || !document.documentElement.classList.contains('assets-once-page-locked'))
            return;
        document.documentElement.classList.remove('assets-once-page-locked');
        document.body.style.position = previousBodyPosition;
        document.body.style.top = previousBodyTop;
        document.body.style.width = previousBodyWidth;
        document.body.style.overflow = previousBodyOverflow;
        window.scrollTo(0, modalScrollY);
    }
    onceDialog.addEventListener('close', unlockOncePage);
    const onceKind = () => (document.querySelector('input[name="assets-once-kind"]:checked')?.value ?? 'transfer');
    const onceStatus = () => (document.querySelector('input[name="assets-once-status"]:checked')?.value ?? 'done');
    function onceFormFields() {
        const kind = onceKind(), from = value('assets-once-from'), to = value('assets-once-to');
        $('assets-once-category-wrap').classList.toggle('hidden', kind !== 'expense');
        $('assets-once-from-wrap').classList.toggle('hidden', kind === 'income');
        $('assets-once-to-wrap').classList.toggle('hidden', kind === 'expense' || kind === 'withdrawal');
        const label = $('assets-once-to-wrap');
        if (kind === 'income')
            label.firstChild.textContent = '入金先口座';
        else
            label.firstChild.textContent = '振替先口座';
        const funding = kind === 'transfer' && from === 'rakuten-bank' && to === 'mizuho-bank';
        $('assets-once-funding-wrap').classList.toggle('hidden', !funding);
        if (!funding)
            $('assets-once-funding').checked = false;
    }
    function onceSnapshot() {
        const fields = $('assets-once-form')
            .querySelectorAll('input,select,textarea');
        return recurringDraftSnapshot(Array.from(fields));
    }
    const onceHasChanges = () => onceSnapshot() !== onceBaseline;
    function populateOnceCategories(selected = null) {
        const select = $('assets-once-category');
        select.replaceChildren(new Option('未分類', ''));
        for (const category of getCategories())
            select.add(new Option(category.name, category.id));
        select.value = selected && [...select.options].some(o => o.value === selected) ? selected : '';
    }
    function resetOnceForm() {
        fundingDraft = null;
        $('assets-once-amount').placeholder = '10000';
        $('assets-once-date').removeAttribute('min');
        $('assets-once-date').removeAttribute('max');
        onceEditingId = null;
        $('assets-once-form').reset();
        populateOnceCategories();
        $('assets-once-date').value = localDate();
        $('assets-once-from').value = 'rakuten-bank';
        $('assets-once-to').value = 'cash-savings';
        $('assets-once-funding').checked = false;
        $('assets-once-dialog-title').textContent = '入出金を登録';
        $('assets-once-save').textContent = '保存';
        status($('assets-once-error'), '');
        onceFormFields();
        onceBaseline = onceSnapshot();
    }
    function openOnce(entry) {
        if (busy || confirming() || onceDialog.open || !getVault()?.unlocked)
            return;
        onceEpoch++;
        resetOnceForm();
        if (entry) {
            onceEditingId = entry.id;
            $('assets-once-date').value = entry.date;
            $('assets-once-name').value = entry.name;
            $('assets-once-amount').value = String(entry.amount);
            populateOnceCategories(entry.categoryId);
            $('assets-once-from').value = entry.fromAccountId ?? 'rakuten-bank';
            $('assets-once-to').value = entry.toAccountId ?? 'cash-savings';
            $('assets-once-funding').checked = !!entry.cardFunding;
            $('assets-once-form').querySelector(`input[name="assets-once-kind"][value="${entry.kind}"]`).checked = true;
            $('assets-once-form').querySelector(`input[name="assets-once-status"][value="${entry.status}"]`).checked = true;
            $('assets-once-dialog-title').textContent = '入出金を編集';
            $('assets-once-save').textContent = '保存';
            onceFormFields();
        }
        onceBaseline = onceSnapshot();
        onceDialog.showModal();
        lockOncePage();
    }
    function openFundingMovement(snapshot) {
        const vault = getVault();
        if (!vault?.unlocked || busy || confirming() || onceDialog.open)
            return;
        const data = vault.assetSettings();
        const bill = { cardId: 'rakuten-mizuho', paymentDate: snapshot.paymentDate, amount: snapshot.billAmount };
        const matches = manualMizuhoFundingEntries(bill, data);
        if (matches.length === 1) {
            openOnce(matches[0]);
            return;
        }
        if (matches.length > 1 || !mizuhoTransferForBill(bill, data)) {
            onceShowAll = true;
            renderOnce();
            $('assets-once-title').scrollIntoView({ block: 'start' });
            simpleActivity('登録済みの振替・定期入出金を確認してください。新しい振替は自動登録しません。', true);
            return;
        }
        const window = mizuhoFundingWindow(snapshot.paymentDate, (data.mizuhoTransferPlan ?? DEFAULT_MIZUHO_PLAN).leadDays);
        if (!window)
            return;
        openOnce();
        if (!onceDialog.open)
            return;
        fundingDraft = snapshot;
        const date = $('assets-once-date');
        date.min = window.first;
        date.max = window.last < localDate() ? window.last : localDate();
        // Never silently substitute the forecast date or amount for the real transfer.
        date.value = localDate() >= window.first && localDate() <= window.last ? localDate() : '';
        $('assets-once-amount').value = '';
        $('assets-once-amount').placeholder = String(snapshot.transferAmount);
        $('assets-once-name').value = 'みずほ楽天カードの代金送金';
        $('assets-once-to').value = 'mizuho-bank';
        $('assets-once-funding').checked = true;
        onceFormFields();
        $('assets-once-dialog-title').textContent = '実際の送金を記録';
        onceBaseline = onceSnapshot();
    }
    async function closeOnce() {
        if (busy || confirming() || !onceDialog.open)
            return;
        const epoch = onceEpoch, snapshot = onceSnapshot();
        if (onceHasChanges()) {
            if (!await requestConfirmation({ owner: confirmationOwner, parent: onceDialog, title: '未保存の変更を破棄しますか？',
                message: '入力した内容は保存されません。', acceptLabel: '破棄する', cancelLabel: '編集を続ける', destructive: true }))
                return;
            if (epoch !== onceEpoch || busy || !onceDialog.open || onceSnapshot() !== snapshot)
                return;
        }
        onceDialog.close();
        resetOnceForm();
    }
    function readOnce() {
        const kind = onceKind(), from = value('assets-once-from'), to = value('assets-once-to');
        return validateOneTime({ id: onceEditingId ?? crypto.randomUUID(), date: value('assets-once-date'),
            name: value('assets-once-name'), amount: Number(value('assets-once-amount')), kind, status: onceStatus(),
            categoryId: kind === 'expense' ? value('assets-once-category') || null : null,
            fromAccountId: kind === 'income' ? null : from, toAccountId: kind === 'transfer' || kind === 'income' ? to : null,
            ...(kind === 'transfer' && from === 'rakuten-bank' && to === 'mizuho-bank' && $('assets-once-funding').checked ? { cardFunding: true } : {}) });
    }
    function renderOnce() {
        const data = getVault()?.unlocked ? getVault().assetSettings() : null;
        const list = $('assets-once-list');
        list.replaceChildren();
        if (!data)
            return;
        const entries = [...(data.oneTime ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
        $('assets-once-count').textContent = `${entries.length}件`;
        if (!entries.length)
            list.append(make('p', 'assets-once-empty', 'まだ入出金の記録はありません。'));
        for (const entry of (onceShowAll ? entries : entries.slice(0, 6))) {
            const row = make('div', 'assets-once-item'), detail = make('div', 'assets-once-item-detail');
            detail.append(make('strong', '', entry.name));
            const from = accountName(entry.fromAccountId), to = accountName(entry.toAccountId);
            const route = entry.kind === 'transfer' ? `${from} → ${to}` : entry.kind === 'income' ? to : from;
            detail.append(make('small', '', `${formatDate(entry.date)} · ${onceKinds[entry.kind]} · ${route} · ${entry.status === 'done' ? '実行済み' : '予定'}${entry.kind === 'expense' ? ' · ' + (getCategories().find(c => c.id === entry.categoryId)?.name ?? '未分類') : ''}`));
            const right = make('div', 'assets-once-item-action');
            right.append(make('b', '', `${entry.kind === 'income' ? '+' : entry.kind === 'expense' || entry.kind === 'withdrawal' ? '−' : ''}${yen(entry.amount)}`), addButton('編集', () => openOnce(entry)), addButton('削除', () => { void deleteOnce(entry); }, true));
            row.append(detail, right);
            list.append(row);
        }
        const more = $('assets-once-toggle');
        more.classList.toggle('hidden', entries.length <= 6);
        more.textContent = onceShowAll ? '閉じる' : `すべて表示（${entries.length}件）`;
    }
    async function saveOnce() {
        if (busy || confirming() || !onceDialog.open)
            return;
        const node = $('assets-once-error');
        try {
            const entry = readOnce();
            if (fundingDraft) {
                const data = requireVault().assetSettings();
                const bill = { cardId: 'rakuten-mizuho', paymentDate: fundingDraft.paymentDate, amount: fundingDraft.billAmount };
                const window = mizuhoFundingWindow(bill.paymentDate, (data.mizuhoTransferPlan ?? DEFAULT_MIZUHO_PLAN).leadDays);
                if (!window || entry.date < window.first || entry.date > window.last || entry.date > localDate() || entry.status !== 'done' || !entry.cardFunding)
                    throw new Error('実際の送金日・金額・振替先・実行済み状態を確認してください。');
                if (!mizuhoTransferForBill(bill, data))
                    throw new Error('振替が登録されています。最新情報を取得して既存の記録を確認してください。');
            }
            toggleBusy(true);
            status(node, '入出金を保存中…');
            await requireVault().upsertOneTime(entry, fundingDraft ?? undefined);
            onceDialog.close();
            resetOnceForm();
            onSaved('入出金をOneDriveに保存しました。');
            render();
            onPayrollChange();
        }
        catch (error) {
            status(node, mutationError(error), true);
        }
        finally {
            toggleBusy(false);
        }
    }
    async function deleteOnce(entry) {
        const vault = getVault();
        if (busy || confirming() || !vault?.unlocked)
            return;
        const id = entry.id, epoch = onceEpoch;
        const unchanged = () => JSON.stringify(vault.assetSettings().oneTime?.find(x => x.id === id)) === JSON.stringify(entry);
        if (!unchanged())
            return;
        if (!await requestConfirmation({ owner: confirmationOwner, title: '入出金記録を削除しますか？',
            message: `「${entry.name}」（${formatDate(entry.date)}）の記録を削除します。`, acceptLabel: '削除する', destructive: true }))
            return;
        if (epoch !== onceEpoch || busy || getVault() !== vault || !vault.unlocked)
            return;
        if (!unchanged()) {
            status($('assets-once-status'), '記録が更新されました。最新情報から確認してください。', true);
            return;
        }
        toggleBusy(true);
        try {
            await vault.deleteOneTime(id);
            onSaved('入出金記録を削除しました。');
            render();
            onPayrollChange();
        }
        catch (error) {
            status($('assets-once-status'), mutationError(error, '削除'), true);
        }
        finally {
            toggleBusy(false);
        }
    }
    function renderAccounts() {
        const vault = getVault();
        if (!vault?.unlocked)
            return;
        observeLocalPayroll(vault);
        const records = vault.readonlyRecords(), today = new Date();
        const data = fixedCostCalculationAssets({ records, assets: vault.assetSettings(), rules: vault.merchantRules(), categories: [], fixedCostMigrations: vault.fixedCostMigrations(), payroll: { ready: false, syncedAt: null, entries: [] } }, localDay(today));
        const work = prepareBankForecast(records, data);
        const available = payrollOwner === vault && (payrollSynced || (payrollStale && payrollUseStale)) ? payrollIncome : [];
        const currentReport = forecastBankBalances(data, localDay(today), records, available, data.payrollDepositAccount, localDay(today), work);
        const now = currentReport.accounts;
        for (const account of ASSET_ACCOUNTS) {
            const current = now[account.id], latest = current.baseline;
            const label = latestTexts.get(account.id);
            label.replaceChildren();
            label.append(make('small', 'assets-balance-caption', '現在の推定残高'), make('strong', `assets-balance ${current.balance === null ? 'data-status-muted' : ''}`, current.balance !== null ? yen(current.balance) : current.baseline ? DATA_STATUS.unavailable : DATA_STATUS.unregistered));
            const details = accountDetails.get(account.id);
            details.replaceChildren();
            if (latest) {
                label.append(make('small', 'assets-balance-date', `最終確認：${yen(latest.balance)}（${formatDateTime(latest.observedAt, true)}）`));
                const parts = [];
                if (current.recurringDelta)
                    parts.push(`定期入出金 ${current.recurringDelta > 0 ? '+' : ''}${yen(current.recurringDelta)}`);
                if (current.oneTimeDelta)
                    parts.push(`単発入出金 ${current.oneTimeDelta > 0 ? '+' : ''}${yen(current.oneTimeDelta)}`);
                if (current.cardNisaDelta)
                    parts.push(`カード積立 +${yen(current.cardNisaDelta)}`);
                if (current.payrollDelta)
                    parts.push(`Payroll給与 +${yen(current.payrollDelta)}`);
                const cardDebits = currentReport.cardDebitByAccount[account.id] ?? 0;
                if (cardDebits)
                    parts.push(`カード引落 −${yen(cardDebits)}`);
                const autoTransfer = currentReport.autoTransferByAccount[account.id] ?? 0;
                if (autoTransfer)
                    parts.push(`みずほ送金予測 ${autoTransfer > 0 ? '+' : ''}${yen(autoTransfer)}`);
                const estimatedCardDebits = currentReport.fixedCostCardEstimatesByAccount[account.id] ?? 0;
                if (estimatedCardDebits)
                    parts.push(`カード固定費 −${yen(estimatedCardDebits)}（見込み）`);
                const estimatedTransfer = currentReport.estimatedTransferByAccount[account.id] ?? 0;
                if (estimatedTransfer)
                    parts.push(`みずほ送金 ${estimatedTransfer > 0 ? '+' : ''}${yen(estimatedTransfer)}（見込み）`);
                const expected = currentReport.estimatedByAccount[account.id] ?? 0;
                if (expected)
                    parts.push(`給与 +${yen(expected)}（見込み）`);
                // Shared calculation details in the warning settings.
                if (parts.length)
                    details.append(make('p', '', parts.join(' / ')));
                if (current.warning)
                    details.append(make('p', '', current.warning));
                if (current.nisaOverlap?.scheduledDelta && current.balance !== null)
                    details.append(make('p', '', `重複候補の未確認予定を除いた場合の参考値：${yen(current.balance - current.nisaOverlap.scheduledDelta)}`));
                if (current.overdue && current.balance !== null)
                    details.append(make('p', '', `期限経過・未確認 ${current.overdue.count}件：すべて実行された場合 ${yen(current.balance + current.overdue.delta)}（差額 ${yen(current.overdue.delta)}、参考値）`));
                if (data.payrollDepositAccount === account.id) {
                    if (payrollStale && payrollUseStale && payrollOwner === vault)
                        details.append(make('p', '', 'Payrollの前回取得分を使用中（最新同期失敗）。'));
                    else if (!payrollSynced)
                        details.append(make('p', '', 'Payrollの給与は未取得です。'));
                }
                if (account.id === 'rakuten-bank' && !data.payrollDepositAccount)
                    details.append(make('p', '', '給与の振込先は「設定」で登録できます。'));
                if (!details.childElementCount)
                    details.append(make('p', '', '入出金の変動なし'));
            }
            else {
                label.append(make('small', 'assets-balance-date', 'まず残高を登録してください。'));
                details.append(make('p', '', '残高未登録'));
            }
            const reconciliation = reconciliationViews.get(account.id);
            const reconciliationWasOpen = reconciliation.querySelector('details.assets-reconcile-card')?.open ?? false;
            reconciliation.replaceChildren();
            let match = null;
            try {
                match = reconcileBalance(data, account.id, records, available, data.payrollDepositAccount, payrollSynced, localDay(today));
            }
            catch {
                reconciliation.append(make('p', 'assets-reconcile-unavailable', '過去の残高を照合できませんでした。設定と記録を確認してください。'));
            }
            if (match) {
                const report = match;
                const gap = report.difference;
                const block = document.createElement('details');
                block.className = `assets-reconcile-card${gap !== 0 ? ' has-difference' : ' is-matched'}${report.valuationMayChange ? ' is-investment' : ''}`;
                block.open = reconciliationWasOpen;
                const summary = make('summary', 'assets-reconcile-summary');
                const heading = make('span', 'assets-reconcile-title', '残高照合（再計算と実績）');
                const text = make('strong', 'assets-reconcile-difference', gap === 0 ? '再計算と一致' : `${gap > 0 ? '+' : '−'}${yen(Math.abs(gap))}`);
                summary.append(heading, text);
                block.append(summary);
                const body = make('div', 'assets-reconcile-body');
                const pair = make('div', 'assets-reconcile-figures');
                for (const [name, value] of [['前回の確認残高', report.previous.balance], ['現在の設定による再計算残高', report.predicted], ['今回の実際の残高', report.actual]]) {
                    const cell = make('div', 'assets-reconcile-figure');
                    cell.append(make('span', '', name), make('strong', '', yen(value)));
                    pair.append(cell);
                }
                body.append(make('p', 'assets-reconcile-period', `${report.previousDay} → ${report.latestDay} の入出金を現在の設定で再計算`), pair);
                if (report.oneTimeOverlap)
                    body.append(make('p', 'assets-reconcile-advice', '単発入出金と定期予定・給与の対応が確認できないため、照合結果は参考値です。'));
                if (report.nisaOverlap)
                    body.append(make('p', 'assets-reconcile-advice', 'NISA積立の対応が確認できないため、照合結果は参考値です。'));
                if (gap === 0 && report.provisionalEntries)
                    body.append(make('p', 'assets-reconcile-advice', `期限経過・未確認：${report.provisionalEntries}件（実行時の差額 ${yen(report.provisionalDelta)}）`));
                if (gap !== 0) {
                    body.append(make('p', 'assets-reconcile-advice', report.valuationMayChange
                        ? 'NISAの評価額には相場変動が含まれるため、差額は未記録の入出金を意味しません。'
                        : '未記録の入出金がないか確認してください。予測と実際のズレは、未反映の予定や設定変更でも発生します。'));
                    const findings = [];
                    if (report.provisionalEntries)
                        findings.push(`予定のままの単発入出金：${report.provisionalEntries}件（実行時の差額 ${yen(report.provisionalDelta)}）`);
                    if (report.unmappedCard)
                        findings.push('引落口座が未設定のカード明細があります');
                    if (report.payrollNotReady)
                        findings.push('給与データを取得できていません');
                    if (report.sameDayEntries)
                        findings.push('今回の確認日と同日の予定が含まれています（確認時刻より後の取引かもしれません）');
                    if (findings.length) {
                        const hints = make('ul', 'assets-reconcile-findings');
                        for (const item of findings)
                            hints.append(make('li', '', item));
                        body.append(hints);
                    }
                    if (!report.valuationMayChange && !report.provisionalEntries && !report.nisaOverlap && !report.oneTimeOverlap) {
                        const action = addButton('入出金を確認・登録', () => {
                            openOnce();
                            if (!onceDialog.open)
                                return;
                            const kind = gap < 0 ? 'expense' : 'income';
                            $('assets-once-form').querySelector(`input[name="assets-once-kind"][value="${kind}"]`).checked = true;
                            if (kind === 'expense')
                                $('assets-once-from').value = account.id;
                            else
                                $('assets-once-to').value = account.id;
                            onceFormFields();
                            onceBaseline = onceSnapshot();
                        });
                        action.classList.add('assets-reconcile-action');
                        body.append(action);
                    }
                }
                const explanation = make('details', 'assets-reconcile-footnote');
                explanation.append(make('summary', '', '現在の設定による再計算値'), make('p', '', '当時保存していた予測値ではありません。確認当日の入出金や設定変更で差額が生じる場合があり、使途不明金とは断定できません。'));
                body.append(explanation);
                block.append(body);
                reconciliation.append(block);
            }
            const history = histories.get(account.id);
            history.replaceChildren();
            const items = data.snapshots.filter(x => x.accountId === account.id).sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id));
            for (const item of items.slice(0, 12)) {
                const row = make('div', 'assets-history-row');
                const copy = make('span', '', `${formatDateTime(item.observedAt, true)}　${yen(item.balance)}`);
                row.append(copy, addButton('削除', () => { void deleteSnapshot(item); }, true));
                history.append(row);
            }
            if (!items.length)
                history.append(make('p', 'assets-help', 'まだ残高履歴はありません。'));
            if (items.length > 12)
                history.append(make('p', 'assets-help', `直近12件を表示（全${items.length}件）`));
            const count = document.getElementById(`assets-history-count-${account.id}`);
            if (count)
                count.textContent = `（${items.length}件）`;
        }
    }
    function renderBalanceWarnings() {
        const vault = getVault();
        if (!vault?.unlocked || balanceWarningDirty)
            return;
        const limits = vault.assetSettings().balanceWarningLimits;
        for (const id of BALANCE_WARNING_ACCOUNTS)
            $(`balance-warning-${id}`).value = String(limits?.[id] ?? 0);
    }
    async function saveBalanceWarnings() {
        if (busy || confirming())
            return;
        const node = $('balance-warning-status');
        try {
            const limits = validateBalanceWarningLimits(Object.fromEntries(BALANCE_WARNING_ACCOUNTS.map(id => [id, Number(value(`balance-warning-${id}`))])));
            toggleBusy(true);
            status(node, '保存中…');
            await requireVault().setBalanceWarningLimits(limits);
            balanceWarningDirty = false;
            onSaved('残高警告の設定を保存しました。');
            render();
        }
        catch (error) {
            status(node, mutationError(error), true);
        }
        finally {
            toggleBusy(false);
        }
    }
    function renderMizuhoPlan() {
        const vault = getVault();
        if (!vault?.unlocked)
            return;
        const plan = vault.assetSettings().mizuhoTransferPlan ?? DEFAULT_MIZUHO_PLAN;
        if (!mizuhoPlanDirty) {
            $('mizuho-plan-enabled').checked = plan.enabled;
            $('mizuho-plan-lead').value = String(plan.leadDays);
            $('mizuho-plan-extra').checked = plan.extraForSmallBills;
        }
        const update = () => {
            const extra = $('mizuho-plan-extra').checked;
            $('mizuho-plan-example').textContent = `例：24,245円 → ${yen(estimateMizuhoTransferAmount(24245, extra))}、160,500円 → ${yen(estimateMizuhoTransferAmount(160500, extra))}（請求額から自動試算）`;
        };
        update();
    }
    async function saveMizuhoPlan() {
        if (busy)
            return;
        const plan = { enabled: $('mizuho-plan-enabled').checked, leadDays: Number(value('mizuho-plan-lead')), extraForSmallBills: $('mizuho-plan-extra').checked };
        const node = $('mizuho-plan-status');
        toggleBusy(true);
        status(node, '保存中…');
        try {
            await requireVault().setMizuhoTransferPlan(plan);
            mizuhoPlanDirty = false;
            onSaved('みずほへの送金予測を保存しました。');
            render();
        }
        catch (err) {
            status(node, mutationError(err), true);
        }
        finally {
            toggleBusy(false);
        }
    }
    function renderBirthMonth() {
        const vault = getVault();
        const input = $('assets-birth-month');
        input.disabled = !vault?.unlocked || busy;
        $('assets-birth-save').disabled = !vault?.unlocked || busy;
        if (!birthDirty)
            input.value = vault?.unlocked ? vault.assetSettings().birthMonth ?? '' : '';
    }
    async function saveBirthMonth() {
        if (busy)
            return;
        const input = $('assets-birth-month');
        const month = input.value;
        const node = $('assets-birth-status');
        if (!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month) || month > localDate().slice(0, 7)) {
            status(node, '生年月を確認してください。', true);
            return;
        }
        toggleBusy(true);
        status(node, '保存中…');
        try {
            await requireVault().setBirthMonth(month);
            birthDirty = false;
            onSaved('生年月を保存しました。');
            render();
        }
        catch (error) {
            status(node, mutationError(error), true);
        }
        finally {
            toggleBusy(false);
        }
    }
    function renderNisaLink() {
        const vault = getVault();
        if (!vault?.unlocked)
            return;
        const assets = vault.assetSettings(), rule = assets.nisaCardRule;
        if (!nisaDirty) {
            const select = $('assets-nisa-funding');
            const options = [{ value: '', label: '未確認' }, { value: 'independent', label: '銀行積立とは別の積立' }, ...assets.recurring.filter(r => r.toAccountId === 'nisa' && r.fromAccountId !== null && r.fromAccountId !== 'nisa' && r.kind === 'transfer').map(r => ({ value: `same:${r.id}`, label: `同じ積立：${r.name}` }))];
            const selected = rule?.bankFunding?.kind === 'same' ? `same:${rule.bankFunding.recurringId}` : rule?.bankFunding?.kind === 'independent' ? 'independent' : '';
            if (!options.some(o => o.value === selected))
                options.push({ value: selected, label: '同じ積立：登録済み予定（現在は未登録）' });
            choices(select, options);
            select.value = selected;
            $('assets-nisa-card').value = rule?.cardId ?? CARDS[0].id;
            $('assets-nisa-merchant').value = rule?.merchantContains ?? '';
        }
        $('assets-nisa-match-count').textContent = '';
        $('assets-nisa-disable').disabled = busy || !rule;
    }
    async function updateNisaLink(clear = false) {
        if (busy)
            return;
        const node = $('assets-nisa-status');
        try {
            const cardId = value('assets-nisa-card'), merchant = value('assets-nisa-merchant').trim();
            const funding = value('assets-nisa-funding');
            const bankFunding = funding === 'independent' ? { kind: 'independent' } : funding.startsWith('same:') ? { kind: 'same', recurringId: funding.slice(5) } : undefined;
            const link = clear ? null : validateNisaCardRule({ cardId, merchantContains: merchant, enabled: true, ...(bankFunding ? { bankFunding } : {}) });
            // Invalid or empty matching text must not silently match every card row.
            if (!clear && !CARDS.some(c => c.id === cardId))
                throw new Error('対象カードを選択してください。');
            toggleBusy(true);
            status(node, '連携条件をOneDriveに保存しています…');
            await requireVault().setNisaCardRule(link);
            nisaDirty = false;
            onSaved(clear ? 'NISAカード連携を解除しました。' : 'NISAカード連携を保存しました。');
            render();
        }
        catch (error) {
            status(node, mutationError(error), true);
        }
        finally {
            toggleBusy(false);
        }
    }
    function renderRecurring() {
        const vault = getVault();
        if (!vault?.unlocked)
            return;
        const all = [...vault.assetSettings().recurring].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
        const entries = all.filter(item => item.kind !== 'expense');
        const today = localDate();
        $('assets-recurring-count').textContent = `${entries.length}件`;
        const list = $('assets-recurring-list');
        list.replaceChildren();
        if (!entries.length) {
            list.append(make('p', 'assets-empty', '登録済みの設定はありません。'));
            return;
        }
        for (const item of entries) {
            const card = make('div', `assets-recurring-item${item.enabled ? '' : ' is-disabled'}`);
            const top = make('div', 'assets-recurring-top');
            const title = make('strong', '', item.name), sum = make('b', '', `${item.kind === 'expense' ? '−' : item.kind === 'income' ? '+' : '⇄'} ${yen(item.amount)}`);
            top.append(title, sum);
            const path = item.kind === 'expense' ? `${accountName(item.fromAccountId)}から引落` :
                item.kind === 'income' ? `${accountName(item.toAccountId)}へ入金` : `${accountName(item.fromAccountId)} → ${accountName(item.toAccountId)}`;
            const category = item.categoryId ? getCategories().find(c => c.id === item.categoryId)?.name : '';
            const tags = make('div', 'assets-recurring-tags');
            tags.append(make('span', 'assets-recurring-tag', frequencyLabel(item)));
            if (category)
                tags.append(make('span', 'assets-recurring-tag', category));
            if (!item.enabled)
                tags.append(make('span', 'assets-recurring-tag is-paused', '停止中'));
            const route = make('p', 'assets-recurring-route', path);
            if (item.endOn && item.endOn < today)
                tags.append(make('span', 'assets-recurring-tag', '終了済み'));
            else if (item.startOn > today)
                tags.append(make('span', 'assets-recurring-tag', `開始予定 ${formatDate(item.startOn)}`));
            else if (item.endOn)
                tags.append(make('span', 'assets-recurring-tag', `終了予定 ${formatDate(item.endOn)}`));
            const actions = make('div', 'assets-recurring-actions');
            actions.append(addButton('編集', () => { void openRecurringEditor(item); }), addButton('削除', () => { void removeRecurring(item); }, true));
            card.append(top, route, tags, actions);
            list.append(card);
        }
    }
    async function removeRecurring(item) {
        const vault = getVault(), epoch = onceEpoch;
        if (busy || confirming() || item.kind === 'expense' || !vault?.unlocked)
            return;
        const unchanged = () => JSON.stringify(vault.assetSettings().recurring.find(x => x.id === item.id)) === JSON.stringify(item);
        if (!unchanged())
            return;
        const draft = recurringSnapshot(), previousId = editingId;
        if (!await requestConfirmation({ owner: confirmationOwner, title: '定期入出金を削除しますか？',
            message: `「${item.name}」の定期入出金を削除します。${editingId === item.id && recurringHasChanges() ? '\n編集中の入力も破棄されます。' : ''}`,
            acceptLabel: '削除する', destructive: true }))
            return;
        if (epoch !== onceEpoch || busy || getVault() !== vault || !vault.unlocked)
            return;
        if (!unchanged() || editingId !== previousId || recurringSnapshot() !== draft) {
            status($('assets-recurring-status'), '記録または入力が更新されました。再確認してください。', true);
            return;
        }
        const node = $('assets-recurring-status');
        toggleBusy(true);
        status(node, 'OneDriveから削除しています…');
        try {
            await vault.deleteRecurring(item.id);
            if (editingId === item.id)
                resetForm();
            onSaved('定期入出金をOneDriveから削除しました。');
            render();
        }
        catch (error) {
            status(node, mutationError(error, '削除'), true);
        }
        finally {
            toggleBusy(false);
        }
    }
    function renderPayroll() {
        const vault = getVault();
        if (!vault?.unlocked)
            return;
        observeLocalPayroll(vault);
        if (!payrollAccountDirty) {
            const data = vault.assetSettings();
            $('assets-payroll-deposit').value = data.payrollDepositAccount ?? '';
            payrollAccountBaseline = JSON.stringify([data.payrollDepositAccount, data.payrollDepositAccountHistory]);
        }
        for (const element of document.querySelectorAll('#assets-payroll-connect input, #assets-payroll-connect button, #assets-payroll-deposit-form select, #assets-payroll-deposit-form button'))
            element.disabled = !!payrollBusy;
        const haveLast = payrollOwner === vault && payrollSyncedAt > 0;
        $('assets-payroll-count').textContent = haveLast ? `${payrollIncome.length}件` : payrollBusy ? '—' : '0件';
        $('assets-payroll-last').textContent = haveLast ? `${formatDateTime(payrollSyncedAt)}${payrollStale ? '（更新失敗・古いデータ）' : ''}` : payrollBusy ? '読み込み中…' : '未同期';
        const staleBox = $('assets-payroll-stale');
        staleBox.classList.toggle('hidden', !payrollStale || !haveLast);
        $('assets-payroll-use-stale').checked = payrollUseStale;
        const recurring = vault.assetSettings().recurring.filter(e => e.enabled && e.startOn <= localDate() && (!e.endOn || e.endOn >= localDate()) && recurringSalaryRole(e) !== null);
        if (payrollStale && haveLast) {
            const note = $('assets-payroll-status');
            note.textContent = `Payrollの最新同期に失敗しました。最終成功：${formatDateTime(payrollSyncedAt, true)}。${payrollUseStale ? '古い給与情報を予測に使用中です。' : '古い給与情報は予測から除外しています。'}`;
            note.classList.add('bad');
            note.setAttribute('role', 'alert');
        }
        const warning = $('assets-payroll-mapping-warning');
        const deposit = vault.assetSettings().payrollDepositAccount;
        const unknown = payrollIncome.some(e => e.kind === 'salary' && payrollRole(e) === null);
        const mismatch = !!deposit && recurring.some(e => e.toAccountId !== deposit && payrollIncome.some(p => p.kind === 'salary' && payrollRole(p) === recurringSalaryRole(e) && p.paidOn.slice(0, 7) === localDate().slice(0, 7)));
        warning.textContent = haveLast && !payrollStale && payrollIncome.length && (!deposit || unknown || mismatch) ?
            [!deposit ? '給与の入金先が未設定です。' : '', unknown ? '勤務区分不明の給与があります。Payrollの勤務先設定を確認してください。' : '', mismatch ? '給与の定期入金と入金先設定が一致していません。重複計上にご注意ください。' : ''].filter(Boolean).join(' ') : '';
    }
    /** Manual registration is explicit; automatic reads use only the encrypted settings document. */
    async function syncPayroll(automatic = false, hint) {
        return traceFinanceOperation('payroll-sync', async () => {
            if (busy || payrollBusy)
                return;
            const vault = getVault();
            if (!vault?.unlocked || vault.recoveryOnly) {
                if (!automatic)
                    status($('assets-payroll-status'), 'Financeの保管庫を解除してから連携してください。', true);
                return;
            }
            observeLocalPayroll(vault);
            const pass = $('assets-payroll-secret');
            const entered = automatic ? '' : pass.value;
            if (!automatic)
                pass.value = '';
            const epoch = ++payrollEpoch, vaultGuard = vault.payrollOperationGuard();
            const current = () => { try {
                vaultGuard();
                return getVault() === vault && epoch === payrollEpoch;
            }
            catch {
                return false;
            } };
            const guard = () => { if (!current())
                throw new Error('Payroll連携の操作が変更されました。'); };
            payrollBusy = automatic ? 'automatic' : 'manual';
            lastPayrollAttemptAt = Date.now();
            let notify = !payrollSynced;
            try {
                renderPayroll();
                const saved = await vault.readPayrollCredential(automatic ? hint : undefined);
                guard();
                const changed = payrollCredential !== undefined && payrollCredential !== saved;
                observeVerifiedPayroll(saved);
                if (changed) {
                    notify = true;
                    renderAccounts();
                    renderPayroll();
                    onPayrollChange(true);
                }
                if (!entered && !saved) {
                    if (!automatic)
                        status($('assets-payroll-status'), '初回連携にはPayrollのパスフレーズを入力してください。', true);
                    return;
                }
                // Even before the usual synchronization interval, observe credential revocation.
                if (automatic && payrollOwner === vault && payrollSession && payrollSynced && Date.now() - payrollSyncedAt < 10 * 60 * 1000)
                    return;
                if (!payrollOwner || payrollOwner !== vault || entered && entered !== saved)
                    clearPayroll();
                const secret = entered || saved;
                status($('assets-payroll-status'), automatic ? 'Payrollの収入を自動同期しています…' : 'Payrollの暗号化収入を取得・検証しています…');
                const existing = !entered && payrollOwner === vault ? payrollSession : null;
                const { session, items } = existing ? { session: existing, items: await existing.refresh() } : await PayrollReadSession.connectAndRefresh(vault.payrollReadClient(), secret, guard);
                guard();
                const verified = await vault.readPayrollCredential();
                guard();
                if (verified !== saved) {
                    observeVerifiedPayroll(verified);
                    throw new Error('Payroll連携設定が変更されました。最新の設定で再同期してください。');
                }
                let credentialError;
                if (!automatic) {
                    try {
                        const action = payrollPassphraseUpdate(entered, saved);
                        if (action !== undefined) {
                            await vault.setPayrollAutoPassphrase(action, saved);
                            guard();
                            observedLocalCredential = vault.assetSettings().payrollAutoPassphrase;
                            payrollCredential = action;
                        }
                    }
                    catch (error) {
                        guard();
                        credentialError = error;
                        let latest;
                        try {
                            latest = await vault.readPayrollCredential();
                        }
                        catch (readError) {
                            guard();
                            if (saved !== null)
                                throw readError;
                            latest = null;
                        }
                        guard();
                        if (latest !== saved) {
                            observeVerifiedPayroll(latest);
                            throw error;
                        }
                    }
                }
                guard();
                // A manually entered but not persisted credential may be used in this tab only.
                // Never keep it as a reusable automatic session.
                payrollSession = credentialError === undefined ? session : null;
                payrollOwner = vault;
                payrollIncome = items;
                payrollSynced = true;
                payrollSyncedAt = Date.now();
                payrollSessionGuard = vaultGuard;
                payrollStale = false;
                payrollUseStale = false;
                notify = true;
                const message = `Payrollから${items.length}件の給与実績を${automatic ? '自動取得' : '取得'}しました。`;
                status($('assets-payroll-status'), credentialError === undefined ? message :
                    `${message} ただし自動連携設定の${mutationError(credentialError)}。取得済みの給与情報は維持しています。`, credentialError !== undefined);
            }
            catch (error) {
                if (!current())
                    return;
                notify = true;
                const lastVerified = payrollOwner === vault && payrollSyncedAt > 0;
                payrollSession = null;
                payrollSynced = false;
                payrollStale = lastVerified;
                if (!lastVerified) {
                    clearPayroll();
                }
                else
                    payrollUseStale = false;
                status($('assets-payroll-status'), `給与を取得できませんでした：${error instanceof Error ? error.message : '通信エラー'}。${lastVerified ? '最終成功時の給与はこのタブに保持しましたが、予測から除外しています。' : '設定から再接続できます。'}`, true);
            }
            finally {
                if (epoch === payrollEpoch) {
                    payrollBusy = false;
                    $('assets-payroll-sync').disabled = !getVault()?.unlocked;
                    $('assets-payroll-forget').disabled = !getVault()?.unlocked;
                    if (current()) {
                        if (notify)
                            renderAccounts();
                        renderPayroll();
                        if (notify)
                            onPayrollChange(true);
                    }
                }
            }
        });
    }
    async function refreshPayroll(hint) {
        const vault = getVault();
        if (!vault?.unlocked || vault.recoveryOnly)
            return;
        observeLocalPayroll(vault);
        if (payrollBusy || busy)
            return;
        if (Date.now() - lastPayrollAttemptAt < 60 * 1000)
            return;
        await syncPayroll(true, hint);
    }
    async function forgetPayroll() {
        if (busy || payrollBusy)
            return;
        const vault = getVault();
        if (!vault?.unlocked || confirming())
            return;
        const credential = vault.assetSettings().payrollAutoPassphrase, epoch = payrollEpoch, lockGuard = vault.payrollOperationGuard();
        if (!await requestConfirmation({ owner: confirmationOwner, title: 'Payroll連携を解除しますか？', message: '保存済みのパスフレーズと、このタブの給与情報を破棄します。給与の原本は変更しません。', acceptLabel: '連携を解除する', destructive: true }))
            return;
        const current = () => { try {
            lockGuard();
            return getVault() === vault && payrollEpoch === epoch;
        }
        catch {
            return false;
        } };
        if (!current() || busy || payrollBusy || vault.assetSettings().payrollAutoPassphrase !== credential)
            return;
        payrollBusy = 'manual';
        let changed = false;
        $('assets-payroll-forget').disabled = true;
        try {
            await vault.setPayrollAutoPassphrase(null, credential);
            if (!current())
                return;
            clearPayroll();
            payrollCredential = null;
            observedLocalCredential = null;
            $('assets-payroll-secret').value = '';
            status($('assets-payroll-status'), 'Payroll連携を解除し、Financeの暗号化設定からパスフレーズを削除しました。');
            changed = true;
            renderAccounts();
        }
        catch (error) {
            if (current())
                status($('assets-payroll-status'), mutationError(error, '解除'), true);
        }
        finally {
            if (epoch === payrollEpoch) {
                payrollBusy = false;
                if (current()) {
                    renderPayroll();
                    if (changed)
                        onPayrollChange(true);
                }
                else
                    $('assets-payroll-forget').disabled = !getVault()?.unlocked;
            }
        }
    }
    async function savePayrollDeposit() {
        if (busy || payrollBusy)
            return;
        if (!getVault()?.unlocked) {
            status($('assets-payroll-status'), 'Financeの保管庫を解除してください。', true);
            return;
        }
        const id = value('assets-payroll-deposit');
        if (!['', 'rakuten-bank', 'cash-savings'].includes(id))
            throw new Error('給与の振込先が不正です。');
        const node = $('assets-payroll-status');
        toggleBusy(true);
        status(node, '給与の入金先設定をOneDriveに保存しています…');
        try {
            const vault = requireVault(), settings = vault.assetSettings();
            if (payrollAccountBaseline !== JSON.stringify([settings.payrollDepositAccount, settings.payrollDepositAccountHistory]))
                throw Error('給与振込先が更新されました。最新情報を確認して編集し直してください。');
            await vault.setPayrollDepositAccount(id === '' ? null : id);
            payrollAccountDirty = false;
            onSaved('給与の入金先を保存しました。');
            render();
        }
        catch (error) {
            status(node, mutationError(error), true);
        }
        finally {
            toggleBusy(false);
        }
    }
    function render() {
        const unlocked = !!getVault()?.unlocked;
        for (const element of document.querySelectorAll('#assets-payroll-connect input, #assets-payroll-connect button, #assets-payroll-deposit-form select, #assets-payroll-deposit-form button'))
            element.disabled = !unlocked || !!payrollBusy;
        for (const element of document.querySelectorAll('#assets-nisa-link-form input, #assets-nisa-link-form select, #assets-nisa-link-form button'))
            element.disabled = !unlocked || busy;
        renderBirthMonth();
        $('assets-lock-message').classList.toggle('hidden', unlocked);
        $('assets-workspace').classList.toggle('hidden', !unlocked);
        if (!unlocked)
            return;
        renderAccounts();
        renderOnce();
        renderNisaLink();
        renderMizuhoPlan();
        renderBalanceWarnings();
        renderPayroll();
        renderRecurring();
    }
    // Group the everyday bank account separately from the two savings assets.
    for (const account of ASSET_ACCOUNTS) {
        const article = make('section', 'panel assets-account-card');
        article.setAttribute('aria-label', `${account.name}の残高設定`);
        const header = make('div', 'assets-account-heading'), icon = make('div', 'assets-account-icon', account.icon), title = make('div');
        title.append(make('h3', '', account.name), make('p', '', account.detail));
        header.append(icon, title);
        const balance = make('div', 'assets-latest');
        latestTexts.set(account.id, balance);
        const fields = document.createElement('form');
        fields.className = 'assets-balance-form';
        fields.autocomplete = 'off';
        const amountLabel = make('label', 'rules-field', '確認した残高（円）');
        const amount = document.createElement('input');
        amount.type = 'number';
        amount.required = true;
        amount.min = '0';
        amount.step = '1';
        amount.inputMode = 'numeric';
        amount.placeholder = '金額を入力';
        amount.setAttribute('aria-label', `${account.name}の残高`);
        amountLabel.append(amount);
        amounts.set(account.id, amount);
        const save = document.createElement('button');
        save.type = 'submit';
        save.className = 'save-action';
        save.textContent = '保存';
        save.setAttribute('aria-label', `${account.name}の残高を保存`);
        save.disabled = busy;
        fields.append(amountLabel, save);
        fields.addEventListener('submit', event => { event.preventDefault(); void saveSnapshot(account.id); });
        const historyDetails = document.createElement('details');
        historyDetails.className = 'assets-history';
        const sum = make('summary', 'assets-history-summary');
        sum.append(make('span', 'assets-history-caption', '残高の記録履歴'));
        const count = make('span', 'assets-history-counter', '（0件）');
        count.id = `assets-history-count-${account.id}`;
        sum.append(count);
        historyDetails.append(sum);
        const history = make('div', 'assets-history-content');
        historyDetails.append(history);
        histories.set(account.id, history);
        const reconciliation = make('div', 'assets-reconciliation');
        reconciliationViews.set(account.id, reconciliation);
        article.append(header, balance, reconciliation, fields, historyDetails);
        $(account.id === 'rakuten-bank' || account.id === 'mizuho-bank' ? 'assets-account-main' : 'assets-account-savings').append(article);
        const info = $('assets-account-info');
        const detailRow = make('div', 'assets-info-row');
        const heading = make('strong', '', account.name);
        const detail = make('div', 'assets-info-text');
        accountDetails.set(account.id, detail);
        detailRow.append(heading, detail);
        info.append(detailRow);
    }
    choices($('assets-once-from'), ASSET_ACCOUNTS.map(x => ({ value: x.id, label: x.name })));
    choices($('assets-once-to'), ASSET_ACCOUNTS.map(x => ({ value: x.id, label: x.name })));
    resetOnceForm();
    $('assets-once-add').addEventListener('click', () => openOnce());
    $('assets-once-toggle').addEventListener('click', () => { onceShowAll = !onceShowAll; renderOnce(); });
    $('assets-once-close').addEventListener('click', closeOnce);
    $('assets-once-cancel').addEventListener('click', closeOnce);
    bindModalDismiss(onceDialog, () => { void closeOnce(); });
    $('assets-once-form').addEventListener('change', onceFormFields);
    $('assets-once-form').addEventListener('submit', event => { event.preventDefault(); void saveOnce(); });
    choices($('assets-nisa-card'), CARDS.map(c => ({ value: c.id, label: c.name })));
    $('assets-nisa-link-form').addEventListener('input', () => { nisaDirty = true; });
    $('assets-birth-month').addEventListener('input', () => { birthDirty = true; });
    $('assets-birth-form').addEventListener('submit', event => { event.preventDefault(); void saveBirthMonth(); });
    $('assets-nisa-link-form').addEventListener('change', () => { nisaDirty = true; });
    $('assets-nisa-link-form').addEventListener('submit', event => { event.preventDefault(); void updateNisaLink(); });
    $('assets-nisa-disable').addEventListener('click', () => { void updateNisaLink(true); });
    $('balance-warning-form').addEventListener('input', () => { balanceWarningDirty = true; });
    $('balance-warning-form').addEventListener('submit', event => { event.preventDefault(); void saveBalanceWarnings(); });
    $('mizuho-plan-form').addEventListener('input', () => { mizuhoPlanDirty = true; });
    $('mizuho-plan-form').addEventListener('change', () => { mizuhoPlanDirty = true; });
    $('mizuho-plan-form').addEventListener('submit', event => { event.preventDefault(); void saveMizuhoPlan(); });
    $('mizuho-plan-extra').addEventListener('change', () => { $('mizuho-plan-example').textContent = `例：24,245円 → ${yen(estimateMizuhoTransferAmount(24245, $('mizuho-plan-extra').checked))}、160,500円 → ${yen(estimateMizuhoTransferAmount(160500, $('mizuho-plan-extra').checked))}`; });
    $('assets-payroll-connect').addEventListener('submit', event => { event.preventDefault(); void syncPayroll(); });
    $('assets-payroll-deposit-form').addEventListener('submit', event => { event.preventDefault(); void savePayrollDeposit(); });
    $('assets-payroll-deposit').addEventListener('change', () => { payrollAccountDirty = true; });
    $('assets-payroll-forget').addEventListener('click', () => { void forgetPayroll(); });
    $('assets-payroll-use-stale').addEventListener('change', event => {
        payrollUseStale = event.target.checked && payrollStale && payrollOwner === getVault();
        renderAccounts();
        renderPayroll();
        onPayrollChange();
    });
    choices($('assets-recurring-from'), ASSET_ACCOUNTS.map(x => ({ value: x.id, label: x.name })));
    choices($('assets-recurring-to'), ASSET_ACCOUNTS.map(x => ({ value: x.id, label: x.name })));
    choices($('assets-recurring-day'), [{ value: '0', label: '末日' }, ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}日` }))]);
    choices($('assets-recurring-month'), Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}月` })));
    choices($('assets-recurring-weekday'), weekdayLabels.map((label, i) => ({ value: String(i), label: `${label}曜日` })));
    $('assets-recurring-kind').addEventListener('change', updateFormFields);
    $('assets-recurring-frequency').addEventListener('change', updateFormFields);
    $('assets-recurring-clear').addEventListener('click', async () => {
        const vault = getVault(), epoch = onceEpoch, draft = recurringSnapshot(), previousId = editingId;
        if (busy || confirming() || !vault?.unlocked)
            return;
        if (recurringHasChanges()) {
            if (!await requestConfirmation({ owner: confirmationOwner, title: '未保存の変更を破棄しますか？',
                message: '編集中の入力をクリアします。', acceptLabel: '破棄する', cancelLabel: '編集を続ける', destructive: true }))
                return;
            if (epoch !== onceEpoch || busy || getVault() !== vault || !vault.unlocked || editingId !== previousId || recurringSnapshot() !== draft)
                return;
        }
        resetForm();
        status($('assets-recurring-status'), '入力をクリアしました。');
    });
    $('assets-recurring-form').addEventListener('submit', event => {
        event.preventDefault();
        if (busy || confirming())
            return;
        void (async () => {
            const node = $('assets-recurring-status');
            try {
                const entry = readEntry();
                toggleBusy(true);
                status(node, 'OneDriveに暗号化保存しています…');
                await requireVault().upsertRecurring(entry);
                resetForm();
                onSaved('定期入出金をOneDriveに保存しました。');
                render();
            }
            catch (error) {
                status(node, mutationError(error), true);
            }
            finally {
                toggleBusy(false);
            }
        })();
    });
    resetForm();
    // Refresh the read-only calculation when the calendar day changes, even when
    // the page stays open across midnight. Never refresh or write OneDrive here.
    let lastProjectionDay = localDay(new Date());
    const refreshForNewDay = () => {
        const next = localDay(new Date());
        if (next === lastProjectionDay)
            return;
        lastProjectionDay = next;
        if (!$('assets-page').classList.contains('hidden') && getVault()?.unlocked)
            renderAccounts();
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden)
        refreshForNewDay(); });
    window.setInterval(refreshForNewDay, 120000);
    window.setInterval(() => { if (!document.hidden)
        void refreshPayroll(); }, 10 * 60 * 1000);
    return { render, openFundingMovement, openRecurring: async (id) => {
            const vault = getVault();
            if (!vault?.unlocked || busy)
                return false;
            const match = vault.assetSettings().recurring.find(entry => entry.id === id);
            if (!match)
                return false;
            return openRecurringEditor(match);
        }, refreshPayroll, payrollSnapshot: () => {
            const vault = getVault();
            if (vault?.unlocked)
                observeLocalPayroll(vault);
            const ready = !!vault?.unlocked && payrollOwner === vault && (payrollSynced || (payrollStale && payrollUseStale && payrollOwner === vault));
            return ready ? { ready: true, syncedAt: payrollSyncedAt, entries: structuredClone(payrollIncome) } : { ready: false, ...(payrollBusy ? { loading: true } : {}), syncedAt: null, entries: [] };
        }, reset: () => {
            onceEpoch++;
            cancelConfirmation(confirmationOwner);
            if (onceDialog.open)
                onceDialog.close();
            unlockOncePage();
            resetForm();
            resetOnceForm();
            onceShowAll = false;
            nisaDirty = false;
            birthDirty = false;
            payrollAccountDirty = false;
            mizuhoPlanDirty = false;
            balanceWarningDirty = false;
            for (const id of BALANCE_WARNING_ACCOUNTS)
                $(`balance-warning-${id}`).value = '';
            status($('balance-warning-status'), '');
            payrollEpoch++;
            payrollBusy = false;
            clearPayroll();
            payrollCredential = undefined;
            observedLocalCredential = undefined;
            lastPayrollAttemptAt = 0;
            $('assets-payroll-secret').value = '';
            $('assets-payroll-count').textContent = '0件';
            $('assets-payroll-last').textContent = '未同期';
            $('assets-payroll-stale').classList.add('hidden');
            status($('assets-payroll-status'), '');
            for (const account of ASSET_ACCOUNTS) {
                amounts.get(account.id).value = '';
                latestTexts.get(account.id).replaceChildren();
                histories.get(account.id).replaceChildren();
                reconciliationViews.get(account.id).replaceChildren();
                accountDetails.get(account.id).replaceChildren();
                $(`assets-history-count-${account.id}`).textContent = '（0件）';
            }
            for (const id of ['assets-once-list', 'assets-recurring-list', 'assets-nisa-match-count', 'assets-payroll-stale-note', 'assets-payroll-mapping-warning'])
                document.getElementById(id)?.replaceChildren();
            $('assets-once-count').textContent = '0件';
            $('assets-recurring-count').textContent = '0件';
            $('assets-once-toggle').textContent = 'すべて表示';
            $('assets-once-toggle').classList.add('hidden');
            $('assets-nisa-funding').replaceChildren();
            $('assets-nisa-merchant').value = '';
            $('assets-nisa-card').value = CARDS[0].id;
            $('assets-payroll-deposit').value = '';
            $('assets-payroll-use-stale').checked = false;
            $('mizuho-plan-enabled').checked = false;
            $('mizuho-plan-extra').checked = false;
            $('mizuho-plan-lead').value = '';
            status($('assets-nisa-status'), '');
            status($('mizuho-plan-status'), '');
            status($('assets-birth-status'), '');
            status($('assets-balances-status'), '');
            status($('assets-recurring-status'), '');
            status($('assets-once-status'), '');
            render();
            onPayrollChange();
        }, isBusy: () => busy || payrollBusy === 'manual' || confirming(), isDirty: () => onceHasChanges() || recurringHasChanges() || nisaDirty || birthDirty || payrollAccountDirty || mizuhoPlanDirty || balanceWarningDirty || [...amounts.values()].some(input => input.value.trim() !== '') };
}
