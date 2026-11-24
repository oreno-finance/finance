import { CARDS, calculatedTotal, getCard, type ParsedStatement, type ImportRow } from './models/types.js';
import { parseStatementText } from './importers/statement-parser.js';
import { parsePdfFile, assertPdfLimits } from './importers/pdf-reader.js';
import { decodeCardCsv, identifyCardCsv, parseCardCsv } from './importers/card-csv.js';
import { cardPaymentDate } from './importers/payment-date.js';
import { prepareStatementRevision, type RevisionDiff } from './importers/revision-review.js';
import { planStatementImport, statementSignature } from './importers/import-policy.js';
import { hasVault, unlockVault, readStatements, readOriginal, exportEncryptedBackup, deleteLegacyVault, lockVault, type LocalSource } from './storage/encrypted-vault.js';
import { verifyLegacyMigration, verifyDownloadedBackup } from './storage/legacy-cleanup.js';
import { graphClientWithoutRedirect, initCloudSettings, cloudConnectPrompt, activeMicrosoftAccountId, cloudConnectionNotice, recordCloudConnectionFailure, type CloudConnectPrompt } from './cloud/cloud-settings.js';
import { syncFinanceCloudGates } from './ui/cloud-gate.js';
import { LiveVault, CloudWriteUncertainError, BrowserKeyGenerationChangedError } from './cloud/live-vault.js';
import { GraphError } from './cloud/onedrive-api.js';
import { readBrowserKey, rememberBrowserKey, forgetBrowserKey, applyBrowserRetentionChoice, isBrowserRemembered, InvalidRememberedBrowserKeyError, isManuallyLocked, setManualLock, clearManualLock, notifyOtherFinanceTabs, CROSS_TAB_LOCK_KEY, type BrowserKeyContext } from './cloud/remembered-browser.js';
import type { CloudRecord } from './cloud/merge.js';
import { displayMerchant, matchingRule, sortedRules, normalizeMerchant, PALETTE, type CategoryDefinition, type MerchantRule, type MatchMode, type CategoryId, type PaletteId } from './cloud/merchant-rules.js';
import { importErrors, importDisplayErrors, cardSelectionPending, duplicateMonths } from './importers/batch-policy.js';
import { prioritizedIndices, orderedPreviewRows, type PreviewSort } from './ui/preview-order.js';
import { availableYears, availableMonths, calendarBillingPeriod, filteredStatementIndices } from './ui/manage-filter.js';
import { recentMerchants } from './ui/recent-merchants.js';
import { planCategoryBatch, categoryBatchChanged } from './ui/category-draft.js';
import { initAssetsSettings, type AssetsUi } from './ui/assets-settings.js';
import { measureFinancePhase } from './cloud/performance-diagnostics.js';
import { initFutureProjection, type FutureProjectionUi } from './ui/future-projection.js'; /* finance-v143 */
import { canonicalStatementFilename } from './ui/statement-filename.js';
import { initMonthlySummary, type MonthlySummaryUi } from './ui/monthly-summary.js'; /* finance-monthly-v140 */
import { initPasswordFields, hidePasswordField, clearPasswordField } from './ui/password-fields.js';
import { saveLastView, type FinanceView } from './ui/view-preference.js';
import { initHome, type HomeUi } from './ui/home.js';
import { initAnalysis, type AnalysisUi } from './ui/analysis.js';
import {analysisDrilldownMatches,analysisDrilldownBreakdown,drilldownPeriodLabel,type AnalysisDrilldown,type AnalysisReportContext} from './ui/analysis-drilldown.js';
import {monthlyReport,prepareMonthlyReports,type MonthlySource} from './summary/monthly-summary.js';
import { initMonthlyReports, type MonthlyReportsUi } from './ui/monthly-reports.js';
import { initSubscriptions, type SubscriptionsUi } from './ui/subscriptions.js';
import { initCardSettings, type CardSettingsUi } from './ui/card-settings.js';
import { showActivity, simpleActivity, finishActivity } from './ui/activity-feedback.js';
import { statementPoints } from './summary/point-benefits.js';
import { hasInterruptionRisk, shouldRefreshOnFocus, type InterruptionSnapshot } from './ui/safety-policy.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};
const yen = (n: number | null): string => n === null ? '未取得' : `${n.toLocaleString('ja-JP')}円`;
const statements: ParsedStatement[] = [];
const failedImports: string[] = [];
// Errors attached to the active uploader attempt only. Historical failures stay
// in the import queue until explicitly dismissed, not in a newly opened dialog.
const currentUploadFailures: string[] = [];
// Keep the original import fingerprint so editing a row does not change duplicate detection.
const importedSignatures = new WeakMap<ParsedStatement, string>();
const savedIds = new WeakMap<ParsedStatement, string>();
// Keep the same remote identity across retries after a partially completed multi-year batch.
const pendingCloudIds = new WeakMap<ParsedStatement, string>();
// Import is a temporary staging area, independent of all cloud-loaded records.
const importStaged = new WeakSet<ParsedStatement>();
const savedFingerprints = new WeakMap<ParsedStatement, string>();
const pendingSources = new WeakMap<ParsedStatement, LocalSource>();
const originalSaved = new WeakSet<ParsedStatement>();
const dirty = new WeakSet<ParsedStatement>();
let liveVault: LiveVault | null = null;
let liveVaultRememberContext:BrowserKeyContext|null=null;
let assetsUi: AssetsUi | null = null;
let futureUi: FutureProjectionUi | null = null;
let summaryUi: MonthlySummaryUi | null = null;
let homeUi: HomeUi | null = null;
let analysisUi: AnalysisUi | null = null;
let reportsUi: MonthlyReportsUi | null = null;
let subscriptionsUi: SubscriptionsUi | null = null;
let cardSettingsUi: CardSettingsUi | null = null;
let currentModal: 'create' | 'unlock' | 'migrate' | null = null;
let cloudStartupRunning = false;
let lockSequence=0;
let cleanupBusy=false;
let vaultDiscoveryCompleted = false;
let modalResolve: ((success: boolean) => void) | null = null;
let activeIndex = -1;
let clipboardHtml = '';
let batchBusy = false;
let filesBusy = false;
let importUploadFeedback = '';
let hasImportedInThisSession = false;
let revisionBusy = false;
let previewSort: PreviewSort | null = null;
let manageSort: PreviewSort | null = null; /* finance-v145 */
const initialCalendar = calendarBillingPeriod();
let manageYear = initialCalendar.year;
let manageMonth = initialCalendar.month;
let manageReturnToSummary = false;
let activeAnalysisDrilldown:AnalysisDrilldown|null=null;
let analysisDrilldownSeed:AnalysisReportContext|null=null;
let drilldownRows=new Map<string,Set<string>>();
let analysisSourceProvider:(()=>MonthlySource|null)|null=null;
let analysisReturnPageY=0;
let analysisReturnContentY=0;
let returnToHome: 'import'|'manage'|'assets'|null = null;
let homeNavigationPending=false;
let summaryReturnPageY = 0;
let summaryReturnContentY = 0;
let lastSavedAt: string | null = null;
let editingRuleId: string | null = null;
let rulesBusy = false;
let categoryDraft: CategoryDefinition[] | null = null;
let categoryBaseline: CategoryDefinition[] = [];
let categorySaving = false;
let cloudRefreshing = false;
let lastCloudCheckAt = 0;

/** A single source of truth for operations that must not be interrupted. */
function interruptionState():InterruptionSnapshot {
  const busy:string[]=[];const unsaved:string[]=[];
  if(batchBusy)busy.push('カード明細の保存');
  if(filesBusy)busy.push('ファイルの解析');
  if(revisionBusy)busy.push('明細の差し替え確認');
  if(rulesBusy||categorySaving)busy.push('ルール・カテゴリーの保存');
  if(assetsUi?.isBusy())busy.push('口座・Payroll処理');
  if(cardSettingsUi?.isBusy())busy.push('カード設定の保存');
  if(subscriptionsUi?.isBusy())busy.push('固定費の保存');
  if(reportsUi?.isBusy())busy.push('月次レポートの処理');
  if(cleanupBusy)busy.push('暗号化データの整理');
  if(liveVault?.isRotating)busy.push('パスフレーズの変更');
  if(liveVault?.hasPendingYearBatch)busy.push('明細の保存結果の確認');
  if(cloudRefreshing)busy.push('OneDriveの更新');
  if(cloudStartupRunning&&liveVault?.unlocked)busy.push('OneDriveの接続確認');
  if(pending().length||failedImports.length)unsaved.push('カード明細');
  if(assetsUi?.isDirty())unsaved.push('口座設定');
  if(cardSettingsUi?.isDirty())unsaved.push('カード設定');
  if(reportsUi?.isDirty())unsaved.push('月次レポートのメモ');
  if(subscriptionsUi?.isDirty())unsaved.push('固定費の編集');
  if(categoryDraft){try{if(categoryBatchChanged(categoryPlan()))unsaved.push('カテゴリー編集');}
    catch{unsaved.push('カテゴリー編集');}}
  if(ruleFormHasChanges())unsaved.push('利用先ルール');
  return {busy,unsaved};
}
function assertRefreshSafe():void {
  const state=interruptionState();
  if(state.busy.length)throw new Error(`${state.busy.join('・')}が完了してから更新してください。`);
  if(state.unsaved.length)throw new Error(`未保存の${state.unsaved.join('・')}があります。保存または破棄してから更新してください。`);
}
function confirmInterruption(label:string):boolean {
  const state=interruptionState();
  if(state.busy.length){operationResult(`${state.busy.join('・')}が進行中です。${label}はできません。`,'warn');return false;}
  return !state.unsaved.length||window.confirm(`未保存の${state.unsaved.join('・')}があります。破棄して${label}しますか？`);
}

const ruleModes:Record<MatchMode,string>={exact:'完全一致',prefix:'前方一致',contains:'部分一致'};
function rules():MerchantRule[]{return liveVault?.unlocked ? liveVault.merchantRules():[];}
function categories():CategoryDefinition[]{return liveVault?.unlocked?liveVault.merchantCategories():[];}
function categoryById(id:CategoryId|null|undefined){
  const item=categories().find(category=>category.id===id);
  if(!item)return null;
  return {...item,hex:PALETTE.find(color=>color.id===item.color)?.hex??'#718096'};
}
function cardDisplayName(cardId:string|null):string|undefined {
  return (cardId&&liveVault?.unlocked?liveVault.assetSettings().cardPreferences?.[cardId]?.name:undefined)??getCard(cardId)?.name;
}
function refreshCardOptionLabels():void {
  for(const id of ['rule-card','recent-merchants-card','assets-nisa-card']){
    const select=document.getElementById(id) as HTMLSelectElement|null;
    if(!select)continue;
    for(const option of select.options)if(getCard(option.value))option.textContent=cardDisplayName(option.value)!;
  }
}
function categoryFor(row:ImportRow,s:ParsedStatement) {
  const matched=matchingRule(row.merchant,s.cardId,rules());
  return categoryById(matched?.categoryId);
}
function categoryChip(meta:NonNullable<ReturnType<typeof categoryById>>):HTMLSpanElement {
  const chip=document.createElement('span');chip.className='category-chip';
  chip.style.setProperty('--category-color',meta.hex);
  const dot=div('category-dot');dot.setAttribute('aria-hidden','true');
  chip.append(dot,document.createTextNode(meta.name));return chip;
}
function merchantFor(row:ImportRow,s:ParsedStatement):string {
  return displayMerchant(row.merchant,s.cardId,rules(),row.merchantOverride);
}


const list = $('statement-list');
const previewEmpty = $('preview-empty');
const previewContent = $('preview-content');
const rowBody = $('transaction-rows');


function active(): ParsedStatement | undefined { return statements[activeIndex]; }
function statementWorkingFingerprint(s:ParsedStatement):string {
  // Issuer fingerprint remains raw for duplicate detection; overrides must be
  // part of the edit fingerprint to avoid losing changes during async uploads.
  return JSON.stringify([statementSignature(s),s.rows.map(r=>[r.id,r.merchantOverride??null])]);
}
function hasUnsavedChanges(s: ParsedStatement): boolean {
  return !savedIds.has(s) || dirty.has(s) || savedFingerprints.get(s) !== statementWorkingFingerprint(s);
}
function markDirty(s: ParsedStatement): void {
  // Editing only changes the in-memory draft. OneDrive writes require Save.
  dirty.add(s);
  render();
}
/** Do not replace the editor DOM on input blur: the following click must reach its button. */
function markManagerInlineDirty(s: ParsedStatement): void {
  dirty.add(s);
  if ($('manage-view').classList.contains('hidden') || active() !== s) return;
  updateManagerEditState(s);
}
function dateDisplay(value: string | null | undefined): string { return value ? value.replace(/-/g, '/') : '未取得'; }
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}
function downloadFile(bytes: BlobPart, mime: string, filename: string): void {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function setBadgeState(className: string, text: string): void {
  const detailBadge = $('detail-status-pill');
  detailBadge.className = className;
  detailBadge.textContent = text;
}
function balanced(s: ParsedStatement): boolean { return s.rows.length > 0 && s.statedTotal !== null && s.statedTotal === calculatedTotal(s); }
function issues(s: ParsedStatement): string[] {
  const errors = importErrors(s, pendingSources.has(s) || originalSaved.has(s));
  const idx = statements.indexOf(s);
  if (idx >= 0 && duplicateMonths(statements).has(idx)) errors.push('同じカード・請求月が重複しています');
  return errors;
}
/** Expected Rakuten/Vpass card choices are not red errors; saving still requires a valid card. */
function displayIssues(s: ParsedStatement): string[] {
  const errors = importDisplayErrors(s, pendingSources.has(s) || originalSaved.has(s));
  const idx = statements.indexOf(s);
  if (idx >= 0 && duplicateMonths(statements).has(idx)) errors.push('同じカード・請求月が重複しています');
  return errors;
}
function needsReview(s: ParsedStatement): boolean { return issues(s).length > 0; }
function pending(): ParsedStatement[] { return statements.filter(hasUnsavedChanges); }
function importQueue(): ParsedStatement[] { return statements.filter(s => importStaged.has(s)); }
function importActive(): ParsedStatement | undefined {
  const statement = active();
  return statement && importStaged.has(statement) ? statement : undefined;
}

function toast(text: string): void { simpleActivity(text); }
function operationResult(message: string, kind: 'good' | 'working' | 'bad' | 'warn' = 'good'): void {
  if (kind === 'good') lastSavedAt = new Date().toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  showActivity(message,kind);
}
function sessionStorageSafe(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}
/** One-time cleanup of the obsolete raw AES key. Never read or restore it. */
function purgeLegacyTabKey():void {
  const store=sessionStorageSafe();
  if(store)try{store.removeItem('finance-vault-tab-key-v1');}
  catch{/* Private browsing may disable sessionStorage. No key is ever consumed. */}
}
function clientIdForTab(): string { return $<HTMLInputElement>('cloud-client-id').value.trim(); }
function localStorageSafe():Storage|null {try{return window.localStorage;}catch{return null;}}
function browserKeyContext():BrowserKeyContext|null {
  const homeAccountId=activeMicrosoftAccountId();
  if(!homeAccountId)return null;
  const current={clientId:clientIdForTab(),homeAccountId};
  // Never bind a key to a newly selected account while the vault client still
  // belongs to its prior MSAL login.
  if(liveVault&&liveVaultRememberContext&&
      (liveVaultRememberContext.clientId!==current.clientId||liveVaultRememberContext.homeAccountId!==current.homeAccountId))return null;
  return current;
}
/** Current tab remains unlocked when notifying other tabs of a completed rotation. */
function broadcastVaultLock():void {
  const storage=localStorageSafe();
  if(!storage)throw new Error('他のタブへロックを通知できません。ブラウザのサイトデータ設定を確認してください。');
  setManualLock(storage);
  notifyOtherFinanceTabs(storage);
}
/** Force-close sensitive views on a lock from this tab or another one. */
function clearUnlockedFinanceViews():void {
  lockSequence++;
  activeAnalysisDrilldown=null;drilldownRows.clear();liveVault?.lock();
  if(currentModal!==null)modalClose(false);
  resetRuleEditor();categoryDraft=null;categoryBaseline=[];
  const categoriesDialog=document.getElementById('categories-dialog') as HTMLDialogElement|null;
  if(categoriesDialog?.open)categoriesDialog.close();
  summaryUi?.reset();futureUi?.reset();homeUi?.reset();analysisUi?.reset();reportsUi?.reset();subscriptionsUi?.reset();
  statements.splice(0);failedImports.splice(0);activeIndex=-1;
  render();renderRules();assetsUi?.reset();cardSettingsUi?.reset();updateCloudStatus();
  void updateBrowserRememberStatus();
}
function resumeManualAutoUnlock():void {
  const storage=localStorageSafe();
  if(storage)try{clearManualLock(storage);}catch{/* This is a preference, not a vault write. */}
}
async function updateBrowserRememberStatus():Promise<void> {
  const status=$('cloud-remember-status');
  const register=$<HTMLButtonElement>('cloud-remember-register');
  const forget=$<HTMLButtonElement>('cloud-remember-forget');
  const context=browserKeyContext();
  // Show only the action that is meaningful right now, never two disabled controls.
  register.classList.add('hidden');register.disabled=true;
  forget.classList.add('hidden');forget.disabled=true;
  if(!context){status.textContent='Microsoftアカウントに接続すると状態を確認できます。';return;}
  try {
    const remembered=await isBrowserRemembered(context);
    const local=localStorageSafe();
    const locked=!local||isManuallyLocked(local);
    if(remembered){
      status.textContent=locked
        ? '記憶済み・手動ロック中。次回も自動解除するには、解除時に「このブラウザを記憶する」を選んでください。'
        : '記憶済み。次回からパスフレーズを入力せずに開けます。';
      forget.classList.remove('hidden');forget.disabled=false;
    }else if(liveVault?.unlocked&&!liveVault.isRotating){
      status.textContent='未設定。次回はパスフレーズの入力が必要です。';
      register.classList.remove('hidden');register.disabled=false;
    }else{
      status.textContent='未設定。保管庫の解除時に「このブラウザを記憶する」を選べます。';
    }
  }catch(error){
    status.textContent=error instanceof InvalidRememberedBrowserKeyError
      ? '記憶情報が壊れています。「記憶を解除」してから登録し直してください。'
      : '記憶状態を確認できません。通常のパスフレーズ解除は利用できます。';
    // Allow explicitly clearing a broken key; never silently destroy one.
    forget.classList.remove('hidden');forget.disabled=false;
  }
}

function div(className: string, content?: string): HTMLDivElement {
  const node = document.createElement('div'); node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

/** Shared statement card for the import screen and the management screen. */
function createStatementEntry(index: number, withDelete: boolean): HTMLElement {
  const statement = statements[index]!;
  const state = displayIssues(statement).length ? 'review' : cardSelectionPending(statement) ? 'selection' : statement.confirmation === 'provisional' ? 'provisional' : 'verified';
  const entry = div(`statement-entry${withDelete ? ' has-delete' : ''}`);
  const item = document.createElement('button');
  item.type = 'button';
  item.className = `statement-card ${state}${index === activeIndex ? ' selected' : ''}`;
  item.setAttribute('aria-pressed', String(index === activeIndex));
  const left = div('statement-main');
  const name = cardDisplayName(statement.cardId) ?? `${providerLabel(statement.provider)}（カード確認）`;
  const title = document.createElement('b'); title.textContent = name;
  const subtitle = document.createElement('small');
  subtitle.textContent = `${statement.billingMonth?.replace('-', '/') ?? '請求月不明'} · ${statement.sourceKind==='pdf'?canonicalStatementFilename(statement):statement.sourceName}`;
  const right = div('statement-end');
  const amount = document.createElement('strong'); amount.textContent = yen(statement.statedTotal);
  const flag = document.createElement('span'); flag.className = `statement-flag ${state}`;
  flag.textContent = statement.sourceKind==='csv'&&!statement.paymentDate ? '引落日未設定' : state === 'review' ? '要確認' : state === 'selection' ? 'カード選択待ち' : state === 'provisional' ? '暫定明細' : '照合OK';
  // Save state is shown in the batch action / management status, not on every list row.
  right.append(amount, flag);
  left.append(title, subtitle);
  item.append(left, right);
  item.addEventListener('click', () => { activeIndex = index; render(); });
  entry.append(item);
  if (withDelete) {
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'statement-remove';
    remove.title = '取込待ちの一覧から除外';
    remove.setAttribute('aria-label', `${name} ${statement.billingMonth ?? ''}の取込下書きを除外`);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width:'16', height:'16', fill:'none', stroke:'currentColor', 'stroke-width':'1.8', 'stroke-linecap':'round', 'stroke-linejoin':'round' })) icon.setAttribute(key, value);
    for (const d of ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14', 'M10 10v7', 'M14 10v7']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d); icon.append(path);
    }
    remove.append(icon);
    remove.disabled = batchBusy;
    remove.addEventListener('click', () => {
      if (withDelete) discardImportDraft(index);
      else void deleteStatement(index);
    });
    entry.append(remove);
  }
  return entry;
}

/** The same uploader DOM is used inline on first visit and inside the modal later. */
function updateImportUploadFeedback():void {
  const node=$('import-upload-feedback');
  const messages=[...currentUploadFailures, ...(importUploadFeedback?[importUploadFeedback]:[])];
  node.textContent=messages.join('\n');
  node.classList.toggle('hidden',messages.length===0);
  $('import-clear-errors').classList.toggle('hidden',currentUploadFailures.length===0);
}
function openImportAddDialog():void {
  if(filesBusy||revisionBusy||batchBusy)return;
  if(!$('import-view').classList.contains('import-compact'))return;
  const dialog=$<HTMLDialogElement>('import-add-dialog');
  if(dialog.open||document.querySelector('dialog[open]'))return;
  // Opening an uploader is a new attempt. Previous parsing failures remain
  // visible in the pending list, but are not errors with this new operation.
  currentUploadFailures.splice(0);
  importUploadFeedback='';
  updateImportUploadFeedback();
  $('import-dialog-content').append($('import-upload-panel'));
  dialog.showModal();
  $('dropzone').focus();
}
function closeImportAddDialog():void {
  const dialog=$<HTMLDialogElement>('import-add-dialog');
  if(dialog.open)dialog.close();
  // Return the single uploader synchronously; do not leave a queued close
  // event able to empty a dialog that the user has already reopened.
  releaseImportAddDialog();
}
function releaseImportAddDialog():void {
  $('import-inline-entry').append($('import-upload-panel'));
  $<HTMLTextAreaElement>('paste-input').value='';
  $<HTMLInputElement>('file-input').value='';
  $<HTMLDetailsElement>('paste-pane').open=false;
  clipboardHtml='';
  importUploadFeedback='';
  currentUploadFailures.splice(0);
  updateImportUploadFeedback();
}
function buildStatementList(): void {
  // Every new browser session starts with the inline uploader, even if cloud
  // statements already exist. After the first successful import in this session,
  // additional files use the small header action and modal.
  // Failed-only imports keep the inline uploader available for immediate retry.
  const hasDrafts=importQueue().length>0;
  const compact=hasDrafts||hasImportedInThisSession;
  $('import-view').classList.toggle('has-import-drafts',hasDrafts);
  $('import-view').classList.toggle('import-compact',compact);
  $('import-inline-entry').classList.toggle('hidden',compact);
  $('import-add-open').classList.toggle('hidden',!compact);
  $('import-compact-empty').classList.toggle('hidden',!compact||hasDrafts);
  $('import-compact-empty').textContent=failedImports.length
    ? '解析に失敗したファイルが残っています。取込待ち一覧から確認できます。'
    : '取込待ちの明細はありません。';
  updateImportUploadFeedback();
  list.closest('.statement-index-panel')?.classList.toggle('is-empty', !importQueue().length && !failedImports.length);
  $('list-count').textContent = `${importQueue().length + failedImports.length}件`;
  list.replaceChildren();
  if (!importQueue().length && !failedImports.length) { list.append(div('empty-list', '取込待ちの明細はありません。PDFまたはWeb明細を追加してください。')); return; }
  for (const [index, message] of failedImports.entries()) {
    const entry = div('statement-entry failed-entry');
    const card = div('statement-card review', `解析失敗 · ${message}`);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'statement-remove'; remove.textContent = '×';
    remove.title = '失敗した項目を一覧から除外'; remove.setAttribute('aria-label','失敗した取込を除外');
    remove.addEventListener('click', () => {
      failedImports.splice(index, 1);
      const currentIndex=currentUploadFailures.indexOf(message);
      if(currentIndex>=0)currentUploadFailures.splice(currentIndex,1);
      render();
    });
    entry.append(card, remove); list.append(entry);
  }
  for (const index of prioritizedIndices(statements, s => needsReview(s) ? 0 : s.confirmation === 'provisional' ? 1 : 2)) {
    if (importStaged.has(statements[index]!)) list.append(createStatementEntry(index, true));
  }
}

/** Discard a pending import, never delete its already-stored cloud version. */
function discardImportDraft(index: number, announce = true): void {
  const draft = statements[index];
  if (!draft || !importStaged.has(draft)) return;
  const storedId = savedIds.get(draft);
  const canonical = storedId ? liveVault?.records().find(record => record.id === storedId) : undefined;
  importStaged.delete(draft);
  if (canonical) {
    const restored = structuredClone(canonical.statement);
    savedIds.set(restored, canonical.id);
    if (canonical.originalId) originalSaved.add(restored);
    savedFingerprints.set(restored, statementWorkingFingerprint(restored));
    importedSignatures.set(restored, statementSignature(restored));
    statements.splice(index, 1, restored);
  } else {
    statements.splice(index, 1);
    if (activeIndex === index) activeIndex = -1;
    else if (activeIndex > index) activeIndex--;
  }
  if (announce) {
    render();
    toast('取込待ちの下書きを破棄しました。OneDriveの保存済み明細は変更していません。');
  }
}

async function deleteStatement(index: number): Promise<void> {
  if (batchBusy || filesBusy) return;
  const statement = statements[index];
  if (!statement) return;
  const name = cardDisplayName(statement.cardId) ?? providerLabel(statement.provider);
  const storedId = savedIds.get(statement);
  const message = `${name}（${statement.billingMonth ?? '請求月不明'}）の明細を削除しますか？` +
    (storedId ? '\nOneDriveの解析済み明細を削除します。' +
      (statement.sourceKind === 'pdf' ? '\n暗号化PDF原本はOneDriveに保持されます。' : '') +
      '\n解析済み明細の削除を元に戻すことはできません。' : '\n未保存の解析結果を破棄します。');
  // Stored records always require confirmation, even when validation currently fails.
  // Only unreviewable, never-saved import drafts may be discarded in one click.
  const mustConfirm = !!storedId || !needsReview(statement);
  if (mustConfirm && !window.confirm(message)) return;
  batchBusy = true;
  operationResult(storedId ? `${name}の明細をOneDriveから削除中…` : `${name}の下書きを破棄しています…`, 'working');
  render();
  try {
    if (storedId) {
      if (!liveVault?.unlocked) throw new Error('OneDrive保管庫を解除してください。');
      await liveVault.delete(storedId);
    }
    const mutationWarning=storedId?liveVault?.takeMutationWarning():null;
    const current = statements.indexOf(statement);
    if (current < 0) return;
    statements.splice(current, 1);
    if (!statements.length) activeIndex = -1;
    else if (activeIndex === current) activeIndex = Math.min(current, statements.length - 1);
    else if (current < activeIndex) activeIndex--;
    if (!$('manage-view').classList.contains('hidden')) selectVisibleManagerStatement();
    if (storedId && !pending().length) replaceCloudRecords(liveVault!.records());
    updateCloudStatus();
    const result = storedId ? `${name}の明細をOneDriveから削除しました。` : `${name}の未保存下書きを破棄しました。`;
    operationResult(mutationWarning??result,mutationWarning?'warn':'good');
    toast(mutationWarning??result);
  } catch (error) {
    const unknown=error instanceof CloudWriteUncertainError;
    const result = `${unknown?'削除結果を確認できません':'削除できませんでした'}：${error instanceof Error ? error.message : '不明なエラー'}`;
    operationResult(result,unknown?'warn':'bad');toast(result);
  } finally {
    batchBusy = false;
    render();
  }
}

function providerLabel(provider: ParsedStatement['provider']): string {
  return ({ jcb:'JCB', rakuten:'楽天カード', view:'ビューカード', smbc:'三井住友カード系', goldpoint:'GOLD POINT CARD+', unknown:'不明な発行会社' })[provider];
}

function renderCardOptions(s: ParsedStatement): void {
  const cardSelect = $<HTMLSelectElement>('manage-card');
  cardSelect.replaceChildren();
  const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'カードを選択してください'; cardSelect.append(blank);
  const candidates = CARDS.filter(card => s.provider === 'unknown' || card.provider === s.provider);
  for (const card of candidates) {
    const option = document.createElement('option'); option.value = card.id; option.textContent = cardDisplayName(card.id)??card.name; cardSelect.append(option);
  }
  cardSelect.value = s.cardId ?? '';
}

function notice(message: string, state: 'good' | 'warn' | 'bad' | 'info'): HTMLElement {
  const el = div(`notice ${state}`); el.textContent = message; return el;
}

function renderSummary(): void {
  const s = importActive();
  if (!s) {
    previewEmpty.classList.remove('hidden'); previewContent.classList.add('hidden');
    setBadgeState('pill neutral', '待機中');
    return;
  }
  previewEmpty.classList.add('hidden'); previewContent.classList.remove('hidden');
  $('card-display').textContent = cardDisplayName(s.cardId) ?? 'カード未確定';
  $('card-display').classList.toggle('hidden',s.provider==='rakuten'||s.provider==='smbc'&&s.sourceKind!=='csv');
  const rakutenChoice=$('import-rakuten-choice');
  rakutenChoice.classList.toggle('hidden',s.provider!=='rakuten');
  const smbcChoice=$('import-smbc-choice');
  smbcChoice.classList.toggle('hidden',s.provider!=='smbc'||s.sourceKind==='csv');
  for(const choice of [rakutenChoice,smbcChoice]){
    for(const radio of choice.querySelectorAll<HTMLInputElement>('input[type=radio]')){
      radio.checked=radio.value===s.cardId;
      radio.disabled=batchBusy||revisionBusy;
    }
  }
  $('detail-month').textContent = s.billingMonth ? `${s.billingMonth.slice(0, 4)}年${Number(s.billingMonth.slice(5))}月` : '未取得';
  $('detail-date').textContent = s.sourceKind==='csv'&&!s.paymentDate?'未設定':dateDisplay(s.paymentDate);
  $('detail-count').textContent = `${s.rows.length}件`;
  $('amount-stated').textContent = yen(s.statedTotal);
  $('amount-calculated').textContent = yen(calculatedTotal(s));
  const diff = s.statedTotal === null ? null : s.statedTotal - calculatedTotal(s);
  $('amount-diff').textContent = yen(diff);
  $('amount-diff').classList.toggle('negative', diff !== null && diff !== 0);
  const validationIssues=displayIssues(s);
  if (s.sourceKind==='csv'&&!s.paymentDate) setBadgeState('pill warn', '引落日未設定');
  else if (validationIssues.length) setBadgeState('pill bad', '要確認');
  else if (cardSelectionPending(s)) setBadgeState('pill info', 'カード選択待ち');
  else if (s.confirmation === 'provisional') setBadgeState('pill info', '暫定明細・照合OK');
  else setBadgeState('pill good', '照合OK');
  $('verification-ok').classList.toggle('hidden', !balanced(s));
  const notices = $('notice-list'); notices.replaceChildren();
  if (!balanced(s) && s.rows.length && s.statedTotal !== null) notices.append(notice(`差額が${yen(diff)}あります。金額や未抽出の行を確認してください。`, 'bad'));
  if (s.confirmation === 'provisional') notices.append(notice('請求確定前の明細です。確定後に請求額が変わる場合があります。', 'info'));
  for (const error of validationIssues) {
    if(s.sourceKind==='csv'&&!s.paymentDate&&error==='支払日が不明または不正です')continue;
    notices.append(notice(error, 'bad'));
  }
  const fixedWarnings = s.warnings.filter(w => !/請求金額と明細合計に差額|対象カードを選択|カードの種類を特定/.test(w));
  for (const w of fixedWarnings) notices.append(notice(w, validationIssues.length ? 'bad' : 'warn'));
}

function makeInput(value: string, className: string, update: (value: string, input: HTMLInputElement) => void, ariaLabel: string): HTMLInputElement {
  const input = document.createElement('input');
  // Use the OS date picker for dates, and the phone's number keypad for money.
  // Amounts stay text to preserve signed refunds and comma-separated values.
  input.type = ariaLabel === '利用日' ? 'date' : 'text';
  input.value = input.type === 'date' ? value.replace(/\//g, '-') : value;
  if (ariaLabel === '金額') input.inputMode = 'numeric';
  input.className = className; input.setAttribute('aria-label', ariaLabel);
  input.addEventListener('change', () => update(input.value, input));
  return input;
}

/** Bind permanent cloud actions once; rendering must never add event handlers. */
function initCloudActionControls(): void {
  const connectionDialog=$<HTMLDialogElement>('cloud-connect-dialog');
  $('cloud-connect-later').addEventListener('click',()=>{
    cloudConnectDismissed=true;
    connectionDialog.close();
  });
  connectionDialog.addEventListener('cancel',()=>{cloudConnectDismissed=true;});
  $('cloud-connect-continue').addEventListener('click',()=>{
    const mode=connectionDialog.dataset.mode;
    cloudConnectDismissed=true;
    connectionDialog.close();
    if(mode==='setup'){
      showView('settings');
      $<HTMLDetailsElement>('cloud-advanced').open=true;
      $<HTMLInputElement>('cloud-client-id').focus();
      return;
    }
    $<HTMLButtonElement>('cloud-login').click();
  });
  $('cloud-resume-batch').addEventListener('click',()=>{void (async()=>{
    if(!liveVault?.unlocked||!liveVault.hasPendingYearBatch||batchBusy||filesBusy)return;
    const list=liveVault.pendingYearBatchEntries();
    const fingerprint=(s:ParsedStatement)=>JSON.stringify(s);
    if(list.some(item=>statements.some(s=>{
      const id=savedIds.get(s)??pendingCloudIds.get(s);
      return id===item.id&&fingerprint(s)!==fingerprint(item.statement);
    }))){
      operationResult('編集中の明細があります。変更を確認してから保存してください。','warn');return;
    }
    batchBusy=true;updateCloudStatus();render();
    try {
      await liveVault.resumePendingYearBatch();
      const records=liveVault.records();
      for(const s of statements){
        const id=savedIds.get(s)??pendingCloudIds.get(s);
        if(!id||!list.some(item=>item.id===id))continue;
        const stored=records.find(r=>r.id===id);
        if(!stored||fingerprint(stored.statement)!==fingerprint(s))continue;
        savedIds.set(s,id);savedFingerprints.set(s,statementWorkingFingerprint(s));
        dirty.delete(s);importStaged.delete(s);pendingSources.delete(s);
        if(stored.originalId)originalSaved.add(s);
      }
      if(!pending().length)replaceCloudRecords(records);
      renderRules();assetsUi?.render();futureUi?.render();cardSettingsUi?.render();
      operationResult('保存を完了しました。','good');
    }catch(error){
      operationResult(error instanceof Error?error.message:'保存を再開できませんでした。','warn');
    }finally {batchBusy=false;updateCloudStatus();render();}
  })();});
}

function renderSortControls(): void {
  for (const [key, id] of [['usedOn', 'sort-date'], ['amount', 'sort-amount']] as const) {
    const button = $<HTMLButtonElement>(id);
    const direction = previewSort?.key === key ? previewSort.direction : null;
    button.querySelector('.sort-arrow')!.textContent = direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : '↕';
    button.classList.toggle('active', direction !== null);
    button.setAttribute('aria-label', `${key === 'usedOn' ? '利用日' : '当月請求額'}を${direction === 'asc' ? '降順' : '昇順'}に並べ替え`);
    button.title = direction === 'asc' ? '昇順（クリックで降順）' : direction === 'desc' ? '降順（クリックで昇順）' : 'クリックで昇順';
    button.closest('th')!.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none');
  }
}

function renderRows(): void {
  const s = importActive(); rowBody.replaceChildren();
  renderSortControls();
  if (!s) return;
  if (!s.rows.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 4; td.textContent = '取引がありません。明細の管理から修正するか、読み直してください。';
    tr.append(td); rowBody.append(tr); return;
  }
  for (const row of orderedPreviewRows(s.rows, previewSort)) {
    const tr = document.createElement('tr');
    for (const value of [dateDisplay(row.usedOn), merchantFor(row,s), row.amount.toLocaleString('ja-JP'), row.description || '—']) {
      const td = document.createElement('td'); td.textContent = value; td.title = value; tr.append(td);
    }
    // Keep the category badge beside the merchant instead of adding a second line.
    // Each import-preview row must have one consistent height, regardless of category.
    const merchantCell=tr.children[1] as HTMLTableCellElement;
    merchantCell.title = row.merchant !== merchantFor(row,s) ? `元の利用先：${row.merchant}` : row.merchant;
    const merchantContent=div('preview-merchant-content');
    const merchantName=div('preview-merchant-name');
    merchantName.textContent=merchantFor(row,s);
    merchantContent.append(merchantName);
    const meta=categoryFor(row,s);
    if(meta){merchantCell.classList.add('preview-merchant-cell');merchantContent.append(categoryChip(meta));}
    merchantCell.replaceChildren(merchantContent);
    tr.children[2]!.classList.add('amount-cell');
    tr.children[3]!.classList.add('note');
    rowBody.append(tr);
  }
}

function updateBatchStatus(): void {
  const drafts = importQueue().filter(hasUnsavedChanges);
  const blocked = importQueue().filter(s => issues(s).length > 0);
  const selectionOnly = blocked.filter(s => cardSelectionPending(s) && displayIssues(s).length === 0);
  const errors = blocked.filter(s => displayIssues(s).length > 0);
  const errorCount = blocked.length + failedImports.length;
  const button = $<HTMLButtonElement>('batch-import');
  const missingPaymentCards=cardsMissingCsvPayment();
  const paymentAction=$<HTMLButtonElement>('import-payment-settings');
  paymentAction.classList.toggle('hidden',missingPaymentCards.length===0);
  button.disabled = !drafts.length || errorCount > 0 || batchBusy || filesBusy || revisionBusy;
  $('clear-all').classList.toggle('hidden', importQueue().length + failedImports.length === 0);
  button.textContent = batchBusy ? 'OneDriveに保存中…' : drafts.length ? `明細 ${drafts.length}件を一括取り込む` : '明細を一括取り込む';
  const otherErrors=errors.filter(s=>!(s.sourceKind==='csv'&&!s.paymentDate&&issues(s).every(e=>e==='支払日が不明または不正です'))).length+failedImports.length;
  $('batch-status').textContent = otherErrors
    ? `${otherErrors}件に不備があります`
    : missingPaymentCards.length ? `${missingPaymentCards.length}枚のカードの引落日が未設定`
      : selectionOnly.length ? `${selectionOnly.length}件のカード選択待ち`
        : errorCount ? `${errorCount}件に不備があります`
          : drafts.length ? `${drafts.length}件をまとめて取り込み` : '取込対象はありません';
  $('batch-description').textContent = otherErrors ? '不備がある明細は保存できません。' : '';
}

/** One adapter supplies the state and actions; every gated page uses the same UI. */
function syncCloudGate():void {
  const notice=cloudConnectionNotice();
  syncFinanceCloudGates({
    blocked:!liveVault?.unlocked,
    locked:!!liveVault?.exists&&vaultDiscoveryCompleted&&notice.kind==='connected',
    checking:cloudStartupRunning||notice.kind==='checking',
    notice,
    onRetry:()=>{$<HTMLButtonElement>('cloud-login').click();},
    onReauthenticate:()=>{$<HTMLButtonElement>('cloud-reauth').click();},
    onUnlock:()=>{void askVault('unlock');},
    onSettings:()=>showView('settings'),
  });
}

function render(): void {
  // While parsing a batch, preserve draft state but defer expensive full
  // rebuilds until it finishes. Revision confirmation remains interactive.
  if(filesBusy&&!revisionBusy){
    updateImportUploadFeedback();
    return;
  }
  // Imports are expensive DOM work. Navigation back to Import calls render()
  // explicitly, so hidden screens never need to rebuild their draft tables.
  if (!$('import-view').classList.contains('hidden')) {
    applyCsvPaymentSettings();
    refreshCardOptionLabels();
    buildStatementList(); renderSummary(); renderRows(); updateBatchStatus();
  }
  if (!$('manage-view').classList.contains('hidden')) renderManager();
  if (!$('rules-view').classList.contains('hidden')) renderRules();
  if (!$('summary-view').classList.contains('hidden')) summaryUi?.render();
  if (!$('home-view').classList.contains('hidden')) homeUi?.render();
  if (!$('analysis-view').classList.contains('hidden')) analysisUi?.render();
  if (!$('subscriptions-view').classList.contains('hidden')) subscriptionsUi?.render();
  // The report page owns its fetched snapshot; avoid refreshing on unrelated edits.
  if (!$('future-view').classList.contains('hidden')) futureUi?.render();
  syncCloudGate();
}

function attachSource(statement: ParsedStatement, source?: LocalSource): void {
  if (source) pendingSources.set(statement, source);
}

function replaceCloudRecords(records: CloudRecord[]): void {
  // Never discard an unsaved local draft while reloading remote data.
  if (pending().length && statements.length) throw new Error('未保存の編集があるため再読み込みできません。');
  statements.splice(0);
  activeIndex=-1;
  for(const record of records) {
    const statement=record.statement;
    savedIds.set(statement,record.id);
    if(record.originalId) originalSaved.add(statement);
    savedFingerprints.set(statement,statementWorkingFingerprint(statement));
    importedSignatures.set(statement,statementSignature(statement));
    statements.push(statement);
  }
  if(statements.length)activeIndex=0;
  render();
}
function appendCloudRecordsKeepingDrafts(records:CloudRecord[]):void {
  const drafts=statements.filter(hasUnsavedChanges);
  statements.splice(0);
  for(const record of records) {
    const statement=record.statement;
    savedIds.set(statement,record.id);
    if(record.originalId)originalSaved.add(statement);
    savedFingerprints.set(statement,statementWorkingFingerprint(statement));
    importedSignatures.set(statement,statementSignature(statement));
    statements.push(statement);
  }
  for(const draft of drafts) {
    // A committed item is now canonical; only preserve unsaved new/edited drafts.
    if(!statements.some(record=>savedIds.get(record)===savedIds.get(draft)&&savedIds.has(draft))) statements.unshift(draft);
  }
  activeIndex=statements.length?0:-1;
  render();
}
function updateCloudStatus(message?:string):void {
  if(!liveVault?.unlocked)subscriptionsUi?.reset();
  if(!liveVault?.unlocked&&reportsUi){
    reportsUi.reset();
    if(!$('reports-view').classList.contains('hidden'))reportsUi.render();
  }
  const label=$('cloud-live-status');
  const bar=$('cloud-live-bar');
  const state=!liveVault?'未接続':liveVault.unlocked?'接続済み':!vaultDiscoveryCompleted?'確認中':liveVault.exists?'ロック中':'保管庫なし';
  // New vault creation is an explicit action, never a side effect of refresh.
  $('cloud-new-vault').classList.toggle('hidden',!liveVault||!vaultDiscoveryCompleted||liveVault.exists||liveVault.unlocked);
  const connectionIssue=message
    ? /Microsoftアカウントが未接続/.test(message)?'未接続'
      : /再認証/.test(message)?'Microsoftアカウントの再認証が必要'
      : /アクセス権限/.test(message)?'OneDriveへのアクセス権限がありません'
      : /接続してください|失敗|エラー|一時的に/.test(message)?'一時的に接続できない'
      : null
    : null;
  const cloudIssue=cloudConnectionNotice();
  label.textContent=!liveVault?.unlocked&&['network','reauth','restore','mismatch','unknown'].includes(cloudIssue.kind)
    ?cloudIssue.message:connectionIssue??state;
  // Keep the global bar quiet when connected. Only missing access or an error needs attention.
  const failure=message && /失敗|エラー|不備|接続してください|未保存|更新確認/.test(message);
  bar.textContent='';
  if(failure && message) showActivity(message,'bad');
  $('cloud-live-migrate').classList.toggle('hidden',!liveVault);
  $('cloud-resume-batch').classList.toggle('hidden',!liveVault?.hasPendingYearBatch);
  syncCloudGate();
}
/** The values are shown only in a local browser confirmation, never transmitted. */
const collisionLabel:Record<string,string>={
  balance:'残高',observedAt:'残高確認日時',amount:'金額',usedOn:'利用日',merchant:'利用先',description:'補足',
  merchantOverride:'表示名',statedTotal:'請求総額',paymentDate:'引落日',billingMonth:'請求月',
  name:'名称',displayName:'表示名',pattern:'一致文字列',patterns:'一致候補',mode:'一致方法',
  categoryId:'カテゴリー',color:'色',enabled:'有効・無効',status:'状態',priority:'優先順位',
  date:'日付',delete:'削除と編集',cardDebitAccounts:'カード引落口座',
  nisaCardRule:'NISAのカード積立',payrollDepositAccount:'給与の入金先',payrollAutoPassphrase:'給与の自動取得設定',
  birthMonth:'生年月',mizuhoTransferPlan:'みずほ送金予測',
};
function collisionValue(value:unknown):string {
  if(value===undefined||value===null||value==='')return '未設定';
  if(typeof value==='number')return value.toLocaleString('ja-JP');
  if(typeof value==='string')return value.slice(0,75);
  return JSON.stringify(value).slice(0,90);
}
function confirmCloudConflicts(title:string,rows:readonly {label:string;field:string;local:string;remote:string}[]):boolean {
  const details=rows.slice(0,5).map(item=>
    `・${item.label} / ${collisionLabel[item.field]??item.field}\n  この端末：${item.local}\n  OneDrive：${item.remote}`).join('\n');
  const suffix=rows.length>5?`\nほか${rows.length-5}項目`:'',
    info=`${title}（${rows.length}件）\n${details}${suffix}\n\n［OK］この端末の変更を採用して保存\n［キャンセル］保存せずOneDriveの値を保持`;
  return window.confirm(info);
}

let cloudConnectDismissed=false;
function showCloudConnectDialog(mode:CloudConnectPrompt):void {
  if(!mode||cloudConnectDismissed)return;
  const dialog=$<HTMLDialogElement>('cloud-connect-dialog');
  if(dialog.open||document.querySelector('dialog[open]'))return;
  const setup=mode==='setup';
  $('cloud-connect-title').textContent=setup?'OneDriveの設定':mode==='reconnect'?'OneDriveに再接続':'OneDriveに接続';
  $('cloud-connect-copy').textContent=setup?'接続設定を完了してください。':'Microsoftアカウントで接続してください。';
  $('cloud-connect-continue').textContent=setup?'設定を開く':mode==='reconnect'?'再接続':'Microsoftアカウントで接続';
  dialog.dataset.mode=mode;
  dialog.showModal();
  $<HTMLButtonElement>('cloud-connect-continue').focus();
}

async function startCloud():Promise<void> {
  if(cloudStartupRunning||liveVault?.unlocked)return;
  cloudStartupRunning=true;
  const startedWithLockSequence=lockSequence;
  vaultDiscoveryCompleted=false;
  // Connecting is a background task. It must not block navigation or silently redirect.
  $('cloud-live-status').textContent='接続中';
  showActivity('OneDriveに接続中…','working');
  const slowNotice=setTimeout(()=>{
    if(!cloudStartupRunning)return;
    showActivity('OneDriveの接続に時間がかかっています','working');
  },12000);
  try {
    const client=await measureFinancePhase('startup.auth',()=>graphClientWithoutRedirect());
    liveVault=new LiveVault(client);
    const authAccountId=activeMicrosoftAccountId();
    liveVaultRememberContext=authAccountId?{clientId:clientIdForTab(),homeAccountId:authAccountId}:null;
    liveVault.setAssetConflictResolver((collisions,details=[])=>confirmCloudConflicts('資産設定に同時編集があります',
      collisions.map((item,i)=>({label:details[i]?.label??item.itemId,field:item.field,
        local:details[i]?.localValue??'変更あり',remote:details[i]?.remoteValue??'別端末で変更あり'}))));
    liveVault.setStatementConflictResolver(collisions=>confirmCloudConflicts('カード明細に同時編集があります',
      collisions.map(item=>({label:`明細 ${item.recordId.slice(0,12)} / ${item.path.replace(/^record\.statement\./,'')}`,
        field:item.path.split('.').at(-1)??item.path,local:collisionValue(item.local),remote:collisionValue(item.remote)}))));
    liveVault.setRuleConflictResolver(collisions=>confirmCloudConflicts('利用先ルール・カテゴリーに同時編集があります',
      collisions.map(item=>({label:item.ruleId.startsWith('category:')?`カテゴリー ${item.ruleId.slice(9)}`:`利用先ルール ${item.ruleId.slice(0,16)}`,
        field:item.field,local:collisionValue(item.local),remote:collisionValue(item.remote)}))));
    assetsUi?.render();futureUi?.render();cardSettingsUi?.render();
    const exists=await measureFinancePhase('startup.discover',()=>liveVault!.discover());
    vaultDiscoveryCompleted=true;
    finishActivity('OneDrive');
    updateCloudStatus();
    if(exists) {
      const browserContext=browserKeyContext();
      const local=localStorageSafe();
      // Fail closed when the manual-lock preference cannot be inspected.
      const allowAutomatic=!!local&&!isManuallyLocked(local);
      let restored=false;
      if(allowAutomatic&&browserContext){
        try {
          const remembered=await readBrowserKey(browserContext);
          if(remembered){
            await liveVault.unlockBrowserKey(remembered);
            if(lockSequence!==startedWithLockSequence||isManuallyLocked(local!)){liveVault.lock();return;}
            const restoredRecords=liveVault.records();
            appendCloudRecordsKeepingDrafts(restoredRecords);lastCloudCheckAt=Date.now();
            renderRules();assetsUi?.render();futureUi?.render();cardSettingsUi?.render();
            void assetsUi?.refreshPayroll();updateCloudStatus();
            operationResult(`このブラウザの保存鍵で自動復号しました（${restoredRecords.length}件）。`);
            restored=true;
          }
        }catch(error){
          // Only proven generation changes or corrupt local records invalidate a
          // remembered key. Network/auth failures must leave it intact.
          if(error instanceof BrowserKeyGenerationChangedError||error instanceof InvalidRememberedBrowserKeyError){
            try{await forgetBrowserKey(browserContext);}catch{/* Best effort; future attempts still validate the index. */}
          }
          if(error instanceof BrowserKeyGenerationChangedError||error instanceof InvalidRememberedBrowserKeyError)
            operationResult('ブラウザの保存鍵を利用できません。パスフレーズで解除してください。','warn');
          else operationResult('ブラウザの自動解除を確認できません。パスフレーズで解除してください。','warn');
        }
      }
      await updateBrowserRememberStatus();
      if(!restored)await askVault('unlock');
    }
    else {
      updateCloudStatus();
      operationResult('現在のMicrosoftアカウントのアプリ領域にFinance保管庫が見つかりません。既存データを探している場合は、MicrosoftアカウントとClient IDを確認してください。', 'bad');
    }
  } catch(error) {
    finishActivity('OneDrive');
    recordCloudConnectionFailure(error);
    const issue=error instanceof GraphError
      ? error.status===401?'Microsoftアカウントの再認証が必要です。':error.status===403?'OneDriveへのアクセス権限がありません。':
        [429,500,502,503,504].includes(error.status)?'OneDriveに一時的に接続できません。時間をおいて再試行してください。':error.message
      : error instanceof Error?error.message:'接続エラー';
    updateCloudStatus(`OneDriveに接続してください：${issue}`);
    showCloudConnectDialog(cloudConnectPrompt());
  } finally {clearTimeout(slowNotice);cloudStartupRunning=false;syncCloudGate();}
}
async function refreshCloud():Promise<void> {
  assertRefreshSafe();
  if(!liveVault||!vaultDiscoveryCompleted)await startCloud();
  if(!liveVault||!vaultDiscoveryCompleted)throw new Error('Microsoftアカウントの認証と保管庫の確認を完了してください。');
  if(!liveVault.exists)throw new Error('このMicrosoftアカウントのアプリ領域に保管庫がありません。接続先アカウントとClient IDを確認してください。新規作成は実行していません。');
  if(!liveVault.unlocked) {
    if(!await askVault('unlock'))throw new Error('既存保管庫のロック解除をキャンセルしました。');
    return;
  }
  assertRefreshSafe();
  cloudRefreshing=true;
  try {
    const current=liveVault;
    const fresh=await current.refresh();
    // Never overwrite local state if a different vault has been connected.
    if(current!==liveVault||!current.unlocked)throw new Error('更新中に保管庫が変更されました。');
    replaceCloudRecords(fresh);
    renderRules();
    assetsUi?.render();futureUi?.render();
    lastCloudCheckAt=Date.now();
    void assetsUi?.refreshPayroll();
    updateCloudStatus('OneDriveから最新の明細を取得しました。');
  } finally { cloudRefreshing=false; }
}
async function migrateLegacy():Promise<void> {
  if(!liveVault)await startCloud();
  if(!liveVault)throw new Error('OneDriveへの接続が必要です。');
  // IndexedDB is accessed ONLY when the user explicitly requests old-data migration.
  if(!await hasVault())throw new Error('このブラウザには旧IndexedDBの明細がありません。別の端末・URLでは引き継げません。');
  if(liveVault.exists&&!liveVault.unlocked) {
    if(!await askVault('unlock'))return;
  }
  if(!window.confirm('旧IndexedDBの明細とPDFを暗号化してOneDriveへ移行します。旧データは削除しません。すでに移行済みの明細IDは上書きしません。続行しますか？'))return;
  await askVault('migrate');
}

/** This flow never removes legacy IndexedDB automatically or during migration. */
function initLegacyCleanup():void {
  const dialog=$<HTMLDialogElement>('legacy-cleanup-dialog');
  const status=$('legacy-cleanup-status');
  const backupButton=$<HTMLButtonElement>('legacy-cleanup-download');
  const deleteButton=$<HTMLButtonElement>('legacy-cleanup-delete');
  const fileLabel=$('legacy-cleanup-file-label');
  const backupInput=$<HTMLInputElement>('legacy-cleanup-file');
  const secretInput=$<HTMLInputElement>('legacy-cleanup-secret');
  const checkButton=$<HTMLButtonElement>('legacy-cleanup-check');
  let backup:Blob|null=null;
  let verified=false;
  let busy=false;
  const report=(message:string,error=false)=>{
    status.textContent=message;status.classList.toggle('error',error);
  };
  const reset=()=>{
    backup=null;verified=false;deleteButton.disabled=true;
    deleteButton.classList.add('hidden');backupButton.classList.add('hidden');
    fileLabel.classList.add('hidden');backupInput.value='';secretInput.value='';report('');
  };
  const assertSafe=()=>{
    if(!liveVault?.unlocked||!vaultDiscoveryCompleted)
      throw new Error('OneDrive保管庫を解除してからお試しください。');
    assertRefreshSafe();
  };
  const compare=async()=>{
    assertSafe();
    const old=await readStatements();
    const cloud=await liveVault!.refresh();
    return verifyLegacyMigration(old,cloud,
      async id=>(await readOriginal(id))?.bytes??null,
      id=>liveVault!.original(id));
  };
  $('cloud-legacy-cleanup').addEventListener('click',()=>{
    reset();dialog.showModal();
  });
  $('legacy-cleanup-close').addEventListener('click',()=>{if(!busy)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{lockVault();reset();});
  const execute=async(work:()=>Promise<void>)=>{
    if(busy)return;
    busy=true;checkButton.disabled=true;backupButton.disabled=true;deleteButton.disabled=true;
    try{await work();}
    catch(error){report(error instanceof Error?error.message:'確認に失敗しました。',true);verified=false;deleteButton.disabled=true;}
    finally{busy=false;checkButton.disabled=false;backupButton.disabled=false;deleteButton.disabled=!verified;}
  };
  checkButton.addEventListener('click',()=>{void execute(async()=>{
    backup=null;verified=false;backupButton.classList.add('hidden');fileLabel.classList.add('hidden');deleteButton.classList.add('hidden');
    if(!await hasVault())throw new Error('この端末に旧データはありません。');
    if(!secretInput.value)throw new Error('旧パスフレーズを入力してください。');
    await unlockVault(secretInput.value);secretInput.value='';
    const result=await compare();
    backup=await exportEncryptedBackup();
    report(`${result.statementCount}件の明細とPDF原本${result.sourceCount}件を照合しました。`);
    backupButton.classList.remove('hidden');fileLabel.classList.remove('hidden');
  });});
  backupButton.addEventListener('click',()=>{
    if(!backup)return;
    const url=URL.createObjectURL(backup);
    const a=document.createElement('a');a.href=url;a.download=`finance-legacy-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000);
  });
  backupInput.addEventListener('change',()=>{void execute(async()=>{
    verified=false;
    if(!backup||!backupInput.files?.[0])throw new Error('バックアップファイルを選択してください。');
    if(!await verifyDownloadedBackup(backup,backupInput.files[0]))throw new Error('保存したバックアップと一致しません。');
    verified=true;report('バックアップを確認しました。');deleteButton.classList.remove('hidden');
  });});
  deleteButton.addEventListener('click',()=>{void execute(async()=>{
    if(!verified||!backup)throw new Error('バックアップの確認が必要です。');
    // Refresh and compare once more immediately before deletion.
    await compare();
    // An old tab may have updated IndexedDB after the download. Never delete
    // records unless the selected backup still covers the exact latest ciphertext.
    const exported=JSON.parse(await backup.text()) as Record<string,unknown>;
    const current=JSON.parse(await (await exportEncryptedBackup()).text()) as Record<string,unknown>;
    delete exported.createdAt;delete current.createdAt;
    if(JSON.stringify(exported)!==JSON.stringify(current))
      throw new Error('旧データが更新されています。もう一度照合とバックアップを行ってください。');
    if(!window.confirm('この端末の旧データを削除します。よろしいですか？'))return;
    await deleteLegacyVault();
    verified=false;backup=null;dialog.close();
    toast('旧データを削除しました。');
  });});
}

/** Temporary hover expansion never changes the saved collapsed preference. */
let desktopMenuPeekTimer:number|null=null;
let desktopMenuCloseTimer:number|null=null;
let desktopMenuResetTimer:number|null=null;
/**
 * A hover-open sidebar can synthesize pointerenter/pointerleave when its
 * overlay closes. After navigation, suppress peek until the pointer *moves*
 * beyond the original 244px-wide drawer region. Never clear this guard from
 * pointerleave: a layout change can trigger it without physical mouse motion.
 */
let desktopMenuNavigationHoverBlock:{left:number;top:number;right:number;bottom:number}|null=null;
function blockDesktopMenuHoverUntilExit(sidebar:HTMLElement):void {
  const shell=document.querySelector('.app-shell');
  if(!shell?.classList.contains('nav-collapsed')||!shell.classList.contains('nav-peeking'))return;
  const bounds=sidebar.getBoundingClientRect();
  const expandedWidth=244; // Explicit CSS drawer width; never use the shrinking rail width.
  desktopMenuNavigationHoverBlock={
    left:Math.min(0,bounds.left),top:0,
    right:Math.max(expandedWidth,bounds.right),bottom:window.innerHeight,
  };
  // There may already be a pending dwell timer from an earlier pointerenter.
  if(desktopMenuPeekTimer!==null){window.clearTimeout(desktopMenuPeekTimer);desktopMenuPeekTimer=null;}
  hideSidebarTooltip();
}
function releaseDesktopMenuHoverOnMove(x:number,y:number):void {
  const bounds=desktopMenuNavigationHoverBlock;
  if(bounds&&(x<bounds.left||x>=bounds.right||y<bounds.top||y>=bounds.bottom))
    desktopMenuNavigationHoverBlock=null;
}
function hideSidebarTooltip():void {
  const tip=document.getElementById('sidebar-tooltip');
  if(tip)tip.hidden=true;
}
function clearDesktopMenuPeek(preserveManualTransition=false):void {
  hideSidebarTooltip();
  if(desktopMenuPeekTimer!==null){window.clearTimeout(desktopMenuPeekTimer);desktopMenuPeekTimer=null;}
  if(desktopMenuCloseTimer!==null){window.clearTimeout(desktopMenuCloseTimer);desktopMenuCloseTimer=null;}
  const shell=document.querySelector('.app-shell');
  const wasPeeking=shell?.classList.contains('nav-peeking')??false;
  if(desktopMenuResetTimer!==null){window.clearTimeout(desktopMenuResetTimer);desktopMenuResetTimer=null;}
  // Hover-only teardown must not animate the 244px overlay into its 72px slot.
  // The explicit pin/unpin button, however, needs its own transition, even
  // when it was clicked during the hover preview or its short reset window.
  if(wasPeeking&&!preserveManualTransition)shell?.classList.add('nav-peek-resetting');
  else shell?.classList.remove('nav-peek-resetting');
  shell?.classList.remove('nav-peeking','nav-peek-closing');
  // Prevent the 244px overlay from tweening back into the 72px flex slot.
  // Normal button-initiated width transitions remain unchanged.
  if(wasPeeking&&!preserveManualTransition)desktopMenuResetTimer=window.setTimeout(()=>{
    shell?.classList.remove('nav-peek-resetting');desktopMenuResetTimer=null;
  },40);
}
/** Hover-only closing animation: preserve the rail until the drawer has retracted. */
function closeDesktopMenuPeek():void {
  hideSidebarTooltip();
  if(desktopMenuPeekTimer!==null){window.clearTimeout(desktopMenuPeekTimer);desktopMenuPeekTimer=null;}
  const shell=document.querySelector('.app-shell');
  if(!shell?.classList.contains('nav-peeking')||window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    clearDesktopMenuPeek();return;
  }
  if(desktopMenuCloseTimer!==null)window.clearTimeout(desktopMenuCloseTimer);
  shell.classList.add('nav-peek-closing');
  desktopMenuCloseTimer=window.setTimeout(clearDesktopMenuPeek,190);
}

/** Desktop compact sidebar preference contains no financial data. */
function setDesktopMenuCollapsed(collapsed:boolean):void {
  // A deliberate pin/unpin cancels any post-navigation hover suppression.
  desktopMenuNavigationHoverBlock=null;
  // Keep the manual animation active when pinning an already-hovered menu.
  clearDesktopMenuPeek(true);
  const shell=document.querySelector('.app-shell');
  const button=document.getElementById('sidebar-collapse-toggle');
  shell?.classList.toggle('nav-collapsed',collapsed);
  hideSidebarTooltip();
  if(button){
    button.setAttribute('aria-expanded',String(!collapsed));
    button.setAttribute('aria-label',collapsed?'メニューを固定表示する':'メニューを折りたたむ');
    button.title=collapsed?'メニューを固定表示する':'メニューを折りたたむ';
    const label=document.getElementById('sidebar-collapse-label');
    if(label)label.textContent=collapsed?'固定表示':'折りたたむ';
  }
  try{window.localStorage.setItem('finance-sidebar-collapsed',collapsed?'1':'0');}catch{/* storage disabled */}
}
/** Only mouse hover, and only after a deliberate dwell, temporarily expands the menu. */
function scheduleDesktopMenuPeek():void {
  const shell=document.querySelector('.app-shell');
  if(desktopMenuNavigationHoverBlock||!shell?.classList.contains('nav-collapsed')||window.matchMedia('(max-width: 800px)').matches)return;
  if(shell.classList.contains('nav-peek-closing')){
    if(desktopMenuCloseTimer!==null){window.clearTimeout(desktopMenuCloseTimer);desktopMenuCloseTimer=null;}
    shell.classList.remove('nav-peek-closing');
    return;
  }
  if(desktopMenuPeekTimer!==null)window.clearTimeout(desktopMenuPeekTimer);
  desktopMenuPeekTimer=window.setTimeout(()=>{
    desktopMenuPeekTimer=null;
    const shell=document.querySelector('.app-shell');
    if(desktopMenuNavigationHoverBlock||!shell?.classList.contains('nav-collapsed'))return;
    hideSidebarTooltip();
    shell.classList.add('nav-peeking');
  },340);
}

/** Mobile disclosure uses one state source for buttons, assistive tech and keyboard access. */
function setMobileMenuOpen(requested:boolean):void {
  const isMobile=window.matchMedia('(max-width: 800px)').matches;
  const expanded=requested&&isMobile;
  const sidebar=document.getElementById('finance-sidebar');
  const toggle=document.getElementById('mobile-nav-toggle');
  const panel=document.getElementById('mobile-nav-panel');
  if(expanded&&sidebar){
    sidebar.style.setProperty('--finance-mobile-header-height',`${Math.ceil(sidebar.getBoundingClientRect().height)}px`);
  }
  sidebar?.classList.toggle('mobile-open',expanded);
  if(toggle){
    toggle.setAttribute('aria-expanded',String(expanded));
    toggle.setAttribute('aria-label',expanded?'メニューを閉じる':'メニューを開く');
    toggle.title=expanded?'メニューを閉じる':'メニューを開く';
  }
  if(panel)panel.inert=isMobile&&!expanded;
}

function showView(view: FinanceView): void {
  // Acquire the guard before any rerender or retract, even for routes that
  // bypass the sidebar click listener. This is navigation, not a manual pin.
  const sidebar=document.getElementById('finance-sidebar');
  if(sidebar)blockDesktopMenuHoverUntilExit(sidebar);
  // Client-side navigation keeps the sidebar in the DOM, so let hover reveal
  // retract before removing its overlay. Explicit toggle actions stay separate.
  if(document.querySelector('.app-shell.nav-peeking'))closeDesktopMenuPeek();
  else clearDesktopMenuPeek();
  hideSidebarTooltip();
  const fromHome=homeNavigationPending;homeNavigationPending=false;
  returnToHome=fromHome&&(view==='manage'||view==='import'||view==='assets')?view:null;
  setMobileMenuOpen(false);
  if (view !== 'manage') manageReturnToSummary = false;
  if(view!=='manage'){activeAnalysisDrilldown=null;analysisDrilldownSeed=null;drilldownRows.clear();}
  if(view!=='import')closeImportAddDialog();
  $('manage-back-summary').classList.toggle('hidden', view !== 'manage' || !manageReturnToSummary);
  $('manage-back-analysis').classList.toggle('hidden', view !== 'manage' || !activeAnalysisDrilldown || fromHome || manageReturnToSummary);
  $('manage-back-home').classList.toggle('hidden',view!=='manage'||returnToHome!=='manage');
  $('import-back-home').classList.toggle('hidden',view!=='import'||returnToHome!=='import');
  $('assets-back-home').classList.toggle('hidden',view!=='assets'||returnToHome!=='assets');
  $('home-view').classList.toggle('hidden', view !== 'home');
  $('import-view').classList.toggle('hidden', view !== 'import');
  $('manage-view').classList.toggle('hidden', view !== 'manage');
  $('rules-view').classList.toggle('hidden', view !== 'rules');
  $('settings-view').classList.toggle('hidden', view !== 'settings');
  $('assets-page').classList.toggle('hidden', view !== 'assets');
  $('future-view').classList.toggle('hidden', view !== 'future'); /* finance-v148 */
  $('summary-view').classList.toggle('hidden', view !== 'summary');
  $('analysis-view').classList.toggle('hidden', view !== 'analysis');
  $('reports-view').classList.toggle('hidden', view !== 'reports');
  $('subscriptions-view').classList.toggle('hidden', view !== 'subscriptions');
  // The overview already shows the cloud state; avoid repeating the global banner.
  $('cloud-live-bar').classList.add('hidden');
  for (const mode of ['home', 'import', 'manage', 'summary', 'analysis', 'subscriptions', 'reports', 'rules', 'assets', 'future', 'settings'] as const) {
    const nav = $<HTMLButtonElement>(`nav-${mode}`);
    nav.classList.toggle('active', view === mode);
    if (view === mode) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  if (view === 'import' && !importActive()) {
    activeIndex = statements.findIndex(s => importStaged.has(s));
  }
  if (view === 'manage') renderManager();
  if (view === 'import') render();
  if (view === 'rules') {renderRules();}
  if (view === 'assets') assetsUi?.render();
  if (view === 'settings') cardSettingsUi?.render();
  if (view === 'future') futureUi?.render();
  if (view === 'summary') summaryUi?.render();
  if (view === 'analysis') analysisUi?.render();
  if (view === 'reports') reportsUi?.render();
  if (view === 'subscriptions') subscriptionsUi?.render();
  if (view === 'home') homeUi?.render();
  syncCloudGate();
  // Switching menus always starts the destination at its top. Explicit
  // 'back to summary' navigation restores its captured position afterward.
  const content = document.querySelector<HTMLElement>('.workspace > .content');
  if (content) content.scrollTop = 0;
  window.scrollTo(0, 0);
  saveLastView(sessionStorageSafe(), view);
}

function managerIndices(context?:AnalysisReportContext|null): number[] {
  if(!activeAnalysisDrilldown){drilldownRows.clear();return filteredStatementIndices(statements, manageYear, manageMonth);}
  const source=context?.source??analysisSourceProvider?.();
  drilldownRows=source?analysisDrilldownMatches(source,activeAnalysisDrilldown,context?.reports):new Map();
  return statements.map((statement,index)=>({statement,index,id:savedIds.get(statement)}))
    .filter(item=>item.id&&drilldownRows.has(item.id))
    .sort((a,b)=>(b.statement.paymentDate??'').localeCompare(a.statement.paymentDate??'')||a.index-b.index)
    .map(item=>item.index);
}

function selectVisibleManagerStatement(): void {
  const indices = managerIndices();
  if (!indices.includes(activeIndex)) activeIndex = indices[0] ?? -1;
}

function setOptions(select: HTMLSelectElement, choices: Array<[string, string]>, selected: string): void {
  // Reuse the existing option nodes where possible: changes should not reset focus.
  const current = choices.map(([value]) => value).join('|');
  const previous = Array.from(select.options).map(option => option.value).join('|');
  if (current !== previous) {
    select.replaceChildren(...choices.map(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label;
      return option;
    }));
  }
  select.value = selected;
}

function renderManagerFilters(context?:AnalysisReportContext|null): number[] { /* finance-v149 / P2 payment-month drill-down */
  const drilldown=activeAnalysisDrilldown;
  $('manage-drilldown').classList.toggle('hidden',!drilldown);
  $('manage-period-controls').classList.toggle('hidden',!!drilldown);
  if(drilldown){
    $('manage-drilldown-title').textContent=`${drilldown.label} · ${drilldownPeriodLabel(drilldown.periods)}`;
    $('manage-drilldown-description').textContent='支払月で絞り込み中 · 該当する取引行のみ表示';
  }
  const picker=$<HTMLInputElement>('manage-period');
  picker.value=manageYear==='all'||manageMonth==='all'?'':`${manageYear}-${manageMonth}`;
  $('manage-show-all').classList.toggle('active',manageYear==='all'&&manageMonth==='all');
  return managerIndices(context);
}
function manageChangePeriod(period:string):void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))return;
  manageYear=period.slice(0,4);manageMonth=period.slice(5);
  selectVisibleManagerStatement();renderManager();
}
function manageShiftMonth(offset:number):void {
  const current=manageYear!=='all'&&manageMonth!=='all'?`${manageYear}-${manageMonth}`:
    `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}`;
  const year=Number(current.slice(0,4)),month=Number(current.slice(5,7));
  const target=new Date(Date.UTC(year,month-1+offset,1));
  manageChangePeriod(`${target.getUTCFullYear()}-${String(target.getUTCMonth()+1).padStart(2,'0')}`);
}

function openRecurringForReview(entryId:string):void {
  const vault=liveVault;
  if(!vault?.unlocked){toast('OneDrive保管庫を解除してください。');return;}
  if(!vault.assetSettings().recurring.some(item=>item.id===entryId)){
    toast('定期入出金が見つかりません。OneDriveを更新してください。');return;
  }
  showView('assets');
  if(!assetsUi?.openRecurring(entryId))toast('定期入出金の編集画面を開けませんでした。');
}

function renderManagerDrilldownBreakdown(context?:AnalysisReportContext|null):void {
  const block=$('manage-drilldown-breakdown');
  block.classList.toggle('hidden',!activeAnalysisDrilldown);
  $('manage-view').classList.toggle('manage-with-drilldown',!!activeAnalysisDrilldown);
  block.replaceChildren();
  const request=activeAnalysisDrilldown,source=context?.source??analysisSourceProvider?.();
  if(!request||!source)return;
  try{
    const data=analysisDrilldownBreakdown(source,request,context?.reports);
    const heading=document.createElement('h2');heading.textContent='対象金額の内訳';block.append(heading);
    const summary=div('manage-breakdown-totals');
    for(const [label,amount] of [['カード取引',data.cardAmount],['銀行の定期支出予定',data.recurringAmount],['単発支出（実行済み）',data.oneTimeAmount],['分析の合計',data.total]] as const){
      const item=div('manage-breakdown-total');
      const name=document.createElement('span');name.textContent=label;
      const value=document.createElement('strong');value.textContent=`${amount.toLocaleString('ja-JP')}円`;
      item.append(name,value);summary.append(item);
    }
    block.append(summary);
    if(data.byYear.length>1){
      const compare=div('manage-breakdown-yearly');
      const title=document.createElement('h3');title.textContent='年別の内訳';compare.append(title);
      for(const row of data.byYear){
        const item=div('manage-breakdown-total');
        const year=document.createElement('span');year.textContent=`${row.year}年（カード${row.cardAmount.toLocaleString('ja-JP')}円／定期${row.recurringAmount.toLocaleString('ja-JP')}円／単発${row.oneTimeAmount.toLocaleString('ja-JP')}円）`;
        const total=document.createElement('strong');total.textContent=`${row.total.toLocaleString('ja-JP')}円`;
        item.append(year,total);compare.append(item);
      }
      block.append(compare);
    }
    if(data.oneTime.length){
      const list=div('manage-breakdown-recurring');
      const title=document.createElement('h3');title.textContent='実行済みの単発支出';list.append(title);
      for(const entry of data.oneTime){
        const line=div('manage-breakdown-recurring-item');
        const label=div('manage-breakdown-recurring-name');
        const name=document.createElement('strong');name.textContent=entry.name;
        const detail=document.createElement('small');detail.textContent=`${entry.date} · ${entry.amount.toLocaleString('ja-JP')}円`;
        label.append(name,detail);
        const button=document.createElement('button');button.type='button';button.className='secondary-action';
        button.textContent='口座管理で確認';button.addEventListener('click',()=>showView('assets'));
        line.append(label,button);list.append(line);
      }
      block.append(list);
    }
    if(data.recurring.length){
      const note=document.createElement('p');note.className='manage-breakdown-note';
      note.textContent='銀行の定期支出は予定として計上しています。カード取引とは別に、以下から確認・修正できます。';
      block.append(note);
      const list=div('manage-breakdown-recurring');
      for(const entry of data.recurring){
        const row=div('manage-breakdown-recurring-item');
        const name=div('manage-breakdown-recurring-name');
        const title=document.createElement('strong');title.textContent=entry.name;
        const detail=document.createElement('small');detail.textContent=`${entry.date} · ${entry.amount.toLocaleString('ja-JP')}円${entry.cardOverlap?' · カードと重複の可能性':''}`;
        name.append(title,detail);
        const button=document.createElement('button');button.type='button';button.className='secondary-action';
        button.textContent='口座管理で確認';button.addEventListener('click',()=>openRecurringForReview(entry.entryId));
        row.append(name,button);list.append(row);
      }
      block.append(list);
    }
  }catch(error){
    const message=document.createElement('p');
    message.textContent=`内訳を表示できません：${error instanceof Error?error.message:'データを確認してください。'}`;
    block.append(message);
  }
}

/** Update editing feedback without replacing inputs, rows or action buttons. */
function updateManagerEditState(s:ParsedStatement):void {
  $('manage-status').textContent=hasUnsavedChanges(s)?'未保存の変更':'保存済み';
  $('manage-points').querySelector('strong')!.textContent=`${statementPoints(s,liveVault?.unlocked?liveVault.assetSettings().cardPreferences:undefined).toLocaleString('ja-JP')} pt`;
  $<HTMLButtonElement>('manage-save').disabled=batchBusy||filesBusy||!hasUnsavedChanges(s);
  const errors=displayIssues(s);
  $('manage-validation').textContent=errors.length?`要修正：${errors.join(' / ')}`:cardSelectionPending(s)?'カード選択待ち':hasUnsavedChanges(s)?'変更は保存ボタンを押すまで反映されません。':'検証OK。';
  const selected=$('manage-list').querySelector<HTMLElement>('.statement-card.selected');
  const flag=selected?.querySelector<HTMLElement>('.statement-flag');
  if(selected&&flag){
    const state=errors.length?'review':cardSelectionPending(s)?'selection':s.confirmation==='provisional'?'provisional':'verified';
    selected.className=`statement-card ${state} selected`;
    flag.className=`statement-flag ${state}`;
    flag.textContent=s.sourceKind==='csv'&&!s.paymentDate?'引落日未設定':state==='review'?'要確認':state==='selection'?'カード選択待ち':state==='provisional'?'暫定明細':'照合OK';
  }
}

function updateManagerMerchantMetadata(control:HTMLElement,row:ImportRow,s:ParsedStatement):void {
  const secondary=div('manage-merchant-secondary');
  const category=categoryFor(row,s);
  if(category)secondary.append(categoryChip(category));
  else secondary.append(div('category-chip manage-uncategorized','未分類'));
  const currentDisplay=merchantFor(row,s).trim();
  const originalMerchant=row.merchant.trim();
  if(originalMerchant&&currentDisplay!==originalMerchant){
    const original=div('manage-source-text',`原文：${row.merchant}`);
    original.title=row.merchant;secondary.append(original);
  }
  const old=control.querySelector('.manage-merchant-secondary');
  if(old)old.replaceWith(secondary);else control.append(secondary);
}

function renderManager(): void {
  const request=activeAnalysisDrilldown,source=request?analysisSourceProvider?.():null;
  const seed=analysisDrilldownSeed;analysisDrilldownSeed=null;
  let context:AnalysisReportContext|null=null;
  if(request&&source){
    // Reuse the just-rendered analysis reports only when all mutable inputs
    // remain exactly the same; otherwise build a fresh per-render context.
    const sameSource=seed&&seed.source.records===source.records&&
      JSON.stringify([seed.source.assets,seed.source.rules,seed.source.categories,seed.source.payroll,seed.source.currentPeriod])===
      JSON.stringify([source.assets,source.rules,source.categories,source.payroll,source.currentPeriod]);
    if(sameSource&&request.periods.every(p=>seed.reports.has(p)))context={source,reports:seed.reports};
    else {const prepared=prepareMonthlyReports(source.records);
      context={source,reports:new Map(request.periods.map(p=>[p,monthlyReport(p,source,prepared)]))};}
  }
  const indices = renderManagerFilters(context);
  renderManagerDrilldownBreakdown(context);
  $('manage-list-count').textContent = `${indices.length}件`;
  const managerList = $('manage-list');
  managerList.replaceChildren();
  for (const index of indices) managerList.append(createStatementEntry(index, false));
  if (!indices.length) managerList.append(div('empty-list', activeAnalysisDrilldown?'この条件に一致する明細はありません。':statements.length?'この年月の明細はありません。':'明細がありません。'));
  if (!indices.includes(activeIndex)) activeIndex = indices[0] ?? -1;
  const s = indices.includes(activeIndex) ? active() : undefined;
  const empty = $('manage-empty');
  empty.classList.toggle('hidden', !!s);
  empty.querySelector('h3')!.textContent = indices.length ? '編集する明細を選択してください' : '該当する明細がありません';
  $('manage-content').classList.toggle('hidden', !s);
  if (!s) return;
  renderCardOptions(s);
  $('manage-month').textContent = s.billingMonth ? `${s.billingMonth.slice(0,4)}年${Number(s.billingMonth.slice(5))}月` : '未取得';
  $('manage-payment').textContent = dateDisplay(s.paymentDate);
  const originalButton=$<HTMLButtonElement>('manage-original-download');
  const savedId=savedIds.get(s);
  originalButton.disabled=batchBusy||filesBusy||!liveVault?.unlocked||!savedId||
    !liveVault.readonlyRecords().some(record=>record.id===savedId&&!!record.originalId);
  originalButton.title=s.sourceKind==='pdf'?'復号したPDFが端末のダウンロード先に保存されます。':'CSV・テキスト貼り付け明細にPDF原本はありません。';
  $<HTMLButtonElement>('manage-add-row').disabled=!!activeAnalysisDrilldown;
  $<HTMLButtonElement>('manage-delete').disabled = batchBusy || filesBusy;
  updateManagerEditState(s);
  for (const [key,id,label] of [['usedOn','manage-sort-date','利用日'],['amount','manage-sort-amount','金額']] as const) {
    const button=$<HTMLButtonElement>(id);
    const active=manageSort?.key===key;
    button.textContent=`${label} ${active?(manageSort!.direction==='asc'?'▲':'▼'):'↕'}`;
    button.closest('th')?.setAttribute('aria-sort',active?(manageSort!.direction==='asc'?'ascending':'descending'):'none');
  }
  const body = $('manage-rows'); body.replaceChildren();
  // Sorting is display-only: deletions must continue to address original row indices.
  const matchingRows=activeAnalysisDrilldown?drilldownRows.get(savedIds.get(s)??''):null;
  const visibleRows=s.rows.map((row,index)=>({row,index,usedOn:row.usedOn,amount:row.amount}))
    .filter(item=>!activeAnalysisDrilldown||matchingRows?.has(item.row.id));
  for (const {index,row} of orderedPreviewRows(visibleRows,manageSort)) {
    const tr = document.createElement('tr');
    const fields: Array<[string,string,(v:string,input:HTMLInputElement)=>void]> = [
      [row.usedOn, '利用日', (value,input) => {
        const next = value.trim().replace(/\//g,'-');
        if (!validDate(next)) { toast('有効な利用日を選択してください'); input.value=row.usedOn; return; }
        if(next===row.usedOn)return;
        row.usedOn = next; markManagerInlineDirty(s);
      }],
      [merchantFor(row,s), '利用先', (value,input) => {
        const requested=value.trim();
        const defaultDisplay=displayMerchant(row.merchant,s.cardId,rules());
        const previous=row.merchantOverride;
        if(!requested || requested===defaultDisplay || requested===row.merchant) delete row.merchantOverride;
        else row.merchantOverride=requested;
        if(previous===row.merchantOverride)return;
        const control=input.closest<HTMLElement>('.manage-merchant-control');
        if(control)updateManagerMerchantMetadata(control,row,s);
        markManagerInlineDirty(s);
      }],
      [row.amount.toLocaleString('ja-JP'), '金額', (value,input) => {
        if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value.trim())) { toast('金額は整数で入力してください'); input.value=row.amount.toLocaleString('ja-JP'); return; }
        const next=Number(value.replace(/,/g,''));
        if(!Number.isSafeInteger(next)){toast('金額が大きすぎます');input.value=row.amount.toLocaleString('ja-JP');return;}
        if(next===row.amount)return;
        row.amount=next;markManagerInlineDirty(s);
      }],
      [row.description ?? '', '補足', value => {
        const next=value.trim();if(next===(row.description??''))return;
        row.description=next;markManagerInlineDirty(s);
      }],
    ];
    for (const [value, aria, update] of fields) {
      const td = document.createElement('td');
      td.dataset.label=aria;
      const field=makeInput(value, aria === '金額' ? 'numeric-input' : '', update, aria);
      if(aria==='利用先') {
        const cell=div('manage-merchant-control manage-merchant-quiet');
        const main=div('manage-merchant-main');main.append(field);cell.append(main);
        updateManagerMerchantMetadata(cell,row,s);
        td.append(cell);
      }else td.append(field);
      tr.append(td);
      if (aria === '金額') td.classList.add('amount-cell');
    }
    const td = document.createElement('td');td.dataset.label='操作';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'manage-row-delete'; remove.textContent = '削除';
    remove.addEventListener('click', () => { s.rows.splice(index, 1); markDirty(s); });
    td.append(remove); tr.append(td); body.append(tr);
  }
}

function updateRuleCategoryVisual():void {
  const selected=$<HTMLSelectElement>('rule-category').value;
  const category=categoryById(selected);
  const dot=$('rule-category-dot');
  dot.style.setProperty('--category-color',category?.hex??'#718096');
  dot.classList.toggle('is-empty',!category);
}
function fillRuleCategoryOptions():void {
  const select=$<HTMLSelectElement>('rule-category');
  const selected=select.value;
  select.replaceChildren(new Option('分類しない',''));
  for(const category of categories()){
    const color=PALETTE.find(item=>item.id===category.color);
    const option=new Option(`${category.name}（${color?.name??'灰'}）`,category.id);
    option.style.color=color?.hex??'';
    select.add(option);
  }
  select.value=categories().some(category=>category.id===selected)?selected:'';
  updateRuleCategoryVisual();
}
function syncRuleModeRadios():void {
  const mode=$<HTMLSelectElement>('rule-mode').value;
  document.querySelectorAll<HTMLInputElement>('input[name="rule-mode-choice"]').forEach(radio=>{
    radio.checked=radio.value===mode;
  });
}
function rulePatternInputs():HTMLInputElement[] { /* finance-v149 */
  return Array.from($('rule-pattern-alternatives').querySelectorAll<HTMLInputElement>('input[data-rule-alternative]'));
}
function renderRulePatternAlternatives(values:readonly string[]):void {
  const container=$('rule-pattern-alternatives');container.replaceChildren();
  for(const value of values) {
    const row=div('rule-pattern-row');
    const input=document.createElement('input');input.type='text';input.maxLength=200;
    input.value=value;input.placeholder='追加の利用先名';input.dataset.ruleAlternative='true';
    input.autocomplete='off';input.setAttribute('autocapitalize','off');input.setAttribute('autocorrect','off');input.spellcheck=false;
    // Explicit 1Password opt-out: this is a merchant string, never a credential.
    input.setAttribute('data-1p-ignore','true');
    input.setAttribute('aria-label','追加の利用先名');
    const remove=document.createElement('button');remove.type='button';remove.className='rule-pattern-remove';
    remove.textContent='削除';remove.setAttribute('aria-label','この利用先を削除');
    remove.addEventListener('click',()=>{row.remove();$<HTMLButtonElement>('rule-pattern-add').disabled=rulePatternInputs().length>=19;});
    row.append(input,remove);container.append(row);
  }
  $<HTMLButtonElement>('rule-pattern-add').disabled=values.length>=19;
}
function addRulePatternAlternative():void {
  const existing=rulePatternInputs();if(existing.length>=19)return;
  renderRulePatternAlternatives([...existing.map(item=>item.value),'']);
  const latest=rulePatternInputs();latest[latest.length-1]?.focus();
}
let ruleEditorBaseline:string|null=null;
function ruleFormFingerprint():string {
  const form=$<HTMLFormElement>('rules-form');
  return JSON.stringify([...form.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea')]
    .map((field,index)=>[field.id||field.name||String(index),field instanceof HTMLInputElement&&(field.type==='checkbox'||field.type==='radio')?field.checked:field.value]));
}
function ruleFormHasChanges():boolean {return ruleEditorBaseline!==null&&ruleFormFingerprint()!==ruleEditorBaseline;}
function resetRuleEditor():void {
  editingRuleId=null;
  $('rules-editor-title').textContent='新しいルール';
  $<HTMLFormElement>('rules-form').reset();
  renderRulePatternAlternatives([]);
  $<HTMLSelectElement>('rule-card').value='';
  $<HTMLSelectElement>('rule-category').value='';
  updateRuleCategoryVisual();
  $<HTMLInputElement>('rule-priority').value='100';
  $<HTMLInputElement>('rule-enabled').checked=true;
  $<HTMLButtonElement>('rule-save').textContent='保存';
  ruleEditorBaseline=ruleFormFingerprint();

}
function populateRuleEditor(rule:MerchantRule):void {
  editingRuleId=rule.id;
  $('rules-editor-title').textContent='ルールの編集';
  $<HTMLInputElement>('rule-pattern').value=rule.pattern;
  renderRulePatternAlternatives(rule.patterns??[]);
  $<HTMLSelectElement>('rule-mode').value=rule.mode;
  syncRuleModeRadios();
  $<HTMLInputElement>('rule-display-name').value=rule.displayName;
  $<HTMLSelectElement>('rule-card').value=rule.cardId??'';
  fillRuleCategoryOptions();
  $<HTMLSelectElement>('rule-category').value=rule.categoryId??'';
  updateRuleCategoryVisual();
  $<HTMLInputElement>('rule-priority').value=String(rule.priority);
  $<HTMLInputElement>('rule-enabled').checked=rule.enabled;
  $<HTMLButtonElement>('rule-save').textContent='保存';
  ruleEditorBaseline=ruleFormFingerprint();

  $<HTMLInputElement>('rule-pattern').focus();
  $('rules-form').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function openRuleForRow(row:ImportRow,s:ParsedStatement):void {
  resetRuleEditor();
  showView('rules');
  $<HTMLInputElement>('rule-pattern').value=row.merchant;
  $<HTMLSelectElement>('rule-mode').value='exact';
  syncRuleModeRadios();
  $<HTMLInputElement>('rule-display-name').value=row.merchantOverride??matchingRule(row.merchant,s.cardId,rules())?.displayName??'';
  $<HTMLSelectElement>('rule-card').value='';
  $<HTMLSelectElement>('rule-category').value=matchingRule(row.merchant,s.cardId,rules())?.categoryId??'';
  updateRuleCategoryVisual();

  $<HTMLInputElement>('rule-display-name').focus();
}
function proposedRule():MerchantRule | null {
  const patterns=[$<HTMLInputElement>('rule-pattern').value,...rulePatternInputs().map(input=>input.value)].map(p=>p.trim()).filter(Boolean); /* finance-v147 */
  const pattern=patterns[0]??'';
  if(patterns.length>20||patterns.some(p=>p.length>200)||
     new Set(patterns.map(normalizeMerchant)).size!==patterns.length)return null;
  const displayName=$<HTMLInputElement>('rule-display-name').value;
  const priority=Number($<HTMLInputElement>('rule-priority').value);
  if(!normalizeMerchant(pattern)||!displayName.trim()||!Number.isSafeInteger(priority)||priority<0||priority>1000)return null;
  return {id:editingRuleId??'preview-rule',pattern,...(patterns.length>1?{patterns:patterns.slice(1)}:{}),mode:$<HTMLSelectElement>('rule-mode').value as MatchMode,
    displayName,cardId:$<HTMLSelectElement>('rule-card').value||null,enabled:$<HTMLInputElement>('rule-enabled').checked,priority,
    categoryId:($<HTMLSelectElement>('rule-category').value||null) as CategoryId|null};
}
function renderRules():void {
  const unlocked=!!liveVault?.unlocked;
  $('rules-lock-message').classList.toggle('hidden',unlocked);
  $('rules-workspace').classList.toggle('hidden',!unlocked);
  if(!unlocked)return;
  fillRuleCategoryOptions();
  const current=sortedRules(rules());
  $('rules-list-count').textContent=`${current.length}件`;
  const list=$('rules-list');list.replaceChildren();
  if(!current.length)list.append(div('empty-list','利用先ルールはまだありません。左のフォームから登録できます。'));
  for(const rule of current){
    const item=div(`rules-item${rule.enabled?'':' rules-disabled'}`);
    const top=div('rules-item-top'),main=div('rules-item-main');
    const heading=div('rules-item-heading');
    const name=div('rules-item-name',rule.displayName);
    const source=div('rules-item-source',`${[rule.pattern,...(rule.patterns??[])].join(' / ')} · ${ruleModes[rule.mode]}`);
    heading.append(name,source);main.append(heading);
    const card=rule.cardId?cardDisplayName(rule.cardId)??rule.cardId:'全カード';
    const metaLine=div('rules-item-meta-line');
    metaLine.append(div('rules-item-meta',`${card} · 優先 ${rule.priority}`));
    const category=categoryById(rule.categoryId);
    if(category)metaLine.append(categoryChip(category));
    main.append(metaLine);
    top.append(main,div('rules-tag',rule.enabled?'有効':'無効'));item.append(top);
    const buttons=div('rules-item-actions');
    const edit=document.createElement('button');edit.type='button';edit.textContent='編集';edit.disabled=rulesBusy;
    edit.addEventListener('click',()=>populateRuleEditor(rule));
    const toggle=document.createElement('button');toggle.type='button';toggle.disabled=rulesBusy;toggle.textContent=rule.enabled?'無効にする':'有効にする';
    toggle.addEventListener('click',()=>{void saveRule({...rule,enabled:!rule.enabled});});
    const remove=document.createElement('button');remove.type='button';remove.className='rules-remove';remove.textContent='削除';remove.disabled=rulesBusy;
    remove.addEventListener('click',()=>{void deleteRule(rule);});
    buttons.append(edit,toggle,remove);item.append(buttons);list.append(item);
  }
}
/** Edit the entire list in a modal; no cloud writes or main screen rerenders until Save. */
function openCategoryDialog():void {
  if(!liveVault?.unlocked || rulesBusy)return;
  categoryBaseline=categories().map(item=>({...item}));
  categoryDraft=categoryBaseline.map(item=>({...item}));
  $<HTMLInputElement>('rules-category-name').value='';
  $<HTMLSelectElement>('rules-category-color').value='blue';
  renderCategoryDraft();
  $<HTMLDialogElement>('categories-dialog').showModal();
}
function categoryPlan(){
  if(!categoryDraft)return {upserts:[],removeIds:[]};
  return planCategoryBatch(categoryBaseline,categoryDraft);
}
function updateCategoryDraftStatus():void {
  const status=$('rules-category-status');
  try {
    const changes=categoryPlan();
    const n=changes.upserts.length+changes.removeIds.length;
    status.textContent=n?`${n}件の変更があります。保存するとOneDriveへまとめて反映されます。`:'変更はありません。';
    status.classList.remove('bad');
    $<HTMLButtonElement>('categories-dialog-save').disabled=categorySaving || !categoryBatchChanged(changes);
  } catch(error){
    status.textContent=error instanceof Error?error.message:'入力を確認してください。';
    status.classList.add('bad');
    $<HTMLButtonElement>('categories-dialog-save').disabled=true;
  }
}
function renderCategoryDraft():void {
  const box=$('rules-category-list');box.replaceChildren();
  if(!categoryDraft)return;
  for(const item of categoryDraft){
    const row=div('rules-category-row');
    const swatch=div('rules-category-dot');
    const paint=()=>swatch.style.setProperty('--category-color',PALETTE.find(c=>c.id===item.color)?.hex??'#718096');
    paint();
    const name=document.createElement('input');name.type='text';name.maxLength=60;name.value=item.name;
    name.setAttribute('aria-label',`${item.name}の名前`);
    name.addEventListener('input',()=>{item.name=name.value;updateCategoryDraftStatus();});
    const select=document.createElement('select');select.setAttribute('aria-label',`${item.name}の色`);
    for(const color of PALETTE)select.add(new Option(color.name,color.id));
    select.value=item.color;
    select.addEventListener('change',()=>{item.color=select.value as PaletteId;paint();updateCategoryDraftStatus();});
    const remove=document.createElement('button');remove.type='button';remove.className='category-delete';remove.textContent='削除';
    remove.setAttribute('aria-label',`${item.name}を削除予定にする`);
    remove.addEventListener('click',()=>{categoryDraft=categoryDraft!.filter(c=>c.id!==item.id);renderCategoryDraft();});
    name.disabled=select.disabled=remove.disabled=categorySaving;
    row.append(swatch,name,select,remove);box.append(row);
  }
  if(!categoryDraft.length)box.append(div('empty-list','カテゴリーはありません。下から追加してください。'));
  $<HTMLButtonElement>('rules-category-add').disabled=categorySaving;
  $<HTMLButtonElement>('categories-dialog-cancel').disabled=categorySaving;
  $<HTMLButtonElement>('categories-dialog-close').disabled=categorySaving;
  $<HTMLInputElement>('rules-category-name').disabled=categorySaving;
  $<HTMLSelectElement>('rules-category-color').disabled=categorySaving;
  updateCategoryDraftStatus();
}
function addDraftCategory():void {
  if(!categoryDraft||categorySaving)return;
  const input=$<HTMLInputElement>('rules-category-name');
  const name=input.value.trim();
  if(!name){input.focus();$('rules-category-status').textContent='追加するカテゴリー名を入力してください。';return;}
  categoryDraft.push({id:`cat-${crypto.randomUUID()}`,name,color:$<HTMLSelectElement>('rules-category-color').value as PaletteId});
  input.value='';
  renderCategoryDraft();
  input.focus();
}
function closeCategoryDialog():void {
  if(categorySaving)return;
  if(categoryDraft){
    let changed=true;
    try {changed=categoryBatchChanged(categoryPlan());}catch {changed=true;}
    if(changed&&!window.confirm('保存していないカテゴリーの変更を破棄しますか？'))return;
  }
  categoryDraft=null;categoryBaseline=[];
  $<HTMLDialogElement>('categories-dialog').close();
}
async function saveCategoryDialog():Promise<void> {
  if(categorySaving||rulesBusy||!liveVault?.unlocked||!categoryDraft)return;
  let changes;
  try {changes=categoryPlan();} catch(error){updateCategoryDraftStatus();return;}
  if(!categoryBatchChanged(changes))return;
  categorySaving=true;rulesBusy=true;
  renderCategoryDraft();
  $('rules-category-status').textContent='';
  showActivity('カテゴリーを保存中…','working');
  try {
    await liveVault.applyCategoryBatch(changes);
    categoryDraft=null;categoryBaseline=[];
    $<HTMLDialogElement>('categories-dialog').close();
    operationResult('カテゴリーをまとめてOneDriveに保存しました。');
    render();
  }catch(error){
    const status=$('rules-category-status');
    const unknown=error instanceof CloudWriteUncertainError;
    status.textContent=`${unknown?'保存結果未確認':'保存失敗'}：${error instanceof Error?error.message:'通信エラー'}。編集内容は残っています。`;
    status.classList.add('bad');
    operationResult(unknown?'カテゴリーが保存済みの可能性があります。最新データを取得して確認してください。':'カテゴリーの一括保存に失敗しました。編集内容は保持しています。',unknown?'warn':'bad');
  }finally{
    rulesBusy=false;categorySaving=false;
    if(categoryDraft){
      const status=$('rules-category-status');
      const failure=status.classList.contains('bad')?status.textContent:null;
      renderCategoryDraft();
      if(failure){status.textContent=failure;status.classList.add('bad');}
    }
    renderRules();
  }
}
/** Picker is read-only: selecting a merchant fills the predicate field only. */
function renderRecentMerchants():void {
  const candidates=recentMerchants(statements.filter(s=>savedIds.has(s)&&!importStaged.has(s)));
  const card=$<HTMLSelectElement>('recent-merchants-card').value;
  const search=normalizeMerchant($<HTMLInputElement>('recent-merchants-search').value);
  const filtered=candidates.filter(item=>(!card||item.cardId===card)&&(!search||normalizeMerchant(item.merchant).includes(search)));
  const list=$('recent-merchants-list');list.replaceChildren();
  $('recent-merchants-count').textContent=`該当 ${filtered.length}件（最新60件を表示）`;
  for(const item of filtered.slice(0,60)) {
    const button=document.createElement('button');button.type='button';button.className='recent-merchant-item';
    const name=document.createElement('strong');name.textContent=item.merchant;
    const detail=document.createElement('small');
    detail.textContent=`${cardDisplayName(item.cardId)??'カード不明'} · 最終利用 ${item.lastDate||'不明'} · ${item.count}回`;
    button.append(name,detail);
    button.addEventListener('click',()=>{
      $<HTMLInputElement>('rule-pattern').value=item.merchant;
      $<HTMLDialogElement>('recent-merchants-dialog').close();
      $<HTMLInputElement>('rule-pattern').focus();
    });
    list.append(button);
  }
  if(!filtered.length)list.append(div('empty-list','該当する利用先がありません。過去の保存済み明細を確認してください。'));
}
function openRecentMerchants():void {
  const picker=$<HTMLSelectElement>('recent-merchants-card');
  picker.value=$<HTMLSelectElement>('rule-card').value;
  $<HTMLInputElement>('recent-merchants-search').value='';
  renderRecentMerchants();
  $<HTMLDialogElement>('recent-merchants-dialog').showModal();
  $<HTMLInputElement>('recent-merchants-search').focus();
}
async function saveRule(rule:MerchantRule):Promise<void> {
  if(rulesBusy||!liveVault?.unlocked)return;
  rulesBusy=true;$<HTMLButtonElement>('rule-save').disabled=true;
  $('rules-sync-status').className='rules-sync-status';$('rules-sync-status').textContent='';
  showActivity('利用先ルールを保存中…','working');
  try {
    await liveVault.upsertMerchantRule(rule);
    if(editingRuleId===rule.id)resetRuleEditor();
    $('rules-sync-status').textContent='';
    operationResult('利用先ルールをOneDriveに保存しました。');
    render();
  } catch(error) {
    $('rules-sync-status').className='rules-sync-status bad';
    const unknown=error instanceof CloudWriteUncertainError;
    $('rules-sync-status').textContent=`利用先ルールの${unknown?'保存結果未確認':'保存失敗'}：${error instanceof Error?error.message:'不明なエラー'}`;
    operationResult(unknown?'利用先ルールが保存済みの可能性があります。最新データを取得して確認してください。':'利用先ルールを保存できませんでした。内容を保持しています。',unknown?'warn':'bad');
  } finally{rulesBusy=false;$<HTMLButtonElement>('rule-save').disabled=false;renderRules();}
}
async function deleteRule(rule:MerchantRule):Promise<void> {
  if(rulesBusy||!liveVault?.unlocked)return;
  if(!window.confirm(`利用先ルール「${rule.pattern} → ${rule.displayName}」を削除しますか？\n元のカード明細は変更されません。`))return;
  rulesBusy=true;
  try {
    $('rules-sync-status').textContent='';showActivity('利用先ルールを削除中…','working');
    await liveVault.removeMerchantRule(rule.id);
    if(editingRuleId===rule.id)resetRuleEditor();
    $('rules-sync-status').textContent='';
    operationResult('利用先ルールを削除しました。');render();
  } catch(error) {
    $('rules-sync-status').className='rules-sync-status bad';
    const unknown=error instanceof CloudWriteUncertainError;
    $('rules-sync-status').textContent=`${unknown?'削除結果未確認':'削除失敗'}：${error instanceof Error?error.message:'不明なエラー'}`;
    operationResult(unknown?'ルールの削除が完了している可能性があります。最新データを取得して確認してください。':'利用先ルールを削除できませんでした。',unknown?'warn':'bad');
  } finally{rulesBusy=false;renderRules();}
}

async function refreshVaultControls():Promise<void> {
  updateCloudStatus();
  $('preview-empty').querySelector('p')!.textContent=liveVault?.unlocked
    ? '上のエリアからCSV・PDFを選択してください。テキスト貼り付けは詳細設定から利用できます。'
    : 'OneDriveに接続し、暗号化保管庫を解除すると保存済みの明細が表示されます。';
}
function modalClose(success:boolean):void {
  const dlg=$<HTMLDialogElement>('vault-dialog');if(dlg.open)dlg.close();
  clearPasswordField('vault-passphrase');clearPasswordField('vault-passphrase-confirm');
  currentModal=null;modalResolve?.(success);modalResolve=null;
}
function askVault(mode:'create'|'unlock'|'migrate'):Promise<boolean> {
  // A hidden dialog can still have an in-flight unlock; never replace its resolver.
  if(currentModal!==null||$<HTMLDialogElement>('vault-dialog').open)return Promise.resolve(false);
  return new Promise(resolve=>{
    modalResolve=resolve;currentModal=mode;
    $('vault-error').textContent='';
    $('vault-confirm-group').classList.toggle('hidden',mode!=='create');
    $('vault-retention-options').classList.toggle('hidden',mode==='migrate');
    $<HTMLInputElement>('vault-retention-every-time').checked=true;
    const pass=$<HTMLInputElement>('vault-passphrase');
    pass.minLength=mode==='create'?12:1;
    pass.autocomplete=mode==='create'?'new-password':'current-password';
    hidePasswordField('vault-passphrase');hidePasswordField('vault-passphrase-confirm');
    $('vault-dialog-title').textContent=mode==='create'?'OneDrive保管庫の新規作成':mode==='migrate'?'旧データをOneDriveへ移行':'OneDrive保管庫のロック解除';
    const unlockDescription=mode==='create'
      ? 'OneDriveに暗号化保管庫を作成します。12文字以上のパスフレーズを1Passwordに保存してください。'
      :mode==='migrate'?'旧ブラウザ保存に使ったパスフレーズを入力します。移行後も同じパスフレーズでOneDriveを解除できます。'
        :liveVault?.needsLayoutMigration
          ? '旧v1.0の保管庫が見つかりました。復号後、年別フォルダへ暗号化データとPDFを安全に移行します。旧データは削除しません。移行完了後は古いv1.0からの編集を避けてください。'
          : '';
    $('vault-dialog-copy').textContent=unlockDescription;
    $('vault-dialog-copy').classList.toggle('hidden',!unlockDescription);
    $('vault-submit').textContent=mode==='create'?'暗号化保管庫を作成':mode==='migrate'?'暗号化して移行':'復号して開く';
    $<HTMLDialogElement>('vault-dialog').showModal();pass.focus();
  });
}
async function ensureUnlocked():Promise<boolean> {
  if(liveVault?.unlocked)return true;
  if(!liveVault)await startCloud();
  if(liveVault?.unlocked)return true;
  if(!liveVault)return false;
  return askVault(liveVault.exists?'unlock':'create');
}
async function downloadManagedOriginal():Promise<void> {
  const s=active();const id=s?savedIds.get(s):undefined;
  if(!s||!id||!liveVault?.unlocked){toast('保存済みのPDF原本を選択してください。');return;}
  const button=$<HTMLButtonElement>('manage-original-download');
  if(button.disabled||filesBusy||cloudRefreshing)return;
  filesBusy=true;button.disabled=true;
  try {
    const bytes=await liveVault.original(id);
    if(!bytes)throw new Error('この明細のPDF原本は保存されていません。');
    downloadFile(new Uint8Array(bytes).buffer,'application/pdf',canonicalStatementFilename(s,id));
    toast('暗号化PDF原本を復号し、統一ファイル名でダウンロードしました。');
  }catch(error){toast(`PDF原本の取得に失敗しました：${error instanceof Error?error.message:'不明なエラー'}`);}
  finally{button.disabled=false;filesBusy=false;}
}

async function saveEditedStatement(s:ParsedStatement, manual=false):Promise<void> {
  if(!savedIds.has(s))return;
  if(!hasUnsavedChanges(s)) {
    if(manual){operationResult('変更はありません。OneDriveに保存済みです。');toast('この明細はOneDriveに保存済みです。');}
    return;
  }
  if(batchBusy||filesBusy){
    if(manual) operationResult('別の保存処理中です。変更は未保存のまま保持しています。', 'working');
    return;
  }
  if(issues(s).length){updateCloudStatus('変更内容に不備があります。修正してから保存してください。');operationResult('内容に不備があるため、OneDriveへの保存を保留しています。','warn');return;}
  if(!liveVault?.unlocked){updateCloudStatus('ロック中のため変更は未保存です。');operationResult('保管庫がロック中のため未保存です。','warn');return;}
  batchBusy=true;updateBatchStatus();
  operationResult('変更内容をOneDriveへ保存中…', 'working');
  const fingerprint=statementWorkingFingerprint(s);
  try {
    const id=savedIds.get(s)!;
    await liveVault.saveBatch([{id,statement:structuredClone(s),source:s.sourceKind==='pdf'?pendingSources.get(s):undefined}]);
    const mutationWarning=liveVault.takeMutationWarning();
    if(statementWorkingFingerprint(s)===fingerprint){
      savedFingerprints.set(s,fingerprint);dirty.delete(s);pendingSources.delete(s);importStaged.delete(s);
      if(s.sourceKind==='pdf')originalSaved.add(s);
      if(!pending().length)replaceCloudRecords(liveVault.records());
    } else {
      // Further edits during an in-flight Save remain in memory until the next click.
    }
    if(!hasUnsavedChanges(s)) {
      updateCloudStatus(mutationWarning??'変更をOneDriveに保存しました。');
      operationResult(mutationWarning??'変更内容をOneDriveに保存しました。',mutationWarning?'warn':'good');
      toast(mutationWarning??'変更内容をOneDriveに保存しました。');
    } else operationResult('保存中に新しい変更がありました。もう一度保存してください。', 'warn');
  } catch(error){
    const uncertain=error instanceof CloudWriteUncertainError;
    const result=`${uncertain?'保存結果を確認できません':'保存失敗（未保存の変更を保持中）'}：${error instanceof Error?error.message:'不明なエラー'}`;
    updateCloudStatus(result);operationResult(result,uncertain?'warn':'bad');toast(result);
  } finally{batchBusy=false;render();}
}
async function saveAllPending():Promise<void> {
  if(batchBusy||filesBusy||revisionBusy)return;
  const candidates=importQueue().filter(hasUnsavedChanges);if(!candidates.length)return;
  const invalidCount=importQueue().filter(s=>issues(s).length).length+failedImports.length;
  if(invalidCount){toast(`不備のある明細が${invalidCount}件あります。修正してから保存してください。`);return;}
  batchBusy=true;updateBatchStatus();
  operationResult(`${candidates.length}件の明細をOneDriveへ暗号化保存中…`, 'working');
  try {
    if(!await ensureUnlocked()){operationResult('ロック解除がキャンセルされました。明細は未保存です。','warn');return;}
    const latest=importQueue().filter(hasUnsavedChanges);
    if(!latest.length)return;
    const fingerprints=latest.map(s=>statementWorkingFingerprint(s));
    const ids=await liveVault!.saveBatch(latest.map(s=>{
      let id=savedIds.get(s)??pendingCloudIds.get(s);
      if(!id){id=crypto.randomUUID();pendingCloudIds.set(s,id);}
      return {id,statement:structuredClone(s),source:s.sourceKind==='pdf'?pendingSources.get(s):undefined};
    }));
    for(const [index,s]of latest.entries()){
      savedIds.set(s,ids[index]!);
      if(statementWorkingFingerprint(s)===fingerprints[index]){
        savedFingerprints.set(s,fingerprints[index]!);dirty.delete(s);pendingSources.delete(s);importStaged.delete(s);
        if(s.sourceKind==='pdf')originalSaved.add(s);
      }
    }
    if(!pending().length)replaceCloudRecords(liveVault!.records());
    let mutationWarning=liveVault!.takeMutationWarning();
    try{await refreshVaultControls();}
    catch{mutationWarning=mutationWarning??'OneDriveへの保存は完了しましたが、画面の更新に失敗しました。最新データを取得してください。';}
    const remaining = importQueue().length;
    const message = remaining
      ? `${latest.length - remaining}件をOneDriveに保存しました。残り${remaining}件は未確定です。`
      : `${latest.length}件の明細をOneDriveに暗号化保存しました。`;
    operationResult(mutationWarning??message,mutationWarning||remaining?'warn':'good');
    toast(mutationWarning??message);
  }catch(error){
    const uncertain=error instanceof CloudWriteUncertainError;
    const message=`${uncertain?'一括保存結果を確認できません':'一括保存に失敗しました'}：${error instanceof Error?error.message:'不明なエラー'}`;
    updateCloudStatus(message);operationResult(message,uncertain?'warn':'bad');toast(message);
  }finally{batchBusy=false;render();}
}

/** Display actual old/new rows before a month is replaced, regardless of import source. */
function confirmStatementRevision(old:ParsedStatement,newStatement:ParsedStatement,diff:RevisionDiff):Promise<boolean> {
  return new Promise(resolve=>{
    const dialog=$<HTMLDialogElement>('import-revision-dialog');
    const ok=$<HTMLButtonElement>('import-revision-accept');
    const cancel=$<HTMLButtonElement>('import-revision-cancel');
    const warning=$('import-revision-override-warning');
    const acknowledged=$<HTMLInputElement>('import-revision-override-accept');
    const details=$('import-revision-details');details.replaceChildren();
    const needsAck=diff.overridesLost.length>0;
    warning.classList.toggle('hidden',!needsAck);acknowledged.checked=false;ok.disabled=needsAck;
    const label=cardDisplayName(newStatement.cardId)??'カード';
    $('import-revision-summary').textContent=
      `${label}　${newStatement.billingMonth}分\n保存済み：${old.sourceKind==='paste'?'テキスト':old.sourceKind.toUpperCase()} ${yen(old.statedTotal)}（${old.rows.length}件）\n`+
      `新規：${newStatement.sourceKind==='paste'?'テキスト':newStatement.sourceKind.toUpperCase()} ${yen(newStatement.statedTotal)}（${newStatement.rows.length}件）`;
    const stats=$('import-revision-stats');stats.replaceChildren();
    for(const [name,count] of [['一致',diff.matched],['新規',diff.added.length],['削除',diff.removed.length],
      ['補足変更',diff.changed.length],['重複・曖昧',diff.ambiguous.length],['表示名引継ぎ',diff.transferred],['補足引継ぎ',diff.notesTransferred]] as const){
      const span=document.createElement('span');span.textContent=`${name} ${count}件`;stats.append(span);
    }
    const section=(heading:string,rows:readonly ImportRow[])=>{
      if(!rows.length)return;
      const block=document.createElement('section');
      const strong=document.createElement('strong');strong.textContent=`${heading}（${rows.length}件）`;block.append(strong);
      for(const row of rows.slice(0,50)){
        const p=document.createElement('p');
        p.textContent=`${row.usedOn}　${row.merchant}　${yen(row.amount)}${row.merchantOverride?'　表示名:'+row.merchantOverride:''}`;
        block.append(p);
      }
      if(rows.length>50){const more=document.createElement('p');more.textContent=`ほか${rows.length-50}件`;block.append(more);}
      details.append(block);
    };
    section('CSV・新しい明細にのみ存在',diff.added);
    section('旧明細にのみ存在（差し替えで削除）',diff.removed);
    section('同条件の取引が複数あり、一対一で引き継げない行',diff.ambiguous);
    section('引き継げない表示名・補足がある行',diff.overridesLost);
    if(diff.changed.length){
      const block=document.createElement('section');const head=document.createElement('strong');
      head.textContent=`補足の変更（${diff.changed.length}件）`;block.append(head);
      for(const change of diff.changed.slice(0,50)){
        const x=document.createElement('p');
        x.textContent=`${change.after.usedOn} ${change.after.merchant}：${change.before.description||'なし'} → ${change.after.description||'なし'}`;
        block.append(x);
      }
      details.append(block);
    }
    if(!details.children.length){const neutral=document.createElement('section');neutral.textContent='取引金額・利用先・日付に差分はありません。取り込み元を更新します。';details.append(neutral);}
    // The checkbox label stays stable across repeated imports; counts are shown above.

    const finish=(accepted:boolean)=>{
      dialog.removeEventListener('cancel',onCancel);
      ok.removeEventListener('click',onOk);
      cancel.removeEventListener('click',onCancelClick);
      acknowledged.removeEventListener('change',onChange);
      if(dialog.open)dialog.close();
      resolve(accepted);
    };
    const onCancel=(event:Event)=>{event.preventDefault();finish(false);};
    const onCancelClick=()=>finish(false);
    const onOk=()=>{if(needsAck&&!acknowledged.checked)return;finish(true);};
    const onChange=()=>{ok.disabled=needsAck&&!acknowledged.checked;};
    dialog.addEventListener('cancel',onCancel);cancel.addEventListener('click',onCancelClick);
    ok.addEventListener('click',onOk);acknowledged.addEventListener('change',onChange);
    dialog.showModal();
  });
}
/** CSV is structurally valid even when its payment configuration is missing.
 *  Payment-date validation belongs to the save gate, never to CSV parsing. */
function csvPaymentDate(cardId:string,billingMonth:string):string|null {
  const existing=statements.find(s=>s.cardId===cardId&&s.billingMonth===billingMonth);
  if(existing?.paymentDate&&validDate(existing.paymentDate))return existing.paymentDate;
  const timing=liveVault?.unlocked?liveVault.assetSettings().cardPreferences?.[cardId]?.payment:undefined;
  return timing?cardPaymentDate(billingMonth,timing):null;
}
/** Complete queued, still-unpaid CSV drafts after the encrypted card settings are saved. */
function applyCsvPaymentSettings():void {
  for(const statement of importQueue()){
    if(statement.sourceKind!=='csv'||statement.paymentDate||!statement.cardId||!statement.billingMonth)continue;
    const date=csvPaymentDate(statement.cardId,statement.billingMonth);
    if(!date)continue;
    statement.paymentDate=date;
    importedSignatures.set(statement,statementSignature(statement));
  }
}
function cardsMissingCsvPayment():string[] {
  return [...new Set(importQueue()
    .filter(s=>s.sourceKind==='csv'&&!s.paymentDate&&s.cardId)
    .map(s=>s.cardId!))];
}

async function acceptStatement(s: ParsedStatement, source?: LocalSource): Promise<boolean> {
  if (batchBusy || revisionBusy) { toast('別の処理中は明細を追加できません。'); return false; }
  const decision=planStatementImport(statements,s,existing=>importedSignatures.get(existing)??statementSignature(existing));
  const replacingSameContent=decision.kind==='duplicate'&&s.sourceKind==='csv'&&
    statements[decision.index]!.sourceKind!=='csv';
  if(decision.kind==='duplicate'&&!replacingSameContent){
    activeIndex=importStaged.has(statements[decision.index]!)?decision.index:-1;render();
    importUploadFeedback='同一内容の明細はすでに登録されています。';
    updateImportUploadFeedback();
    toast('同一内容の明細はすでに登録されています。重複保存しません。');return false;
  }
  if(decision.kind==='revision'||replacingSameContent){
    const index=decision.index;
    const existing=statements[index]!;
    if(hasUnsavedChanges(existing)&&!importStaged.has(existing)){
      toast('同じ月に未保存の編集があります。先に明細の管理で保存してください。');return false;
    }
    const prepared=prepareStatementRevision(existing,s);
    const baseline=statementWorkingFingerprint(existing);
    revisionBusy=true;render();
    try{
      if(!await confirmStatementRevision(existing,prepared.statement,prepared.diff)){
        toast('差し替えを取り消しました。保存済みの明細はそのままです。');return false;
      }
      // A cloud refresh or local edit while the dialog was open must not retarget the replacement.
      if(statements[index]!==existing||statementWorkingFingerprint(existing)!==baseline)
        throw new Error('差し替え対象が更新されました。CSVを読み直してください。');
      const revised=prepared.statement;
      statements[index]=revised;
      const oldId=savedIds.get(existing)??pendingCloudIds.get(existing);
      if(oldId){
        if(savedIds.has(existing)){
          savedIds.set(revised,oldId);
          savedFingerprints.set(revised,savedFingerprints.get(existing)??statementWorkingFingerprint(existing));
          dirty.add(revised);
        }else pendingCloudIds.set(revised,oldId);
        if(originalSaved.has(existing))originalSaved.add(revised);
      }
      attachSource(revised,source);
      importedSignatures.set(revised,statementSignature(s));
      importStaged.add(revised);
      hasImportedInThisSession=true;activeIndex=index;render();
      toast(`${cardDisplayName(s.cardId)??'カード'}の${s.billingMonth}分を差し替え待ちにしました。まだOneDriveには保存していません。`);
    }finally{revisionBusy=false;render();}
    return true;
  }
  importedSignatures.set(s,statementSignature(s));
  attachSource(s,source);importStaged.add(s);
  statements.unshift(s);activeIndex=0;hasImportedInThisSession=true;
  render();
  toast(`${cardDisplayName(s.cardId)??providerLabel(s.provider)}の明細を解析しました（${s.rows.length}件）。`);
  return true;
}

/** A successful upload closes the dialog only when nothing still needs attention. */
function importBatchIsClean(accepted:number,rejected:number,failed:number):boolean {
  return accepted>0 && rejected===0 && failed===0 && currentUploadFailures.length===0 && !importUploadFeedback;
}

async function handleFiles(files: FileList | File[]): Promise<void> {
  if(filesBusy||batchBusy||revisionBusy){toast('別の取込処理が完了してから追加してください。');return;}
  const chosen=Array.from(files);if(!chosen.length)return;
  filesBusy=true;importUploadFeedback='';currentUploadFailures.splice(0);updateImportUploadFeedback();updateBatchStatus();
  showActivity('明細を読み込み中…','working');
  let accepted=0,rejected=0,failed=0;
  try{
    let processed=0;
    for(const file of chosen){
      processed++;
      showActivity(`明細を読み込み中… (${processed}/${chosen.length})`,'working');
      const name=file.name.toLowerCase();
      if(!name.endsWith('.pdf')&&!name.endsWith('.csv')){
        const reason=`${file.name}: CSVまたはPDF形式ではありません。`;
        failedImports.push(reason);currentUploadFailures.push(reason);
        failed++;render();continue;
      }
      try{
        let result=false;
        if(name.endsWith('.csv')){
          if(file.size===0||file.size>2_000_000)throw new Error('CSVのサイズが不正です（上限2MB）。');
          const text=decodeCardCsv(await file.arrayBuffer());
          const meta=identifyCardCsv(text,file.name);
          const date=csvPaymentDate(meta.cardId,meta.billingMonth);
          result=await acceptStatement(parseCardCsv(text,file.name,date));
        }else{
          // Check the 15 MB limit BEFORE allocating a byte buffer.
          assertPdfLimits(file.size);
          // Read the Blob once. PDF.js receives its own copy because its
          // worker may transfer (detach) the buffer during extraction.
          const originalBytes=new Uint8Array(await file.arrayBuffer());
          const parsed=await parsePdfFile(file,originalBytes);
          result=await acceptStatement(parsed,{bytes:originalBytes,mime:'application/pdf'});
        }
        if(result)accepted++;else rejected++;
      }catch(error){
        const reason=`${file.name}: ${error instanceof Error?error.message:'読み込みに失敗しました。'}`;
        failedImports.push(reason);currentUploadFailures.push(reason);failed++;toast(reason);render();
      }
    }
  }finally{
    filesBusy=false;finishActivity('明細を読み込み中');render();
    // A clean successful batch returns to the review list. Failed/duplicate
    // batches remain open so the user can see what happened and retry.
    if(importBatchIsClean(accepted,rejected,failed))closeImportAddDialog();
    else if(accepted===0 && rejected>0 && failed===0 && !importUploadFeedback)
      importUploadFeedback='追加できる新しい明細はありませんでした。';
    updateImportUploadFeedback();
  }
}

type ThemeMode = 'light' | 'dark';
const THEME_KEY = 'finance-theme';

function getThemeMode(): ThemeMode {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}
function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
}
function initTheme(): void {
  const toggles = [document.getElementById('mobile-theme-toggle'),document.getElementById('desktop-theme-toggle')];
  const syncIcons=()=>{
    const dark=document.documentElement.dataset.theme==='dark';
    const message=dark?'ライトモードに切り替える':'ダークモードに切り替える';
    for(const toggle of toggles){
      if(!toggle)continue;
      toggle.setAttribute('aria-label',message);
      toggle.setAttribute('aria-pressed',String(dark));
      toggle.title=message;
    }
  };
  applyTheme(getThemeMode());
  syncIcons();
  for(const toggle of toggles)toggle?.addEventListener('click',()=>{
    const next:ThemeMode=document.documentElement.dataset.theme==='dark'?'light':'dark';
    try {localStorage.setItem(THEME_KEY,next);} catch { /* Private browsing */ }
    applyTheme(next);syncIcons();
  });
}

function init(): void {
  purgeLegacyTabKey();
  // Register navigation before complex initializers. A failure later must not
  // prevent opening Settings to investigate the startup problem.
  $('brand-home').addEventListener('click',()=>showView('home'));
  $('nav-home').addEventListener('click',()=>showView('home'));
  $('manage-back-home').addEventListener('click',()=>showView('home'));
  $('import-back-home').addEventListener('click',()=>showView('home'));
  $('assets-back-home').addEventListener('click',()=>showView('home'));
  $('nav-import').addEventListener('click',()=>showView('import'));
  $('nav-manage').addEventListener('click',()=>{manageReturnToSummary=false;activeAnalysisDrilldown=null;showView('manage');});
  $('nav-summary').addEventListener('click',()=>showView('summary'));
  $('nav-analysis').addEventListener('click',()=>showView('analysis'));
  $('nav-reports').addEventListener('click',()=>showView('reports'));
  $('nav-subscriptions').addEventListener('click',()=>showView('subscriptions'));
  $('nav-rules').addEventListener('click',()=>showView('rules'));
  $('nav-assets').addEventListener('click',()=>showView('assets'));
  $('nav-future').addEventListener('click',()=>showView('future'));
  $('nav-settings').addEventListener('click',()=>showView('settings'));
  $('import-payment-settings').addEventListener('click',()=>showView('settings'));
  initCloudActionControls();
  // storage events fire only in *other* tabs of this origin, never the sender.
  window.addEventListener('storage',event=>{
    if(event.key!==CROSS_TAB_LOCK_KEY||!event.newValue)return;
    const storage=localStorageSafe();
    if(storage)try{setManualLock(storage);}catch{/* Automatic unlock fails closed without storage. */}
    clearUnlockedFinanceViews();
    operationResult('別のFinanceタブで保管庫がロック・切り替えされました。このタブもロックしました。未保存の作業は破棄されています。','warn');
  });
  initPasswordFields();
  initTheme();
  let sidebarCollapsed=false;
  try{sidebarCollapsed=window.localStorage.getItem('finance-sidebar-collapsed')!=='0';}catch{sidebarCollapsed=true;}
  setDesktopMenuCollapsed(sidebarCollapsed);
  document.documentElement.classList.remove('finance-nav-boot-collapsed');
  document.getElementById('sidebar-collapse-toggle')?.addEventListener('click',()=>{
    setDesktopMenuCollapsed(!document.querySelector('.app-shell')?.classList.contains('nav-collapsed'));
  });
  const desktopSidebar=document.getElementById('finance-sidebar');
  // Capture before individual navigation handlers call showView()/retract the
  // drawer. Do not suppress keyboard activation or non-mouse navigation.
  desktopSidebar?.addEventListener('click',event=>{
    if(event.detail>0&&event.target instanceof Element&&event.target.closest('.nav-entry'))
      blockDesktopMenuHoverUntilExit(desktopSidebar);
  },true);
  // Pointerleave generated by a shrinking fixed drawer is NOT a physical
  // exit. Release only when the mouse actually moves beyond its old bounds.
  document.addEventListener('pointermove',event=>{
    if(event.pointerType==='mouse')releaseDesktopMenuHoverOnMove(event.clientX,event.clientY);
  });
  desktopSidebar?.addEventListener('pointerenter',event=>{
    if(event.pointerType==='mouse')scheduleDesktopMenuPeek();
  });
  desktopSidebar?.addEventListener('pointerleave',()=>{closeDesktopMenuPeek();});
  desktopSidebar?.addEventListener('pointerover',event=>{
    if(desktopMenuNavigationHoverBlock||event.pointerType!=='mouse'||!document.querySelector('.app-shell.nav-collapsed:not(.nav-peeking)'))return;
    const target=event.target instanceof Element?event.target.closest<HTMLElement>('[data-nav-label]'):null;
    const tip=document.getElementById('sidebar-tooltip');
    if(!tip||!target||!desktopSidebar.contains(target))return;
    const bounds=target.getBoundingClientRect();
    tip.textContent=target.dataset.navLabel??'';
    tip.style.left=`${Math.round(desktopSidebar.getBoundingClientRect().right+9)}px`;
    tip.style.top=`${Math.max(6,Math.min(window.innerHeight-42,bounds.top+bounds.height/2-18))}px`;
    tip.hidden=false;
  });
  desktopSidebar?.addEventListener('pointerout',event=>{
    if(event.relatedTarget instanceof Node&&event.target instanceof Element){
      const old=event.target.closest('[data-nav-label]');
      const next=event.relatedTarget instanceof Element?event.relatedTarget.closest('[data-nav-label]'):null;
      if(old&&old===next)return;
    }
    hideSidebarTooltip();
  });
  desktopSidebar?.addEventListener('click',event=>{
    if(!(event.target instanceof Element&&event.target.closest('.nav-entry')))return;
    const shell=document.querySelector('.app-shell');
    if(shell?.classList.contains('nav-peek-closing'))return;
    if(shell?.classList.contains('nav-peeking'))closeDesktopMenuPeek();
    else clearDesktopMenuPeek();
  });
  const mobileToggle=document.getElementById('mobile-nav-toggle');
  const mobileBreakpoint=window.matchMedia('(max-width: 800px)');
  setMobileMenuOpen(false);
  mobileToggle?.addEventListener('click',()=>{
    setMobileMenuOpen(!document.getElementById('finance-sidebar')?.classList.contains('mobile-open'));
  });
  mobileBreakpoint.addEventListener('change',()=>{
    setMobileMenuOpen(false);
    setDesktopMenuCollapsed(!!document.querySelector('.app-shell')?.classList.contains('nav-collapsed'));
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&document.getElementById('finance-sidebar')?.classList.contains('mobile-open')){
      setMobileMenuOpen(false);mobileToggle?.focus();
    }
  });
  document.addEventListener('pointerdown',event=>{
    const sidebar=document.getElementById('finance-sidebar');
    if(sidebar?.classList.contains('mobile-open')&&event.target instanceof Node&&!sidebar.contains(event.target))
      setMobileMenuOpen(false);
  });
  futureUi=initFutureProjection(()=>!liveVault?.unlocked?null:{assets:liveVault.assetSettings(),records:liveVault.readonlyRecords()});
  cardSettingsUi=initCardSettings(()=>liveVault,()=>{render();});
  assetsUi=initAssetsSettings(()=>liveVault,categories,message=>{
    operationResult(message);
    // showView() always renders the destination on entry. Update only the
    // currently visible view rather than rebuilding four hidden pages.
    render();
  },()=>{render();});
  const homeSource=()=>{
    if(!liveVault?.unlocked)return null;
    return {records:liveVault.readonlyRecords(),rules:liveVault.merchantRules(),
      categories:liveVault.merchantCategories(),assets:liveVault.assetSettings(),
      payroll:assetsUi?.payrollSnapshot()??{ready:false,syncedAt:null,entries:[]}};
  };
  analysisSourceProvider=homeSource;
  homeUi=initHome({source:homeSource,navigate:(destination,recordId,drilldown)=>{
    activeAnalysisDrilldown=drilldown??null;
    if(destination==='manage'&&recordId){
      const index=statements.findIndex(item=>savedIds.get(item)===recordId);
      if(index<0){toast('明細が見つかりません。OneDriveを更新してください。');return;}
      const billing=statements[index]?.billingMonth;
      manageYear=billing&&/^\d{4}-(0[1-9]|1[0-2])$/.test(billing)?billing.slice(0,4):'all';
      manageMonth=manageYear==='all'?'all':billing!.slice(5);
      activeIndex=index;
    }
    homeNavigationPending=true;showView(destination);
  },saveMizuhoFunding:async(month,done,snapshot)=>{
    if(!liveVault?.unlocked)throw new Error('OneDrive保管庫を解除してください。');
    await liveVault.setMizuhoFundingChecked(month,done,snapshot);
  }});
  analysisUi=initAnalysis({source:homeSource,openMonth:(period)=>{summaryUi?.setPeriod(period);showView('summary');},
    openDrilldown:(request,context)=>{
      if(!homeSource()){toast('先にOneDrive保管庫を解除してください。');return;}
      analysisReturnPageY=window.scrollY;
      const content=document.querySelector<HTMLElement>('.workspace > .content');
      analysisReturnContentY=content?.scrollTop??0;
      activeAnalysisDrilldown=request;
      analysisDrilldownSeed=context;
      manageReturnToSummary=false;
      activeIndex=-1;
      showView('manage');
    },openSettings:()=>showView('settings')});
  subscriptionsUi=initSubscriptions({source:homeSource,vault:()=>liveVault,
    onSaved:()=>{
      if(!$('home-view').classList.contains('hidden'))homeUi?.render();
      if(!$('summary-view').classList.contains('hidden'))summaryUi?.render();
      if(!$('analysis-view').classList.contains('hidden'))analysisUi?.render();
      if(!$('assets-page').classList.contains('hidden'))assetsUi?.render();
    },openAccountSettings:()=>showView('assets')});
  reportsUi=initMonthlyReports({source:homeSource,vault:()=>liveVault,openMonth:(period)=>{summaryUi?.setPeriod(period);showView('summary');}});
  summaryUi=initMonthlySummary({
    source:homeSource,
    saveCardNoUseMonth:async(period,confirmed)=>{if(!liveVault?.unlocked)throw new Error('保管庫を解除してください。');await liveVault.setCardNoUseMonth(period,confirmed);homeUi?.render();},
    openReport:(period)=>{reportsUi?.openPeriod(period);showView('reports');},
    openRecurring:openRecurringForReview,
    openFixedCost:(id)=>{showView('subscriptions');subscriptionsUi?.openFixedCost(id);},
    openDrilldown:(request)=>{
      if(!homeSource()){toast('先にOneDrive保管庫を解除してください。');return;}
      summaryReturnPageY=window.scrollY;
      const content=document.querySelector<HTMLElement>('.workspace > .content');
      summaryReturnContentY=content?.scrollTop??0;
      activeAnalysisDrilldown=request;
      manageReturnToSummary=true;
      activeIndex=-1;
      showView('manage');
    },
    openRecord:(id)=>{
      const index=statements.findIndex(s=>savedIds.get(s)===id);
      if(index<0){toast('該当する明細が見つかりません。OneDriveを更新してください。');return;}
      const billing=statements[index]?.billingMonth;
      manageYear=billing&&/^\d{4}-(0[1-9]|1[0-2])$/.test(billing)?billing.slice(0,4):'all';
      manageMonth=manageYear==='all'?'all':billing!.slice(5);
      activeIndex=index;
      summaryReturnPageY=window.scrollY;
      const content=document.querySelector<HTMLElement>('.workspace .content');
      summaryReturnContentY=content?.scrollTop??0;
      manageReturnToSummary=true;
      showView('manage');
      if(content)content.scrollTop=0;
      window.scrollTo(0,0);
    },
  });
  $('cloud-new-vault').addEventListener('click',()=>{void (async()=>{
    try {
      if(cloudStartupRunning||!liveVault||!vaultDiscoveryCompleted)throw new Error('先に接続先の保管庫を確認してください。');
      const nowExists=await liveVault.discover();
      vaultDiscoveryCompleted=true;
      updateCloudStatus();
      if(nowExists){
        operationResult('既存の保管庫が見つかりました。新規作成せずに解除してください。');
        await askVault('unlock');
        return;
      }
      const answer=window.confirm('現在接続しているMicrosoftアカウントのアプリ領域にFinance保管庫が見つかりません。\n\n既存のFinanceデータを探している場合は、新規作成せずアカウントとClient IDを確認してください。\n\nこのアカウントに新しい保管庫を作成しますか？');
      if(answer)await askVault('create');
    }catch(error){operationResult(`保管庫の確認に失敗しました：${error instanceof Error?error.message:'通信エラー'}`,'bad');}
  })();});
  initLegacyCleanup();
  $('cloud-remember-register').addEventListener('click',()=>{void (async()=>{
    try{
      const context=browserKeyContext();
      if(!context||!liveVault?.unlocked)throw new Error('Microsoftアカウントと保管庫を解除してください。');
      await rememberBrowserKey(context,liveVault.verifiedBrowserKey());
      resumeManualAutoUnlock();
      operationResult('このブラウザを記憶しました。次回から自動復号します。');
    }catch(error){operationResult(error instanceof Error?error.message:'ブラウザに鍵を保存できません。','bad');}
    finally{await updateBrowserRememberStatus();}
  })();});
  $('cloud-remember-forget').addEventListener('click',()=>{void (async()=>{
    try{
      const context=browserKeyContext();
      if(!context)throw new Error('Microsoftアカウントを接続してください。');
      await forgetBrowserKey(context);

      const local=localStorageSafe();if(local)setManualLock(local);
      operationResult('このブラウザの記憶を解除しました。次回の解除にはパスフレーズが必要です。');
    }catch(error){operationResult(error instanceof Error?error.message:'ブラウザの記憶を解除できません。','bad');}
    finally{await updateBrowserRememberStatus();}
  })();});
  initCloudSettings({
    hasUnsavedChanges:()=>{const state=interruptionState();return !!(state.busy.length||state.unsaved.length);},
    canNavigate:()=>confirmInterruption('認証画面へ移動'),
    onChangePassphrase: async (current,next,onProgress) => {
      if(!liveVault?.unlocked)throw new Error('先にOneDrive保管庫をロック解除してください。');
      assertRefreshSafe();
      const rememberedContext=browserKeyContext();
      await liveVault.changePassphrase(current,next,onProgress);
      // Other open tabs retain the old in-memory key until explicitly notified.
      try{broadcastVaultLock();}catch{operationResult('パスフレーズは変更済みですが、他のタブへロックを通知できません。すべてのFinanceタブを閉じてください。','warn');}
      // Only after an acknowledged generation switch: never delete on a
      // temporary Graph/authentication failure before publication.
      if(rememberedContext){
        try{await forgetBrowserKey(rememberedContext);}
        catch{showActivity('新しいパスフレーズへの変更は完了しましたが、旧ブラウザ鍵を削除できませんでした。ブラウザのサイトデータを確認してください。','bad');}
      }

      void updateBrowserRememberStatus();
      replaceCloudRecords(liveVault.records());lastCloudCheckAt=Date.now();
      renderRules();assetsUi?.render();futureUi?.render();cardSettingsUi?.render();
      updateCloudStatus('OneDrive：新しい暗号化パスフレーズに更新しました。');
      operationResult('暗号化パスフレーズを変更しました。すべての有効データを新しい鍵で再暗号化しました。');
    },
    onCleanupPreview:async()=>{
      assertRefreshSafe();
      if(!liveVault?.unlocked)throw new Error('保管庫を解除してから調べてください。');
      return liveVault.previewCleanup();
    },
    onCleanupDelete:async(which,onProgress)=>{
      assertRefreshSafe();
      if(!liveVault?.unlocked)throw new Error('保管庫を解除してください。');
      cleanupBusy=true;
      try{
        // Lock other open tabs before deleting a previewed generation/orphan.
        broadcastVaultLock();
        const result=await liveVault.deletePreviewedCleanup(which,onProgress);
        operationResult(`${result}件の暗号化ファイルを整理しました。`);
        return result;
      }finally{cleanupBusy=false;}
    },
    onRefresh:refreshCloud,
    onMigration:migrateLegacy,
    onLock:()=>{
      if(!confirmInterruption('ロック'))return false;
      try{broadcastVaultLock();}
      catch{
        // Even without localStorage, this tab must always be lockable.
        operationResult('他のタブへのロック通知に失敗しました。他のFinanceタブも手動で閉じてください。','warn');
      }
      clearUnlockedFinanceViews();
      return true;
    },
  });
  for (const [key, id] of [['usedOn', 'sort-date'], ['amount', 'sort-amount']] as const) {
    $(id).addEventListener('click', () => {
      previewSort = { key, direction: previewSort?.key === key && previewSort.direction === 'asc' ? 'desc' : 'asc' };
      renderRows();
    });
  }
  $('manage-back-analysis').addEventListener('click',()=>{
    showView('analysis');
    const content=document.querySelector<HTMLElement>('.workspace > .content');
    if(content)content.scrollTop=analysisReturnContentY;
    window.scrollTo(0,analysisReturnPageY);
  });
  $('manage-drilldown-clear').addEventListener('click',()=>{
    activeAnalysisDrilldown=null;drilldownRows.clear();activeIndex=-1;selectVisibleManagerStatement();renderManager();
    $('manage-back-analysis').classList.add('hidden');
  });
  $('manage-back-summary').addEventListener('click',()=>{
    showView('summary');
    const content=document.querySelector<HTMLElement>('.workspace .content');
    if(content)content.scrollTop=summaryReturnContentY;
    window.scrollTo(0,summaryReturnPageY);
  });
  $('manage-original-download').addEventListener('click',()=>{void downloadManagedOriginal();});
  for (const [key,id] of [['usedOn','manage-sort-date'],['amount','manage-sort-amount']] as const) {
    $(id).addEventListener('click',()=>{
      manageSort={key,direction:manageSort?.key===key&&manageSort.direction==='asc'?'desc':'asc'};
      renderManager();
    });
  }
  $('manage-prev-month').addEventListener('click',()=>manageShiftMonth(-1));
  $('manage-next-month').addEventListener('click',()=>manageShiftMonth(1));
  $('manage-current-month').addEventListener('click',()=>manageChangePeriod(
    `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}`));
  $('manage-show-all').addEventListener('click',()=>{
    manageYear='all';manageMonth='all';selectVisibleManagerStatement();renderManager();
  });
  $<HTMLInputElement>('manage-period').addEventListener('change',event=>manageChangePeriod(
    (event.target as HTMLInputElement).value));
  for(const card of CARDS){
    const opt=document.createElement('option');opt.value=card.id;opt.textContent=card.name;
    $<HTMLSelectElement>('rule-card').append(opt);
    const recentOption=document.createElement('option');recentOption.value=card.id;recentOption.textContent=card.name;
    $<HTMLSelectElement>('recent-merchants-card').append(recentOption);
  }
  for(const color of PALETTE)$<HTMLSelectElement>('rules-category-color').add(new Option(color.name,color.id));
  $<HTMLSelectElement>('rules-category-color').value='blue';
  $('rules-category-add').addEventListener('click',addDraftCategory);
  $('rules-pick-merchant').addEventListener('click',openRecentMerchants);
  $('rules-category-jump').addEventListener('click',openCategoryDialog);
  $('categories-dialog-close').addEventListener('click',closeCategoryDialog);
  $('categories-dialog-cancel').addEventListener('click',closeCategoryDialog);
  $('categories-dialog-save').addEventListener('click',()=>{void saveCategoryDialog();});
  $('categories-dialog').addEventListener('cancel',event=>{event.preventDefault();closeCategoryDialog();});
  $('recent-merchants-close').addEventListener('click',()=>$<HTMLDialogElement>('recent-merchants-dialog').close());
  $('recent-merchants-dialog').addEventListener('click',event=>{
    if(event.target===$('recent-merchants-dialog'))$<HTMLDialogElement>('recent-merchants-dialog').close();
  });
  $<HTMLSelectElement>('recent-merchants-card').addEventListener('change',renderRecentMerchants);
  $<HTMLInputElement>('recent-merchants-search').addEventListener('input',renderRecentMerchants);
  $<HTMLSelectElement>('rule-category').addEventListener('change',updateRuleCategoryVisual);
  $('rule-reset').addEventListener('click',resetRuleEditor);
  document.querySelectorAll<HTMLInputElement>('input[name="rule-mode-choice"]').forEach(radio=>radio.addEventListener('change',()=>{
    if(radio.checked)$<HTMLSelectElement>('rule-mode').value=radio.value;
  }));
  $('rule-pattern-add').addEventListener('click',addRulePatternAlternative);
  $<HTMLFormElement>('rules-form').addEventListener('submit',event=>{
    event.preventDefault();const candidate=proposedRule();
    if(!candidate){toast('利用先ルールの入力内容を確認してください。');return;}
    // Use a stable ID so a failed upload can be retried without duplicating it.
    if(!editingRuleId){editingRuleId=crypto.randomUUID();candidate.id=editingRuleId;}
    void saveRule(candidate);
  });
  $('rules-reload').addEventListener('click',()=>{
    if(!liveVault?.unlocked||rulesBusy)return;
    void (async()=>{
      try {await refreshCloud();renderRules();$('rules-sync-status').textContent='OneDriveから最新のルールを取得しました。';}
      catch(error){$('rules-sync-status').textContent=`更新失敗：${error instanceof Error?error.message:'通信エラー'}`;}
    })();
  });
  $('import-add-open').addEventListener('click',openImportAddDialog);
  $('import-add-close').addEventListener('click',()=>{if(!filesBusy&&!revisionBusy)closeImportAddDialog();});
  $('import-add-dialog').addEventListener('cancel',event=>{if(filesBusy||revisionBusy)event.preventDefault();});
  $('import-add-dialog').addEventListener('close',()=>{
    if(!$<HTMLDialogElement>('import-add-dialog').open)releaseImportAddDialog();
  });
  $('import-add-dialog').addEventListener('click',event=>{
    if(event.target===$('import-add-dialog')&&!filesBusy&&!revisionBusy)closeImportAddDialog();
  });
  $('import-clear-errors').addEventListener('click',()=>{
    if(filesBusy)return;
    failedImports.splice(0);currentUploadFailures.splice(0);importUploadFeedback='';render();
  });
  $('batch-import').addEventListener('click', () => { void saveAllPending(); });
  $('manage-save').addEventListener('click',()=>{const s=active();if(s){if(savedIds.has(s)){void saveEditedStatement(s,true);}else void saveAllPending();}});
  $('manage-delete').addEventListener('click', () => { if (activeIndex >= 0) void deleteStatement(activeIndex); });
  $('manage-add-row').addEventListener('click', () => { const s = active(); if (!s) return; s.rows.push({id: crypto.randomUUID(), usedOn: new Date().toISOString().slice(0,10),merchant:'',amount:0}); markDirty(s); });
  $<HTMLInputElement>('file-input').addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    // Copy the FileList before resetting the input; some browsers expose a live list.
    const chosen=Array.from(input.files??[]);
    input.value = '';
    if(chosen.length)void handleFiles(chosen);
  });
  const dropzone = $('dropzone');
  dropzone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $<HTMLInputElement>('file-input').click(); } });
  dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', event => {
    event.preventDefault(); dropzone.classList.remove('dragover');
    if (event.dataTransfer?.files) void handleFiles(event.dataTransfer.files);
  });
  const pasteInput = $<HTMLTextAreaElement>('paste-input');
  pasteInput.addEventListener('paste', event => { clipboardHtml = event.clipboardData?.getData('text/html') ?? ''; });
  $('import-rakuten-choice').addEventListener('change',event=>{
    const input=event.target;
    if(!(input instanceof HTMLInputElement)||input.type!=='radio')return;
    const s=importActive();
    if(!s||s.provider!=='rakuten'||!['rakuten-etc','rakuten-mizuho'].includes(input.value))return;
    s.cardId=input.value;
    markDirty(s);
  });
  $('import-smbc-choice').addEventListener('change',event=>{
    const input=event.target;
    if(!(input instanceof HTMLInputElement)||input.type!=='radio')return;
    const s=importActive();
    if(!s||s.provider!=='smbc'||s.sourceKind==='csv'||!['smbc-nl','amazon'].includes(input.value))return;
    s.cardId=input.value;
    markDirty(s);
  });
  $('parse-paste').addEventListener('click', () => {
    if (!pasteInput.value.trim()) {
      importUploadFeedback='明細を貼り付けてください。';
      updateImportUploadFeedback();toast(importUploadFeedback);return;
    }
    importUploadFeedback='';currentUploadFailures.splice(0);updateImportUploadFeedback();
    try{
      const s=parseStatementText(pasteInput.value,'paste','Web明細の貼り付け',clipboardHtml);
      void acceptStatement(s).then(added=>{
        if(added && importBatchIsClean(1,0,0))closeImportAddDialog();
      }).catch(error=>{
        importUploadFeedback=error instanceof Error?error.message:'解析できませんでした。';
        updateImportUploadFeedback();toast(importUploadFeedback);
      });
      // Only the parsed draft lives in memory; raw HTML is discarded.
      pasteInput.value='';clipboardHtml='';
    }catch(error){
      importUploadFeedback=error instanceof Error?error.message:'解析できませんでした。';
      updateImportUploadFeedback();toast(importUploadFeedback);
    }
  });
  $<HTMLSelectElement>('manage-card').addEventListener('change', event => {
    const s = active(); if (!s) return;
    s.cardId = (event.target as HTMLSelectElement).value || null;
    const chosen = getCard(s.cardId);
    if (chosen) s.provider = chosen.provider;
    // An account/month collision is shown as an error and blocks the batch.
    markDirty(s);
  });
  $('clear-all').addEventListener('click', () => {
    const drafts = importQueue();
    if (!drafts.length && !failedImports.length) { toast('破棄できる取込待ちの明細はありません。'); return; }
    if (!window.confirm(`取込待ちの明細${drafts.length}件と解析失敗${failedImports.length}件を破棄しますか？\nOneDriveに保存済みの明細は削除されません。`)) return;
    for (const draft of drafts) discardImportDraft(statements.indexOf(draft), false);
    failedImports.splice(0);currentUploadFailures.splice(0);importUploadFeedback='';
    activeIndex = -1;
    render(); toast('未保存の明細を破棄しました。');
  });
  $('vault-cancel').addEventListener('click', () => modalClose(false));
  $<HTMLDialogElement>('vault-dialog').addEventListener('cancel', event => { event.preventDefault(); modalClose(false); });
  $('vault-form').addEventListener('submit', event => {
    event.preventDefault();
    void (async () => {
      const mode = currentModal;
      if (!mode) return;
      const startedWithLockSequence=lockSequence;
      const pass = $<HTMLInputElement>('vault-passphrase').value;
      const confirmPass = $<HTMLInputElement>('vault-passphrase-confirm').value;
      const rememberBrowser=mode!=='migrate'&&$<HTMLInputElement>('vault-browser-keep').checked;
      const submit = $<HTMLButtonElement>('vault-submit');
      $('vault-error').textContent = '';
      if (mode === 'create' && pass !== confirmPass) { $('vault-error').textContent = '確認用パスフレーズが一致しません。'; return; }
      submit.disabled = true;
      // The global loading surface owns progress. Keep the unlock dialog out
      // of the way while OneDrive downloads/decrypts; reopen on a real failure.
      const vaultDialog=$<HTMLDialogElement>('vault-dialog');
      if(vaultDialog.open)vaultDialog.close();
      try {
        let browserSaveFailure:string|null=null;
        if(!liveVault)throw new Error('Microsoftアカウントへの接続が必要です。');
        // Revoke an obsolete browser key before creating a new cloud vault.
        // An IndexedDB failure must not leave a successfully created vault behind
        // while the dialog reports that creation failed.
        if(mode==='create'&&!rememberBrowser){
          const newContext=browserKeyContext();
          if(!newContext)throw new Error('Microsoftアカウントを確認できません。');
          await applyBrowserRetentionChoice(newContext,false);
        }
        if(mode==='create')await liveVault.create(pass);
        else if(mode==='migrate') {
          await unlockVault(pass);
          const legacy=await readStatements();
          // Read and validate the full old source before creating the live vault.
          const data: Array<{id:string;statement:ParsedStatement;source?:LocalSource}>=[];
          for(const item of legacy){
            const original=item.hasSource?await readOriginal(item.id):null;
            data.push({id:item.id,statement:item.statement,...(original?{source:{bytes:original.bytes,mime:original.mime}}:{})});
          }
          if(!liveVault.exists)await liveVault.create(pass);
          const existing=new Set(liveVault.records().map(x=>x.id));
          const unimported=data.filter(x=>!existing.has(x.id));
          if(unimported.length)await liveVault.saveBatch(unimported);

          toast(`旧明細${data.length}件中、${unimported.length}件をOneDriveへ移行しました。旧データは削除していません。`);
        } else {
          const layoutMigration=liveVault.needsLayoutMigration;
          await liveVault.unlock(pass);
          if(layoutMigration)toast('旧OneDrive保管庫を年別構造へ移行しました。旧ファイルも保持しています。');
        }
        if(lockSequence!==startedWithLockSequence){liveVault.lock();throw new Error('別のタブで保管庫がロックされました。解除操作を中止しました。');}
        const context=browserKeyContext();
        if(rememberBrowser){
          // Browser memory is opt-in. Never export raw AES key bytes.
          try{
            if(!context)throw new Error('Microsoftアカウントを確認できません。');
            await applyBrowserRetentionChoice(context,true,liveVault.verifiedBrowserKey());
          }catch(error){
            browserSaveFailure=`保管庫は解除できましたが、このブラウザを記憶できませんでした：${error instanceof Error?error.message:'保存エラー'}`;
          }
        }else if(mode!=='create'){
          // "毎回入力する" explicitly revokes an older remembered key.
          // If deletion cannot be verified, keep the vault locked and the dialog open.
          try{
            if(!context)throw new Error('Microsoftアカウントを確認できません。');
            await applyBrowserRetentionChoice(context,false);
          }catch(error){
            liveVault.lock();
            throw new Error(`以前のブラウザ記憶を解除できませんでした。再試行してください：${error instanceof Error?error.message:'保存エラー'}`);
          }
        }
        if(lockSequence!==startedWithLockSequence){
          liveVault.lock();
          if(rememberBrowser&&context)try{await forgetBrowserKey(context);}catch{/* Manual-lock preference remains active. */}
          throw new Error('別のタブで保管庫がロックされました。再度解除してください。');
        }
        await updateBrowserRememberStatus();
        if(lockSequence!==startedWithLockSequence){
          liveVault.lock();
          throw new Error('別のタブで保管庫がロックされました。再度解除してください。');
        }
        resumeManualAutoUnlock();
        if(browserSaveFailure)$('cloud-remember-status').textContent=browserSaveFailure;
        modalClose(true);
        const unlockedRecords=liveVault.records();
        appendCloudRecordsKeepingDrafts(unlockedRecords);lastCloudCheckAt=Date.now();
        renderRules();
        assetsUi?.render();futureUi?.render();cardSettingsUi?.render();
        void assetsUi?.refreshPayroll();
        updateCloudStatus();
        await refreshVaultControls();
        if(browserSaveFailure)operationResult(browserSaveFailure,'bad');
        else if(mode==='unlock')toast(`OneDriveから${unlockedRecords.length}件を復号しました。`);
      } catch (error) {
        $('vault-error').textContent = error instanceof Error ? error.message : '認証できませんでした。';
        // Keep the original askVault promise active so the user can retry.
        if(currentModal===mode&&!vaultDialog.open){vaultDialog.showModal();$<HTMLInputElement>('vault-passphrase').focus();}
      } finally { submit.disabled = false; }
    })();
  });
  ruleEditorBaseline=ruleFormFingerprint();
  // Every fresh app load starts on Home, regardless of the prior tab route.
  showView('home');
  void refreshVaultControls();
  render();
  document.documentElement.dataset.financeReady='true';
  void startCloud();
  window.addEventListener('focus',()=>{
    if(!shouldRefreshOnFocus(Date.now(),lastCloudCheckAt,!!liveVault?.unlocked,document.hidden,interruptionState()))return;
    lastCloudCheckAt=Date.now(); // Throttle retries even when the network is down.
    void refreshCloud().catch(error=>updateCloudStatus(`更新確認失敗：${error instanceof Error?error.message:'通信エラー'}`));
  });
  window.addEventListener('beforeunload',event=>{
    const state=interruptionState();
    if(hasInterruptionRisk(state)){event.preventDefault();event.returnValue='';}
  });

}
init();
