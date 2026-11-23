import { validateMizuhoPlan } from './assets.js';
import { estimateMizuhoTransferAmount } from './mizuho-transfer.js';
import { measureFinancePhase } from './performance-diagnostics.js';
import { validateFixedCosts } from '../fixed-costs/contracts.js';
import { GraphError } from './onedrive-api.js';
import { decryptDocument, decryptIndex, decryptOriginal, deriveCloudKey, encryptDocument, encryptIndex, encryptOriginal, encryptRules, decryptRules, freshSalt, parseEnvelope, parseIndexEnvelope } from './cloud-crypto.js';
import { emptyDocument, mergeDocuments, detectDocumentEditCollisions, duplicateStatementMonths } from './merge.js';
import { emptyIndex, statementBucket, originalParts, validateIndex } from './layout.js';
import { emptyAssets, mergeAssets, detectAssetsEditCollisions, describeAssetsEditCollisions, validateSnapshot, validateRecurring, validateOneTime, withUpdatedNisaCardRule, validatePayrollAutoPassphrase, validateBirthMonth, validateCardDebitAccounts, validateCardPreferences, validateCardRecurringDecisions } from './assets.js';
import { encryptAssets, decryptAssets, encryptMonthlyReport, decryptMonthlyReport } from './cloud-crypto.js';
import { reportRevision, revisedDocument, snapshotHash } from '../reports/monthly-report.js';
import { emptyRules, mergeRules, detectRuleEditCollisions, validateRule, validateCategory, listCategories, PALETTE, CATEGORIES } from './merchant-rules.js';
const clone = (value) => structuredClone(value);
function sameYearRevisions(a, b) {
    return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}
function sameCleanupFiles(a, b) {
    return a.length === b.length && a.every(item => b.some(expected => item.id === expected.id && item.etag === expected.etag && item.name === expected.name));
}
const isConflict = (error) => error instanceof GraphError && (error.status === 409 || error.status === 412);
// 409/412 are known rejected writes. Other transport errors can occur *after* Graph committed a write.
const isDefiniteWriteRejection = (error) => error instanceof GraphError
    && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
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
export class LiveVault {
    client;
    key = null;
    salt = '';
    dataSetId = null;
    rotating = false;
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
    constructor(client) {
        this.client = client;
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
    get isRotating() { return this.rotating; }
    get exists() { return this.hasRemote; }
    get needsLayoutMigration() { return this.hasLegacy; }
    get hasPendingYearBatch() { return this.pendingYearBatch !== null; }
    pendingYearBatchEntries() {
        return this.pendingYearBatch?.items.map(item => ({ id: item.id, statement: clone(item.statement) })) ?? [];
    }
    /** Deduplicated canonical references. Used only in the defensive copy getter
     * and the explicitly immutable view getter. */
    canonicalRecords() {
        // During a billing-month correction, prefer the record whose stored year
        // matches its current billing month until old-year cleanup has completed.
        const merged = new Map();
        for (const [bucket, { document }] of this.shards)
            for (const record of document.records) {
                const rank = statementBucket(record.statement.billingMonth) === bucket ? 1 : 0;
                const previous = merged.get(record.id);
                if (!previous || rank > previous.rank)
                    merged.set(record.id, { record, rank });
            }
        return [...merged.values()].map(item => item.record);
    }
    records() {
        if (!this.key)
            throw new Error('クラウド保管庫はロックされています。');
        return clone(this.canonicalRecords());
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
        const entries = this.canonicalRecords();
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
    payrollReadClient() {
        if (!this.unlocked || this.rotating)
            throw new Error('Finance保管庫を解除してから給与を同期してください。');
        return this.client;
    }
    assetSettings() {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        return clone(this.assetsDocument);
    }
    conflicts() { return [...this.shards.values()].reduce((count, s) => count + s.document.conflicts.length, 0); }
    lock() { this.cleanupPlan = null; this.mutationWarning = null; this.dataSetId = null; this.client.setVaultDataSet?.(null); this.key = null; this.salt = ''; this.shards.clear(); this.recordsViewCache = null; this.index = emptyIndex(); this.rulesDocument = emptyRules(); this.rulesRef = null; this.assetsDocument = emptyAssets(); this.assetsRef = null; this.rulesNeedRefresh = false; this.assetsNeedRefresh = false; this.pendingYearBatch = null; this.reportsNeedRefresh.clear(); }
    /** Report storage is isolated by month; loading does not change any bank/statement data. */
    async listArchivedMonths() {
        if (!this.key || this.rotating)
            throw new Error('保管庫を解除してください。');
        await this.assertActiveGeneration();
        return (await this.client.listMonthlyReports()).map(item => item.period);
    }
    async loadArchivedReport(period) {
        if (!this.key || this.rotating)
            throw new Error('保管庫を解除してください。');
        await this.assertActiveGeneration();
        const remote = await this.client.readMonthlyReport(period);
        const result = remote ? await decryptMonthlyReport(remote.text, this.key, this.salt, period) : null;
        this.reportsNeedRefresh.delete(period); // A confirmed read reconciles an earlier ambiguous write.
        return result;
    }
    async saveArchivedReport(snapshot, note, expectedRevision) {
        if (!this.key || this.rotating)
            throw new Error('保管庫を解除してください。');
        if (this.reportsSaving)
            throw new Error('別のレポートを保存中です。');
        if (this.reportsNeedRefresh.has(snapshot.period))
            throw new CloudWriteUncertainError('保存結果を確認できません。最新のレポートを取得してください。', null);
        if (note.length > 2000)
            throw new Error('メモは2000文字以内にしてください。');
        this.reportsSaving = true;
        try {
            await this.assertActiveGeneration();
            const key = this.key;
            const remote = await this.client.readMonthlyReport(snapshot.period);
            const old = remote ? await decryptMonthlyReport(remote.text, key, this.salt, snapshot.period) : null;
            if ((old?.current.id ?? null) !== expectedRevision)
                throw new CloudEditCancelledError('別の端末でレポートが変更されています。最新の内容を取得してください。');
            const hash = await snapshotHash(snapshot);
            if (old && old.current.sourceHash === hash && old.current.note === note)
                return old;
            const updated = revisedDocument(old, reportRevision(snapshot, hash, note));
            const text = await encryptMonthlyReport(updated, key, this.salt);
            let returned = false;
            try {
                const written = await this.client.writeMonthlyReport(snapshot.period, text, remote ? { id: remote.id, etag: remote.etag } : null);
                returned = true;
                if (!written?.etag) {
                    const readback = await this.client.readMonthlyReport(snapshot.period);
                    if (!readback)
                        throw new Error('保存したレポートを確認できません。');
                    const verified = await decryptMonthlyReport(readback.text, key, this.salt, snapshot.period);
                    if (verified.current.id !== updated.current.id)
                        throw new Error('保存結果が一致しません。');
                }
                return updated;
            }
            catch (error) {
                if (isConflict(error))
                    throw new CloudEditCancelledError('別の端末でレポートが更新されました。最新の内容を取得してください。');
                if (returned || !isDefiniteWriteRejection(error)) {
                    this.reportsNeedRefresh.add(snapshot.period);
                    throw new CloudWriteUncertainError('レポートは保存された可能性があります。最新の内容を取得して確認してください。', error);
                }
                throw error;
            }
        }
        finally {
            this.reportsSaving = false;
        }
    }
    /** Expose only the verified non-extractable key, never raw bytes or a passphrase. */
    verifiedBrowserKey() {
        if (!this.key || this.rotating || this.key.extractable)
            throw new Error('保管庫を解除してからブラウザを記憶してください。');
        return { key: this.key, salt: this.salt, dataSetId: this.dataSetId };
    }
    /** Read-only authentication against this account's current OneDrive index. */
    async unlockBrowserKey(record) {
        if (record.key.extractable || record.key.type !== 'secret' || record.key.algorithm.name !== 'AES-GCM')
            throw new Error('保存したブラウザ鍵が不正です。');
        const index = await this.client.readFinanceIndex();
        if (!index)
            throw new Error('OneDriveの保管庫が見つかりません。');
        const env = parseIndexEnvelope(index.text);
        if (env.salt !== record.salt || (env.dataSetId ?? null) !== record.dataSetId)
            throw new BrowserKeyGenerationChangedError();
        await measureFinancePhase('vault.auto-unlock', () => this.setCurrent(record.key, record.salt, index));
        return this.records();
    }
    async discover() {
        const current = await this.client.readFinanceIndex();
        if (current) {
            this.hasRemote = true;
            this.hasLegacy = false;
            return true;
        }
        const legacy = await this.client.readLiveVault();
        this.hasRemote = !!legacy;
        this.hasLegacy = !!legacy;
        return this.hasRemote;
    }
    /** Read the new layout, with safe recovery of shards committed before the index update. */
    async readCurrent(key, salt, prefetched) {
        const indexFile = prefetched ?? await this.client.readFinanceIndex();
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
        // An upload may have completed just before index registration failed; recover its shard.
        const files = await this.client.listYearFiles();
        const known = new Map(files.map(file => [file.year, file]));
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
            for (const result of results)
                shards.set(result.year, result.shard);
        }
        return { index: validateIndex({ format: 'finance-cloud-index-v1', years }), shards };
    }
    async setCurrent(key, salt, prefetched) {
        const file = prefetched ?? await this.client.readFinanceIndex();
        if (!file)
            throw new Error('OneDriveの暗号化索引が見つかりません。');
        const env = parseIndexEnvelope(file.text);
        this.client.setVaultDataSet?.(env.dataSetId ?? null);
        // Index generation is selected above; independent reads can now proceed together.
        // Do not publish ANY decrypted data until every validation has succeeded.
        const [current, ruleState, assetState] = await measureFinancePhase('vault.load-all', () => Promise.all([
            measureFinancePhase('vault.years', () => this.readCurrent(key, salt, file)),
            measureFinancePhase('vault.rules', () => this.readMerchantRules(key, salt)),
            measureFinancePhase('vault.assets', () => this.readAssets(key, salt)),
        ]));
        const { index, shards } = current;
        this.key = key;
        this.salt = salt;
        this.dataSetId = env.dataSetId ?? null;
        this.index = index;
        this.shards = shards;
        this.recordsViewCache = null;
        this.rulesDocument = ruleState.document;
        this.rulesRef = ruleState.ref;
        this.assetsDocument = assetState.document;
        this.assetsRef = assetState.ref;
        this.hasRemote = true;
        this.hasLegacy = false;
    }
    async unlock(passphrase) {
        return measureFinancePhase('vault.manual-unlock', async () => {
            const current = await this.client.readFinanceIndex();
            if (current) {
                const salt = parseIndexEnvelope(current.text).salt;
                const key = await deriveCloudKey(passphrase, salt);
                await this.setCurrent(key, salt, current);
                return this.records();
            }
            const legacy = await this.client.readLiveVault();
            if (!legacy)
                throw new Error('OneDriveに明細保管庫がありません。最初に作成してください。');
            const envelope = parseEnvelope(legacy.text);
            const key = await deriveCloudKey(passphrase, envelope.salt);
            const old = await decryptDocument(envelope, key);
            // Old v1.0 remains untouched. The index is published only after all shards/PDFs verify.
            await this.migrateV1(old, key, envelope.salt);
            await this.setCurrent(key, envelope.salt);
            return this.records();
        });
    }
    async create(passphrase) {
        if (passphrase.length < 12)
            throw new Error('パスフレーズは12文字以上にしてください。');
        if (await this.client.readFinanceIndex() || await this.client.readLiveVault())
            throw new Error('OneDriveにはすでに保管庫があります。解除して使用してください。');
        const salt = freshSalt(), key = await deriveCloudKey(passphrase, salt);
        await this.client.ensurePayrollNamespace(); // reserved for the future Payroll app, no personal data
        await this.client.writeFinanceIndex(await encryptIndex(emptyIndex(), key, salt), null);
        await this.setCurrent(key, salt);
    }
    /** Verify that the live index still points to the generation unlocked in this tab. */
    async assertActiveGeneration() {
        if (this.rotating)
            throw new Error('パスフレーズの変更中です。完了後に操作してください。');
        const file = await this.client.readFinanceIndex();
        if (!file)
            throw new Error('OneDriveの保管庫索引が見つかりません。');
        const env = parseIndexEnvelope(file.text);
        if (env.salt !== this.salt || (env.dataSetId ?? null) !== this.dataSetId)
            throw new Error('別の端末でパスフレーズが変更されました。保管庫をロックして再解除してください。');
    }
    /**
     * Copy-on-write passphrase rotation. All active files (including PDF originals)
     * are re-encrypted into a fresh generation. The single index switch is last.
     * An interrupted upload leaves the old index and old ciphertext fully usable.
     * Old generations are deliberately NOT deleted as automatic cleanup could
     * destroy the only recoverable copy after a network/verification failure.
     */
    async changePassphrase(current, next, onProgress) {
        if (!this.key)
            throw new Error('保管庫のロック解除が必要です。');
        if (this.rotating || this.assetsSaving || this.reportsSaving)
            throw new Error('保管庫の更新中です。操作完了後にお試しください。');
        if (next.length < 12)
            throw new Error('新しいパスフレーズは12文字以上にしてください。');
        if (current === next)
            throw new Error('新旧のパスフレーズが同じです。');
        if (typeof this.client.forVaultDataSet !== 'function' || typeof this.client.setVaultDataSet !== 'function')
            throw new Error('OneDriveクライアントがパスフレーズ変更に対応していません。');
        this.cleanupPlan = null;
        this.rotating = true;
        let published = false;
        let publishing = false;
        let targetGeneration = null;
        try {
            onProgress?.('現在のパスフレーズを照合中…');
            const startFile = await this.client.readFinanceIndex();
            if (!startFile)
                throw new Error('保管庫索引が見つかりません。');
            const startEnv = parseIndexEnvelope(startFile.text);
            if (startEnv.salt !== this.salt || (startEnv.dataSetId ?? null) !== this.dataSetId)
                throw new Error('別の端末で保管庫が更新されました。先に再解除してください。');
            const currentKey = await deriveCloudKey(current, this.salt);
            await decryptIndex(startEnv, currentKey); // Reject an incorrect old passphrase BEFORE any upload.
            // Never publish from a stale local view. Keep the index ETag for atomic activation.
            const { index, shards } = await this.readCurrent(this.key, this.salt, startFile);
            const rules = await this.readMerchantRules(this.key, this.salt);
            const assets = await this.readAssets(this.key, this.salt);
            const reportRefs = typeof this.client.listMonthlyReports === 'function' ? await this.client.listMonthlyReports() : [];
            const reports = new Map();
            for (const ref of reportRefs) {
                const file = await this.client.readMonthlyReport(ref.period);
                if (!file || file.etag !== ref.etag)
                    throw new Error('月次レポートが更新されました。再実行してください。');
                reports.set(ref.period, await decryptMonthlyReport(file.text, this.key, this.salt, ref.period));
            }
            const originals = new Map();
            for (const { document } of shards.values())
                for (const item of document.records)
                    if (item.originalId) {
                        const month = item.originalMonth ?? item.statement.billingMonth ?? null;
                        originals.set(`${month ?? 'undated'}:${item.originalId}`, { id: item.originalId, month });
                    }
            const generation = crypto.randomUUID();
            targetGeneration = generation;
            const target = this.client.forVaultDataSet(generation);
            const salt = freshSalt();
            const key = await deriveCloudKey(next, salt);
            let completed = 0;
            const total = shards.size + originals.size + reports.size + (rules.ref ? 1 : 0) + (assets.ref ? 1 : 0);
            const progress = () => onProgress?.(`再暗号化して保存中… ${completed}/${total}ファイル`);
            progress();
            for (const [year, shard] of shards) {
                const cipher = await encryptDocument(shard.document, key, salt);
                await target.writeYearVault(year, cipher, null);
                const verified = await target.readYearVault(year);
                if (!verified || JSON.stringify(await decryptDocument(parseEnvelope(verified.text), key)) !== JSON.stringify(shard.document))
                    throw new Error(`${year}年の再暗号化検証に失敗しました。`);
                completed++;
                progress();
            }
            if (rules.ref) {
                await target.writeMerchantRules(await encryptRules(rules.document, key, salt), null);
                const file = await target.readMerchantRules();
                if (!file || JSON.stringify(await decryptRules(file.text, key, salt)) !== JSON.stringify(rules.document))
                    throw new Error('利用先ルールの再暗号化検証に失敗しました。');
                completed++;
                progress();
            }
            if (assets.ref) {
                await target.writeAssetSettings(await encryptAssets(assets.document, key, salt), null);
                const file = await target.readAssetSettings();
                if (!file || JSON.stringify(await decryptAssets(file.text, key, salt)) !== JSON.stringify(assets.document))
                    throw new Error('資産設定の再暗号化検証に失敗しました。');
                completed++;
                progress();
            }
            for (const [period, report] of reports) {
                await target.writeMonthlyReport(period, await encryptMonthlyReport(report, key, salt), null);
                const file = await target.readMonthlyReport(period);
                if (!file || JSON.stringify(await decryptMonthlyReport(file.text, key, salt, period)) !== JSON.stringify(report))
                    throw new Error(`${period}のレポートの再暗号化検証に失敗しました。`);
                completed++;
                progress();
            }
            for (const { id, month } of originals.values()) {
                const source = await this.client.downloadDatedOriginal(id, month);
                const decrypted = await decryptOriginal(source, this.key);
                const cipher = await encryptOriginal(decrypted, key);
                await target.uploadDatedOriginal(id, cipher, month);
                const saved = await target.downloadDatedOriginal(id, month);
                const verified = await decryptOriginal(saved, key);
                if (verified.length !== decrypted.length || !verified.every((byte, i) => byte === decrypted[i]))
                    throw new Error('PDF原本の再暗号化検証に失敗しました。');
                completed++;
                progress();
            }
            onProgress?.('他端末での更新がないか最終確認中…');
            // Confirm there were no changes to any source file during the staging run.
            const checkIndex = await this.client.readFinanceIndex();
            if (!checkIndex || checkIndex.etag !== startFile.etag)
                throw new Error('作業中に索引が変更されました。旧データはそのままです。再実行してください。');
            const nowFiles = await this.client.listYearFiles();
            const actual = new Map(nowFiles.map(file => [file.year, file]));
            if (actual.size !== shards.size || [...shards].some(([year, shard]) => actual.get(year)?.etag !== shard.ref.etag))
                throw new Error('作業中に明細が更新されました。旧データはそのままです。再実行してください。');
            if (reportRefs.length) {
                const nowReports = await this.client.listMonthlyReports();
                const latest = new Map(nowReports.map(ref => [ref.period, ref.etag]));
                if (latest.size !== reportRefs.length || reportRefs.some(ref => latest.get(ref.period) !== ref.etag))
                    throw new Error('作業中に月次レポートが変更されました。旧データはそのままです。');
            }
            else if (typeof this.client.listMonthlyReports === 'function' && (await this.client.listMonthlyReports()).length)
                throw new Error('作業中に新しい月次レポートが保存されました。再実行してください。');
            const nowRules = await this.client.readMerchantRules();
            const nowAssets = await this.client.readAssetSettings();
            if ((nowRules?.etag ?? null) !== (rules.ref?.etag ?? null) || (nowAssets?.etag ?? null) !== (assets.ref?.etag ?? null))
                throw new Error('作業中に設定が更新されました。旧データはそのままです。再実行してください。');
            onProgress?.('新しい暗号化保管庫に切り替え中…');
            publishing = true;
            await this.client.writeFinanceIndex(await encryptIndex(index, key, salt, generation), { id: startFile.id, etag: startFile.etag });
            published = true;
            // The index publication is a single conditional Graph update. All data was
            // verified before this point; the old data is still available as recovery.
            this.key = null;
            await this.setCurrent(key, salt);
        }
        catch (error) {
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
    }
    /** Preview is read-only. Only unreferenced originals inside the active generation
     * and inactive version directories are eligible for deletion. */
    async previewCleanup() {
        if (!this.key || this.rotating || this.assetsSaving || this.reportsSaving)
            throw new Error('保管庫の操作が完了してから整理してください。');
        this.cleanupPlan = null;
        await this.assertActiveGeneration();
        const index = await this.client.readFinanceIndex();
        if (!index)
            throw new Error('保管庫の索引を確認できません。');
        const env = parseIndexEnvelope(index.text);
        if (env.salt !== this.salt || (env.dataSetId ?? null) !== this.dataSetId)
            throw new Error('保管庫が変更されました。再解除してください。');
        const { shards } = await this.readCurrent(this.key, this.salt, index);
        const years = new Map((await this.client.listYearFiles()).map(x => [x.year, `${x.id}:${x.etag}`]));
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
        const originals = allOriginals.filter(file => !referenced.has(`${file.year}/${file.month}/${file.name.toLowerCase()}`));
        const generations = (await this.client.listOldVaultGenerations()).filter(x => x.name.toLowerCase() !== this.dataSetId?.toLowerCase());
        // Current unversioned vaults must NEVER delete their own root folders.
        const legacyFolders = this.dataSetId ? await this.client.listUnversionedFinanceFolders() : [];
        // Old root v1 is never the active vault once a valid current index is open.
        // Snapshots are recovery points: the user must select each snapshot individually.
        const retired = await this.client.listRetiredRootData();
        // Reject scanning if another tab modified a year or switched generations in flight.
        const end = await this.client.readFinanceIndex();
        const endYears = new Map((await this.client.listYearFiles()).map(x => [x.year, `${x.id}:${x.etag}`]));
        if (!end || end.etag !== index.etag || !sameYearRevisions(years, endYears))
            throw new Error('確認中に保管庫が更新されました。再読み込みしてやり直してください。');
        this.cleanupPlan = { index: { id: index.id, etag: index.etag }, dataSetId: this.dataSetId, years, generations, legacyFolders, originals, legacyV1: retired.legacyV1, snapshots: retired.snapshots };
        return { generationCount: generations.length, legacyFolderCount: legacyFolders.length, unreferencedOriginalCount: originals.length, legacyV1Count: retired.legacyV1.length, snapshots: retired.snapshots.map(({ id, name, createdDateTime }) => ({ id, name, createdDateTime })) };
    }
    /** An explicit second action is required. Fail closed if any cloud revision differs. */
    async deletePreviewedCleanup(which, onProgress) {
        if (!this.key || this.rotating || this.assetsSaving || this.reportsSaving || !this.cleanupPlan)
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
        const current = await this.client.readFinanceIndex();
        if (!current || current.id !== plan.index.id || current.etag !== plan.index.etag)
            throw new Error('保管庫の世代・索引が変更されました。確認からやり直してください。');
        const env = parseIndexEnvelope(current.text);
        if (env.salt !== this.salt || (env.dataSetId ?? null) !== this.dataSetId || plan.dataSetId !== this.dataSetId)
            throw new Error('保管庫の世代が変更されました。削除を中止しました。');
        const years = new Map((await this.client.listYearFiles()).map(x => [x.year, `${x.id}:${x.etag}`]));
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
        this.rotating = true;
        let deleted = 0;
        try {
            for (const file of [...originals, ...generations, ...legacyFolders, ...selectedRoot]) {
                // Guard the live generation and concurrent edits before each irreversible request.
                const latest = await this.client.readFinanceIndex();
                const state = latest ? parseIndexEnvelope(latest.text) : null;
                if (!latest || latest.etag !== plan.index.etag || (state?.dataSetId ?? null) !== this.dataSetId)
                    throw new Error('削除中に保管庫の世代が更新されました。残りの削除を中止しました。');
                const checkedYears = new Map((await this.client.listYearFiles()).map(x => [x.year, `${x.id}:${x.etag}`]));
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
                await this.client.deleteCleanupItem(file);
                deleted++;
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
    }
    /** Legacy -> finance/index.enc + finance/statements/YYYY.enc + finance/originals/YYYY/MM/UUID.enc.
     * Idempotent and non-destructive. Do not publish index.enc before all files validate. */
    async migrateV1(old, key, salt) {
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
                const month = copy.originalMonth ?? copy.statement.billingMonth;
                try {
                    await this.client.uploadDatedOriginal(copy.originalId, original, month);
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
                    await this.client.writeYearVault(year, await encryptDocument(expected, key, salt), null);
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
        await this.client.ensurePayrollNamespace();
        // A competing client may have completed migration while we were working.
        try {
            await this.client.writeFinanceIndex(await encryptIndex({ format: 'finance-cloud-index-v1', years }, key, salt), null);
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
    async readMerchantRules(key, salt) {
        // Older isolated test doubles may not expose the new optional Graph endpoint.
        if (typeof this.client.readMerchantRules !== 'function')
            return { document: emptyRules(), ref: null };
        const remote = await this.client.readMerchantRules();
        if (!remote)
            return { document: emptyRules(), ref: null };
        if (this.key === key && this.salt === salt && !this.rulesNeedRefresh &&
            this.rulesRef?.id === remote.id && this.rulesRef.etag === remote.etag)
            return { document: clone(this.rulesDocument), ref: { id: remote.id, etag: remote.etag } };
        const document = await decryptRules(remote.text, key, salt);
        return { document, ref: { id: remote.id, etag: remote.etag } };
    }
    async upsertMerchantRule(rule) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        const valid = validateRule(rule);
        const next = clone(this.rulesDocument);
        const index = next.rules.findIndex(x => x.id === valid.id);
        if (index >= 0)
            next.rules[index] = valid;
        else
            next.rules.push(valid);
        next.deleted = next.deleted.filter(x => x !== valid.id);
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
        return measureFinancePhase('vault.rule-commit', async () => {
            if (this.rotating)
                throw new Error('保管庫の更新・整理中です。');
            if (this.rulesNeedRefresh)
                this.uncertainWrite('rules', null);
            if (!this.key)
                throw new Error('保管庫がロックされています。');
            await this.assertActiveGeneration();
            if (typeof this.client.writeMerchantRules !== 'function')
                throw new Error('OneDriveの利用先ルール保存機能がありません。');
            const key = this.key, base = clone(this.rulesDocument);
            const baselineRef = this.rulesRef ? { ...this.rulesRef } : null;
            for (let attempt = 0; attempt < 5; attempt++) {
                const remote = await this.client.readMerchantRules();
                if (this.rulesRef && !remote)
                    throw new Error('OneDriveの利用先ルールファイルが消去されています。上書きせず停止します。');
                const unchanged = !!remote && baselineRef?.id === remote.id && baselineRef.etag === remote.etag;
                const remoteDoc = remote ? (unchanged ? clone(base) : await decryptRules(remote.text, key, this.salt)) : emptyRules();
                const collisions = detectRuleEditCollisions(base, local, remoteDoc);
                await this.approveCollision(collisions, this.ruleConflictResolver, '利用先ルール・カテゴリー');
                const merged = mergeRules(base, local, remoteDoc, new Date().toISOString(), undefined, collisions.length > 0);
                const encrypted = await encryptRules(merged, key, this.salt);
                let writeReturned = false;
                try {
                    const result = await this.client.writeMerchantRules(encrypted, remote ? { id: remote.id, etag: remote.etag } : null);
                    writeReturned = true;
                    if (result?.id && result.etag) {
                        this.rulesDocument = merged;
                        this.rulesRef = { id: result.id, etag: result.etag };
                    }
                    else {
                        // The upload resolved without a usable ETag. The read-back itself may fail.
                        const verified = await this.readMerchantRules(key, this.salt);
                        if (!verified.ref || JSON.stringify(verified.document) !== JSON.stringify(merged))
                            throw new Error('保存先の内容を今回の変更と照合できませんでした。');
                        this.rulesDocument = verified.document;
                        this.rulesRef = verified.ref;
                    }
                    return;
                }
                catch (error) {
                    if (!writeReturned && isConflict(error))
                        continue;
                    if (writeReturned || !isDefiniteWriteRejection(error))
                        this.uncertainWrite('rules', error);
                    throw error;
                }
            }
            throw new Error('利用先ルールの同時更新が続いています。再試行してください。');
        });
    }
    async readAssets(key, salt) {
        // Existing vaults may not have an assets file yet; do not create one until first save.
        if (typeof this.client.readAssetSettings !== 'function')
            return { document: emptyAssets(), ref: null };
        const remote = await this.client.readAssetSettings();
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
        return { document: await decryptAssets(remote.text, key, salt), ref: { id: remote.id, etag: remote.etag } };
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
    async upsertOneTime(entry) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const valid = validateOneTime(entry), next = clone(this.assetsDocument);
        if (next.deletedOneTime?.includes(valid.id))
            throw new Error('削除済みの入出金IDは再利用できません。');
        const items = next.oneTime ?? [];
        const i = items.findIndex(e => e.id === valid.id);
        if (i >= 0)
            items[i] = valid;
        else
            items.push(valid);
        next.oneTime = items;
        await this.commitAssets(next);
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
        else
            next.recurring.push(valid);
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
        if (index >= 0)
            records[index] = entry;
        else
            records.push(entry);
        next.fixedCosts = validateFixedCosts(records) ?? [];
        if (decision) {
            if (!entry.merchantKey || entry.payment !== 'card' || entry.cardId !== decision.cardId)
                throw new Error('カード定期支出の対応関係が不正です。');
            const preferences = validateCardRecurringDecisions({ [entry.merchantKey]: decision });
            next.cardRecurringDecisions = { ...(next.cardRecurringDecisions ?? {}), [entry.merchantKey]: preferences[entry.merchantKey] };
        }
        await this.commitAssets(next);
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
        next.payrollDepositAccount = account;
        await this.commitAssets(next);
    }
    /** Opt-in credential is stored only in the AES-GCM protected assets document. */
    async setPayrollAutoPassphrase(passphrase) {
        if (!this.key)
            throw new Error('OneDrive保管庫のロック解除が必要です。');
        const next = clone(this.assetsDocument);
        next.payrollAutoPassphrase = validatePayrollAutoPassphrase(passphrase);
        await this.commitAssets(next);
    }
    async setNisaCardRule(rule, today) {
        if (!this.key)
            throw new Error('OneDrive保管庫を解除してください。');
        const date = today ?? (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
        const next = withUpdatedNisaCardRule(this.assetsDocument, rule, date);
        if (JSON.stringify(next) === JSON.stringify(this.assetsDocument))
            return;
        await this.commitAssets(next);
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
        if (confirmed && this.readonlyRecords().some(record => record.statement?.paymentDate?.slice(0, 7) === month))
            throw new Error('既にカード明細がある月は「利用なし」と確認できません。');
        const next = clone(this.assetsDocument);
        const months = new Set(next.cardNoUseMonths ?? []);
        if (confirmed)
            months.add(month);
        else
            months.delete(month);
        next.cardNoUseMonths = [...months].sort();
        await this.commitAssets(next);
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
        if (!next.mizuhoTransferPlan?.enabled || next.cardDebitAccounts?.['rakuten-mizuho'] !== 'mizuho-bank')
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
    async setMizuhoTransferPlan(value) {
        if (!this.key)
            throw new Error('保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        next.mizuhoTransferPlan = validateMizuhoPlan(value);
        if (value.enabled)
            next.cardDebitAccounts = { ...next.cardDebitAccounts, 'rakuten-mizuho': 'mizuho-bank' };
        await this.commitAssets(next);
    }
    async setCardDebitAccounts(value) {
        if (!this.key)
            throw new Error('保管庫を解除してください。');
        const next = clone(this.assetsDocument);
        next.cardDebitAccounts = validateCardDebitAccounts(value) ?? {};
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
        next.cardPreferences = cleanPrefs;
        next.cardDebitAccounts = cleanDebits;
        await this.commitAssets(next);
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
    async commitAssets(local) {
        return measureFinancePhase('vault.asset-commit', async () => {
            if (this.rotating)
                throw new Error('保管庫の更新・整理中です。');
            if (this.assetsNeedRefresh)
                this.uncertainWrite('assets', null);
            await this.assertActiveGeneration();
            if (!this.key)
                throw new Error('OneDrive保管庫がロックされています。');
            if (typeof this.client.writeAssetSettings !== 'function')
                throw new Error('OneDriveの資産設定保存機能がありません。');
            if (this.assetsSaving)
                throw new Error('資産設定を保存中です。完了後にもう一度操作してください。');
            this.assetsSaving = true;
            try {
                const key = this.key, base = clone(this.assetsDocument);
                const baselineRef = this.assetsRef ? { ...this.assetsRef } : null;
                for (let attempt = 0; attempt < 5; attempt++) {
                    const remote = await this.client.readAssetSettings();
                    if (this.assetsRef && !remote)
                        throw new Error('資産設定ファイルがOneDriveから消失しています。上書きせず停止します。');
                    const unchanged = !!remote && baselineRef?.id === remote.id && baselineRef.etag === remote.etag;
                    const current = remote ? (unchanged ? clone(base) : await decryptAssets(remote.text, key, this.salt)) : emptyAssets();
                    const collisions = detectAssetsEditCollisions(base, local, current);
                    if (collisions.length) {
                        if (!this.assetConflictResolver)
                            throw new CloudEditCancelledError('別の端末でも同じ資産項目が変更されています。保存を停止しました。最新データを取得して確認してください。');
                        const details = describeAssetsEditCollisions(base, local, current, collisions);
                        const approved = await this.assetConflictResolver(collisions, details);
                        if (!approved)
                            throw new CloudEditCancelledError('同時編集のため保存を中止しました。OneDriveの内容は変更されていません。');
                    }
                    const merged = mergeAssets(base, local, current, new Date().toISOString(), collisions.length > 0);
                    const encrypted = await encryptAssets(merged, key, this.salt);
                    let writeReturned = false;
                    try {
                        const result = await this.client.writeAssetSettings(encrypted, remote ? { id: remote.id, etag: remote.etag } : null);
                        writeReturned = true;
                        if (result?.id && result.etag) {
                            this.assetsDocument = merged;
                            this.assetsRef = { id: result.id, etag: result.etag };
                        }
                        else {
                            const verified = await this.readAssets(key, this.salt);
                            if (!verified.ref || JSON.stringify(verified.document) !== JSON.stringify(merged))
                                throw new Error('保存先の内容を今回の変更と照合できませんでした。');
                            this.assetsDocument = verified.document;
                            this.assetsRef = verified.ref;
                        }
                        return;
                    }
                    catch (error) {
                        if (!writeReturned && isConflict(error))
                            continue;
                        if (writeReturned || !isDefiniteWriteRejection(error))
                            this.uncertainWrite('assets', error);
                        throw error;
                    }
                }
                throw new Error('資産設定の同時更新が続いています。再試行してください。');
            }
            finally {
                this.assetsSaving = false;
            }
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
    async saveBatch(items) {
        return measureFinancePhase('vault.save-batch', async () => {
            if (this.rotating)
                throw new Error('保管庫の更新・整理中です。');
            if (this.pendingYearBatch)
                throw new CloudWriteUncertainError('未確認の保存があります。設定から保存を再開してください。', null);
            if (!this.key)
                throw new Error('先にOneDrive保管庫を解除してください。');
            await this.assertActiveGeneration();
            const key = this.key;
            const changes = new Map();
            const ids = [];
            const moves = [];
            const before = new Map();
            const existingRecords = new Map(this.records().map(record => [record.id, record]));
            for (const item of items) {
                let id = item.id ?? this.draftIds.get(item.statement);
                if (!id) {
                    id = crypto.randomUUID();
                    this.draftIds.set(item.statement, id);
                }
                ids.push(id);
                const prior = existingRecords.get(id);
                before.set(id, prior ? clone(prior) : null);
                const previousBucket = this.findBucket(id);
                const year = statementBucket(item.statement.billingMonth);
                let originalId = prior?.originalId;
                let originalMonth = prior?.originalMonth ?? prior?.statement.billingMonth ?? null;
                if (item.statement.sourceKind === 'pdf' && item.source) {
                    if (item.source.mime !== 'application/pdf')
                        throw new Error('PDF原本のファイル形式が不正です。');
                    // Deterministic across retries for a draft; never overwrite an existing encrypted PDF.
                    let draft = this.pdfDrafts.get(item.source.bytes);
                    if (!draft) {
                        draft = { id: crypto.randomUUID(), month: item.statement.billingMonth, encrypted: await encryptOriginal(item.source.bytes, key) };
                        this.pdfDrafts.set(item.source.bytes, draft);
                    }
                    originalId = draft.id;
                    originalMonth = draft.month;
                    try {
                        await this.client.uploadDatedOriginal(originalId, draft.encrypted, originalMonth);
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
                if (item.statement.sourceKind === 'pdf' && !originalId)
                    throw new Error('PDF原本がないため保存できません。');
                const record = { id, statement: clone(item.statement), ...(originalId ? { originalId, originalMonth } : {}) };
                const target = this.working(year, changes);
                const index = target.records.findIndex(r => r.id === id);
                if (index >= 0)
                    target.records[index] = record;
                else
                    target.records.push(record);
                target.deleted = target.deleted.filter(x => x !== id);
                if (previousBucket && previousBucket !== year)
                    moves.push({ id, from: previousBucket, to: year });
            }
            // Multi-year writes are not atomic. Distinguish an uncertain result from a rejected edit.
            this.mutationWarning = null;
            let committedYears = 0;
            try {
                // First put records into their destinations; only afterwards tombstone old-year copies.
                for (const [year, updated] of changes) {
                    await this.commitYear(year, updated, new Set(ids));
                    committedYears++;
                }
                for (const move of moves) {
                    const old = this.working(move.from, new Map());
                    old.records = old.records.filter(r => r.id !== move.id);
                    if (!old.deleted.includes(move.id))
                        old.deleted.push(move.id);
                    await this.commitYear(move.from, old);
                    committedYears++;
                }
            }
            catch (error) {
                if (committedYears === 0 && (error instanceof CloudEditCancelledError || isDefiniteWriteRejection(error)))
                    throw error;
                this.pendingYearBatch = {
                    items: items.map((item, i) => ({ id: ids[i], statement: clone(item.statement), ...(item.source ? { source: item.source } : {}) })),
                    before, ids: [...ids],
                };
                throw new CloudWriteUncertainError('一部の明細は保存済みの可能性があります。設定から保存を再開してください。', error);
            }
            try {
                await this.refresh();
            }
            catch {
                this.mutationWarning = 'OneDriveへの保存は確認できましたが、最後の最新データ取得に失敗しました。通信回復後に取得してください。';
            }
            return ids;
        });
    }
    /** Reconcile before retrying a partial year batch. Never overwrite an intervening edit. */
    async resumePendingYearBatch() {
        if (!this.pendingYearBatch)
            throw new Error('再開する保存はありません。');
        if (!this.key)
            throw new Error('保管庫を解除してください。');
        const pending = this.pendingYearBatch;
        // A failed read must leave the in-memory retry plan untouched.
        await this.refresh();
        const remaining = [];
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        for (const item of pending.items) {
            const before = pending.before.get(item.id) ?? null;
            const actual = this.records().find(record => record.id === item.id) ?? null;
            const target = statementBucket(item.statement.billingMonth);
            const copies = [...this.shards].filter(([, shard]) => shard.document.records.some(x => x.id === item.id)).map(([year]) => year);
            if (actual && same(actual.statement, item.statement) && copies.length === 1 && copies[0] === target)
                continue; // Already confirmed on OneDrive; do not write this year again.
            if (actual && same(actual.statement, item.statement)) {
                // Destination committed but old-year tombstone may be missing.
                continue;
            }
            if (!same(actual, before))
                throw new CloudEditCancelledError('他の端末で明細が更新されています。未完了の保存は上書きしません。');
            remaining.push(item);
        }
        // Every item has either the exact intended remote statement or an unchanged
        // original. Retry only unfinished records, keeping their original IDs.
        this.pendingYearBatch = null;
        try {
            if (remaining.length)
                await this.saveBatch(remaining);
            // Cleanup of old-year copies is separate and runs only after destination
            // records are present. This also handles a move to an *earlier* year.
            await this.refresh();
            for (const item of pending.items) {
                const target = statementBucket(item.statement.billingMonth);
                const confirmed = this.shards.get(target)?.document.records.find(r => r.id === item.id);
                if (!confirmed || !same(confirmed.statement, item.statement))
                    throw new Error('保存先の明細を確認できませんでした。');
                await this.registerYear(target);
                for (const [year, shard] of [...this.shards]) {
                    if (year === target || !shard.document.records.some(r => r.id === item.id))
                        continue;
                    const changed = clone(shard.document);
                    changed.records = changed.records.filter(r => r.id !== item.id);
                    if (!changed.deleted.includes(item.id))
                        changed.deleted.push(item.id);
                    await this.commitYear(year, changed);
                }
            }
            await this.refresh();
            return pending.ids;
        }
        catch (error) {
            // If a retry failed after an upload, retain the original plan so a later
            // verified refresh can reconcile all copies rather than blindly resubmit.
            this.pendingYearBatch = pending;
            throw error instanceof CloudWriteUncertainError ? error : new CloudWriteUncertainError('保存結果を確認できません。再接続後に保存を再開してください。', error);
        }
    }
    async delete(id) {
        return measureFinancePhase('vault.delete-record', async () => {
            if (this.pendingYearBatch)
                throw new CloudWriteUncertainError('未確認の保存があります。設定から保存を再開してください。', null);
            if (!this.key)
                throw new Error('先にOneDrive保管庫を解除してください。');
            await this.assertActiveGeneration();
            // Multiple copies can temporarily exist while moving billing months; remove all.
            const years = [...this.shards].filter(([, s]) => s.document.records.some(r => r.id === id)).map(([year]) => year);
            this.mutationWarning = null;
            let deletedYears = 0;
            try {
                for (const year of years) {
                    const changed = clone(this.shards.get(year).document);
                    changed.records = changed.records.filter(r => r.id !== id);
                    if (!changed.deleted.includes(id))
                        changed.deleted.push(id);
                    await this.commitYear(year, changed);
                    deletedYears++;
                }
            }
            catch (error) {
                if (error instanceof CloudEditCancelledError && deletedYears === 0)
                    throw error;
                throw new CloudWriteUncertainError('明細の削除がOneDriveで完了している可能性があります。再操作せず最新データを取得してください。', error);
            }
            try {
                await this.refresh();
            }
            catch {
                this.mutationWarning = '明細の削除は確認できましたが、最新データ取得に失敗しました。通信回復後に取得してください。';
            }
            // Originals are retained for recovery; audited cleanup is a separate operation.
        });
    }
    async registerYear(year) {
        if (!this.key)
            throw new Error('ロックされています。');
        if (this.index.years.includes(year))
            return; // This shard was registered earlier.
        for (let attempt = 0; attempt < 5; attempt++) {
            const file = await this.client.readFinanceIndex();
            if (!file)
                throw new Error('OneDriveの索引がなくなりました。');
            const env = parseIndexEnvelope(file.text);
            if (env.salt !== this.salt || (env.dataSetId ?? null) !== this.dataSetId)
                throw new Error('異なる暗号化索引です。');
            const index = await decryptIndex(env, this.key);
            if (index.years.includes(year)) {
                this.index = index;
                return;
            }
            const changed = { ...index, years: [...index.years, year].sort() };
            try {
                await this.client.writeFinanceIndex(await encryptIndex(changed, this.key, this.salt, this.dataSetId), { id: file.id, etag: file.etag });
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
    }
    async commitYear(year, changed, protectedIds = new Set()) {
        return measureFinancePhase('vault.year-commit', async () => {
            if (!this.key)
                throw new Error('保管庫はロックされています。');
            const base = clone(this.shards.get(year)?.document ?? emptyDocument());
            for (let attempt = 0; attempt < 5; attempt++) {
                const currentRef = this.shards.get(year)?.ref ?? null;
                const check = typeof this.client.readYearVaultForSave === 'function'
                    ? await this.client.readYearVaultForSave(year, currentRef)
                    : { kind: 'remote', file: await this.client.readYearVault(year) };
                const remote = check.kind === 'unchanged' ? currentRef : check.file;
                let latest = check.kind === 'unchanged' ? clone(base) : emptyDocument();
                if (check.kind === 'remote' && check.file) {
                    const env = parseEnvelope(check.file.text);
                    if (env.salt !== this.salt)
                        throw new Error('別の暗号化保管庫が同じ年度に存在します。');
                    latest = await decryptDocument(env, this.key);
                }
                const collisions = detectDocumentEditCollisions(base, changed, latest);
                await this.approveCollision(collisions, this.statementConflictResolver, 'カード明細');
                const merged = mergeDocuments(base, changed, latest, new Date().toISOString(), undefined, collisions.length > 0);
                const duplicates = duplicateStatementMonths(merged.records, protectedIds);
                if (duplicates.length)
                    throw new CloudEditCancelledError(`同じカード・請求月の明細がOneDrive側で重複しています（${duplicates.join('、')}）。最新データを取得し、差し替え先を確認してください。`);
                try {
                    const result = await this.client.writeYearVault(year, await encryptDocument(merged, this.key, this.salt), remote ? { id: remote.id, etag: remote.etag } : null);
                    if (result?.id && result.etag) {
                        // This ETag belongs to exactly the document we uploaded. If another
                        // device updates afterwards, the next refresh detects its new ETag.
                        this.shards.set(year, { document: merged, ref: { id: result.id, etag: result.etag } });
                        this.recordsViewCache = null;
                    }
                    else {
                        // Compatibility fallback for Graph responses without a usable ETag.
                        // Never pair our local document with an unrelated remote ETag.
                        const saved = await this.client.readYearVault(year);
                        if (!saved)
                            throw new Error('年別明細の保存結果を確認できません。');
                        const verifiedEnvelope = parseEnvelope(saved.text);
                        if (verifiedEnvelope.salt !== this.salt)
                            throw new Error('保存直後に暗号化保管庫が変更されました。');
                        const verifiedDocument = await decryptDocument(verifiedEnvelope, this.key);
                        if (JSON.stringify(verifiedDocument) !== JSON.stringify(merged))
                            throw new CloudWriteUncertainError('年別明細の保存結果が他の編集と異なります。最新データを確認してください。', null);
                        this.shards.set(year, { document: verifiedDocument, ref: { id: saved.id, etag: saved.etag } });
                        this.recordsViewCache = null;
                    }
                    await this.registerYear(year);
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
    async refresh() {
        if (!this.key)
            throw new Error('先にOneDrive保管庫を解除してください。');
        if (this.rotating)
            throw new Error('保管庫のパスフレーズ変更中です。完了後に再試行してください。');
        // readCurrent() validates the current index salt and generation itself.
        // A second assertActiveGeneration() would download the same index twice.
        const refreshKey = this.key, refreshSalt = this.salt, refreshGeneration = this.dataSetId;
        const [current, rules, assets] = await measureFinancePhase('vault.refresh', () => Promise.all([
            measureFinancePhase('vault.years', () => this.readCurrent(refreshKey, refreshSalt)),
            measureFinancePhase('vault.rules', () => this.readMerchantRules(refreshKey, refreshSalt)),
            measureFinancePhase('vault.assets', () => this.readAssets(refreshKey, refreshSalt)),
        ]));
        // A lock or changed key during a network operation invalidates the result.
        if (this.key !== refreshKey || this.salt !== refreshSalt || this.dataSetId !== refreshGeneration)
            throw new BrowserKeyGenerationChangedError();
        const { index, shards } = current;
        this.index = index;
        this.shards = shards;
        this.recordsViewCache = null;
        this.rulesDocument = rules.document;
        this.rulesRef = rules.ref;
        this.assetsDocument = assets.document;
        this.assetsRef = assets.ref;
        // Only after *all* cloud reads succeed is another mutation safe.
        this.rulesNeedRefresh = false;
        this.assetsNeedRefresh = false;
        return this.records();
    }
    async original(id) {
        if (!this.key)
            throw new Error('クラウド保管庫はロックされています。');
        const record = this.records().find(r => r.id === id);
        if (!record?.originalId)
            return null;
        return decryptOriginal(await this.client.downloadDatedOriginal(record.originalId, record.originalMonth ?? record.statement.billingMonth), this.key);
    }
}
