import { applyContractEdit } from '../fixed-costs/contract-edit.js';
import { validateMizuhoPlan, validateBalanceWarningLimits } from './assets.js';
import { estimateMizuhoTransferAmount, mizuhoFundingWindow, mizuhoTransferForBill } from './mizuho-transfer.js';
import { traceFinanceOperation, measureFinancePhase } from './performance-diagnostics.js';
import { appendPaymentChange, reviseFuturePaymentChange, originContracts, contractMerchantKeys } from '../fixed-costs/payment-history.js';
import { validateFixedCosts } from '../fixed-costs/contracts.js';
/** Cloud-first, annual-shard vault. IndexedDB is only opened by the explicit legacy import UI. */
import { isZeroUsage, statementPeriod } from '../models/types.js';
import { importErrors } from '../importers/batch-policy.js';
import { isConfirmationRegression } from '../importers/import-policy.js';
import { GraphError, UploadChunkTimeoutError, VaultMutationUncertainError } from './onedrive-api.js';
import { decryptDocument, decryptIndex, decryptOriginal, originalDigest, verifyOriginalDigest, deriveCloudKey, encryptDocument, encryptIndex, encryptOriginal, encryptRules, decryptRules, freshSalt, parseEnvelope, parseIndexEnvelope } from './cloud-crypto.js';
import { statementMonthKey } from '../importers/import-policy.js';
import { emptyDocument, mergeDocuments, detectDocumentEditCollisions, duplicateStatementMonths } from './merge.js';
import { emptyIndex, statementBucket, originalParts, validateIndex } from './layout.js';
import { assertAccountRouteContinuity, updateCardDebitRoutes, updatePayrollDepositRoute, cardDebitAccountOnDay, emptyAssets, validateAssets, mergeAssets, cardRecurringKey, detectAssetsEditCollisions, describeAssetsEditCollisions, validateSnapshot, validateRecurring, validateOneTime, withUpdatedNisaCardRule, validatePayrollAutoPassphrase, validateBirthMonth, validateCardDebitAccounts, validateCardPreferences, validateCardRecurringDecisions } from './assets.js';
import { encryptAssets, decryptAssets, encryptMonthlyReport, decryptMonthlyReport } from './cloud-crypto.js';
import { reportRevision, revisedDocument, snapshotHash } from '../reports/monthly-report.js';
import { migratableCardCost, legacyRuleFixedCost, ruleOverlapsContract } from '../fixed-costs/rule-fixed-costs.js';
import { fixedRuleKey, emptyRules, mergeRules, detectRuleEditCollisions, validateRule, validateCategory, listCategories, PALETTE, CATEGORIES } from './merchant-rules.js';
const clone = (value) => structuredClone(value);
// Field order may change during merge; history array order remains significant.
function sameContract(a, b) {
    const canonical = (value) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
    return canonical(a) === canonical(b);
}
function sameYearRevisions(a, b) {
    return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}
function sameCleanupFiles(a, b) {
    return a.length === b.length && a.every(item => b.some(expected => item.id === expected.id && item.etag === expected.etag && item.name === expected.name));
}
const sameRef = (a, b) => a === null || b === null ? a === b : a.id === b.id && !!a.etag && a.etag === b.etag;
const keysOfRule = (rule) => new Set([fixedRuleKey(rule), ...(rule.fixedCost?.previous ?? []).map(x => x.key)]);
function changedContracts(base, local) {
    const before = new Map(originContracts(base).map(x => [x.id, x])), after = new Map(originContracts(local).map(x => [x.id, x]));
    return new Set([...new Set([...before.keys(), ...after.keys()])].filter(id => {
        const old = before.get(id), next = after.get(id);
        return !old || !next || !sameContract(old, next);
    }));
}
function changedFixedRules(base, local) {
    const before = new Map(base.rules.map(x => [x.id, x])), after = new Map(local.rules.map(x => [x.id, x]));
    return new Set([...new Set([...before.keys(), ...after.keys()])].filter(id => {
        const a = before.get(id), b = after.get(id);
        return !!(a?.fixedCost || b?.fixedCost) && JSON.stringify([a?.fixedCost, a && fixedRuleKey(a)]) !== JSON.stringify([b?.fixedCost, b && fixedRuleKey(b)]);
    }));
}
const isConflict = (error) => error instanceof GraphError && (error.status === 409 || error.status === 412);
// A pre-final timeout cannot commit its target. Other transport errors may occur after commit.
const isDefiniteWriteRejection = (error) => error instanceof UploadChunkTimeoutError || (error instanceof GraphError
    && error.status >= 400 && error.status < 500 && error.status !== 408);
/** A remote write may already have committed; never present this as a definite failure. */
export class CloudWriteUncertainError extends Error {
    reason;
    constructor(message, reason) {
        super(message);
        this.reason = reason;
        this.name = 'CloudWriteUncertainError';
    }
}
/** Cancelled / unapproved collision, not a transport failure. */
export class BrowserKeyGenerationChangedError extends Error {
    constructor() { super('保管庫のパスフレーズまたは世代が変更されています。'); this.name = 'BrowserKeyGenerationChangedError'; }
}
export class CloudEditCancelledError extends Error {
    constructor(message) { super(message); this.name = 'CloudEditCancelledError'; }
}
export class CardNoUseRefreshRequired extends CloudEditCancelledError {
}
/** A read-only preflight found conflicts. Leave the operation lock before asking. */
class BatchApprovalRequired extends CloudEditCancelledError {
    years;
    constructor(years) {
        super('カード明細が別端末で編集されています。');
        this.years = years;
    }
}
export class LiveVault {
    client;
    onMutationWarning;
    key = null;
    lockRevision = 0;
    salt = '';
    dataSetId = null;
    rotating = false;
    recoveryReadOnly = false;
    cleanupPlan = null;
    index = emptyIndex();
    shards = new Map();
    /** UI-only immutable snapshot, rebuilt when a decrypted year document changes. */
    recordsViewCache = null;
    rulesDocument = emptyRules();
    rulesRef = null;
    assetsDocument = emptyAssets();
    assetsRef = null;
    assetConflictResolver = null;
    statementConflictResolver = null;
    ruleConflictResolver = null;
    mutationWarning = null;
    // An ambiguous write must never be retried from a stale in-memory base.
    // A refresh that overlaps a settings save must not replace its baseline,
    // publish stale ciphertext or clear an uncertain-write quarantine.
    settingsRevision = 0;
    rulesSaving = false;
    rulesNeedRefresh = false;
    assetsNeedRefresh = false;
    reportsNeedRefresh = new Set();
    reportsSaving = false;
    /** In-memory retry plan. Sensitive cleartext is never stored in browser storage. */
    pendingYearBatch = null;
    hasRemote = false;
    hasLegacy = false;
    /** Stable temporary identities prevent duplicate inserts after a partial multi-year save. */
    draftIds = new WeakMap();
    pdfDrafts = new WeakMap();
    constructor(client, onMutationWarning) {
        this.client = client;
        this.onMutationWarning = onMutationWarning;
    }
    /** Ask the current user before overwriting any concurrent same-field asset change. */
    setAssetConflictResolver(resolver) {
        this.assetConflictResolver = resolver;
    }
    setStatementConflictResolver(resolver) {
        this.statementConflictResolver = resolver;
    }
    setRuleConflictResolver(resolver) {
        this.ruleConflictResolver = resolver;
    }
    takeMutationWarning() {
        const warning = this.mutationWarning;
        this.mutationWarning = null;
        return warning;
    }
    async approveCollision(items, resolver, domain) {
        if (!items.length)
            return;
        if (!resolver)
            throw new CloudEditCancelledError(`${domain}が別端末でも編集されています。上書きせず停止しました。最新データを取得してください。`);
        let approved = false;
        try {
            approved = await resolver(items);
        }
        catch {
            throw new CloudEditCancelledError(`${domain}の確認画面を開けなかったため保存を停止しました。`);
        }
        if (!approved)
            throw new CloudEditCancelledError(`${domain}の同時編集があったため保存を中止しました。OneDriveの既存内容は変更されていません。`);
    }
    activeMutation = null;
    activeWriterV4 = false;
    mutationRevision = 0;
    lockGuard() {
        const revision = this.lockRevision;
        return () => { if (revision !== this.lockRevision)
            throw new CloudEditCancelledError('操作中に保管庫がロックされました。操作を中止しました。'); };
    }
    async withMutation(guard, run, inherited, checkGeneration = true) {
        guard();
        if (this.recoveryReadOnly)
            throw new CloudEditCancelledError('保存ロックの復旧と最新データ取得が必要です。');
        if (inherited) {
            if (this.activeMutation !== inherited)
                throw new CloudEditCancelledError('保管庫の操作権が失われました。');
            return run(inherited);
        }
        if (this.activeMutation)
            throw new CloudEditCancelledError('別の保存処理が実行中です。');
        let release;
        try {
            release = await this.client.acquireVaultMutation(guard);
        }
        catch (error) {
            // No financial write has started. A failed lock acquisition/recovery
            // must not quarantine an otherwise editable settings document.
            if (error instanceof CloudEditCancelledError)
                throw error;
            throw new CloudEditCancelledError(error instanceof Error ? error.message : '保存を開始できませんでした。');
        }
        const lease = Symbol(), revisionGuard = this.lockGuard();
        this.activeMutation = lease;
        this.mutationRevision++;
        let result;
        let checkedIndex;
        let failed = false, originalError, releaseWarning = null;
        try {
            guard();
            if (checkGeneration) {
                try {
                    const file = await this.assertActiveGeneration(), env = parseIndexEnvelope(file.text);
                    if (env.format === 'finance-cloud-index-envelope-v3' || env.format === 'finance-cloud-index-envelope-v4')
                        checkedIndex = file;
                    if (env.format === 'finance-cloud-index-envelope-v4') {
                        if (!this.key)
                            throw new Error('保管庫がロックされています。');
                        await decryptIndex(env, this.key);
                        guard();
                        this.activeWriterV4 = true;
                    }
                }
                catch (error) {
                    throw new CloudEditCancelledError(`保管庫の現行世代を確認できません。${error instanceof Error ? error.message : ''}`);
                }
                guard();
            }
            result = await run(lease, checkedIndex);
        }
        catch (error) {
            failed = true;
            originalError = error;
            throw error;
        }
        finally {
            try {
                await release();
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : '原因不明';
                const original = originalError instanceof Error ? `${originalError.message}／` : '';
                if (error instanceof VaultMutationUncertainError)
                    throw new CloudWriteUncertainError(`${original}${detail}`, failed ? originalError : error);
                const message = `保存ロックの解除に失敗しました。次の保存時に自動復旧を試みます。続く場合は設定の保存ロック復旧を利用してください。（${detail}）`;
                if (failed) {
                    // A definite rejection must not enter the conflict retry loop while
                    // the marker remains; preserve both the rejection and cleanup cause.
                    if (originalError instanceof CloudEditCancelledError || isDefiniteWriteRejection(originalError))
                        throw new CloudEditCancelledError(`${original}${message}`);
                    throw new CloudWriteUncertainError(`${original}${message}`, originalError);
                }
                releaseWarning = `OneDriveへの保存は確認済みです。${message}`;
            }
            finally {
                this.activeMutation = null;
                this.activeWriterV4 = false;
                this.mutationRevision++;
            }
        }
        try {
            revisionGuard();
        }
        catch (error) {
            throw new CloudWriteUncertainError('操作の終了時に保管庫がロックされました。最新の状態を確認してください。', error);
        }
        if (releaseWarning) {
            // All successful mutations use the same warning path. UI failure cannot
            // turn a confirmed write into a failed save.
            if (this.onMutationWarning) {
                try {
                    this.onMutationWarning(releaseWarning);
                }
                catch { /* feedback only */ }
            }
            else
                this.mutationWarning = [this.mutationWarning, releaseWarning].filter(Boolean).join(' ');
        }
        return result;
    }
    async recoverSaveLock(approve, stillCurrent) {
        return traceFinanceOperation('lock-recovery', async () => {
            if (!this.key || this.activeMutation || this.rotating || this.assetsSaving || this.rulesSaving || this.reportsSaving)
                throw new CloudEditCancelledError('保管庫の解除と実行中の操作の終了が必要です。');
            const guard = this.approvalGuard();
            const check = () => { guard(); if (!stillCurrent() || this.activeMutation || this.assetsSaving || this.rulesSaving || this.reportsSaving)
                throw new CloudEditCancelledError('復旧中に保管庫または操作状態が変更されました。'); };
            const key = this.key, salt = this.salt;
            return this.client.recoverVaultMutationLock(check, async () => {
                // Verify without adopting a new edit baseline or clearing retry plans.
                // In particular, a pending replacement must still compare against the
                // revision the user originally edited, not silently adopt remote edits.
                const [current, rules, assets] = await Promise.all([this.readCurrent(key, salt, undefined, check), this.readMerchantRules(key, salt, true), this.readAssets(key, salt, true)]);
                check();
                await this.verifyCurrentRead(current, rules.ref, assets.ref, check, !!assets.document.cardNoUseMonths?.length);
                check();
                await this.assertActiveGeneration();
                check();
            }, approve);
        });
    }
    /** Old releases cannot interpret v3. Upgrade only during an explicitly
     * authorized maintenance operation, after closing any old-version tabs. */
    async coordinateIndex(file, key, guard) {
        const env = parseIndexEnvelope(file.text);
        if (env.format === 'finance-cloud-index-envelope-v3' || env.format === 'finance-cloud-index-envelope-v4')
            return file;
        const index = await decryptIndex(env, key);
        guard();
        const text = await encryptIndex(index, key, env.salt, env.dataSetId ?? null, true);
        guard();
        await this.client.writeFinanceIndex(text, file);
        guard();
        const saved = await this.client.readFinanceIndex();
        guard();
        if (!saved || saved.id !== file.id || saved.text !== text)
            throw new Error('新版保管庫索引の保存結果を確認できません。');
        // Do not combine the one-way protocol upgrade with deletion/rotation.
        // All old tabs must be closed before the user starts the next operation.
        throw new CloudEditCancelledError('新版の保管庫索引に更新しました。まだ削除・再暗号化は実行していません。すべての端末を最新版で開き直してから、再調査・再実行してください。');
    }
    /** One-way writer compatibility fence, only on an explicit save of new
     * metadata. Older coordinated clients recheck the index after acquiring
     * the same lock and cannot parse v4. No read-only operation upgrades it. */
    async requireWriterV4(key, guard) {
        if (!this.activeMutation)
            throw new CloudEditCancelledError('保管庫の操作権を確認できません。');
        if (this.activeWriterV4)
            return;
        const current = await this.assertActiveGeneration();
        guard();
        const env = parseIndexEnvelope(current.text);
        if (env.format === 'finance-cloud-index-envelope-v4') {
            await decryptIndex(env, key);
            guard();
            this.activeWriterV4 = true;
            return;
        }
        const index = await decryptIndex(env, key);
        guard();
        const text = await encryptIndex(index, key, env.salt, env.dataSetId ?? null, 'v4');
        guard();
        const receipt = await this.client.writeFinanceIndex(text, current);
        guard();
        // The Graph writer already verifies the target ID and changed ETag, or
        // recovers an ambiguous response by exact ciphertext read-back. Do not
        // add a second network failure after that confirmed write.
        if (!receipt) {
            const saved = await this.client.readFinanceIndex(true);
            guard();
            if (!saved || saved.id !== current.id || saved.text !== text || !saved.etag || saved.etag === current.etag)
                throw new CloudWriteUncertainError('新版保管庫への切り替え結果を確認できません。最新データを取得してください。', null);
        }
        else if (receipt.id !== current.id || !receipt.etag || receipt.etag === current.etag) {
            throw new CloudWriteUncertainError('新版保管庫への切り替え結果を確認できません。最新データを取得してください。', null);
        }
        this.activeWriterV4 = true;
    }
    approvalGuard(allowManagement = false) {
        const revision = this.lockRevision, key = this.key, salt = this.salt, generation = this.dataSetId;
        return () => {
            if (!key || this.key !== key || revision !== this.lockRevision || salt !== this.salt || generation !== this.dataSetId || (!allowManagement && this.rotating))
                throw new CloudEditCancelledError('確認中に保管庫が変更されました。保存を中止しました。');
        };
    }
    /** Stop repeat writes until a complete successful vault refresh reconciles the remote state. */
    uncertainWrite(domain, reason) {
        if (domain === 'rules')
            this.rulesNeedRefresh = true;
        else
            this.assetsNeedRefresh = true;
        const label = domain === 'rules' ? '利用先ルール・カテゴリー' : '資産設定';
        const detail = reason instanceof Error ? `（原因：${reason.message}）` : '';
        throw new CloudWriteUncertainError(`${label}はOneDriveに保存済みの可能性があります。保存結果が未確認のため再保存を停止しました。通信回復後に設定の「最新データを取得」で最新データを確認してください。${detail}`, reason);
    }
    get unlocked() { return this.key !== null; }
    get recoveryOnly() { return this.recoveryReadOnly; }
    get isRotating() { return this.rotating; }
    get exists() { return this.hasRemote; }
    get needsLayoutMigration() { return this.hasLegacy; }
    get hasPendingYearBatch() { return this.pendingYearBatch !== null; }
    pendingYearBatchEntries() {
        return this.pendingYearBatch?.items.map(item => ({ id: item.id, statement: clone(item.statement) })) ?? [];
    }
    /** Never choose a financial record by listing order. Keep every copy so
     * shared eligibility checks can exclude ALL ambiguous records. */
    canonicalRecords() {
        return [...this.shards.values()].flatMap(shard => shard.document.records);
    }
    yearCopies(id, shards = this.shards) {
        return [...shards].flatMap(([year, shard]) => shard.document.records.filter(record => record.id === id).map(record => ({ year, record, ref: shard.ref }))).sort((a, b) => a.year.localeCompare(b.year));
    }
    hasYearConflict(id) {
        const copies = this.yearCopies(id);
        return copies.length > 1 || copies.some(x => statementBucket(x.record.statement.billingMonth) !== x.year);
    }
    yearConflictCopies(id) {
        if (!this.key)
            throw new Error('保管庫を解除してください。');
        return this.hasYearConflict(id) ? clone(this.yearCopies(id)) : [];
    }
    recordViews() {
        const counts = new Map();
        for (const { document } of this.shards.values())
            for (const record of document.records)
                counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
        return [...this.shards].flatMap(([year, { document }]) => document.records.map(record => (counts.get(record.id) ?? 0) > 1 || statementBucket(record.statement.billingMonth) !== year ? { ...record, storageYear: year } : record));
    }
    /** Explicit selection after a restart. Verify the approved copies and their
     * ETags under the existing operation right, then preserve the selected copy
     * before removing any other reference. */
    async resolveYearConflict(id, keepYear, reviewed) {
        return traceFinanceOperation('year-conflict', async () => {
            if (this.pendingYearBatch)
                throw new CloudEditCancelledError('先に未確認の保存を再開してください。');
            if (!this.key || !this.hasYearConflict(id))
                throw new CloudEditCancelledError('復旧対象の明細を確認できません。');
            const guard = this.approvalGuard(), key = this.key, salt = this.salt;
            const approved = JSON.stringify(reviewed), selected = reviewed.find(x => x.year === keepYear && x.record.id === id);
            if (!selected || approved !== JSON.stringify(this.yearCopies(id)))
                throw new CloudEditCancelledError('競合内容が変更されました。最新データを確認してください。');
            return this.withMutation(guard, async (lease) => {
                const fresh = await this.readCurrent(key, salt, undefined, guard);
                guard();
                if (approved !== JSON.stringify(this.yearCopies(id, fresh.shards)))
                    throw new CloudEditCancelledError('競合内容が別端末で変更されました。最新データを確認してください。');
                const record = clone(selected.record), target = statementBucket(record.statement.billingMonth), monthKey = statementMonthKey(record.statement);
                if (monthKey && [...fresh.shards.values()].some(x => x.document.records.some(r => r.id !== id && statementMonthKey(r.statement) === monthKey)))
                    throw new CloudEditCancelledError('同じカード・請求月に別の明細があります。先にその明細を確認してください。');
                if (record.originalId) {
                    const encrypted = await this.client.downloadDatedOriginal(record.originalId, record.originalMonth ?? record.statement.billingMonth);
                    guard();
                    await verifyOriginalDigest(await decryptOriginal(encrypted, key), record.originalSha256);
                    guard();
                }
                this.index = fresh.index;
                this.shards = fresh.shards;
                this.recordsViewCache = null;
                const chosen = this.shards.get(target)?.document.records.find(r => r.id === id);
                try {
                    if (JSON.stringify(chosen) !== JSON.stringify(record)) {
                        const doc = clone(this.shards.get(target)?.document ?? emptyDocument());
                        doc.records = doc.records.filter(r => r.id !== id);
                        doc.records.push(record);
                        doc.deleted = doc.deleted.filter(x => x !== id);
                        await this.commitYear(target, doc, new Set(), lease, new Set(), new Set(), true);
                        guard();
                    }
                    // Re-read all copies before cleanup. Do not remove an unreviewed or
                    // changed copy, even if an older client ignored the operation lock.
                    const verified = await this.readCurrent(key, salt, undefined, guard);
                    guard();
                    const copies = this.yearCopies(id, verified.shards);
                    if (JSON.stringify(copies.find(x => x.year === target)?.record) !== JSON.stringify(record) || copies.some(x => x.year !== target && !reviewed.some(r => r.year === x.year && sameRef(r.ref, x.ref) && JSON.stringify(r.record) === JSON.stringify(x.record))))
                        throw new CloudEditCancelledError('復旧中に明細が変更されました。再確認してください。');
                    this.index = verified.index;
                    this.shards = verified.shards;
                    this.recordsViewCache = null;
                    for (const copy of copies) {
                        if (copy.year === target)
                            continue;
                        await this.removeMovedRecords(copy.year, new Set([id]), lease, true);
                        guard();
                    }
                    const result = await this.refresh(lease);
                    guard();
                    if (this.hasYearConflict(id) || JSON.stringify(this.yearCopies(id)[0]?.record) !== JSON.stringify(record))
                        throw new Error('正本を確認できません。');
                    return result;
                }
                catch (error) {
                    // The selected copy was never removed. Explicit re-read and selection
                    // can resume a partial recovery without a new persistent journal.
                    throw new CloudWriteUncertainError('年度間明細の復旧結果を確認できません。最新データを取得してから再確認してください。', error);
                }
            });
        });
    }
    assertNoYearConflict(id) {
        if (this.hasYearConflict(id))
            throw new CloudEditCancelledError('年度間で同じ明細が複数存在します。競合を確認してから操作してください。');
    }
    /** Check affected IDs across all registered/listed years under the existing
     * operation lock. Unchanged shards use the ETag cache; do not adopt a new
     * edit baseline or discard unrelated concurrent changes. */
    async verifyYearEditScope(ids, guard, strictMoves = new Set(), targetYears = new Map(), index) {
        if (!ids.size)
            return;
        if (!this.key || !this.activeMutation)
            throw new CloudEditCancelledError('明細保存の操作権を確認できません。');
        const key = this.key, salt = this.salt;
        let fresh;
        try {
            fresh = await this.readCurrent(key, salt, index, guard);
            guard();
        }
        catch (error) {
            if (error instanceof CloudEditCancelledError)
                throw error;
            throw new CloudEditCancelledError('最新の年度明細を確認できません。保存を中止しました。');
        }
        for (const id of ids) {
            const before = this.yearCopies(id), now = this.yearCopies(id, fresh.shards);
            if (now.length > 1 || now.some(x => statementBucket(x.record.statement.billingMonth) !== x.year) ||
                (before.length && now.length && before[0].year !== now[0].year) ||
                (!before.length && now.length && targetYears.has(id) && targetYears.get(id) !== now[0].year))
                throw new CloudEditCancelledError('年度間で明細が移動または競合しています。最新データを取得してください。');
            if (strictMoves.has(id) && (!before.length || now.length !== 1 || !sameContract(before[0].record, now[0].record)))
                throw new CloudEditCancelledError('移動元の明細が別端末で変更または削除されました。最新データを取得してください。');
        }
        return fresh;
    }
    records() {
        if (!this.key)
            throw new Error('クラウド保管庫はロックされています。');
        return clone(this.recordViews());
    }
    /** Reuse a single defensive copy for read-only analysis/home screens.
     * Canonical records are deeply frozen before being shared, and callers
     * cannot mutate them. The cache compares
     * every year's document identity, so a refresh or successful year save
     * cannot silently return old financial data. Editing must use records(). */
    readonlyRecords() {
        if (!this.key)
            throw new Error('クラウド保管庫はロックされています。');
        const prior = this.recordsViewCache;
        if (prior && prior.documents.size === this.shards.size &&
            [...this.shards].every(([year, shard]) => prior.documents.get(year) === shard.document))
            return prior.records;
        // The view only allocates a small array of references, not another full
        // clone of all statements. Freezing the canonical records is safe: the
        // vault always clones year documents before editing or merging them.
        const entries = this.recordViews();
        // This protects both the returned view and canonical in-memory documents
        // against accidental writes by a rendering component.
        const freeze = (value) => {
            if (!value || typeof value !== 'object' || Object.isFrozen(value))
                return;
            for (const child of Object.values(value))
                freeze(child);
            Object.freeze(value);
        };
        freeze(entries);
        const documents = new Map();
        for (const [year, shard] of this.shards)
            documents.set(year, shard.document);
        this.recordsViewCache = { documents, records: entries };
        return entries;
    }
    merchantRules() {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        return clone(this.rulesDocument.rules);
    }
    fixedCostMigrations() {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        return [...(this.rulesDocument.fixedCostMigrations ?? [])];
    }
    merchantCategories() {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        return clone(listCategories(this.rulesDocument));
    }
    merchantCategoryColors() {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        return clone(this.rulesDocument.categoryColors ?? {});
    }
    /** A Payroll read is valid only in the same unlocked generation, even after a same-key re-unlock. */
    payrollOperationGuard() { return this.approvalGuard(); }
    /** Capture immediately after automatic unlock or a successful full refresh, never on a timer. */
    payrollCredentialHint() {
        if (!this.key || this.recoveryReadOnly || this.rotating || this.assetsNeedRefresh || this.assetsSaving || this.rulesSaving || this.activeMutation)
            return;
        const guard = this.approvalGuard(), document = this.assetsDocument, settingsRevision = this.settingsRevision, mutationRevision = this.mutationRevision;
        let consumed = false;
        return { vault: this, consume: () => {
                if (consumed)
                    return;
                consumed = true;
                guard();
                if (this.recoveryReadOnly || this.assetsNeedRefresh || this.assetsSaving || this.rulesSaving || this.activeMutation || this.assetsDocument !== document || settingsRevision !== this.settingsRevision || mutationRevision !== this.mutationRevision)
                    return;
                return { value: document.payrollAutoPassphrase };
            } };
    }
    async readPayrollCredential(hint) {
        return traceFinanceOperation('payroll-credential', async () => {
            if (this.recoveryReadOnly)
                throw new Error('保管庫の復旧後に給与を同期してください。');
            const guard = this.approvalGuard(), key = this.key, salt = this.salt;
            const verified = hint?.vault === this ? hint.consume() : undefined;
            if (verified) {
                guard();
                return verified.value;
            }
            await this.assertActiveGeneration();
            guard();
            const latest = await this.readAssets(key, salt, true);
            guard();
            await this.assertActiveGeneration();
            guard();
            return latest.document.payrollAutoPassphrase;
        });
    }
    payrollReadClient() {
        if (!this.unlocked || this.rotating || this.recoveryReadOnly)
            throw new Error('Finance保管庫を解除してから給与を同期してください。');
        return this.client;
    }
    cardPreferenceName(cardId) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        return this.assetsDocument.cardPreferences?.[cardId]?.name;
    }
    assetSettings() {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        const result = clone(this.assetsDocument);
        if (this.assetsNeedRefresh && result.cardNoUseMonths?.length)
            result.cardNoUseMonths = [];
        return result;
    }
    conflicts() { return [...this.shards.values()].reduce((count, s) => count + s.document.conflicts.length, 0); }
    lock() { this.lockRevision++; this.recoveryReadOnly = false; this.cleanupPlan = null; this.mutationWarning = null; this.dataSetId = null; this.client.setVaultDataSet?.(null); this.key = null; this.salt = ''; this.shards.clear(); this.recordsViewCache = null; this.index = emptyIndex(); this.rulesDocument = emptyRules(); this.rulesRef = null; this.assetsDocument = emptyAssets(); this.assetsRef = null; this.rulesNeedRefresh = false; this.assetsNeedRefresh = false; this.pendingYearBatch = null; this.draftIds = new WeakMap(); this.pdfDrafts = new WeakMap(); this.reportsNeedRefresh.clear(); }
    /** Report storage is isolated by month; loading does not change any bank/statement data. */
    async listArchivedMonths() {
        return traceFinanceOperation('report-read', async () => {
            if (!this.key || this.rotating)
                throw new Error('保管庫を解除してください。');
            const guard = this.approvalGuard();
            await this.assertActiveGeneration();
            guard();
            const result = await this.client.listMonthlyReports();
            guard();
            return result.map(item => item.period);
        });
    }
    async loadArchivedReport(period) {
        return traceFinanceOperation('report-read', async () => {
            if (!this.key || this.rotating)
                throw new Error('保管庫を解除してください。');
            const guard = this.approvalGuard(), key = this.key, salt = this.salt;
            await this.assertActiveGeneration();
            guard();
            return this.readArchivedReport(period, key, salt, guard);
        });
    }
    async readArchivedReport(period, key, salt, guard) {
        const remote = await this.client.readMonthlyReport(period);
        guard();
        const result = remote ? await decryptMonthlyReport(remote.text, key, salt, period) : null;
        guard();
        this.reportsNeedRefresh.delete(period); // A confirmed read reconciles an earlier ambiguous write.
        return result;
    }
    async loadArchivedReports(period) {
        return traceFinanceOperation('report-read', async () => {
            if (!this.key || this.rotating)
                throw new Error('保管庫を解除してください。');
            const guard = this.approvalGuard(), key = this.key, salt = this.salt;
            await this.assertActiveGeneration();
            guard();
            const [list, document] = await Promise.all([this.client.listMonthlyReports(), this.readArchivedReport(period, key, salt, guard)]);
            guard();
            return [list.map(item => item.period), document];
        });
    }
    async saveArchivedReport(snapshot, note, expectedRevision) {
        return this.saveReportRevision(snapshot.period, snapshot, note, expectedRevision);
    }
    /** An explicit memo-only save never regenerates or reinterprets archived data. */
    async saveArchivedReportNote(period, note, expectedRevision) {
        return this.saveReportRevision(period, null, note, expectedRevision);
    }
    async saveReportRevision(period, snapshot, note, expectedRevision) {
        return traceFinanceOperation('report-save', async () => {
            if (!this.key || this.rotating)
                throw new Error('保管庫を解除してください。');
            if (this.reportsSaving)
                throw new Error('別のレポートを保存中です。');
            if (this.reportsNeedRefresh.has(period))
                throw new CloudWriteUncertainError('保存結果を確認できません。最新のレポートを取得してください。', null);
            if (note.length > 2000)
                throw new Error('メモは2000文字以内にしてください。');
            const guard = this.approvalGuard(), key = this.key, salt = this.salt;
            // Capture the exact inputs represented by the freshly generated snapshot.
            const sourceShards = new Map(this.shards), sourceRules = this.rulesRef, sourceAssets = this.assetsRef;
            const sourceSettingsRevision = this.settingsRevision, sourceMutationRevision = this.mutationRevision;
            this.reportsSaving = true;
            try {
                const index = await this.assertActiveGeneration();
                guard();
                const remote = await this.client.readMonthlyReport(period);
                guard();
                const old = remote ? await decryptMonthlyReport(remote.text, key, salt, period) : null;
                guard();
                if ((old?.current.id ?? null) !== expectedRevision)
                    throw new CloudEditCancelledError('別の端末でレポートが変更されています。最新の内容を取得してください。');
                if (!snapshot && !old)
                    throw new CloudEditCancelledError('保存済みレポートがありません。');
                const body = snapshot ?? old.current.snapshot;
                const hash = snapshot ? await snapshotHash(snapshot) : old.current.sourceHash;
                guard();
                const updated = revisedDocument(old, reportRevision(body, hash, note));
                const text = await encryptMonthlyReport(updated, key, salt);
                guard();
                let returned = false;
                try {
                    return await this.withMutation(guard, async () => {
                        if (snapshot) {
                            if (this.rulesNeedRefresh || this.assetsNeedRefresh || this.pendingYearBatch || this.assetsSaving || this.rulesSaving ||
                                this.settingsRevision !== sourceSettingsRevision || this.mutationRevision !== sourceMutationRevision + 1)
                                throw new CloudEditCancelledError('集計元の保存状態が未確認または変更されています。最新データを取得してください。');
                            try {
                                await this.verifyCurrentRead({ index: this.index, shards: sourceShards, indexRef: index }, sourceRules, sourceAssets, guard);
                                guard();
                            }
                            catch (error) {
                                guard();
                                throw new CloudEditCancelledError('現在の集計元を確認できません。最新データを取得してからレポートを更新してください。');
                            }
                        }
                        if (old && old.current.sourceHash === hash && old.current.note === note) {
                            const latest = await this.client.readMonthlyReport(period, true);
                            guard();
                            if (!latest || !sameRef(remote, latest))
                                throw new CloudEditCancelledError('別の端末でレポートが変更されています。最新の内容を取得してください。');
                            return old;
                        }
                        const written = await this.client.writeMonthlyReport(period, text, remote ? { id: remote.id, etag: remote.etag } : null);
                        returned = true;
                        guard();
                        if (!written?.etag) {
                            const readback = await this.client.readMonthlyReport(period, true);
                            guard();
                            if (!readback || readback.text !== text || !readback.etag || (remote && (remote.id !== readback.id || remote.etag === readback.etag)))
                                throw new Error('保存したレポートを確認できません。');
                            const verified = await decryptMonthlyReport(readback.text, key, salt, period);
                            guard();
                            if (verified.current.id !== updated.current.id)
                                throw new Error('保存結果が一致しません。');
                        }
                        return updated;
                    });
                }
                catch (error) {
                    try {
                        guard();
                    }
                    catch (stale) {
                        if (returned || !isDefiniteWriteRejection(error))
                            throw new CloudWriteUncertainError('レポート保存中に保管庫が変更されました。最新の内容を確認してください。', stale);
                        throw stale;
                    }
                    if (!returned && error instanceof CloudEditCancelledError)
                        throw error;
                    if (isConflict(error))
                        throw new CloudEditCancelledError('別の端末でレポートが更新されました。最新の内容を取得してください。');
                    if (returned || !isDefiniteWriteRejection(error)) {
                        this.reportsNeedRefresh.add(period);
                        if (error instanceof CloudWriteUncertainError)
                            throw error;
                        throw new CloudWriteUncertainError('レポートは保存された可能性があります。最新の内容を取得して確認してください。', error);
                    }
                    throw error;
                }
            }
            finally {
                this.reportsSaving = false;
            }
        });
    }
    /** Expose only the verified non-extractable key, never raw bytes or a passphrase. */
    verifiedBrowserKey() {
        if (!this.key || this.rotating || this.key.extractable)
            throw new Error('保管庫を解除してからブラウザを記憶してください。');
        return { key: this.key, salt: this.salt, dataSetId: this.dataSetId };
    }
    /** Read-only authentication against this account's current OneDrive index. */
    async unlockBrowserKey(record, discovered) {
        return traceFinanceOperation('unlock', async () => {
            if (this.rotating)
                throw new Error('保管庫の管理操作が終了してから解除してください。');
            if (record.key.extractable || record.key.type !== 'secret' || record.key.algorithm.name !== 'AES-GCM')
                throw new Error('保存したブラウザ鍵が不正です。');
            const guard = this.lockGuard();
            const index = discovered ?? await this.client.readFinanceIndex();
            guard();
            if (!index)
                throw new Error('OneDriveの保管庫が見つかりません。');
            const env = parseIndexEnvelope(index.text);
            if (env.salt !== record.salt || (env.dataSetId ?? null) !== record.dataSetId)
                throw new BrowserKeyGenerationChangedError();
            await measureFinancePhase('vault.auto-unlock', () => this.setCurrent(record.key, record.salt, index, guard));
            return this.records();
        });
    }
    async discover() { return (await this.discoverWithIndex()).exists; }
    /** The caller may reuse this encrypted index only within the same startup operation. */
    async discoverWithIndex() {
        return traceFinanceOperation('discover', async () => {
            const current = await this.client.readFinanceIndex();
            if (current) {
                this.hasRemote = true;
                this.hasLegacy = false;
                return { exists: true, index: current };
            }
            const legacy = await this.client.readLiveVault();
            this.hasRemote = !!legacy;
            this.hasLegacy = !!legacy;
            return { exists: this.hasRemote, index: null };
        });
    }
    /** Read the new layout, with safe recovery of shards committed before the index update. */
    async readCurrent(key, salt, prefetched, guard = this.lockGuard()) {
        const indexFile = prefetched ?? await this.client.readFinanceIndex(true);
        guard();
        if (!indexFile)
            throw new Error('OneDriveの暗号化索引が見つかりません。');
        const envelope = parseIndexEnvelope(indexFile.text);
        // A changed salt or data-set generation invalidates an already-unlocked key.
        // Check both before reading any shard, without publishing partial state.
        if (this.key && (envelope.salt !== this.salt || (envelope.dataSetId ?? null) !== this.dataSetId))
            throw new Error('別の端末でパスフレーズが変更されました。保管庫を再解除してください。');
        if (envelope.salt !== salt)
            throw new Error('暗号化索引が異なる保管庫を参照しています。');
        this.client.setVaultDataSet?.(envelope.dataSetId ?? null);
        const index = await decryptIndex(envelope, key);
        guard();
        // An upload may have completed just before index registration failed; recover its shard.
        const files = await this.client.listYearFiles(true);
        guard();
        const known = new Map(files.map(file => [file.year, file]));
        if (known.size !== files.length || files.some(file => !file.id || !file.etag))
            throw new Error('年度一覧の参照情報が不正です。');
        const years = [...new Set([...index.years, ...known.keys()])];
        const shards = new Map();
        // Limit concurrency to four to avoid an uncontrolled burst of Graph requests.
        // Unchanged years are served entirely from the in-memory ETag cache.
        for (let start = 0; start < years.length; start += 4) {
            const group = years.slice(start, start + 4);
            const results = await Promise.all(group.map(async (year) => {
                const file = known.get(year);
                const cached = this.shards.get(year);
                if (file?.etag && cached && cached.ref.id === file.id && cached.ref.etag === file.etag) {
                    return { year, shard: cached };
                }
                const remote = file && typeof this.client.readListedYearVault === 'function'
                    ? await this.client.readListedYearVault(file)
                    : await this.client.readYearVault(year);
                if (!remote)
                    throw new Error(`OneDriveの${year}年の明細ファイルがありません。復旧してください。`);
                if (!file || !sameRef(file, remote))
                    throw new CloudEditCancelledError('取得中に年度明細が変更されました。最新データを取得してください。');
                const docEnv = parseEnvelope(remote.text);
                if (docEnv.salt !== salt)
                    throw new Error(`${year}年の明細が別の保管庫で暗号化されています。`);
                const document = await decryptDocument(docEnv, key);
                for (const record of document.records) {
                    if (!record?.id)
                        throw new Error('年別明細に不正なレコードがあります。');
                }
                return { year, shard: { document, ref: { id: remote.id, etag: remote.etag } } };
            }));
            guard();
            for (const result of results)
                shards.set(result.year, result.shard);
        }
        if (this.key === key && this.salt === salt)
            this.assertKnownOriginalDigests([...shards.values()].map(x => x.document));
        return { index: validateIndex({ format: 'finance-cloud-index-v1', years }), shards, indexRef: { id: indexFile.id, etag: indexFile.etag } };
    }
    /** A known immutable original may not silently lose its identity metadata
     * when an older client writes a statement back to this same generation. */
    assertKnownOriginalDigests(documents) {
        const reference = (r) => `${r.originalMonth ?? r.statement.billingMonth ?? 'undated'}:${r.originalId}`;
        const knownDigests = new Map();
        for (const { document } of this.shards.values())
            for (const r of document.records)
                if (r.originalId && r.originalSha256)
                    knownDigests.set(reference(r), r.originalSha256);
        for (const document of documents)
            for (const r of document.records) {
                const expected = r.originalId ? knownDigests.get(reference(r)) : undefined;
                if (expected && r.originalSha256 !== expected)
                    throw new CloudEditCancelledError('既存のPDF原本検証情報が変更または消失しました。旧版での編集を停止し、原本を確認してください。');
            }
    }
    async verifyCurrentRead(current, rules, assets, guard, hasNoUse = false) {
        const metadata = (kind) => {
            if (typeof this.client.readFinanceMetadata === 'function')
                return this.client.readFinanceMetadata(kind);
            // Isolated legacy Graph fixtures use the existing encrypted read API.
            if (kind === 'index')
                return this.client.readFinanceIndex(true);
            if (kind === 'rules')
                return typeof this.client.readMerchantRules === 'function' ? this.client.readMerchantRules(true) : Promise.resolve(null);
            return typeof this.client.readAssetSettings === 'function' ? this.client.readAssetSettings(true) : Promise.resolve(null);
        };
        const [index, files, ruleRef, assetRef] = await Promise.all([metadata('index'), this.client.listYearFiles(true), metadata('rules'), metadata('assets')]);
        guard();
        if (hasNoUse && !sameRef(assets, assetRef))
            throw new CloudEditCancelledError('利用なし確認が取得中に更新されました。最新データを再取得してください。');
        if (!sameRef(current.indexRef, index) || !sameRef(rules, ruleRef) || !sameRef(assets, assetRef) || files.length !== current.shards.size || new Set(files.map(x => x.year)).size !== files.length || files.some(x => !sameRef(current.shards.get(x.year)?.ref ?? null, x)))
            throw new CloudEditCancelledError('取得中にOneDrive保管庫が更新されました。最新データを取得してください。');
    }
    async setCurrent(key, salt, prefetched, guard = this.lockGuard()) {
        const file = prefetched ?? await this.client.readFinanceIndex();
        guard();
        if (!file)
            throw new Error('OneDriveの暗号化索引が見つかりません。');
        const env = parseIndexEnvelope(file.text);
        this.client.setVaultDataSet?.(env.dataSetId ?? null);
        let recoveryOnly = false;
        const checkRemoteLock = async () => {
            if (!this.activeMutation && typeof this.client.inspectVaultMutationLock === 'function') {
                const status = await this.client.inspectVaultMutationLock();
                guard();
                if (status.state === 'present')
                    recoveryOnly = true;
            }
        };
        await checkRemoteLock();
        guard();
        // Index generation is selected above; independent reads can now proceed together.
        // Do not publish ANY decrypted data until every validation has succeeded.
        const [current, ruleState, assetState] = await measureFinancePhase('vault.load-all', () => Promise.all([
            measureFinancePhase('vault.years', () => this.readCurrent(key, salt, file, guard)),
            measureFinancePhase('vault.rules', () => this.readMerchantRules(key, salt, true)),
            measureFinancePhase('vault.assets', () => this.readAssets(key, salt, true)),
        ]));
        await checkRemoteLock();
        guard();
        await this.verifyCurrentRead(current, ruleState.ref, assetState.ref, guard, !!assetState.document.cardNoUseMonths?.length);
        guard();
        await checkRemoteLock();
        guard();
        const { index, shards } = current;
        guard();
        this.key = key;
        this.salt = salt;
        this.dataSetId = env.dataSetId ?? null;
        this.recoveryReadOnly = recoveryOnly;
        // A stable decrypt under a foreign/abandoned marker authenticates the key
        // for read-only recovery, not the intermediate financial snapshot.
        if (!recoveryOnly) {
            this.index = index;
            this.shards = shards;
            this.recordsViewCache = null;
            this.rulesDocument = ruleState.document;
            this.rulesRef = ruleState.ref;
            this.assetsDocument = assetState.document;
            this.assetsRef = assetState.ref;
        }
        this.hasRemote = true;
        this.hasLegacy = false;
    }
    async unlock(passphrase) {
        return traceFinanceOperation('unlock', async () => {
            if (this.rotating)
                throw new Error('保管庫の管理操作が終了してから解除してください。');
            return measureFinancePhase('vault.manual-unlock', async () => {
                const guard = this.lockGuard();
                const current = await this.client.readFinanceIndex();
                guard();
                if (current) {
                    const salt = parseIndexEnvelope(current.text).salt;
                    const key = await deriveCloudKey(passphrase, salt);
                    guard();
                    await this.setCurrent(key, salt, current, guard);
                    return this.records();
                }
                const legacy = await this.client.readLiveVault();
                if (!legacy)
                    throw new Error('OneDriveに明細保管庫がありません。最初に作成してください。');
                const envelope = parseEnvelope(legacy.text);
                const key = await deriveCloudKey(passphrase, envelope.salt);
                const old = await decryptDocument(envelope, key);
                // Old v1.0 remains untouched. The index is published only after all shards/PDFs verify.
                guard();
                await this.withMutation(guard, async () => {
                    // Recheck after acquiring the exclusive operation right.
                    const latest = await this.client.readFinanceIndex();
                    guard();
                    if (latest)
                        throw new Error('別の端末で保管庫が作成されました。再解除してください。');
                    await this.migrateV1(old, key, envelope.salt, guard);
                    await this.setCurrent(key, envelope.salt, undefined, guard);
                }, undefined, false);
                return this.records();
            });
        });
    }
    async create(passphrase) {
        return traceFinanceOperation('create', async () => {
            if (passphrase.length < 12)
                throw new Error('パスフレーズは12文字以上にしてください。');
            const guard = this.lockGuard();
            return this.withMutation(guard, async () => {
                if (await this.client.readFinanceIndex() || await this.client.readLiveVault())
                    throw new Error('OneDriveにはすでに保管庫があります。解除して使用してください。');
                const salt = freshSalt(), key = await deriveCloudKey(passphrase, salt);
                guard();
                await this.client.ensurePayrollNamespace(); // reserved for the future Payroll app, no personal data
                const encrypted = await encryptIndex(emptyIndex(), key, salt, null, true);
                guard();
                await this.client.writeFinanceIndex(encrypted, null);
                guard();
                await this.setCurrent(key, salt, undefined, guard);
            }, undefined, false);
        });
    }
    /** Verify that the live index still points to the generation unlocked in this tab. */
    async assertActiveGeneration() {
        if (this.rotating)
            throw new Error('パスフレーズの変更中です。完了後に操作してください。');
        const file = await this.client.readFinanceIndex(true);
        if (!file)
            throw new Error('OneDriveの保管庫索引が見つかりません。');
        const env = parseIndexEnvelope(file.text);
        if (env.salt !== this.salt || (env.dataSetId ?? null) !== this.dataSetId)
            throw new Error('別の端末でパスフレーズが変更されました。保管庫をロックして再解除してください。');
        return file;
    }
    /**
     * Copy-on-write passphrase rotation. All active files (including PDF originals)
     * are re-encrypted into a fresh generation. The single index switch is last.
     * An interrupted upload leaves the old index and old ciphertext fully usable.
     * Old generations are deliberately NOT deleted as automatic cleanup could
     * destroy the only recoverable copy after a network/verification failure.
     */
    async changePassphrase(current, next, onProgress) {
        return traceFinanceOperation('passphrase-change', async () => {
            if (!this.key)
                throw new Error('保管庫のロック解除が必要です。');
            if (this.rotating || this.rulesSaving || this.assetsSaving || this.reportsSaving)
                throw new Error('保管庫の更新中です。操作完了後にお試しください。');
            if (next.length < 12)
                throw new Error('新しいパスフレーズは12文字以上にしてください。');
            if (current === next)
                throw new Error('新旧のパスフレーズが同じです。');
            if (typeof this.client.forVaultDataSet !== 'function' || typeof this.client.setVaultDataSet !== 'function')
                throw new Error('OneDriveクライアントがパスフレーズ変更に対応していません。');
            const guard = this.approvalGuard(true), revisionGuard = this.lockGuard(), originalKey = this.key, originalSalt = this.salt;
            return this.withMutation(guard, async () => {
                this.cleanupPlan = null;
                this.rotating = true;
                let published = false;
                let publishing = false;
                let targetGeneration = null;
                try {
                    onProgress?.('現在のパスフレーズを照合中…');
                    let startFile = await this.client.readFinanceIndex();
                    guard();
                    if (!startFile)
                        throw new Error('保管庫索引が見つかりません。');
                    const startEnv = parseIndexEnvelope(startFile.text);
                    if (startEnv.salt !== this.salt || (startEnv.dataSetId ?? null) !== this.dataSetId)
                        throw new Error('別の端末で保管庫が更新されました。先に再解除してください。');
                    const currentKey = await deriveCloudKey(current, originalSalt);
                    guard();
                    await decryptIndex(startEnv, currentKey);
                    guard(); // Reject an incorrect old passphrase BEFORE any upload.
                    startFile = await this.coordinateIndex(startFile, originalKey, guard);
                    guard();
                    // Never publish from a stale local view. Keep the index ETag for atomic activation.
                    const { index, shards } = await this.readCurrent(originalKey, originalSalt, startFile, guard);
                    guard();
                    const rules = await this.readMerchantRules(originalKey, originalSalt);
                    guard();
                    const assets = await this.readAssets(originalKey, originalSalt);
                    guard();
                    const reportRefs = typeof this.client.listMonthlyReports === 'function' ? await this.client.listMonthlyReports() : [];
                    guard();
                    const reports = new Map();
                    for (const ref of reportRefs) {
                        const file = await this.client.readMonthlyReport(ref.period);
                        guard();
                        if (!file || file.etag !== ref.etag)
                            throw new Error('月次レポートが更新されました。再実行してください。');
                        reports.set(ref.period, await decryptMonthlyReport(file.text, originalKey, originalSalt, ref.period));
                        guard();
                    }
                    const originals = new Map();
                    for (const { document } of shards.values())
                        for (const item of document.records)
                            if (item.originalId) {
                                const month = item.originalMonth ?? item.statement.billingMonth ?? null;
                                const ref = `${month ?? 'undated'}:${item.originalId}`;
                                const original = originals.get(ref) ?? { id: item.originalId, month, digests: new Set() };
                                if (item.originalSha256)
                                    original.digests.add(item.originalSha256);
                                originals.set(ref, original);
                            }
                    const generation = crypto.randomUUID();
                    targetGeneration = generation;
                    const target = this.client.forVaultDataSet(generation);
                    const salt = freshSalt();
                    const key = await deriveCloudKey(next, salt);
                    guard();
                    let completed = 0;
                    const total = shards.size + originals.size + reports.size + (rules.ref ? 1 : 0) + (assets.ref ? 1 : 0);
                    const progress = () => onProgress?.(`再暗号化して保存中… ${completed}/${total}ファイル`);
                    progress();
                    guard();
                    for (const [year, shard] of shards) {
                        const cipher = await encryptDocument(shard.document, key, salt);
                        guard();
                        await target.writeYearVault(year, cipher, null);
                        guard();
                        const verified = await target.readYearVault(year);
                        if (!verified || JSON.stringify(await decryptDocument(parseEnvelope(verified.text), key)) !== JSON.stringify(shard.document))
                            throw new Error(`${year}年の再暗号化検証に失敗しました。`);
                        guard();
                        completed++;
                        progress();
                        guard();
                    }
                    if (rules.ref) {
                        const cipher = await encryptRules(rules.document, key, salt);
                        guard();
                        await target.writeMerchantRules(cipher, null);
                        guard();
                        const file = await target.readMerchantRules();
                        if (!file || JSON.stringify(await decryptRules(file.text, key, salt)) !== JSON.stringify(rules.document))
                            throw new Error('利用先ルールの再暗号化検証に失敗しました。');
                        guard();
                        completed++;
                        progress();
                        guard();
                    }
                    if (assets.ref) {
                        const cipher = await encryptAssets(assets.document, key, salt);
                        guard();
                        await target.writeAssetSettings(cipher, null);
                        guard();
                        const file = await target.readAssetSettings();
                        if (!file || JSON.stringify(await decryptAssets(file.text, key, salt)) !== JSON.stringify(assets.document))
                            throw new Error('資産設定の再暗号化検証に失敗しました。');
                        guard();
                        completed++;
                        progress();
                        guard();
                    }
                    for (const [period, report] of reports) {
                        const cipher = await encryptMonthlyReport(report, key, salt);
                        guard();
                        await target.writeMonthlyReport(period, cipher, null);
                        guard();
                        const file = await target.readMonthlyReport(period);
                        if (!file || JSON.stringify(await decryptMonthlyReport(file.text, key, salt, period)) !== JSON.stringify(report))
                            throw new Error(`${period}のレポートの再暗号化検証に失敗しました。`);
                        guard();
                        completed++;
                        progress();
                        guard();
                    }
                    for (const { id, month, digests } of originals.values()) {
                        const source = await this.client.downloadDatedOriginal(id, month);
                        guard();
                        const decrypted = await decryptOriginal(source, originalKey);
                        guard();
                        for (const digest of digests) {
                            await verifyOriginalDigest(decrypted, digest);
                            guard();
                        }
                        const cipher = await encryptOriginal(decrypted, key);
                        guard();
                        await target.uploadDatedOriginal(id, cipher, month);
                        guard();
                        const saved = await target.downloadDatedOriginal(id, month);
                        const verified = await decryptOriginal(saved, key);
                        for (const digest of digests) {
                            await verifyOriginalDigest(verified, digest);
                            guard();
                        }
                        if (verified.length !== decrypted.length || !verified.every((byte, i) => byte === decrypted[i]))
                            throw new Error('PDF原本の再暗号化検証に失敗しました。');
                        guard();
                        completed++;
                        progress();
                        guard();
                    }
                    onProgress?.('他端末での更新がないか最終確認中…');
                    guard();
                    // Confirm there were no changes to any source file during the staging run.
                    const checkIndex = await this.client.readFinanceIndex();
                    guard();
                    if (!checkIndex || checkIndex.etag !== startFile.etag)
                        throw new Error('作業中に索引が変更されました。旧データはそのままです。再実行してください。');
                    const nowFiles = await this.client.listYearFiles(true);
                    guard();
                    const actual = new Map(nowFiles.map(file => [file.year, file]));
                    if (actual.size !== shards.size || [...shards].some(([year, shard]) => actual.get(year)?.etag !== shard.ref.etag))
                        throw new Error('作業中に明細が更新されました。旧データはそのままです。再実行してください。');
                    if (reportRefs.length) {
                        const nowReports = await this.client.listMonthlyReports();
                        guard();
                        const latest = new Map(nowReports.map(ref => [ref.period, ref.etag]));
                        if (latest.size !== reportRefs.length || reportRefs.some(ref => latest.get(ref.period) !== ref.etag))
                            throw new Error('作業中に月次レポートが変更されました。旧データはそのままです。');
                    }
                    else if (typeof this.client.listMonthlyReports === 'function' && (await this.client.listMonthlyReports()).length)
                        throw new Error('作業中に新しい月次レポートが保存されました。再実行してください。');
                    guard();
                    const nowRules = await this.client.readMerchantRules();
                    guard();
                    const nowAssets = await this.client.readAssetSettings();
                    guard();
                    if ((nowRules?.etag ?? null) !== (rules.ref?.etag ?? null) || (nowAssets?.etag ?? null) !== (assets.ref?.etag ?? null))
                        throw new Error('作業中に設定が更新されました。旧データはそのままです。再実行してください。');
                    onProgress?.('新しい暗号化保管庫に切り替え中…');
                    guard();
                    const encrypted = await encryptIndex(index, key, salt, generation, parseIndexEnvelope(startFile.text).format === 'finance-cloud-index-envelope-v4' || assets.document.format === 'finance-assets-v3' || [...shards.values()].some(s => s.document.records.some(r => r.originalSha256)) ? 'v4' : true);
                    guard();
                    publishing = true;
                    await this.client.writeFinanceIndex(encrypted, { id: startFile.id, etag: startFile.etag });
                    published = true;
                    guard();
                    // The index publication is a single conditional Graph update. All data was
                    // verified before this point; the old data is still available as recovery.
                    this.key = null;
                    this.draftIds = new WeakMap();
                    this.pdfDrafts = new WeakMap();
                    await this.setCurrent(key, salt, undefined, revisionGuard);
                    revisionGuard();
                }
                catch (error) {
                    try {
                        revisionGuard();
                    }
                    catch {
                        if (publishing || published)
                            throw new CloudWriteUncertainError('切り替え中にロックされました。新旧パスフレーズとOneDriveの状態を確認してください。', error);
                        throw new CloudEditCancelledError('再暗号化中に保管庫がロックされました。切り替えを中止しました。');
                    }
                    // Graph may commit a file and then lose the HTTP response. Never claim the
                    // old passphrase is authoritative without checking the published index.
                    if (publishing && !published && targetGeneration) {
                        try {
                            const latest = await this.client.readFinanceIndex();
                            if (latest) {
                                const current = parseIndexEnvelope(latest.text);
                                if (current.dataSetId === targetGeneration)
                                    published = true;
                                else if (current.salt === this.salt && (current.dataSetId ?? null) === this.dataSetId)
                                    publishing = false;
                            }
                        }
                        catch { /* Connection unavailable: state must be treated as uncertain. */ }
                    }
                    revisionGuard();
                    if (published) {
                        this.lock();
                        throw new Error('切り替えは完了しましたが、再読み込みに失敗しました。保管庫を新しいパスフレーズで解除してください。');
                    }
                    if (publishing && !(error instanceof GraphError && [409, 412].includes(error.status))) {
                        this.lock();
                        throw new Error('保管庫の切り替え中に通信が途切れ、結果を確認できませんでした。再接続して新しいパスフレーズで解除し、開けなければ以前のパスフレーズを使用してください。');
                    }
                    throw error;
                }
                finally {
                    this.rotating = false;
                }
            });
        });
    }
    /** Preview is read-only. Only unreferenced originals inside the active generation
     * and inactive version directories are eligible for deletion. */
    async previewCleanup() {
        return traceFinanceOperation('cleanup-preview', async () => {
            if (!this.key || this.rotating || this.rulesSaving || this.assetsSaving || this.reportsSaving)
                throw new Error('保管庫の操作が完了してから整理してください。');
            const guard = this.approvalGuard();
            this.cleanupPlan = null;
            const index = await this.assertActiveGeneration();
            guard();
            const { shards } = await this.readCurrent(this.key, this.salt, index, guard);
            guard();
            const years = new Map([...shards].map(([year, { ref }]) => [year, `${ref.id}:${ref.etag}`]));
            // A PDF may be referenced by multiple records and/or years.
            const referenced = new Set();
            for (const { document } of shards.values())
                for (const record of document.records) {
                    if (!record.originalId)
                        continue;
                    const [year, month] = originalParts(record.originalMonth ?? record.statement.billingMonth ?? null);
                    referenced.add(`${year}/${month}/${record.originalId.toLowerCase()}.enc`);
                }
            const allOriginals = await this.client.listDatedOriginals();
            guard();
            const originals = allOriginals.filter(file => !referenced.has(`${file.year}/${file.month}/${file.name.toLowerCase()}`));
            const generations = (await this.client.listOldVaultGenerations()).filter(x => x.name.toLowerCase() !== this.dataSetId?.toLowerCase());
            // Current unversioned vaults must NEVER delete their own root folders.
            const legacyFolders = this.dataSetId ? await this.client.listUnversionedFinanceFolders() : [];
            // Old root v1 is never the active vault once a valid current index is open.
            // Snapshots are recovery points: the user must select each snapshot individually.
            const retired = await this.client.listRetiredRootData();
            guard();
            // Reject scanning if another tab modified a year or switched generations in flight.
            const end = await this.client.readFinanceIndex();
            guard();
            const endYears = new Map((await this.client.listYearFiles()).map(x => [x.year, `${x.id}:${x.etag}`]));
            guard();
            if (!end || end.etag !== index.etag || !sameYearRevisions(years, endYears))
                throw new Error('確認中に保管庫が更新されました。再読み込みしてやり直してください。');
            this.cleanupPlan = { index: { id: index.id, etag: index.etag }, dataSetId: this.dataSetId, years, generations, legacyFolders, originals, legacyV1: retired.legacyV1, snapshots: retired.snapshots };
            return { generationCount: generations.length, legacyFolderCount: legacyFolders.length, unreferencedOriginalCount: originals.length, legacyV1Count: retired.legacyV1.length, snapshots: retired.snapshots.map(({ id, name, createdDateTime }) => ({ id, name, createdDateTime })) };
        });
    }
    /** An explicit second action is required. Fail closed if any cloud revision differs. */
    async deletePreviewedCleanup(which, onProgress) {
        return traceFinanceOperation('cleanup-delete', async () => {
            if (!this.key || this.rotating || this.rulesSaving || this.assetsSaving || this.reportsSaving || !this.cleanupPlan)
                throw new Error('先に不要データの確認を実行してください。');
            const plan = this.cleanupPlan;
            this.cleanupPlan = null; // A preview is single-use, including on failure.
            const snapshotIds = which.snapshotIds ?? [];
            if (!Array.isArray(snapshotIds) || snapshotIds.length !== new Set(snapshotIds).size ||
                snapshotIds.some(id => typeof id !== 'string' || !plan.snapshots.some(file => file.id === id)))
                throw new Error('確認していないスナップショットは削除できません。');
            if (which.legacyV1 && !plan.legacyV1.length)
                throw new Error('旧v1保管庫が確認されていません。');
            if (!which.oldGenerations && !which.unreferencedOriginals && !which.unversionedFolders && !which.legacyV1 && !snapshotIds.length)
                throw new Error('削除対象を選択してください。');
            const guard = this.approvalGuard(true), key = this.key;
            return this.withMutation(guard, async () => {
                let current = await this.client.readFinanceIndex();
                guard();
                if (!current || current.id !== plan.index.id || current.etag !== plan.index.etag)
                    throw new Error('保管庫の世代・索引が変更されました。確認からやり直してください。');
                const env = parseIndexEnvelope(current.text);
                if (env.salt !== this.salt || (env.dataSetId ?? null) !== this.dataSetId || plan.dataSetId !== this.dataSetId)
                    throw new Error('保管庫の世代が変更されました。削除を中止しました。');
                const years = new Map((await this.client.listYearFiles()).map(x => [x.year, `${x.id}:${x.etag}`]));
                guard();
                if (!sameYearRevisions(plan.years, years))
                    throw new Error('明細が更新されました。確認からやり直してください。');
                const originals = which.unreferencedOriginals ? plan.originals : [];
                const generations = which.oldGenerations ? plan.generations : [];
                const legacyFolders = which.unversionedFolders ? plan.legacyFolders : [];
                const selectedRoot = [...(which.legacyV1 ? plan.legacyV1 : []), ...plan.snapshots.filter(file => snapshotIds.includes(file.id))];
                if (legacyFolders.length && !this.dataSetId)
                    throw new Error('現行保管庫の保存領域は削除できません。');
                // Re-list *all* candidates to reject renamed/replaced files and stale ETags.
                if (which.unreferencedOriginals) {
                    const actual = await this.client.listDatedOriginals();
                    if (!sameCleanupFiles(actual.filter(file => originals.some(x => x.id === file.id)), originals))
                        throw new Error('PDF原本の構成が変化しました。削除を中止しました。');
                }
                if (which.oldGenerations) {
                    const actual = await this.client.listOldVaultGenerations();
                    if (!sameCleanupFiles(actual.filter(file => generations.some(x => x.id === file.id)), generations))
                        throw new Error('旧世代フォルダが更新されました。削除を中止しました。');
                }
                if (which.unversionedFolders) {
                    const actual = await this.client.listUnversionedFinanceFolders();
                    if (!sameCleanupFiles(actual.filter(file => legacyFolders.some(x => x.id === file.id)), legacyFolders))
                        throw new Error('旧保存領域が更新されました。削除を中止しました。');
                }
                if (selectedRoot.length) {
                    const actual = await this.client.listRetiredRootData();
                    const rootList = [...actual.legacyV1, ...actual.snapshots];
                    if (!sameCleanupFiles(rootList.filter(file => selectedRoot.some(x => x.id === file.id)), selectedRoot))
                        throw new Error('旧保管庫またはスナップショットが更新されました。削除を中止しました。');
                }
                guard();
                current = await this.coordinateIndex(current, key, guard);
                guard();
                plan.index = { id: current.id, etag: current.etag };
                this.rotating = true;
                let deleted = 0;
                try {
                    for (const file of [...originals, ...generations, ...legacyFolders, ...selectedRoot]) {
                        // Guard the live generation and concurrent edits before each irreversible request.
                        guard();
                        const latest = await this.client.readFinanceIndex();
                        guard();
                        const state = latest ? parseIndexEnvelope(latest.text) : null;
                        if (!latest || latest.etag !== plan.index.etag || (state?.dataSetId ?? null) !== this.dataSetId)
                            throw new Error('削除中に保管庫の世代が更新されました。残りの削除を中止しました。');
                        const checkedYears = new Map((await this.client.listYearFiles()).map(x => [x.year, `${x.id}:${x.etag}`]));
                        guard();
                        if (!sameYearRevisions(plan.years, checkedYears))
                            throw new Error('削除中に明細が更新されました。残りの削除を中止しました。');
                        if (legacyFolders.includes(file) && !this.dataSetId)
                            throw new Error('現行保存領域を削除できません。');
                        if (generations.includes(file) && file.name.toLowerCase() === this.dataSetId?.toLowerCase())
                            throw new Error('現行世代は削除できません。');
                        // Revalidate the exact root entry immediately before its conditional DELETE.
                        if (selectedRoot.includes(file)) {
                            const currentRoot = await this.client.listRetiredRootData();
                            const candidates = [...currentRoot.legacyV1, ...currentRoot.snapshots];
                            if (!sameCleanupFiles(candidates.filter(item => item.id === file.id), [file]))
                                throw new Error('旧データが更新されました。残りの削除を中止しました。');
                        }
                        guard();
                        await this.client.deleteCleanupItem(file);
                        deleted++;
                        guard();
                        onProgress?.(`${deleted}/${originals.length + generations.length + legacyFolders.length + selectedRoot.length}件を整理しました`);
                    }
                    return deleted;
                }
                catch (error) {
                    throw new CloudWriteUncertainError(`整理は${deleted}件まで確認できました。通信エラー時は削除済みの可能性があります。再スキャンしてください。`, error);
                }
                finally {
                    this.rotating = false;
                }
            });
        });
    }
    /** Legacy -> finance/index.enc + finance/statements/YYYY.enc + finance/originals/YYYY/MM/UUID.enc.
     * Idempotent and non-destructive. Do not publish index.enc before all files validate. */
    async migrateV1(old, key, salt, guard) {
        const byYear = new Map();
        const bucket = (year) => {
            let doc = byYear.get(year);
            if (!doc) {
                doc = emptyDocument();
                byYear.set(year, doc);
            }
            return doc;
        };
        for (const record of old.records) {
            const year = statementBucket(record.statement.billingMonth);
            const copy = clone(record);
            if (copy.originalId) {
                // Legacy originals were at the app root. Their ciphertext is already valid with this key.
                const original = await this.client.downloadOriginal(copy.originalId);
                guard();
                if (copy.originalSha256) {
                    await verifyOriginalDigest(await decryptOriginal(original, key), copy.originalSha256);
                    guard();
                }
                const month = copy.originalMonth ?? copy.statement.billingMonth;
                try {
                    guard();
                    await this.client.uploadDatedOriginal(copy.originalId, original, month);
                    guard();
                }
                catch (error) {
                    if (!isConflict(error))
                        throw error;
                    const existing = await this.client.downloadDatedOriginal(copy.originalId, month);
                    if (existing !== original)
                        throw new Error('移行先PDF原本が既存ファイルと一致しません。');
                }
                // Read back before allowing any index to point to this original.
                if (await this.client.downloadDatedOriginal(copy.originalId, month) !== original)
                    throw new Error('PDF原本の移行検証に失敗しました。');
                copy.originalMonth = month;
            }
            bucket(year).records.push(copy);
        }
        // The year is unknown for tombstones of already-deleted records.
        if (old.deleted.length)
            bucket('undated').deleted.push(...old.deleted);
        for (const conflict of old.conflicts) {
            const rec = old.records.find(r => r.id === conflict.recordId);
            bucket(statementBucket(rec?.statement.billingMonth)).conflicts.push(clone(conflict));
        }
        const years = [...byYear.keys()].sort();
        for (const year of years) {
            const expected = byYear.get(year);
            let file = await this.client.readYearVault(year);
            if (!file) {
                try {
                    const encrypted = await encryptDocument(expected, key, salt);
                    guard();
                    await this.client.writeYearVault(year, encrypted, null);
                    guard();
                }
                catch (error) {
                    if (!isConflict(error))
                        throw error;
                }
                file = await this.client.readYearVault(year);
            }
            if (!file)
                throw new Error(`${year}年の明細移行に失敗しました。`);
            const env = parseEnvelope(file.text);
            if (env.salt !== salt)
                throw new Error('移行先の暗号化ソルトが異なります。');
            const actual = await decryptDocument(env, key);
            if (JSON.stringify(actual) !== JSON.stringify(expected))
                throw new Error(`${year}年の移行先データが一致しません。旧保管庫は保持されています。`);
        }
        guard();
        await this.client.ensurePayrollNamespace();
        guard();
        // A competing client may have completed migration while we were working.
        try {
            const encrypted = await encryptIndex({ format: 'finance-cloud-index-v1', years }, key, salt, null, true);
            guard();
            await this.client.writeFinanceIndex(encrypted, null);
            guard();
        }
        catch (error) {
            if (!isConflict(error))
                throw error;
        }
        const check = await this.client.readFinanceIndex();
        if (!check)
            throw new Error('クラウド索引の移行検証に失敗しました。');
        const env = parseIndexEnvelope(check.text);
        if (env.salt !== salt)
            throw new Error('移行中に別のクラウド保管庫が作成されました。');
        const index = await decryptIndex(env, key);
        if (years.some(year => !index.years.includes(year)))
            throw new Error('クラウド索引に移行済み年度が登録されていません。');
    }
    /** Loading an absent rule file is valid for existing installations. */
    async readMerchantRules(key, salt, fresh = false) {
        // Older isolated test doubles may not expose the new optional Graph endpoint.
        if (typeof this.client.readMerchantRules !== 'function')
            return { document: emptyRules(), ref: null };
        const remote = await this.client.readMerchantRules(fresh);
        if (!remote) {
            if (this.rulesRef || this.rulesNeedRefresh)
                throw new Error('既存の利用先ルールファイルがOneDriveから消失したか、保存結果を確認できません。空の設定で上書きしません。');
            return { document: emptyRules(), ref: null };
        }
        if (this.key === key && this.salt === salt && !this.rulesNeedRefresh &&
            this.rulesRef?.id === remote.id && this.rulesRef.etag === remote.etag)
            return { document: clone(this.rulesDocument), ref: { id: remote.id, etag: remote.etag } };
        const document = await decryptRules(remote.text, key, salt);
        return { document, ref: { id: remote.id, etag: remote.etag } };
    }
    async upsertMerchantRule(rule) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        let valid = validateRule(rule);
        const next = clone(this.rulesDocument);
        if (valid.fixedCost) {
            const key = fixedRuleKey(valid), receipts = new Set(next.fixedCostMigrations ?? []);
            const matching = (this.assetsDocument.fixedCosts ?? []).filter(x => migratableCardCost(x) && !receipts.has(x.id) && x.merchantKey === key && ruleOverlapsContract(valid, x));
            if (matching.length > 1)
                throw new Error('同じ利用先の旧固定費が複数あります。固定費管理で確認してください。');
            if (!valid.fixedCost.legacyId && matching.length === 1) {
                const legacy = matching[0];
                valid = validateRule({ ...valid, fixedCost: { ...legacyRuleFixedCost(legacy), ...valid.fixedCost, legacyId: legacy.id } });
            }
            if (valid.fixedCost?.legacyId && !receipts.has(valid.fixedCost.legacyId)) {
                const legacy = (this.assetsDocument.fixedCosts ?? []).find(x => x.id === valid.fixedCost.legacyId);
                if (!legacy || !migratableCardCost(legacy) || legacy.merchantKey && legacy.merchantKey !== key && !valid.fixedCost.previous?.some(p => p.key === legacy.merchantKey))
                    throw new Error('旧固定費との紐付けを確認できません。');
            }
            for (const contract of originContracts(this.assetsDocument)) {
                if (receipts.has(contract.id) || contract.id === valid.fixedCost?.legacyId)
                    continue;
                if (ruleOverlapsContract(valid, contract))
                    throw new Error('同じ利用先に既存の固定費があります。既存契約から編集してください。');
            }
        }
        const index = next.rules.findIndex(x => x.id === valid.id);
        if (index >= 0)
            next.rules[index] = valid;
        else
            next.rules.push(valid);
        next.deleted = next.deleted.filter(x => x !== valid.id);
        if (valid.fixedCost?.legacyId)
            next.fixedCostMigrations = [...new Set([...(next.fixedCostMigrations ?? []), valid.fixedCost.legacyId])];
        await this.commitMerchantRules(next);
    }
    async setCategoryColor(id, color) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        if (!CATEGORIES.some(c => c.id === id) || !PALETTE.some(c => c.id === color))
            throw new Error('カテゴリーの色設定が不正です。');
        const next = clone(this.rulesDocument);
        next.categoryColors = { ...next.categoryColors, [id]: color };
        if (next.categoryDefinitions)
            next.categoryDefinitions = next.categoryDefinitions.map(item => item.id === id ? { ...item, color } : item);
        await this.commitMerchantRules(next);
    }
    async upsertCategory(category) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        const valid = validateCategory(category);
        const next = clone(this.rulesDocument);
        const existing = listCategories(next);
        if (existing.some(item => item.id !== valid.id && item.name.toLocaleLowerCase() === valid.name.toLocaleLowerCase()))
            throw new Error('同じ名前のカテゴリーがすでにあります。');
        if (next.deletedCategories?.includes(valid.id))
            throw new Error('削除したカテゴリーIDは再利用できません。');
        const list = next.categoryDefinitions ?? [];
        const position = list.findIndex(item => item.id === valid.id);
        if (position >= 0)
            list[position] = valid;
        else
            list.push(valid);
        next.categoryDefinitions = list;
        await this.commitMerchantRules(next);
    }
    /** Commit a complete modal edit in one encrypted Graph transaction, including removals. */
    async applyCategoryBatch(changes) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        const upserts = changes.upserts.map(validateCategory);
        const removeIds = new Set(changes.removeIds);
        if (upserts.some(item => removeIds.has(item.id)))
            throw new Error('更新と削除が重複しています。');
        const next = clone(this.rulesDocument);
        const existing = listCategories(next);
        for (const id of removeIds) {
            if (!existing.some(item => item.id === id))
                throw new Error('削除対象のカテゴリーが存在しません。');
        }
        for (const category of upserts) {
            if (next.deletedCategories?.includes(category.id))
                throw new Error('削除済みのカテゴリーIDは再利用できません。');
        }
        const final = new Map(existing.filter(item => !removeIds.has(item.id)).map(item => [item.id, item]));
        for (const category of upserts)
            final.set(category.id, category);
        if (final.size > 160)
            throw new Error('カテゴリー数が上限を超えています。');
        const names = new Set();
        for (const item of final.values()) {
            const key = item.name.normalize('NFKC').toLocaleLowerCase();
            if (names.has(key))
                throw new Error('同じ名前のカテゴリーが重複しています。');
            names.add(key);
        }
        next.rules = next.rules.map(rule => rule.categoryId && removeIds.has(rule.categoryId) ? { ...rule, categoryId: null } : rule);
        next.categoryDefinitions = (next.categoryDefinitions ?? []).filter(item => !removeIds.has(item.id));
        for (const category of upserts) {
            const idx = next.categoryDefinitions.findIndex(item => item.id === category.id);
            if (idx >= 0)
                next.categoryDefinitions[idx] = category;
            else
                next.categoryDefinitions.push(category);
        }
        if (removeIds.size) {
            next.deletedCategories = [...new Set([...(next.deletedCategories ?? []), ...removeIds])];
            if (next.categoryColors)
                for (const id of removeIds)
                    delete next.categoryColors[id];
        }
        await this.commitMerchantRules(next);
    }
    async removeCategory(id) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        if (!listCategories(this.rulesDocument).some(item => item.id === id))
            throw new Error('対象のカテゴリーがありません。');
        const next = clone(this.rulesDocument);
        const used = next.rules.filter(rule => rule.categoryId === id).length;
        next.rules = next.rules.map(rule => rule.categoryId === id ? { ...rule, categoryId: null } : rule);
        next.categoryDefinitions = (next.categoryDefinitions ?? []).filter(item => item.id !== id);
        next.deletedCategories = [...new Set([...(next.deletedCategories ?? []), id])];
        if (next.categoryColors)
            delete next.categoryColors[id];
        await this.commitMerchantRules(next);
        return used;
    }
    async removeMerchantRule(id) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        const next = clone(this.rulesDocument);
        next.rules = next.rules.filter(rule => rule.id !== id);
        if (!next.deleted.includes(id))
            next.deleted.push(id);
        await this.commitMerchantRules(next);
    }
    async commitMerchantRules(local) {
        return traceFinanceOperation('rule-save', async () => {
            return measureFinancePhase('vault.rule-commit', async () => {
                if (this.rotating)
                    throw new Error('保管庫の更新・整理中です。');
                if (this.rulesNeedRefresh)
                    this.uncertainWrite('rules', null);
                if (!this.key)
                    throw new Error('保管庫がロックされています。');
                if (this.rulesSaving)
                    throw new CloudEditCancelledError('利用先ルールを保存中です。完了後にもう一度操作してください。');
                if (typeof this.client.writeMerchantRules !== 'function')
                    throw new Error('OneDriveの利用先ルール保存機能がありません。');
                // Capture the document and ETag synchronously with the caller's draft.
                const guard = this.approvalGuard(), key = this.key, base = clone(this.rulesDocument);
                const baselineRef = this.rulesRef ? { ...this.rulesRef } : null;
                const fixedChanges = changedFixedRules(base, local), assetBase = fixedChanges.size ? clone(this.assetsDocument) : null;
                this.rulesSaving = true;
                this.settingsRevision++;
                try {
                    // The mutation lease checks the active generation before any write.
                    const firstRemote = await this.client.readMerchantRules();
                    guard();
                    for (let attempt = 0; attempt < 5; attempt++) {
                        guard();
                        const remote = attempt === 0 ? firstRemote : await this.client.readMerchantRules();
                        guard();
                        if (baselineRef && !remote)
                            throw new Error('OneDriveの利用先ルールファイルが消去されています。上書きせず停止します。');
                        const unchanged = !!remote && baselineRef?.id === remote.id && baselineRef.etag === remote.etag;
                        const remoteDoc = remote ? (unchanged ? clone(base) : await decryptRules(remote.text, key, this.salt)) : emptyRules();
                        const collisions = detectRuleEditCollisions(base, local, remoteDoc);
                        guard();
                        if (collisions.length) {
                            await this.assertActiveGeneration();
                            guard();
                        }
                        await this.approveCollision(collisions, this.ruleConflictResolver, '利用先ルール・カテゴリー');
                        guard();
                        const merged = mergeRules(base, local, remoteDoc, new Date().toISOString(), undefined, collisions.length > 0);
                        const encrypted = await encryptRules(merged, key, this.salt);
                        guard();
                        let writeReturned = false;
                        try {
                            await this.withMutation(guard, async () => {
                                if (assetBase) {
                                    try {
                                        const latestRules = await this.readMerchantRules(key, this.salt, true);
                                        guard();
                                        if (!sameRef(latestRules.ref, remote))
                                            throw new GraphError(412, 'fixed-cost rules changed');
                                        const latestAssets = await this.readAssets(key, this.salt, true);
                                        guard();
                                        this.verifyFixedRuleChanges(assetBase, latestAssets.document, latestRules.document, merged, fixedChanges);
                                    }
                                    catch (error) {
                                        if (isConflict(error) || error instanceof CloudEditCancelledError)
                                            throw error;
                                        throw new CloudEditCancelledError('最新の固定費情報を確認できないため保存を中止しました。');
                                    }
                                }
                                if (merged.rules.some(({ fixedCost: f }) => f && (f.previous?.some(route => route.startOn !== undefined) || !!f.endOn && f.endOn < f.startOn)))
                                    await this.requireWriterV4(key, guard);
                                const result = await this.client.writeMerchantRules(encrypted, remote ? { id: remote.id, etag: remote.etag } : null);
                                writeReturned = true;
                                guard();
                                if (result?.id && result.etag) {
                                    this.rulesDocument = merged;
                                    this.rulesRef = { id: result.id, etag: result.etag };
                                }
                                else {
                                    // The upload resolved without a usable ETag. The read-back itself may fail.
                                    const verified = await this.readMerchantRules(key, this.salt, true);
                                    if (!verified.ref || JSON.stringify(verified.document) !== JSON.stringify(merged))
                                        throw new Error('保存先の内容を今回の変更と照合できませんでした。');
                                    guard();
                                    this.rulesDocument = verified.document;
                                    this.rulesRef = verified.ref;
                                }
                            });
                            return;
                        }
                        catch (error) {
                            if (!writeReturned && isConflict(error))
                                continue;
                            if (!writeReturned && error instanceof CloudEditCancelledError)
                                throw error;
                            if (writeReturned || !isDefiniteWriteRejection(error))
                                this.uncertainWrite('rules', error);
                            throw error;
                        }
                    }
                    throw new Error('利用先ルールの同時更新が続いています。再試行してください。');
                }
                finally {
                    this.rulesSaving = false;
                    this.settingsRevision++;
                }
            });
        });
    }
    verifyFixedRuleChanges(base, current, remote, merged, changed) {
        const receipts = new Set(remote.fixedCostMigrations ?? []);
        const contracts = originContracts(current);
        const reject = () => { throw new CloudEditCancelledError('固定費が別端末で移行・変更されました。最新データを取得して確認してください。'); };
        for (const rule of merged.rules) {
            if (!changed.has(rule.id) || !rule.fixedCost)
                continue;
            const legacyId = rule.fixedCost.legacyId;
            if (legacyId) {
                if (receipts.has(legacyId)) {
                    if (!remote.rules.some(x => x.id === rule.id && x.fixedCost?.legacyId === legacyId))
                        reject();
                }
                else {
                    const before = (base.fixedCosts ?? []).find(x => x.id === legacyId), now = (current.fixedCosts ?? []).find(x => x.id === legacyId);
                    if (!before || !now || !migratableCardCost(now) || !sameContract(now, before) || (now.merchantKey ? !keysOfRule(rule).has(now.merchantKey) : now.cardId !== rule.cardId))
                        reject();
                }
            }
            for (const contract of contracts) {
                if (receipts.has(contract.id) || contract.id === legacyId)
                    continue;
                if (ruleOverlapsContract(rule, contract))
                    reject();
            }
        }
    }
    async readAssets(key, salt, fresh = false) {
        // Existing vaults may not have an assets file yet; do not create one until first save.
        if (typeof this.client.readAssetSettings !== 'function')
            return { document: emptyAssets(), ref: null };
        const baseline = this.key === key && this.salt === salt ? this.assetsDocument : null;
        const remote = await this.client.readAssetSettings(fresh);
        // Missing on the first ever unlock is valid (legacy vault). Disappearing
        // after a verified read is not: never replace previously loaded settings
        // with empty defaults after a folder rename or remote deletion.
        if (!remote) {
            if (this.assetsRef)
                throw new Error('既存の資産設定ファイルがOneDriveから消失しました。空の設定で上書きしません。');
            return { document: emptyAssets(), ref: null };
        }
        if (this.key === key && this.salt === salt && !this.assetsNeedRefresh &&
            this.assetsRef?.id === remote.id && this.assetsRef.etag === remote.etag)
            return { document: clone(this.assetsDocument), ref: { id: remote.id, etag: remote.etag } };
        const document = await decryptAssets(remote.text, key, salt);
        if (baseline)
            assertAccountRouteContinuity(baseline, document);
        return { document, ref: { id: remote.id, etag: remote.etag } };
    }
    /** Invalidate zero evidence BEFORE writing a statement, while holding the
     * same cross-device mutation right. A failed subsequent year write may
     * require reconfirmation, but can never revive a superseded zero. */
    affectedNoUseMonths(latest, merged) {
        const months = new Set();
        const add = (record) => { const month = statementPeriod(record.statement); if (month)
            months.add(month); };
        const previous = new Map(latest.records.map(record => [record.id, record]));
        const financial = (record) => {
            const s = record.statement;
            return JSON.stringify([s.provider, s.cardId, s.billingMonth, s.paymentDate, s.statedTotal, s.confirmation, s.zeroUsage,
                s.sourceKind, record.originalId, record.originalMonth, s.rows.map(row => row.amount).sort((a, b) => a - b)]);
        };
        for (const record of merged.records) {
            const before = previous.get(record.id);
            previous.delete(record.id);
            if (!before || financial(before) !== financial(record)) {
                add(record);
                if (before)
                    add(before);
            }
        }
        // Deletion must not revive legacy contradictory zero confirmations.
        for (const record of previous.values())
            add(record);
        return months;
    }
    async revokeCardNoUseBeforeYear(months, key, guard) {
        if (!months.size)
            return;
        if (this.assetsNeedRefresh)
            this.uncertainWrite('assets', null);
        let state;
        try {
            state = await this.readAssets(key, this.salt, true);
            guard();
        }
        catch (error) {
            guard();
            throw new CloudEditCancelledError('利用なし確認の最新状態を取得できないため明細保存を停止しました。');
        }
        const next = clone(state.document);
        if (next.cardNoUseMonths?.some(month => months.has(month))) {
            next.cardNoUseMonths = next.cardNoUseMonths.filter(month => !months.has(month));
            const encrypted = await encryptAssets(next, key, this.salt);
            guard();
            let writeReturned = false;
            try {
                const result = await this.client.writeAssetSettings(encrypted, state.ref);
                writeReturned = true;
                guard();
                if (result?.id && result.etag)
                    state = { document: next, ref: result };
                else {
                    const verified = await this.readAssets(key, this.salt, true);
                    guard();
                    if (!verified.ref || JSON.stringify(verified.document) !== JSON.stringify(next))
                        throw new Error('利用なし確認の取消を照合できませんでした。');
                    state = verified;
                }
            }
            catch (error) {
                guard();
                if (writeReturned || !isDefiniteWriteRejection(error))
                    this.uncertainWrite('assets', error);
                throw error;
            }
        }
        guard();
        this.assetsDocument = state.document;
        this.assetsRef = state.ref;
        return state;
    }
    async addBalanceSnapshot(snapshot) {
        await this.addBalanceSnapshots([snapshot]);
    }
    /** Saves all entered account balances in a single encrypted Graph commit. */
    async addBalanceSnapshots(snapshots) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        if (!snapshots.length)
            throw new Error('登録する残高がありません。');
        const next = clone(this.assetsDocument);
        const usedIds = new Set([...next.snapshots.map(item => item.id), ...next.deletedSnapshots]);
        for (const snapshot of snapshots) {
            const valid = validateSnapshot(snapshot);
            if (usedIds.has(valid.id))
                throw new Error('同じ残高記録IDは登録できません。');
            usedIds.add(valid.id);
            next.snapshots.push(valid);
        }
        await this.commitAssets(next);
    }
    async deleteBalanceSnapshot(id) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        if (!next.snapshots.some(item => item.id === id))
            throw new Error('削除対象の残高記録がありません。');
        next.snapshots = next.snapshots.filter(item => item.id !== id);
        next.deletedSnapshots.push(id);
        await this.commitAssets(next);
    }
    /** Single dated movements are encrypted with the rest of assets.enc. */
    async upsertOneTime(entry, funding) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const valid = validateOneTime(entry), next = clone(this.assetsDocument);
        if (next.deletedOneTime?.includes(valid.id))
            throw new Error('削除済みの入出金IDは再利用できません。');
        // A new actual card-funding record replaces the automatic estimate. Guard
        // both the local and remote settings so two devices cannot create two such
        // records for the same invoice through the dedicated entry route.
        const fundingGuard = funding ? (current) => {
            const bill = { cardId: 'rakuten-mizuho', paymentDate: funding.paymentDate, amount: funding.billAmount };
            const window = mizuhoFundingWindow(bill.paymentDate, current.mizuhoTransferPlan?.leadDays ?? 3);
            const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            if (!window || valid.date < window.first || valid.date > window.last || valid.date > today || valid.status !== 'done' || !valid.cardFunding)
                throw new CloudEditCancelledError('実際の送金日・金額・振替先・実行済み状態を確認してください。');
            if (current.oneTime?.some(e => e.id === valid.id) || !mizuhoTransferForBill(bill, current))
                throw new CloudEditCancelledError('振替が登録されているか送金設定が変更されています。最新情報を取得して既存の記録を確認してください。');
        } : undefined;
        fundingGuard?.(next);
        const items = next.oneTime ?? [];
        const i = items.findIndex(e => e.id === valid.id);
        if (i >= 0)
            items[i] = valid;
        else
            items.push(valid);
        next.oneTime = items;
        await this.commitAssets(next, undefined, undefined, fundingGuard);
    }
    async deleteOneTime(id) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        if (!next.oneTime?.some(e => e.id === id))
            throw new Error('対象の単発入出金が見つかりません。');
        next.oneTime = next.oneTime.filter(e => e.id !== id);
        next.deletedOneTime = [...(next.deletedOneTime ?? []), id];
        await this.commitAssets(next);
    }
    async upsertRecurring(entry) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const valid = validateRecurring(entry), next = clone(this.assetsDocument);
        if (next.deletedRecurring.includes(valid.id))
            throw new Error('削除済みの定期入出金IDは再利用できません。');
        const index = next.recurring.findIndex(item => item.id === valid.id);
        if (index >= 0) {
            const original = next.recurring[index];
            if (JSON.stringify(original.paymentHistory) !== JSON.stringify(valid.paymentHistory))
                throw new Error('支払条件履歴は専用の変更操作が必要です。');
            if (valid.pricing === undefined) {
                valid.pricing = original.pricing ? clone(original.pricing) : undefined;
                if (valid.amount !== original.amount) {
                    const today = new Date().toLocaleDateString('sv-SE');
                    const effectiveOn = today < original.startOn ? original.startOn : today;
                    const entries = valid.pricing ?? [{ effectiveOn: original.startOn, amount: original.amount }];
                    if (effectiveOn < entries.at(-1).effectiveOn)
                        throw new Error('新しい料金の適用日が既存履歴より前です。固定費管理で変更してください。');
                    if (effectiveOn === entries.at(-1).effectiveOn)
                        entries[entries.length - 1] = { effectiveOn, amount: valid.amount };
                    else
                        entries.push({ effectiveOn, amount: valid.amount });
                    valid.pricing = entries;
                }
            }
            if (valid.pauses === undefined)
                valid.pauses = original.pauses;
            if (valid.priceKind === undefined)
                valid.priceKind = original.priceKind;
            if (valid.note === undefined)
                valid.note = original.note;
            next.recurring[index] = validateRecurring(valid);
        }
        else {
            if (valid.paymentHistory)
                throw new Error('支払条件履歴は専用の変更操作が必要です。');
            next.recurring.push(valid);
        }
        await this.commitAssets(next);
    }
    /** One encrypted assets commit for the contract plus any candidate registration. */
    async upsertFixedCost(entry, decision) {
        if (!this.key || this.rotating)
            throw new Error('OneDrive保管庫を解除してください。');
        const next = clone(this.assetsDocument), records = [...(next.fixedCosts ?? [])];
        if (next.deletedFixedCosts?.includes(entry.id))
            throw new Error('削除済みの固定費IDは再利用できません。');
        const index = records.findIndex(x => x.id === entry.id);
        if (JSON.stringify(records[index]?.paymentHistory) !== JSON.stringify(entry.paymentHistory))
            throw new Error('支払条件履歴は専用の変更操作が必要です。');
        if (index >= 0)
            records[index] = entry;
        else
            records.push(entry);
        next.fixedCosts = validateFixedCosts(records, next.format !== 'finance-assets-v1') ?? [];
        let candidateGuard;
        if (decision) {
            const key = cardRecurringKey(decision.cardId, decision.merchant);
            const moved = entry.cardId !== decision.cardId;
            if (!entry.merchantKey || entry.payment !== 'card' || !entry.cardId ||
                (moved ? (index >= 0 || decision.state !== 'ignored' || entry.merchantKey !== cardRecurringKey(entry.cardId, decision.merchant)) : decision.state !== 'registered' || entry.merchantKey !== key))
                throw new Error('カード定期支出の対応関係が不正です。');
            const preferences = validateCardRecurringDecisions({ [key]: decision });
            if (moved) {
                const targetKey = entry.merchantKey;
                candidateGuard = current => {
                    const keys = contractMerchantKeys(current), decisions = current.cardRecurringDecisions ?? {};
                    if (keys.has(key) || keys.has(targetKey) || decisions[key] || decisions[targetKey]?.state === 'registered')
                        throw new CloudEditCancelledError('候補または変更先がすでに登録・確認されています。最新情報を取得してください。');
                };
                candidateGuard(this.assetsDocument);
            }
            next.cardRecurringDecisions = { ...(next.cardRecurringDecisions ?? {}), [key]: preferences[key] };
        }
        await this.commitAssets(next, undefined, undefined, candidateGuard);
    }
    /** All edited fields and dated changes use one conditional encrypted write. */
    async editContract(expected, edit) {
        if (!this.key || this.rotating)
            throw new Error('OneDrive保管庫を解除してください。');
        const base = clone(this.assetsDocument), next = clone(base);
        const current = originContracts(base).find(x => x.id === expected.id);
        if (!current || !sameContract(current, expected))
            throw new CloudEditCancelledError('契約が更新されました。最新情報から編集してください。');
        const today = new Date().toLocaleDateString('sv-SE');
        const updated = applyContractEdit(current, edit, today);
        const initial = !!edit.payment && 'terms' in edit.payment && !edit.payment.replaceDate && edit.payment.effectiveOn === current.startOn && today < current.startOn && !current.paymentHistory;
        if (('kind' in current) !== ('kind' in updated)) {
            if (!initial)
                throw new Error('開始済みの契約は保存先を変更できません。');
            if ('kind' in updated) {
                next.fixedCosts = next.fixedCosts.filter(x => x.id !== updated.id);
                next.deletedFixedCosts = [...new Set([...(next.deletedFixedCosts ?? []), updated.id])];
                next.deletedRecurring = next.deletedRecurring.filter(id => id !== updated.id);
                next.recurring.push(updated);
            }
            else {
                next.recurring = next.recurring.filter(x => x.id !== updated.id);
                next.deletedRecurring = [...new Set([...next.deletedRecurring, updated.id])];
                next.deletedFixedCosts = (next.deletedFixedCosts ?? []).filter(id => id !== updated.id);
                next.fixedCosts = [...(next.fixedCosts ?? []), { ...updated, updatedAt: new Date().toISOString() }];
            }
        }
        else if ('kind' in updated)
            next.recurring = next.recurring.map(x => x.id === updated.id ? updated : x);
        else
            next.fixedCosts = next.fixedCosts.map(x => x.id === updated.id ? { ...updated, updatedAt: new Date().toISOString() } : x);
        // A registered candidate must not turn into an independent legacy contract
        // when its sole, not-yet-active route is corrected. Retain ignored decisions.
        const oldKey = initial && !('kind' in current) ? current.merchantKey : null;
        const decision = oldKey ? base.cardRecurringDecisions?.[oldKey] : undefined;
        const removeDecision = !!oldKey && decision?.state === 'registered' && !originContracts(next).some(x => ('kind' in x ? false : x.merchantKey === oldKey) || x.paymentHistory?.some(t => t.merchantKey === oldKey));
        if (removeDecision && oldKey)
            delete next.cardRecurringDecisions[oldKey];
        if (edit.payment && next.format === 'finance-assets-v1')
            next.format = 'finance-assets-v2';
        if (updated.endOn !== null && updated.endOn < updated.startOn)
            next.format = 'finance-assets-v3';
        await this.commitAssets(validateAssets(next), { base, expected: current }, undefined, initial ? remote => {
            if (new Date().toLocaleDateString('sv-SE') >= current.startOn)
                throw new CloudEditCancelledError('契約開始日になりました。最新情報から編集してください。');
            if (removeDecision && oldKey && (JSON.stringify(remote.cardRecurringDecisions?.[oldKey]) !== JSON.stringify(decision) || originContracts(remote).some(x => x.id !== current.id && (('kind' in x ? false : x.merchantKey === oldKey) || x.paymentHistory?.some(t => t.merchantKey === oldKey)))))
                throw new CloudEditCancelledError('カード定期支出の登録内容が変更されました。最新情報から編集してください。');
        } : undefined);
    }
    /** Append dated routing without rewriting the original record. Compare the
     * exact reviewed contract again on every remote ETag retry, including deletion. */
    async changeContractPayment(expected, terms, effectiveOn) {
        if (!this.key || this.rotating)
            throw new Error('OneDrive保管庫を解除してください。');
        const base = clone(this.assetsDocument), next = clone(base);
        const current = originContracts(base).find(x => x.id === expected.id);
        if (!current || !sameContract(current, expected))
            throw new CloudEditCancelledError('契約が更新されました。最新情報から編集してください。');
        const today = new Date().toLocaleDateString('sv-SE');
        const paymentHistory = appendPaymentChange(current, terms, effectiveOn, today);
        if ('kind' in current) {
            next.recurring = next.recurring.map(x => x.id === current.id ? { ...x, paymentHistory } : x);
        }
        else {
            next.fixedCosts = next.fixedCosts.map(x => x.id === current.id ? { ...x, paymentHistory } : x);
        }
        if (next.format === 'finance-assets-v1')
            next.format = 'finance-assets-v2';
        await this.commitAssets(validateAssets(next), { base, expected: current });
    }
    /** Edit/cancel only a future change, under the same exact-contract ETag guard. */
    async reviseContractPayment(expected, expectedDate, replacement) {
        if (!this.key || this.rotating)
            throw new Error('OneDrive保管庫を解除してください。');
        const base = clone(this.assetsDocument), next = clone(base);
        const current = originContracts(base).find(x => x.id === expected.id);
        if (!current || !sameContract(current, expected))
            throw new CloudEditCancelledError('契約が更新されました。最新情報から編集してください。');
        const today = new Date().toLocaleDateString('sv-SE');
        const paymentHistory = reviseFuturePaymentChange(current, expectedDate, today, replacement);
        const updated = { ...current, paymentHistory };
        if (!paymentHistory)
            delete updated.paymentHistory;
        if ('kind' in current)
            next.recurring = next.recurring.map(x => x.id === current.id ? updated : x);
        else
            next.fixedCosts = next.fixedCosts.map(x => x.id === current.id ? updated : x);
        if (next.format === 'finance-assets-v1')
            next.format = 'finance-assets-v2';
        await this.commitAssets(validateAssets(next), { base, expected: current });
    }
    /** Undo mistaken formal registrations. Ending a valid contract keeps its history. */
    async deleteFixedCost(id) {
        if (!this.key || this.rotating)
            throw new Error('OneDrive保管庫を解除してください。');
        const next = clone(this.assetsDocument), existing = next.fixedCosts?.find(entry => entry.id === id);
        if (!existing)
            throw new Error('削除対象の固定費が見つかりません。');
        next.fixedCosts = next.fixedCosts.filter(entry => entry.id !== id);
        next.deletedFixedCosts = [...(next.deletedFixedCosts ?? []), id];
        if (existing.merchantKey && next.cardRecurringDecisions?.[existing.merchantKey]?.state === 'registered') {
            const remainder = { ...next.cardRecurringDecisions };
            delete remainder[existing.merchantKey];
            next.cardRecurringDecisions = remainder;
        }
        await this.commitAssets(next);
    }
    async setPayrollDepositAccount(account) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        const next = clone(this.assetsDocument);
        updatePayrollDepositRoute(next, account, new Date().toLocaleDateString('sv-SE'));
        await this.commitAssets(next);
    }
    /** Opt-in credential is stored only in the AES-GCM protected assets document. */
    async setPayrollAutoPassphrase(passphrase, expected = this.assetsDocument.payrollAutoPassphrase) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        const next = clone(this.assetsDocument);
        const check = (current) => {
            if (current.payrollAutoPassphrase !== expected)
                throw new CloudEditCancelledError('Payroll連携設定が変更されました。最新データを取得してから操作してください。');
        };
        check(this.assetsDocument);
        next.payrollAutoPassphrase = validatePayrollAutoPassphrase(passphrase);
        await this.commitAssets(next, undefined, undefined, check);
    }
    async setNisaCardRule(rule, today) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const date = today ?? (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
        const next = withUpdatedNisaCardRule(this.assetsDocument, rule, date);
        if (JSON.stringify(next) === JSON.stringify(this.assetsDocument))
            return;
        const funding = next.nisaCardRule?.bankFunding;
        const check = (current) => {
            if (funding?.kind === 'same' && !current.recurring.some(r => r.id === funding.recurringId && r.kind === 'transfer' && r.toAccountId === 'nisa' && r.fromAccountId !== null && r.fromAccountId !== 'nisa'))
                throw new CloudEditCancelledError('対応する銀行積立が変更または削除されました。最新の設定を確認してください。');
        };
        check(this.assetsDocument);
        await this.commitAssets(next, undefined, undefined, check);
    }
    async setBirthMonth(value) {
        if (!this.key)
            throw new Error('保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        const born = validateBirthMonth(value);
        if (born)
            next.birthMonth = born;
        else
            delete next.birthMonth;
        await this.commitAssets(next);
    }
    /** Manual monthly card-funding acknowledgement, persisted ONLY in encrypted assets. */
    async setCardNoUseMonth(month, confirmed) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const now = new Date(), maxMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        if (!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month) || month > maxMonth || typeof confirmed !== 'boolean')
            throw new Error('カード未利用の確認年月が不正です。');
        if (this.pendingYearBatch)
            throw new CloudEditCancelledError('未確認の明細保存を解決してから操作してください。');
        if (confirmed && this.readonlyRecords().some(record => statementPeriod(record.statement) === month))
            throw new Error('既にカード明細がある月は「利用なし」と確認できません。');
        const next = clone(this.assetsDocument);
        const months = new Set(next.cardNoUseMonths ?? []);
        if (confirmed)
            months.add(month);
        else
            months.delete(month);
        next.cardNoUseMonths = [...months].sort();
        await this.commitAssets(next, undefined, { month, confirmed });
    }
    async setMizuhoFundingChecked(month, done, snapshot) {
        if (!this.key)
            throw new Error('保管庫を解除してください。');
        const now = new Date(), current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const previousDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const previous = `${previousDate.getFullYear()}-${String(previousDate.getMonth() + 1).padStart(2, '0')}`;
        // The previous month's missed acknowledgement must be recoverable after
        // month rollover. Never accept arbitrary historic or future changes.
        if ((month !== current && month !== previous) || (month === current && now.getDate() < 12) || typeof done !== 'boolean')
            throw new Error('みずほ送金確認は当月12日以降、または前月分のみ操作できます。');
        const next = clone(this.assetsDocument);
        const matchingBills = this.readonlyRecords().filter(r => r.statement.cardId === 'rakuten-mizuho' && r.statement.paymentDate?.slice(0, 7) === month);
        const paymentDate = snapshot?.paymentDate ?? next.mizuhoFundingChecks?.[month]?.paymentDate ?? (matchingBills.length === 1 ? matchingBills[0]?.statement.paymentDate : null) ?? now.toLocaleDateString('sv-SE');
        if (!next.mizuhoTransferPlan?.enabled || cardDebitAccountOnDay(next, 'rakuten-mizuho', paymentDate) !== 'mizuho-bank')
            throw new Error('みずほ送金予測の設定を確認してください。');
        if (done) {
            if (!snapshot || !Number.isSafeInteger(snapshot.billAmount) || snapshot.billAmount <= 0 ||
                !Number.isSafeInteger(snapshot.transferAmount) || snapshot.transferAmount <= 0 ||
                typeof snapshot.billId !== 'string' || typeof snapshot.paymentDate !== 'string' || snapshot.paymentDate.slice(0, 7) !== month)
                throw new Error('確定済みの請求明細がないため、送金済みを記録できません。');
            // Check the currently unlocked vault, not a stale UI summary.
            const matches = this.readonlyRecords().filter(record => record.statement.cardId === 'rakuten-mizuho' &&
                record.statement.paymentDate?.slice(0, 7) === month);
            if (matches.length !== 1)
                throw new Error('この月の請求明細を一意に確認できません。');
            const record = matches[0], statement = record.statement;
            const total = statement.rows.reduce((sum, row) => sum + row.amount, 0);
            if (statement.confirmation !== 'confirmed' || record.id !== snapshot.billId ||
                statement.paymentDate !== snapshot.paymentDate || !Number.isSafeInteger(total) || total !== snapshot.billAmount ||
                estimateMizuhoTransferAmount(total, next.mizuhoTransferPlan.extraForSmallBills) !== snapshot.transferAmount)
                throw new Error('請求内容が変更されました。最新明細で送金額を再確認してください。');
        }
        const previousCheck = next.mizuhoFundingChecks?.[month];
        if (previousCheck?.done === done && (!done ||
            (previousCheck.billAmount === snapshot?.billAmount && previousCheck.paymentDate === snapshot?.paymentDate &&
                previousCheck.transferAmount === snapshot?.transferAmount && previousCheck.billId === snapshot?.billId)))
            return;
        next.mizuhoFundingChecks = { ...(next.mizuhoFundingChecks ?? {}), [month]: { done, updatedAt: now.toISOString(),
                ...(done ? { ...snapshot } : {}) } };
        await this.commitAssets(next);
    }
    async setBalanceWarningLimits(value) {
        if (!this.key)
            throw new Error('保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        next.balanceWarningLimits = validateBalanceWarningLimits(value);
        await this.commitAssets(next);
    }
    async setMizuhoTransferPlan(value) {
        if (!this.key)
            throw new Error('保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        next.mizuhoTransferPlan = validateMizuhoPlan(value);
        if (value.enabled)
            updateCardDebitRoutes(next, { ...next.cardDebitAccounts, 'rakuten-mizuho': 'mizuho-bank' }, new Date().toLocaleDateString('sv-SE'));
        await this.commitAssets(next);
    }
    async setCardDebitAccounts(value) {
        if (!this.key)
            throw new Error('保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        updateCardDebitRoutes(next, value, new Date().toLocaleDateString('sv-SE'));
        await this.commitAssets(next);
    }
    /** Atomically persist preference + debit account settings in one encrypted assets write. */
    async setCardConfiguration(preferences, debits) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        const cleanPrefs = validateCardPreferences(preferences) ?? {};
        const cleanDebits = validateCardDebitAccounts(debits) ?? {};
        if (next.mizuhoTransferPlan?.enabled && cleanDebits['rakuten-mizuho'] !== 'mizuho-bank')
            throw new Error('送金予測が有効です。みずほ楽天カードの引落口座は「みずほ銀行」を選んでください。');
        // A future-rate edit must not overwrite a concurrently revised schedule,
        // even if the general asset conflict dialog would permit overwriting.
        const rateFields = (pref) => JSON.stringify([pref?.pointRatePercent, pref?.pointRateHistory]);
        const today = new Date().toLocaleDateString('sv-SE');
        const futureEdits = Object.entries(next.cardPreferences ?? {}).flatMap(([id, old]) => {
            const latest = old.pointRateHistory?.at(-1);
            return latest && latest.effectiveOn > today && rateFields(old) !== rateFields(cleanPrefs[id])
                ? [{ id, old, latest, changed: cleanPrefs[id] }] : [];
        });
        const editedCards = [...new Set([...Object.keys(next.cardPreferences ?? {}), ...Object.keys(cleanPrefs)])].filter(id => JSON.stringify(next.cardPreferences?.[id]) !== JSON.stringify(cleanPrefs[id]));
        const originalRates = new Map(editedCards.map(id => [id, rateFields(next.cardPreferences?.[id])]));
        const rateGuard = editedCards.length ? (current) => {
            for (const [id, original] of originalRates) {
                if (rateFields(current.cardPreferences?.[id]) !== original)
                    throw new CloudEditCancelledError('還元率の変更予定が更新されました。最新情報を取得してください。');
            }
            const day = new Date().toLocaleDateString('sv-SE');
            for (const { id, old, latest, changed } of futureEdits) {
                if (latest.effectiveOn <= day || rateFields(current.cardPreferences?.[id]) !== rateFields(old))
                    throw new CloudEditCancelledError('還元率の変更予定が更新されたか、適用が開始されました。最新情報を取得してください。');
                const prefix = old.pointRateHistory.slice(0, -1), history = changed?.pointRateHistory ?? [];
                if (!history.length || changed?.pointRatePercent !== history.at(-1)?.ratePercent || JSON.stringify(history.slice(0, prefix.length)) !== JSON.stringify(prefix) || history.slice(prefix.length).some(entry => entry.effectiveOn < day))
                    throw new CloudEditCancelledError('適用済みの還元率履歴は変更できません。');
            }
        } : undefined;
        next.cardPreferences = cleanPrefs;
        updateCardDebitRoutes(next, cleanDebits, today);
        await this.commitAssets(next, undefined, undefined, rateGuard);
    }
    async setCardPreferences(value) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        next.cardPreferences = validateCardPreferences(value) ?? {};
        await this.commitAssets(next);
    }
    /** Analysis-only metadata; never inserted into the bank recurring schedule. */
    async setCardRecurringDecision(key, decision) {
        if (!this.key || this.rotating)
            throw new Error('OneDrive保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        const changes = { ...(next.cardRecurringDecisions ?? {}) };
        if (decision) {
            const validated = validateCardRecurringDecisions({ [key]: decision });
            changes[key] = validated[key];
        }
        else {
            if (!Object.prototype.hasOwnProperty.call(changes, key))
                return;
            delete changes[key];
        }
        next.cardRecurringDecisions = changes;
        await this.commitAssets(next);
    }
    /** Move a legacy display-name key to the stable issuer-merchant key in one cloud write. */
    async migrateCardRecurringDecision(fromKey, toKey, expected, decision) {
        if (!this.key || this.rotating)
            throw new Error('OneDrive保管庫を解除してください。');
        if (fromKey === toKey)
            return;
        const next = clone(this.assetsDocument);
        const previous = next.cardRecurringDecisions?.[fromKey];
        if (!previous || next.cardRecurringDecisions?.[toKey])
            throw new Error('移行対象の登録状態が変更されました。');
        if (JSON.stringify(previous) !== JSON.stringify(expected) || previous.cardId !== decision.cardId || previous.state !== decision.state)
            throw new Error('移行元の登録内容が更新されました。読み直してください。');
        const normalized = validateCardRecurringDecisions({ [toKey]: decision })[toKey];
        const updated = { ...(next.cardRecurringDecisions ?? {}) };
        delete updated[fromKey];
        updated[toKey] = normalized;
        next.cardRecurringDecisions = updated;
        await this.commitAssets(next);
    }
    async deleteRecurring(id) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        if (!next.recurring.some(item => item.id === id))
            throw new Error('削除対象の定期入出金がありません。');
        next.recurring = next.recurring.filter(item => item.id !== id);
        next.deletedRecurring.push(id);
        await this.commitAssets(next);
    }
    /** A single serialized assets document is saved with Graph ETag and three-way merge. */
    assetsSaving = false;
    async commitAssets(local, historyGuard, noUse, rateGuard) {
        return traceFinanceOperation('settings-save', async () => {
            return measureFinancePhase('vault.asset-commit', async () => {
                if (this.rotating)
                    throw new Error('保管庫の更新・整理中です。');
                if (this.assetsNeedRefresh)
                    this.uncertainWrite('assets', null);
                if (!this.key)
                    throw new Error('OneDrive保管庫がロックされています。');
                if (typeof this.client.writeAssetSettings !== 'function')
                    throw new Error('OneDriveの資産設定保存機能がありません。');
                if (this.assetsSaving)
                    throw new CloudEditCancelledError('資産設定を保存中です。完了後にもう一度操作してください。');
                if (historyGuard && JSON.stringify(historyGuard.base) !== JSON.stringify(this.assetsDocument))
                    throw new CloudEditCancelledError('資産設定が更新されました。最新情報から編集してください。');
                const guard = this.approvalGuard(), key = this.key, base = clone(this.assetsDocument);
                const baselineRef = this.assetsRef ? { ...this.assetsRef } : null;
                const fixedChanges = changedContracts(base, local);
                this.assetsSaving = true;
                this.settingsRevision++;
                try {
                    // Keep the special confirmation preflight; ordinary settings check under the mutation lease.
                    const firstRemote = noUse
                        ? (await Promise.all([this.assertActiveGeneration(), this.client.readAssetSettings(true)]))[1]
                        : await this.client.readAssetSettings();
                    guard();
                    for (let attempt = 0; attempt < 5; attempt++) {
                        guard();
                        const remote = attempt === 0 ? firstRemote : await this.client.readAssetSettings(!!noUse);
                        guard();
                        if (baselineRef && !remote)
                            throw new Error('資産設定ファイルがOneDriveから消失しています。上書きせず停止します。');
                        const unchanged = !!remote && baselineRef?.id === remote.id && baselineRef.etag === remote.etag;
                        const current = remote ? (unchanged ? clone(base) : await decryptAssets(remote.text, key, this.salt)) : emptyAssets();
                        if (historyGuard && !sameContract(originContracts(current).find(x => x.id === historyGuard.expected.id), historyGuard.expected))
                            throw new CloudEditCancelledError('契約が同時に変更または削除されました。最新情報を取得してください。');
                        rateGuard?.(current);
                        const collisions = detectAssetsEditCollisions(base, local, current);
                        if (collisions.some(c => c.field === 'paymentHistory'))
                            throw new CloudEditCancelledError('支払条件履歴が同時に変更されました。最新情報を取得して変更し直してください。');
                        guard();
                        if (collisions.length) {
                            if (!noUse) {
                                await this.assertActiveGeneration();
                                guard();
                            }
                            if (!this.assetConflictResolver)
                                throw new CloudEditCancelledError('別の端末でも同じ資産項目が変更されています。保存を停止しました。最新データを取得して確認してください。');
                            const details = describeAssetsEditCollisions(base, local, current, collisions);
                            const approved = await this.assetConflictResolver(collisions, details);
                            if (!approved)
                                throw new CloudEditCancelledError('同時編集のため保存を中止しました。OneDriveの内容は変更されていません。');
                        }
                        guard();
                        const merged = mergeAssets(base, local, current, new Date().toISOString(), collisions.length > 0);
                        if (noUse) {
                            const months = new Set(merged.cardNoUseMonths ?? []);
                            if (noUse.confirmed)
                                months.add(noUse.month);
                            else
                                months.delete(noUse.month);
                            merged.cardNoUseMonths = [...months].sort();
                            validateAssets(merged);
                        }
                        const encrypted = await encryptAssets(merged, key, this.salt);
                        guard();
                        let writeReturned = false;
                        try {
                            await this.withMutation(guard, async () => {
                                if (noUse?.confirmed) {
                                    let current;
                                    try {
                                        current = await this.readCurrent(key, this.salt, undefined, guard);
                                        guard();
                                    }
                                    catch (error) {
                                        guard();
                                        throw new CardNoUseRefreshRequired('最新のカード明細を確認できないため「利用なし」の保存を停止しました。');
                                    }
                                    if ([...current.shards.values()].some(shard => shard.document.records.some(record => statementPeriod(record.statement) === noUse.month)))
                                        throw new CardNoUseRefreshRequired('OneDriveにカード明細がある月は「利用なし」と確認できません。最新データを取得してください。');
                                    if (current.shards.size !== this.shards.size || [...current.shards].some(([year, shard]) => {
                                        const prior = this.shards.get(year)?.ref;
                                        return prior?.id !== shard.ref.id || prior?.etag !== shard.ref.etag;
                                    }))
                                        throw new CardNoUseRefreshRequired('明細が別端末で更新されています。最新データを取得してから利用なしを確認してください。');
                                }
                                rateGuard?.(current);
                                if (fixedChanges.size) {
                                    try {
                                        const latest = await this.readMerchantRules(key, this.salt, true);
                                        guard();
                                        const receipts = new Set(latest.document.fixedCostMigrations ?? []);
                                        for (const id of fixedChanges) {
                                            if (receipts.has(id))
                                                throw new CloudEditCancelledError('移行済み固定費は旧契約から変更できません。最新データを取得してください。');
                                            const contract = originContracts(merged).find(x => x.id === id);
                                            if (contract && latest.document.rules.some(rule => ruleOverlapsContract(rule, contract)))
                                                throw new CloudEditCancelledError('利用先ルールに同じ固定費が登録されています。最新データを取得してください。');
                                        }
                                    }
                                    catch (error) {
                                        if (error instanceof CloudEditCancelledError)
                                            throw error;
                                        throw new CloudEditCancelledError('最新の利用先ルールを確認できないため固定費の保存を中止しました。');
                                    }
                                }
                                if (merged.format === 'finance-assets-v3')
                                    await this.requireWriterV4(key, guard);
                                const result = await this.client.writeAssetSettings(encrypted, remote ? { id: remote.id, etag: remote.etag } : null);
                                writeReturned = true;
                                guard();
                                if (result?.id && result.etag) {
                                    this.assetsDocument = merged;
                                    this.assetsRef = { id: result.id, etag: result.etag };
                                }
                                else {
                                    const verified = await this.readAssets(key, this.salt, true);
                                    if (!verified.ref || JSON.stringify(verified.document) !== JSON.stringify(merged))
                                        throw new Error('保存先の内容を今回の変更と照合できませんでした。');
                                    guard();
                                    this.assetsDocument = verified.document;
                                    this.assetsRef = verified.ref;
                                }
                            });
                            return;
                        }
                        catch (error) {
                            if (!writeReturned && isConflict(error))
                                continue;
                            if (!writeReturned && error instanceof CloudEditCancelledError)
                                throw error;
                            if (writeReturned || !isDefiniteWriteRejection(error))
                                this.uncertainWrite('assets', error);
                            throw error;
                        }
                    }
                    throw new Error('資産設定の同時更新が続いています。再試行してください。');
                }
                finally {
                    this.assetsSaving = false;
                    this.settingsRevision++;
                }
            });
        });
    }
    findBucket(id) {
        for (const [year, { document }] of this.shards)
            if (document.records.some(x => x.id === id))
                return year;
        return null;
    }
    working(year, changes) {
        let doc = changes.get(year);
        if (!doc) {
            doc = clone(this.shards.get(year)?.document ?? emptyDocument());
            changes.set(year, doc);
        }
        return doc;
    }
    /** Review ordinary existing-record edits before any year or PDF write.
     * Source replacements and moves retain their stricter existing guards. */
    reviewBatchCollisions(items, fresh) {
        const proposed = new Map();
        for (const item of items) {
            if (!item.id)
                continue;
            const year = statementBucket(item.statement.billingMonth), base = this.shards.get(year)?.document;
            const prior = base?.records.find(r => r.id === item.id);
            if (!base || !prior)
                continue;
            const remote = fresh?.get(year)?.document.records.find(r => r.id === item.id);
            if (isConfirmationRegression(prior.statement, item.statement) || isConfirmationRegression(remote?.statement, item.statement))
                throw new CloudEditCancelledError('確定明細を未確定明細で置き換えることはできません。');
            if ((item.replace || item.source || prior.statement.sourceKind !== item.statement.sourceKind || prior.statement.confirmation !== item.statement.confirmation) && !sameContract(prior, remote))
                throw new CloudEditCancelledError('差し替え元の明細が別の操作で更新されました。最新データを確認してください。');
            if (remote && (remote.originalId !== prior.originalId || remote.originalMonth !== prior.originalMonth || remote.originalSha256 !== prior.originalSha256 || remote.statement.sourceKind !== prior.statement.sourceKind || remote.statement.confirmation !== prior.statement.confirmation))
                throw new CloudEditCancelledError('明細の原本または確定状態が変更されました。最新データを確認してください。');
            if (item.replace || item.source)
                continue;
            const changed = proposed.get(year) ?? clone(base);
            proposed.set(year, changed);
            const record = { id: item.id, statement: clone(item.statement), ...(prior.originalId ? { originalId: prior.originalId, originalMonth: prior.originalMonth ?? prior.statement.billingMonth ?? null, ...(prior.originalSha256 ? { originalSha256: prior.originalSha256 } : {}) } : {}) };
            changed.records[changed.records.findIndex(r => r.id === item.id)] = record;
            changed.deleted = changed.deleted.filter(id => id !== item.id);
        }
        const result = new Map();
        for (const [year, changed] of proposed) {
            const remote = fresh?.get(year);
            const collisions = detectDocumentEditCollisions(this.shards.get(year).document, changed, remote?.document ?? emptyDocument());
            if (collisions.length)
                result.set(year, { ref: remote?.ref ?? null, collisions });
        }
        return result;
    }
    async saveBatch(items, onProgress) {
        return traceFinanceOperation('statement-save', async () => {
            const guard = this.approvalGuard();
            // Hold one operation right across originals and their first references.
            if (this.pendingYearBatch)
                throw new CloudWriteUncertainError('未確認の保存があります。設定から保存を再開してください。', null);
            if (items.some(item => item.id && this.hasYearConflict(item.id)))
                throw new CloudEditCancelledError('年度間で競合した明細は通常保存できません。');
            const affected = new Set(), explicitIds = new Set(), moving = new Set(), targets = new Map();
            for (const item of items) {
                const target = statementBucket(item.statement.billingMonth);
                affected.add(target);
                if (item.id) {
                    explicitIds.add(item.id);
                    targets.set(item.id, target);
                    const old = this.findBucket(item.id);
                    if (old) {
                        affected.add(old);
                        if (old !== target)
                            moving.add(item.id);
                    }
                }
            }
            if (affected.size > 1 || items.some(item => item.statement.sourceKind === 'pdf' && item.source)) {
                let approved;
                let checkApprovedLocal;
                const run = () => this.withMutation(guard, async (lease, index) => {
                    checkApprovedLocal?.();
                    const fresh = await this.verifyYearEditScope(explicitIds, guard, moving, targets, index);
                    const review = this.reviewBatchCollisions(items, fresh?.shards);
                    if (approved) {
                        checkApprovedLocal?.();
                        if (!sameContract([...approved], [...review]))
                            throw new CloudEditCancelledError('承認した競合内容が変更されました。最新データを確認してください。');
                    }
                    else if (review.size)
                        throw new BatchApprovalRequired(review);
                    return this.saveBatchInternal(items, lease, onProgress, false, approved, index ? fresh : undefined);
                });
                try {
                    return await run();
                }
                catch (error) {
                    if (!(error instanceof BatchApprovalRequired))
                        throw error;
                    // The preflight performed no writes. withMutation has released its lock.
                    const localRevision = this.mutationRevision, localShards = new Map(this.shards);
                    const reviewedItems = items.map(item => ({ id: item.id, statement: clone(item.statement), replace: item.replace, source: item.source }));
                    const collisions = [...error.years.values()].flatMap(year => year.collisions);
                    await this.approveCollision(clone(collisions), this.statementConflictResolver, 'カード明細');
                    guard();
                    const checkLocal = (expectedRevision) => {
                        guard();
                        if (this.mutationRevision !== expectedRevision || localShards.size !== this.shards.size || [...localShards].some(([year, shard]) => this.shards.get(year) !== shard) ||
                            reviewedItems.length !== items.length || reviewedItems.some((item, i) => item.id !== items[i]?.id || item.replace !== items[i]?.replace || item.source !== items[i]?.source || !sameContract(item.statement, items[i]?.statement)))
                            throw new CloudEditCancelledError('承認中に編集内容が変更されました。最新データを確認してください。');
                    };
                    if (this.activeMutation)
                        throw new CloudEditCancelledError('別の保存処理が実行中です。');
                    checkLocal(localRevision);
                    checkApprovedLocal = () => checkLocal(localRevision + 1); // own lock acquisition only
                    approved = error.years;
                    return run();
                }
            }
            return this.saveBatchInternal(items, undefined, onProgress);
        });
    }
    async saveBatchInternal(items, lease, onProgress, deferRefresh = false, approved, scope) {
        const progress = (phase, done, total) => { try {
            onProgress?.(phase, done, total);
        }
        catch { /* UI feedback cannot interrupt storage. */ } };
        return measureFinancePhase('vault.save-batch', async () => {
            if (this.rotating)
                throw new Error('保管庫の更新・整理中です。');
            if (this.pendingYearBatch)
                throw new CloudWriteUncertainError('未確認の保存があります。設定から保存を再開してください。', null);
            if (!this.key)
                throw new Error('先にOneDrive保管庫を解除してください。');
            const guard = this.approvalGuard(), key = this.key, revision = this.lockRevision;
            progress("保存前検証", 0, items.length);
            // The outer mutation already checked the current generation after acquiring the lock.
            const generation = lease ? undefined : parseIndexEnvelope((await this.assertActiveGeneration()).text).format;
            guard();
            const changes = new Map();
            const ids = [];
            const moves = new Map();
            const before = new Map();
            const expected = new Map();
            // Read canonical references; only the affected records need a recovery copy.
            const existingRecords = new Map(this.canonicalRecords().map(record => [record.id, record]));
            const replacementIds = new Set();
            // Proof is local to this save and its existing operation lease; never cache across operations.
            const uploadedOriginals = new Set();
            let preparedCount = 0;
            for (const item of items) {
                guard();
                progress("原本の暗号化・送信と明細準備", preparedCount, items.length);
                let id = item.id ?? this.draftIds.get(item.statement);
                if (!id) {
                    id = crypto.randomUUID();
                    this.draftIds.set(item.statement, id);
                }
                ids.push(id);
                const prior = existingRecords.get(id);
                before.set(id, prior ? clone(prior) : null);
                if (item.replace && !prior)
                    throw new CloudEditCancelledError('差し替え元の明細がありません。最新データを確認してください。');
                if (isConfirmationRegression(prior?.statement, item.statement))
                    throw new CloudEditCancelledError('確定明細を未確定明細で置き換えることはできません。');
                if (prior && (item.replace || item.source || prior.statement.sourceKind !== item.statement.sourceKind || prior.statement.confirmation !== item.statement.confirmation))
                    replacementIds.add(id);
                const previousBucket = this.findBucket(id);
                const year = statementBucket(item.statement.billingMonth);
                let originalId = prior?.originalId;
                let originalSha256 = prior?.originalSha256;
                let originalMonth = prior?.originalMonth ?? prior?.statement.billingMonth ?? null;
                if (item.statement.zeroUsage !== undefined && (!isZeroUsage(item.statement) || importErrors(item.statement, !!item.source || !!originalId).length))
                    throw new Error('利用なし明細の形式が不正です。');
                if (item.statement.sourceKind === 'pdf' && item.source) {
                    if (item.source.mime !== 'application/pdf')
                        throw new Error('PDF原本のファイル形式が不正です。');
                    // Deterministic across retries for a draft; never overwrite an existing encrypted PDF.
                    let draft = this.pdfDrafts.get(item.source.bytes);
                    if (!draft) {
                        const bytes = new Uint8Array(item.source.bytes);
                        draft = { id: crypto.randomUUID(), month: item.statement.billingMonth, sha256: await originalDigest(bytes), encrypted: await encryptOriginal(bytes, key) };
                        guard();
                        this.pdfDrafts.set(item.source.bytes, draft);
                    }
                    originalId = draft.id;
                    originalMonth = draft.month;
                    originalSha256 = draft.sha256;
                    guard();
                    try {
                        const receipt = await this.client.uploadDatedOriginal(originalId, draft.encrypted, originalMonth);
                        guard();
                        if (lease && this.activeMutation === lease && receipt?.id && receipt.etag)
                            uploadedOriginals.add(`${originalMonth ?? 'undated'}:${originalId}:${originalSha256 ?? ''}`);
                    }
                    catch (error) {
                        if (!isConflict(error))
                            throw error;
                        // Retrying the same upload is safe only when the immutable ciphertext matches.
                        const existing = await this.client.downloadDatedOriginal(originalId, originalMonth);
                        if (existing !== draft.encrypted)
                            throw new Error('PDF原本の識別子が既存ファイルと衝突しました。');
                    }
                }
                guard();
                if (item.statement.sourceKind === 'pdf' && !originalId)
                    throw new Error('PDF原本がないため保存できません。');
                const record = { id, statement: clone(item.statement), ...(originalId ? { originalId, originalMonth, ...(originalSha256 ? { originalSha256 } : {}) } : {}) };
                expected.set(id, clone(record));
                const target = this.working(year, changes);
                const index = target.records.findIndex(r => r.id === id);
                if (index >= 0)
                    target.records[index] = record;
                else
                    target.records.push(record);
                target.deleted = target.deleted.filter(x => x !== id);
                if (previousBucket && previousBucket !== year) {
                    const ids = moves.get(previousBucket) ?? new Set();
                    ids.add(id);
                    moves.set(previousBucket, ids);
                }
                preparedCount++;
                progress("原本の暗号化・送信と明細準備", preparedCount, items.length);
            }
            // Multi-year writes are not atomic. Distinguish an uncertain result from a rejected edit.
            this.mutationWarning = null;
            let committedYears = 0;
            // Only the uncomplicated, already registered years can reuse the locked snapshot.
            // Moves, new years, approvals and writer-format changes retain the full refresh path.
            const writerV4Before = this.activeWriterV4;
            const reuseScope = lease && scope && !moves.size && !approved?.size && [...changes.keys()].every(year => this.index.years.includes(year) && scope.shards.has(year)) ? scope : undefined;
            const syncInCommit = (generation === 'finance-cloud-index-envelope-v3' || generation === 'finance-cloud-index-envelope-v4') && !lease && !deferRefresh && changes.size === 1 && !moves.size && [...changes.keys()].every(year => this.index.years.includes(year));
            try {
                // First put records into their destinations; only afterwards tombstone old-year copies.
                for (const [year, updated] of changes) {
                    guard();
                    progress("年度データ保存・原本検証", committedYears, changes.size + moves.size);
                    await this.commitYear(year, updated, new Set(ids), lease, replacementIds, uploadedOriginals, false, approved?.get(year), syncInCommit ? 'save' : false);
                    committedYears++;
                    progress("年度データ保存・原本検証", committedYears, changes.size + moves.size);
                }
                for (const [year, ids] of moves) {
                    guard();
                    progress("年度データ保存・原本検証", committedYears, changes.size + moves.size);
                    await this.removeMovedRecords(year, ids, lease);
                    committedYears++;
                    progress("年度データ保存・原本検証", committedYears, changes.size + moves.size);
                }
            }
            catch (error) {
                if (committedYears === 0 && (error instanceof CloudEditCancelledError || isDefiniteWriteRejection(error)))
                    throw error;
                if (this.key === key && this.lockRevision === revision)
                    this.pendingYearBatch = {
                        items: items.map((item, i) => ({ id: ids[i], statement: clone(item.statement), ...(item.source ? { source: item.source } : {}), ...(item.replace ? { replace: true } : {}) })),
                        before, expected, ids: [...ids],
                    };
                if (error instanceof CloudWriteUncertainError)
                    throw error;
                throw new CloudWriteUncertainError('一部の明細は保存済みの可能性があります。設定から保存を再開してください。', error);
            }
            const checkCommitted = () => { try {
                guard();
            }
            catch (error) {
                throw new CloudWriteUncertainError('保存中に保管庫が変更されました。最新データを確認してください。', error);
            } };
            checkCommitted();
            if (deferRefresh || syncInCommit)
                return ids; // Recovery or the single-year commit owns final sync.
            progress("保存結果の同期確認", 0, 1);
            try {
                const hint = reuseScope && writerV4Before === this.activeWriterV4 ? reuseScope : undefined;
                if (hint)
                    for (const year of changes.keys())
                        hint.shards.set(year, this.shards.get(year));
                await this.refresh(lease, false, hint);
            }
            catch {
                checkCommitted();
                this.mutationWarning = [this.mutationWarning, 'OneDriveへの保存は確認できましたが、最後の最新データ取得に失敗しました。通信回復後に取得してください。'].filter(Boolean).join(' ');
            }
            checkCommitted();
            return ids;
        });
    }
    /** Only after all destination writes succeed, remove old copies once per year. */
    async removeMovedRecords(year, ids, lease, strictBaseline = false) {
        const changed = clone(this.shards.get(year)?.document ?? emptyDocument());
        changed.records = changed.records.filter(record => !ids.has(record.id));
        changed.deleted = [...new Set([...changed.deleted, ...ids])];
        await this.commitYear(year, changed, undefined, lease, undefined, undefined, strictBaseline);
    }
    /** Compare all copies, not only the deduplicated view; original references are part of the record. */
    classifyPendingYearBatch(pending) {
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const pendingIds = new Set(pending.ids), months = new Set(pending.items.map(item => statementMonthKey(item.statement)));
        const copies = new Map();
        const byMonth = new Map();
        const deleted = new Map();
        for (const [year, shard] of this.shards) {
            for (const id of shard.document.deleted) {
                if (!pendingIds.has(id))
                    continue;
                const years = deleted.get(id) ?? [];
                years.push(year);
                deleted.set(id, years);
            }
            for (const record of shard.document.records) {
                if (pendingIds.has(record.id)) {
                    const list = copies.get(record.id) ?? [];
                    list.push({ year, record });
                    copies.set(record.id, list);
                }
                const month = statementMonthKey(record.statement);
                if (month && months.has(month)) {
                    const list = byMonth.get(month) ?? [];
                    list.push({ year, record });
                    byMonth.set(month, list);
                }
            }
        }
        return pending.items.map(item => {
            const before = pending.before.get(item.id) ?? null, expected = pending.expected.get(item.id);
            const target = statementBucket(item.statement.billingMonth), found = copies.get(item.id) ?? [];
            const destination = found.find(copy => copy.year === target);
            const unchanged = (copy) => !!before && copy.year === statementBucket(before.statement.billingMonth) && same(copy.record, before);
            let status = 'conflict';
            if (destination && same(destination.record, expected)) {
                if (found.length === 1)
                    status = 'saved';
                else if (found.length === 2 && found.some(copy => copy.year !== target && unchanged(copy)))
                    status = 'cleanup';
            }
            else if ((!before && !found.length && !deleted.has(item.id)) || (found.length === 1 && unchanged(found[0])))
                status = 'unsaved';
            // A different ID for the same card/month is also an intervening import.
            const monthKey = statementMonthKey(item.statement);
            const other = (monthKey ? byMonth.get(monthKey) ?? [] : []).filter(copy => copy.record.id !== item.id);
            if (status === 'unsaved' && other.length)
                status = 'conflict';
            const conflictFingerprint = status === 'conflict' ? JSON.stringify([
                expected, [...found].sort((a, b) => a.year.localeCompare(b.year)),
                [...(deleted.get(item.id) ?? [])].sort(), [...other].sort((a, b) => a.year.localeCompare(b.year) || a.record.id.localeCompare(b.record.id)),
            ]) : undefined;
            return { id: item.id, statement: clone(item.statement), status, ...(conflictFingerprint ? { conflictFingerprint } : {}) };
        });
    }
    /** Read only: never retry a write or clear the recovery plan while checking results. */
    async inspectPendingYearBatch() {
        return traceFinanceOperation('pending-check', async () => {
            const pending = this.pendingYearBatch, guard = this.approvalGuard();
            if (!pending)
                throw new Error('確認する保存はありません。');
            await this.refresh(undefined, true);
            guard();
            if (this.pendingYearBatch !== pending)
                throw new CloudEditCancelledError('確認対象の保存が変更されました。最新データを確認してください。');
            return this.classifyPendingYearBatch(pending);
        });
    }
    /** Reconcile before retrying; approved conflicts are excluded, never overwritten. */
    async resumePendingYearBatch(approveConflicts) {
        return traceFinanceOperation('pending-resume', async () => {
            const pending = this.pendingYearBatch, guard = this.approvalGuard();
            if (!pending || !this.key)
                throw new Error('再開する保存はありません。');
            const key = this.key;
            const checkPlan = () => { guard(); if (this.pendingYearBatch !== pending)
                throw new CloudEditCancelledError('再開対象の保存が変更されました。最新データを確認してください。'); };
            const conflictError = () => new CloudEditCancelledError('他の端末で明細が更新されています。保存結果を確認してから再開してください。');
            const results = await this.inspectPendingYearBatch();
            checkPlan();
            const conflicts = results.filter(result => result.status === 'conflict');
            const approved = new Map(conflicts.map(result => [result.id, result.conflictFingerprint]));
            if (conflicts.length) {
                if (!approveConflicts || !await approveConflicts(results))
                    throw conflictError();
                checkPlan();
            }
            if (results.every(result => result.status === 'saved')) {
                this.pendingYearBatch = null;
                return pending.ids;
            }
            const accepted = pending.ids.filter(id => !approved.has(id));
            const verify = (current) => {
                // A changed, newly conflicting, or no longer conflicting record requires new approval.
                const latest = current.filter(result => result.status === 'conflict');
                if (latest.length !== approved.size || latest.some(result => !approved.has(result.id) || approved.get(result.id) !== result.conflictFingerprint))
                    throw conflictError();
                return current.filter(result => !approved.has(result.id));
            };
            try {
                const ids = await this.withMutation(guard, async (lease) => {
                    checkPlan();
                    // Revalidate generation and ALL year copies under the lease, without
                    // fetching unrelated settings and rules again.
                    const fresh = await this.readCurrent(key, this.salt, undefined, guard);
                    checkPlan();
                    this.index = fresh.index;
                    this.shards = fresh.shards;
                    this.recordsViewCache = null;
                    const current = verify(this.classifyPendingYearBatch(pending));
                    const retryIds = new Set(current.filter(result => result.status === 'unsaved').map(result => result.id));
                    const remaining = pending.items.filter(item => retryIds.has(item.id));
                    this.pendingYearBatch = null;
                    try {
                        if (remaining.length)
                            await this.saveBatchInternal(remaining, lease, undefined, true);
                        guard();
                        // commitYear already retains the exact accepted document and ETag.
                        // Reuse that state for cleanup, rather than a second full refresh.
                        const verified = verify(this.classifyPendingYearBatch(pending));
                        if (verified.some(result => result.status === 'unsaved'))
                            throw new Error('未保存の明細が残っています。');
                        const cleanup = new Map();
                        for (const result of verified) {
                            if (result.status !== 'cleanup')
                                continue;
                            const target = statementBucket(result.statement.billingMonth);
                            for (const [year, shard] of this.shards) {
                                if (year === target || !shard.document.records.some(r => r.id === result.id))
                                    continue;
                                const ids = cleanup.get(year) ?? new Set();
                                ids.add(result.id);
                                cleanup.set(year, ids);
                            }
                        }
                        for (const [year, ids] of cleanup) {
                            await this.removeMovedRecords(year, ids, lease);
                            guard();
                        }
                        await this.refresh(lease);
                        guard();
                        if (verify(this.classifyPendingYearBatch(pending)).some(result => result.status !== 'saved'))
                            throw new Error('保存結果を確認できませんでした。');
                        return accepted;
                    }
                    finally {
                        // Keep the original plan until even lock release has completed.
                        // Do not resurrect plaintext after a lock or account change.
                        try {
                            guard();
                            this.pendingYearBatch = pending;
                        }
                        catch { /* invalid vault */ }
                    }
                }, undefined, false);
                checkPlan();
                this.pendingYearBatch = null;
                return ids;
            }
            catch (error) {
                try {
                    guard();
                }
                catch {
                    throw new CloudWriteUncertainError('保存再開中に保管庫が変更されました。最新データを確認してください。', null);
                }
                if (error instanceof CloudEditCancelledError)
                    throw error;
                throw error instanceof CloudWriteUncertainError ? error : new CloudWriteUncertainError('保存結果を確認できません。再接続後に保存を再開してください。', error);
            }
        });
    }
    async delete(id) {
        return traceFinanceOperation('statement-delete', async () => {
            return measureFinancePhase('vault.delete-record', async () => {
                if (this.pendingYearBatch)
                    throw new CloudWriteUncertainError('未確認の保存があります。設定から保存を再開してください。', null);
                if (!this.key)
                    throw new Error('先にOneDrive保管庫を解除してください。');
                const guard = this.approvalGuard();
                const generation = parseIndexEnvelope((await this.assertActiveGeneration()).text).format;
                guard();
                this.assertNoYearConflict(id);
                const years = [...this.shards].filter(([, s]) => s.document.records.some(r => r.id === id)).map(([year]) => year);
                this.mutationWarning = null;
                let deletedYears = 0;
                const syncInCommit = (generation === 'finance-cloud-index-envelope-v3' || generation === 'finance-cloud-index-envelope-v4') && years.length === 1 && this.index.years.includes(years[0]);
                try {
                    for (const year of years) {
                        guard();
                        const changed = clone(this.shards.get(year).document);
                        changed.records = changed.records.filter(r => r.id !== id);
                        if (!changed.deleted.includes(id))
                            changed.deleted.push(id);
                        await this.commitYear(year, changed, undefined, undefined, undefined, undefined, false, undefined, syncInCommit ? 'delete' : false);
                        deletedYears++;
                    }
                }
                catch (error) {
                    if (error instanceof CloudEditCancelledError && deletedYears === 0)
                        throw error;
                    throw new CloudWriteUncertainError('明細の削除がOneDriveで完了している可能性があります。再操作せず最新データを取得してください。', error);
                }
                if (!syncInCommit)
                    try {
                        await this.refresh();
                    }
                    catch {
                        this.mutationWarning = [this.mutationWarning, '明細の削除は確認できましたが、最新データ取得に失敗しました。通信回復後に取得してください。'].filter(Boolean).join(' ');
                    }
                // Originals are retained for recovery; audited cleanup is a separate operation.
            });
        });
    }
    async registerYear(year, lease) {
        if (!this.key)
            throw new Error('ロックされています。');
        const guard = this.approvalGuard(), key = this.key;
        if (this.index.years.includes(year))
            return; // This shard was registered earlier.
        return this.withMutation(guard, async () => {
            for (let attempt = 0; attempt < 5; attempt++) {
                guard();
                const file = await this.client.readFinanceIndex();
                guard();
                if (!file)
                    throw new Error('OneDriveの索引がなくなりました。');
                const env = parseIndexEnvelope(file.text);
                if (env.salt !== this.salt || (env.dataSetId ?? null) !== this.dataSetId)
                    throw new Error('異なる暗号化索引です。');
                const index = await decryptIndex(env, key);
                guard();
                if (index.years.includes(year)) {
                    this.index = index;
                    return;
                }
                const changed = { ...index, years: [...index.years, year].sort() };
                try {
                    const encrypted = await encryptIndex(changed, key, this.salt, this.dataSetId, env.format === 'finance-cloud-index-envelope-v4' ? 'v4' : env.format === 'finance-cloud-index-envelope-v3');
                    guard();
                    await this.client.writeFinanceIndex(encrypted, { id: file.id, etag: file.etag });
                    guard();
                    this.index = changed;
                    return;
                }
                catch (error) {
                    if (isConflict(error))
                        continue;
                    throw error;
                }
            }
            throw new Error('OneDrive索引の同時更新が続いています。再試行してください。');
        }, lease);
    }
    async commitYear(year, changed, protectedIds = new Set(), lease, replacementIds = new Set(), uploadedOriginals = new Set(), strictBaseline = false, approved, syncInCommit = false) {
        return measureFinancePhase('vault.year-commit', async () => {
            if (!this.key)
                throw new Error('保管庫はロックされています。');
            const base = clone(this.shards.get(year)?.document ?? emptyDocument()), baselineRef = this.shards.get(year)?.ref ?? null, key = this.key, guard = this.approvalGuard();
            const changedIds = new Set();
            if (!lease) {
                const before = new Map(base.records.map(r => [r.id, r])), after = new Map(changed.records.map(r => [r.id, r]));
                for (const id of new Set([...before.keys(), ...after.keys()]))
                    if (!sameContract(before.get(id), after.get(id)))
                        changedIds.add(id);
                for (const id of changed.deleted)
                    if (!base.deleted.includes(id))
                        changedIds.add(id);
            }
            for (let attempt = 0; attempt < 5; attempt++) {
                guard();
                const currentRef = baselineRef;
                const check = typeof this.client.readYearVaultForSave === 'function'
                    ? await this.client.readYearVaultForSave(year, currentRef)
                    : { kind: 'remote', file: await this.client.readYearVault(year) };
                guard();
                const remote = check.kind === 'unchanged' ? currentRef : check.file;
                if (strictBaseline && !sameRef(baselineRef, remote))
                    throw new CloudEditCancelledError('復旧対象の年度が変更されました。再確認してください。');
                let latest = check.kind === 'unchanged' ? clone(base) : emptyDocument();
                if (check.kind === 'remote' && check.file) {
                    const env = parseEnvelope(check.file.text);
                    if (env.salt !== this.salt)
                        throw new Error('別の暗号化保管庫が同じ年度に存在します。');
                    latest = await decryptDocument(env, key);
                }
                guard();
                this.assertKnownOriginalDigests([latest]);
                // Import revisions are whole-source replacements, never field-wise blends.
                // Even a stale ordinary edit must not be merged into a replaced original.
                for (const next of changed.records) {
                    if (!protectedIds.has(next.id))
                        continue;
                    const previous = base.records.find(r => r.id === next.id);
                    const remoteRecord = latest.records.find(r => r.id === next.id);
                    if (isConfirmationRegression(remoteRecord?.statement, next.statement))
                        throw new CloudEditCancelledError('OneDriveに確定明細があります。未確定明細では置き換えません。');
                    if (!previous)
                        continue;
                    const sourceChanged = remoteRecord && (remoteRecord.originalId !== previous.originalId || remoteRecord.originalMonth !== previous.originalMonth || remoteRecord.originalSha256 !== previous.originalSha256 || remoteRecord.statement.sourceKind !== previous.statement.sourceKind || remoteRecord.statement.confirmation !== previous.statement.confirmation);
                    if ((replacementIds.has(next.id) && JSON.stringify(previous) !== JSON.stringify(remoteRecord)) || sourceChanged)
                        throw new CloudEditCancelledError('差し替え元の明細が別の操作で更新されました。最新データを確認してから再度差し替えてください。');
                }
                const collisions = detectDocumentEditCollisions(base, changed, latest);
                // A batch approval is bound to the exact remote revision and collision list.
                // Never wait on UI confirmation while the inherited operation lock is held.
                if (lease) {
                    if (approved ? (!sameRef(approved.ref, remote) || !sameContract(approved.collisions, collisions)) : collisions.length > 0)
                        throw new CloudEditCancelledError('カード明細が別端末で編集されています。最新データを取得してから操作をやり直してください。');
                }
                else
                    await this.approveCollision(collisions, this.statementConflictResolver, 'カード明細');
                guard();
                const merged = mergeDocuments(base, changed, latest, new Date().toISOString(), undefined, collisions.length > 0);
                const duplicates = duplicateStatementMonths(merged.records, protectedIds);
                if (duplicates.length)
                    throw new CloudEditCancelledError(`同じカード・請求月の明細がOneDrive側で重複しています（${duplicates.join('、')}）。最新データを取得し、差し替え先を確認してください。`);
                if (merged.records.some(r => r.statement.zeroUsage !== undefined && (!isZeroUsage(r.statement) || importErrors(r.statement, !!r.originalId).length)))
                    throw new CloudEditCancelledError('利用なし明細が競合しました。最新データを確認してください。');
                const encrypted = await encryptDocument(merged, key, this.salt);
                guard();
                try {
                    await this.withMutation(guard, async (activeLease, index) => {
                        const scope = !lease ? await this.verifyYearEditScope(changedIds, guard, new Set(), new Map([...changedIds].map(id => [id, year])), index) : undefined;
                        if (scope && !sameRef(scope.shards.get(year)?.ref ?? null, remote))
                            throw new GraphError(412, 'preconditionFailed');
                        const writerV4Before = this.activeWriterV4;
                        const noUseMonths = this.affectedNoUseMonths(latest, merged);
                        const checksNoUse = noUseMonths.size > 0;
                        if (checksNoUse) {
                            if (this.assetsSaving)
                                throw new CloudEditCancelledError('資産設定を保存中です。完了後に明細を保存してください。');
                            this.assetsSaving = true;
                            this.settingsRevision++;
                        }
                        let assetHint;
                        try {
                            // A stale client must not introduce a reference to an original that
                            // was deleted by a completed cleanup. Verify new references under
                            // the same operation right as the year write.
                            const refKey = (record) => `${record.originalMonth ?? record.statement.billingMonth ?? 'undated'}:${record.originalId}:${record.originalSha256 ?? ''}`;
                            const oldRefs = new Set(latest.records.filter(r => r.originalId).map(refKey));
                            for (const record of merged.records) {
                                if (!record.originalId || oldRefs.has(refKey(record)))
                                    continue;
                                if (lease && activeLease === lease && uploadedOriginals.has(refKey(record)))
                                    continue;
                                guard();
                                try {
                                    const original = await this.client.downloadDatedOriginal(record.originalId, record.originalMonth ?? record.statement.billingMonth ?? null);
                                    guard();
                                    if (!original)
                                        throw new Error('PDF原本なし');
                                    await verifyOriginalDigest(await decryptOriginal(original, key), record.originalSha256);
                                    guard();
                                }
                                catch (error) {
                                    guard();
                                    throw new CloudEditCancelledError('PDF原本の存在と復号を確認できません。最新データを取得してから再登録してください。');
                                }
                                oldRefs.add(refKey(record));
                            }
                            if (merged.records.some(record => record.originalSha256))
                                await this.requireWriterV4(key, guard);
                            assetHint = await this.revokeCardNoUseBeforeYear(noUseMonths, key, guard);
                            guard();
                            const result = await this.client.writeYearVault(year, encrypted, remote ? { id: remote.id, etag: remote.etag } : null);
                            try {
                                guard();
                            }
                            catch (error) {
                                throw new CloudWriteUncertainError('保存中に保管庫が変更されました。最新データを確認してください。', error);
                            }
                            if (result?.id && result.etag) {
                                // This ETag belongs to exactly the document we uploaded. If another
                                // device updates afterwards, the next refresh detects its new ETag.
                                this.shards.set(year, { document: merged, ref: { id: result.id, etag: result.etag } });
                                this.recordsViewCache = null;
                            }
                            else {
                                // Compatibility fallback for Graph responses without a usable ETag.
                                // Never pair our local document with an unrelated remote ETag.
                                const saved = await this.client.readYearVault(year, true);
                                if (!saved)
                                    throw new Error('年別明細の保存結果を確認できません。');
                                const verifiedEnvelope = parseEnvelope(saved.text);
                                if (verifiedEnvelope.salt !== this.salt)
                                    throw new Error('保存直後に暗号化保管庫が変更されました。');
                                const verifiedDocument = await decryptDocument(verifiedEnvelope, key);
                                try {
                                    guard();
                                }
                                catch (error) {
                                    throw new CloudWriteUncertainError('保存中に保管庫が変更されました。最新データを確認してください。', error);
                                }
                                if (JSON.stringify(verifiedDocument) !== JSON.stringify(merged))
                                    throw new CloudWriteUncertainError('年別明細の保存結果が他の編集と異なります。最新データを確認してください。', null);
                                this.shards.set(year, { document: verifiedDocument, ref: { id: saved.id, etag: saved.etag } });
                                this.recordsViewCache = null;
                            }
                            try {
                                await this.registerYear(year, activeLease);
                                guard();
                            }
                            catch (error) {
                                if (error instanceof CloudEditCancelledError || error instanceof UploadChunkTimeoutError)
                                    throw new CloudWriteUncertainError('明細保存後に索引の更新を完了できませんでした。最新データを確認してください。', error);
                                throw error;
                            }
                        }
                        finally {
                            if (checksNoUse) {
                                this.assetsSaving = false;
                                this.settingsRevision++;
                            }
                        }
                        if (syncInCommit) {
                            // Keep the existing operation right through the closing snapshot fence.
                            // The scope was read under this same lease; replace only the verified
                            // written shard. A writer-format upgrade requires the ordinary read.
                            const hint = index && scope && writerV4Before === this.activeWriterV4 && scope.shards.has(year) ? scope : undefined;
                            if (hint)
                                hint.shards.set(year, this.shards.get(year));
                            try {
                                await this.refresh(activeLease, false, hint, assetHint);
                            }
                            catch (error) {
                                try {
                                    guard();
                                }
                                catch {
                                    throw new CloudWriteUncertainError('保存中に保管庫が変更されました。最新データを確認してください。', error);
                                }
                                this.mutationWarning = [this.mutationWarning, syncInCommit === 'delete' ? '明細の削除は確認できましたが、最新データ取得に失敗しました。通信回復後に取得してください。' : 'OneDriveへの保存は確認できましたが、最後の最新データ取得に失敗しました。通信回復後に取得してください。'].filter(Boolean).join(' ');
                            }
                        }
                    }, lease);
                    return;
                }
                catch (error) {
                    if (isConflict(error))
                        continue;
                    throw error;
                }
            }
            throw new Error(`${year}年の同時更新が続いています。未保存データを保持して再試行してください。`);
        });
    }
    async refresh(lease, inspectPending = false, hint, assetHint) {
        return traceFinanceOperation('refresh', async () => {
            if (lease !== undefined ? this.activeMutation !== lease : this.activeMutation !== null)
                throw new CloudEditCancelledError(`${this.assetsSaving || this.rulesSaving ? '設定' : '明細'}を保存中です。完了後に最新データを取得してください。`);
            if ((hint || assetHint) && !lease)
                throw new CloudEditCancelledError('保存の操作権を確認できません。');
            if (inspectPending && !this.pendingYearBatch)
                throw new CloudEditCancelledError('保存結果の確認対象がありません。');
            if (!this.key)
                throw new Error('先にOneDrive保管庫を解除してください。');
            if (this.rotating)
                throw new Error('保管庫のパスフレーズ変更中です。完了後に再試行してください。');
            if (this.assetsSaving || this.rulesSaving)
                throw new CloudEditCancelledError('設定を保存中です。完了後に最新データを取得してください。');
            const settingsRevision = this.settingsRevision, mutationRevision = this.mutationRevision, observedLease = this.activeMutation;
            const verifyLocalRevision = () => {
                if (settingsRevision !== this.settingsRevision || this.assetsSaving || this.rulesSaving)
                    throw new CloudEditCancelledError('取得中に設定の保存が開始されました。完了後に最新データを取得してください。');
                if (mutationRevision !== this.mutationRevision || observedLease !== this.activeMutation)
                    throw new CloudEditCancelledError('取得中に明細の保存が開始されました。完了後に最新データを取得してください。');
            };
            const refreshKey = this.key, refreshSalt = this.salt, refreshGeneration = this.dataSetId, refreshRevision = this.lockRevision, guard = this.approvalGuard();
            const verifyRemoteLock = async () => {
                verifyLocalRevision();
                if (!lease && typeof this.client.inspectVaultMutationLock === 'function') {
                    const lock = await this.client.inspectVaultMutationLock();
                    guard();
                    if (lock.state === 'present')
                        throw new CloudEditCancelledError('別の保存操作が進行中か保存ロックが残っています。完了後に最新データを取得してください。');
                }
            };
            await verifyRemoteLock();
            guard();
            const [current, rules, assets] = await measureFinancePhase('vault.refresh', () => Promise.all([
                measureFinancePhase('vault.years', () => hint ? Promise.resolve(hint) : this.readCurrent(refreshKey, refreshSalt, undefined, guard)),
                measureFinancePhase('vault.rules', () => this.readMerchantRules(refreshKey, refreshSalt, true)),
                measureFinancePhase('vault.assets', () => assetHint ? Promise.resolve(assetHint) : this.readAssets(refreshKey, refreshSalt, true)),
            ]));
            await verifyRemoteLock();
            guard();
            await this.verifyCurrentRead(current, rules.ref, assets.ref, guard, !!assets.document.cardNoUseMonths?.length);
            guard();
            await verifyRemoteLock();
            guard();
            // A lock or changed key during a network operation invalidates the result.
            if (this.key !== refreshKey || this.salt !== refreshSalt || this.dataSetId !== refreshGeneration || this.lockRevision !== refreshRevision || this.rotating)
                throw new BrowserKeyGenerationChangedError();
            verifyLocalRevision();
            const { index, shards } = current;
            // readonlyRecords() already checks every shard document identity.
            this.index = index;
            this.shards = shards;
            this.rulesDocument = rules.document;
            this.rulesRef = rules.ref;
            this.assetsDocument = assets.document;
            this.assetsRef = assets.ref;
            // Only after *all* cloud reads succeed is another mutation safe.
            this.rulesNeedRefresh = false;
            this.assetsNeedRefresh = false;
            this.recoveryReadOnly = false;
            return this.records();
        });
    }
    async original(id) {
        return traceFinanceOperation('original-read', async () => {
            if (!this.key)
                throw new Error('クラウド保管庫はロックされています。');
            this.assertNoYearConflict(id);
            const record = this.canonicalRecords().find(r => r.id === id);
            if (!record?.originalId)
                return null;
            const originalId = record.originalId, originalMonth = record.originalMonth ?? record.statement.billingMonth;
            const guard = this.approvalGuard(), key = this.key;
            await this.assertActiveGeneration();
            guard();
            const encrypted = await this.client.downloadDatedOriginal(originalId, originalMonth);
            guard();
            const bytes = await decryptOriginal(encrypted, key);
            guard();
            await verifyOriginalDigest(bytes, record.originalSha256);
            guard();
            this.assertNoYearConflict(id);
            const current = this.canonicalRecords().find(r => r.id === id);
            if (!current || current.originalId !== originalId || (current.originalMonth ?? current.statement.billingMonth) !== originalMonth || current.originalSha256 !== record.originalSha256)
                throw new CloudEditCancelledError('取得中にPDF原本参照が変更されました。再取得してください。');
            return bytes;
        });
    }
}
