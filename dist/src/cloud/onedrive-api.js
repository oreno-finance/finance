/** Microsoft Graph API client for the encrypted Finance vault and connectivity checks. */
import { PROBE_FILE_NAME } from './test-envelope.js';
import { countFinanceRequest, measureFinancePhase } from './performance-diagnostics.js';
import { FINANCE_DIR, PAYROLL_DIR, checkBucket, checkOriginalMonth, originalParts } from './layout.js';
import { asSnapshots, isSnapshotName, MAX_SNAPSHOT_BYTES, snapshotName, validateBackupText } from './vault-snapshots.js';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GENERATION_NAME = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export class GraphError extends Error {
    status;
    code;
    constructor(status, code) {
        super(`OneDrive APIエラー (${status}${code ? ` / ${code}` : ''})。権限・接続・アカウントを確認してください。`);
        this.status = status;
        this.code = code;
    }
}
/** This is an empty coordination folder, never a data file. Folder creation
 * uses conflictBehavior=fail, not an upload session or a read-then-write lock.
 * No lease expiry: a suspended tab must never regain permission after expiry. */
const MUTATION_LOCK_NAME = 'finance-operation-lock';
/** Honor an explicit throttling response, without replaying an ambiguous write. */
function throttlingDelay(response, attempt) {
    const value = response.headers.get('Retry-After');
    const delay = value === null ? 1000 * 2 ** attempt : /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    if (!Number.isFinite(delay) || delay > 60000)
        return null;
    return Math.max(0, delay);
}
const wait = (ms) => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
export class VaultOperationBusyError extends Error {
    constructor(message = '別の端末で保存中か、前回の通信中断で保存ロックが残っています。時間を置いて再試行してください。続く場合は設定の「保存ロックを確認」を利用してください。') { super(message); this.name = 'VaultOperationBusyError'; }
}
/** A data write is still unconfirmed, not merely a failed lock DELETE. */
export class VaultMutationUncertainError extends Error {
    constructor() { super('OneDriveの書込み結果が不明なため操作ロックを保持しました。設定の保存ロック復旧で保存結果を確認してください。'); this.name = 'VaultMutationUncertainError'; }
}
export class OneDriveTestClient {
    tokenSource;
    http;
    onUnauthorized;
    mutationLease = null;
    mutationAcquiring = false;
    // Only a marker created by this client, after a known-ended write.
    completedMarker = null;
    async acquireVaultMutation(guard) {
        if (this.mutationLease || this.mutationAcquiring)
            throw new VaultOperationBusyError();
        this.mutationAcquiring = true;
        try {
            guard();
            const parent = await this.folderPath([FINANCE_DIR], true);
            if (!parent)
                throw new Error('保管庫の操作領域を確認できません。');
            guard();
            if (this.completedMarker?.parent === parent) {
                const previous = this.completedMarker;
                const current = await this.readRecoveryMarker(parent, previous.id);
                guard();
                if (current)
                    await this.releaseMutationMarker(current, guard);
                this.completedMarker = null;
            }
            guard();
            let item;
            try {
                const response = await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: MUTATION_LOCK_NAME, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
                }, false, true, false, guard);
                if (response.status !== 201)
                    throw new Error('操作ロックの新規作成を確認できません。');
                item = await response.json();
                if (typeof item?.id === 'string' && item.id && item.name === MUTATION_LOCK_NAME && item.folder && !item.eTag) {
                    const createdId = item.id;
                    const metadata = await this.graph(`/me/drive/items/${encodeURIComponent(createdId)}?$select=id,name,eTag,folder`, { cache: 'no-store' });
                    item = await metadata.json();
                    if (item.id !== createdId)
                        throw new Error('作成したロックのIDが一致しません。');
                }
            }
            catch (error) {
                if (error instanceof GraphError && [409, 412].includes(error.status))
                    throw new VaultOperationBusyError();
                if (error instanceof GraphError && error.status === 429)
                    throw new Error('OneDriveの通信制限（HTTP 429）により保存を開始できませんでした。時間を置いて再試行してください。');
                throw new Error('保管庫の操作権を確認できません。設定の保存ロックを確認し、中断した操作だけを復旧してください。');
            }
            if (typeof item.id !== 'string' || !item.id || typeof item.eTag !== 'string' || !item.eTag || item.name !== MUTATION_LOCK_NAME || !item.folder || typeof item.folder !== 'object' || Array.isArray(item.folder) || (item.folder.childCount !== undefined && item.folder.childCount !== 0))
                throw new Error('OneDriveの操作ロック作成結果が不明です。保存は開始しません。');
            const lease = { uncertain: false, guard, released: false };
            this.mutationLease = lease;
            return async () => {
                if (this.mutationLease !== lease)
                    throw new Error('保管庫の操作権が変化しました。');
                try {
                    // A lost final response might mean the server is still committing.
                    // Do not make a destructive operation possible by releasing its fence.
                    if (lease.uncertain)
                        throw new VaultMutationUncertainError();
                    const marker = { id: item.id, etag: item.eTag, createdAt: null };
                    this.completedMarker = { parent, id: marker.id };
                    try {
                        await this.releaseMutationMarker(marker, () => { });
                    }
                    catch (error) {
                        // OneDrive may update the empty coordination folder's metadata after
                        // creation. Only the client that created this exact ID may refresh
                        // its ETag, and only after a definite conditional DELETE rejection.
                        // Never transfer ownership to a successor or bypass If-Match.
                        if (!(error instanceof GraphError && error.status === 412 && error.code.toLowerCase() === 'resourcemodified'))
                            throw error;
                        const current = await this.readRecoveryMarker(parent, marker.id);
                        if (!current) {
                            this.completedMarker = null;
                            return;
                        }
                        if (current.id !== marker.id || current.etag === marker.etag)
                            throw error;
                        // This is a single revalidation, not an unbounded 412 retry loop.
                        await this.releaseMutationMarker(current, () => { });
                    }
                    this.completedMarker = null;
                }
                finally {
                    lease.released = true;
                    this.mutationLease = null;
                }
            };
        }
        finally {
            this.mutationAcquiring = false;
        }
    }
    /** Read-only inspection. Never infer ownership or expiry from the marker age. */
    async inspectVaultMutationLock() {
        const parent = await this.folderPath([FINANCE_DIR], false);
        if (!parent)
            return { state: 'absent', createdAt: null };
        try {
            const response = await this.graph(`/me/drive/items/${encodeURIComponent(parent)}:/${MUTATION_LOCK_NAME}?$select=id,name,folder,createdDateTime`);
            const item = await response.json();
            if (!item || typeof item.id !== 'string' || !item.id || item.name !== MUTATION_LOCK_NAME || !item.folder || typeof item.folder !== 'object' || Array.isArray(item.folder))
                throw new Error('保存ロックの形式を確認できません。');
            const created = typeof item.createdDateTime === 'string' ? new Date(item.createdDateTime) : null;
            return { state: 'present', createdAt: created && Number.isFinite(created.valueOf()) ? created.toISOString() : null };
        }
        catch (error) {
            if (error instanceof GraphError && error.status === 404)
                return { state: 'absent', createdAt: null };
            throw error;
        }
    }
    /** Delete only this exact marker. Replaying a conditional DELETE cannot
     * delete a successor (which has a different ID). A 412 is not retried by this helper. */
    async releaseMutationMarker(marker, guard) {
        for (let attempt = 0; attempt < 2; attempt++) {
            guard();
            try {
                const response = await this.graph(`/me/drive/items/${encodeURIComponent(marker.id)}`, { method: 'DELETE', headers: { 'If-Match': marker.etag } }, false, true, false, guard);
                if (response.status !== 204)
                    throw new Error('操作ロックの削除応答が不明です。');
                return;
            }
            catch (error) {
                if (error instanceof GraphError && error.status === 404)
                    return; // this exact ID is already gone
                if (attempt || error instanceof GraphError && error.status < 500 && error.status !== 408)
                    throw error;
                await wait(500);
            }
        }
    }
    async readRecoveryMarker(parent, expectedId) {
        let item;
        try {
            item = await (await this.graph(`/me/drive/items/${encodeURIComponent(parent)}:/${MUTATION_LOCK_NAME}?$select=id,name,folder,eTag,createdDateTime`, { cache: 'no-store' })).json();
        }
        catch (error) {
            if (error instanceof GraphError && error.status === 404)
                return null;
            throw error;
        }
        if (!item || typeof item.id !== 'string' || !item.id || typeof item.eTag !== 'string' || !item.eTag || item.name !== MUTATION_LOCK_NAME || !item.folder || typeof item.folder !== 'object' || Array.isArray(item.folder) || (item.folder.childCount !== undefined && item.folder.childCount !== 0))
            throw new Error('空の保存ロックと更新情報を確認できません。解除しません。');
        if (expectedId !== undefined && item.id !== expectedId) {
            this.completedMarker = null;
            throw new VaultOperationBusyError('保存ロックのIDが変化しました。別の操作のロックは解除しません。');
        }
        const children = await (await this.graph(`/me/drive/items/${encodeURIComponent(item.id)}/children?$select=id&$top=1`, { cache: 'no-store' })).json();
        if (!Array.isArray(children.value) || children.value.length || children['@odata.nextLink'])
            throw new Error('保存ロックが空ではない、または一覧を確認できません。解除しません。');
        const date = typeof item.createdDateTime === 'string' ? new Date(item.createdDateTime) : null;
        return { id: item.id, etag: item.eTag, createdAt: date && Number.isFinite(date.valueOf()) ? date.toISOString() : null };
    }
    /** Explicit recovery only. No expiry or takeover of an active lease.
     * User must stop other clients and confirm interrupted writes; an unchanged
     * marker is not proof that another device has stopped. */
    async recoverVaultMutationLock(guard, verify, approve) {
        if (this.mutationLease || this.mutationAcquiring)
            throw new VaultOperationBusyError();
        this.mutationAcquiring = true;
        try {
            guard();
            this.clearDirectoryCache();
            const parent = await this.folderPath([FINANCE_DIR], false);
            guard();
            if (!parent)
                return 'absent';
            const marker = await this.readRecoveryMarker(parent);
            guard();
            if (!marker)
                return 'absent';
            if (!await approve(marker.createdAt))
                return 'cancelled';
            guard();
            await verify();
            guard();
            const current = await this.readRecoveryMarker(parent);
            guard();
            if (!current || current.id !== marker.id || current.etag !== marker.etag)
                throw new Error('確認中に保存ロックが変化しました。解除せず停止しました。');
            await this.releaseMutationMarker(marker, guard);
            guard();
            if (this.completedMarker?.id === marker.id)
                this.completedMarker = null;
            return 'released';
        }
        finally {
            this.mutationAcquiring = false;
        }
    }
    checkMutationGuard() { if (this.mutationLease) {
        if (this.mutationLease.released)
            throw new Error('保管庫の操作権が解除されました。');
        this.mutationLease.guard();
    } }
    markMutationUncertain() { if (this.mutationLease)
        this.mutationLease.uncertain = true; }
    // Resolve Graph folder IDs once per client session. These are non-secret IDs,
    // retained only in memory; a new sign-in/client receives a fresh cache.
    appRoot = null;
    dataSetId = null;
    // Bounded encrypted-text cache. Each invocation still checks Graph metadata / ETag.
    // Conservative JS string footprint (UTF-16, 2 bytes/code unit). Encrypted
    // originals must never enter this cache, even when their ETag is unchanged.
    static MAX_ENCRYPTED_CACHE_BYTES = 8 * 1024 * 1024;
    encryptedReadCache = new Map();
    encryptedReadJobs = new Map();
    encryptedReadEpoch = 0;
    /** v2 data sets are isolated; only index.enc remains at the stable root. */
    setVaultDataSet(id) {
        if (id !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
            throw new Error('保管庫世代IDが不正です。');
        if (this.dataSetId !== id) {
            this.encryptedReadCache.clear();
            this.encryptedReadJobs.clear();
            this.encryptedReadEpoch++;
        }
        this.dataSetId = id;
    }
    forVaultDataSet(id) {
        const stage = new OneDriveTestClient(this.tokenSource, this.http, this.onUnauthorized);
        stage.setVaultDataSet(id);
        stage.mutationLease = this.mutationLease;
        return stage;
    }
    financeDataPath(...tail) {
        return this.dataSetId ? [FINANCE_DIR, 'versions', this.dataSetId, ...tail] : [FINANCE_DIR, ...tail];
    }
    directoryIds = new Map();
    resolvingDirectories = new Map();
    clearDirectoryCache() {
        this.directoryIds.clear();
        this.resolvingDirectories.clear();
        this.appRoot = null;
    }
    // Browser fetch is a host method: passing it around unbound can trigger
    // `Failed to execute 'fetch' on 'Window': Illegal invocation`.
    // Call it through globalThis so the native receiver is preserved. Custom
    // HTTP functions can still be injected by tests.
    constructor(tokenSource, http = (input, init) => globalThis.fetch(input, init), onUnauthorized) {
        this.tokenSource = tokenSource;
        this.http = http;
        this.onUnauthorized = onUnauthorized;
    }
    /** A single read deadline covers headers and the entire response body.
     * Writes are never aborted here because their committed state may be uncertain. */
    async withReadDeadline(url, init, consume, timeoutMs = 30000) {
        const controller = new AbortController();
        let timeout;
        const expired = new Promise((_, reject) => {
            timeout = setTimeout(() => {
                controller.abort();
                reject(new Error(`OneDriveの読み取りが${Math.ceil(timeoutMs / 1000)}秒以内に完了しませんでした。`));
            }, timeoutMs);
        });
        try {
            return await Promise.race([
                (async () => consume(await this.http(url, { ...init, signal: controller.signal })))(),
                expired,
            ]);
        }
        catch (error) {
            if (controller.signal.aborted)
                throw new Error(`OneDriveの読み取りが${Math.ceil(timeoutMs / 1000)}秒以内に完了しませんでした。`);
            throw error;
        }
        finally {
            if (timeout !== undefined)
                clearTimeout(timeout);
        }
    }
    async readResponseBytes(response, maxBytes) {
        if (Number(response.headers.get('Content-Length') ?? 0) > maxBytes)
            throw new Error('OneDriveのファイルがサイズ上限を超えています。');
        if (!response.body) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length > maxBytes)
                throw new Error('OneDriveのファイルがサイズ上限を超えています。');
            return bytes;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                length += value.byteLength;
                if (length > maxBytes)
                    throw new Error('OneDriveのファイルがサイズ上限を超えています。');
                chunks.push(value);
            }
        }
        catch (error) {
            // Stop the network stream immediately if the limit or read fails.
            try {
                await reader.cancel();
            }
            catch { /* Preserve the original validation error. */ }
            throw error;
        }
        finally {
            reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    }
    async httpWithReadTimeout(url, init) {
        if ((init.method ?? 'GET').toUpperCase() !== 'GET')
            return this.http(url, init);
        // Graph metadata is JSON and must fit within 8 MiB; downloading originals
        // uses the separate size-bounded streaming path below.
        return this.withReadDeadline(url, init, async (response) => {
            const data = await this.readResponseBytes(response, 8 * 1024 * 1024);
            return new Response([204, 205, 304].includes(response.status) ? null : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), {
                status: response.status, statusText: response.statusText, headers: response.headers,
            });
        });
    }
    async graph(path, init = {}, allowNotModified = false, lockRequest = false, nonCommitting = false, requestGuard = () => { }) {
        const method = (init.method ?? 'GET').toUpperCase();
        let sent = false;
        const request = async (forceRefresh = false) => {
            // An old client remains usable after the access token expires; MSAL owns
            // every token's lifetime. Never hold a bearer token inside this client.
            sent = false;
            requestGuard();
            if (method !== 'GET' && !lockRequest)
                this.checkMutationGuard();
            const token = typeof this.tokenSource === 'string'
                ? this.tokenSource : await this.tokenSource(forceRefresh);
            requestGuard();
            if (method !== 'GET' && !lockRequest)
                this.checkMutationGuard();
            sent = true;
            countFinanceRequest(method === 'GET' ? 'graph.get' : 'graph.write');
            return measureFinancePhase('graph.request', () => this.httpWithReadTimeout(GRAPH + path, {
                ...init,
                headers: { ...init.headers, Authorization: `Bearer ${token}` },
                redirect: 'error',
            }));
        };
        let response;
        const send = async () => {
            try {
                return await request();
            }
            catch (error) {
                if (sent && method !== 'GET' && !lockRequest && !nonCommitting)
                    this.markMutationUncertain();
                throw error;
            }
        };
        response = await send();
        // 429 is an explicit throttling rejection. Honor Retry-After; never replay
        // ambiguous 408/5xx or transport failures for a data write.
        for (let attempt = 0; attempt < 3 && (response.status === 429 || (method === 'GET' && response.status === 503)); attempt++) {
            const delay = response.status === 429 ? throttlingDelay(response, attempt) : 200 * (attempt + 1);
            if (delay === null)
                break;
            await wait(delay);
            response = await send();
        }
        if (!lockRequest && !nonCommitting && method !== 'GET' && (response.status === 408 || response.status >= 500))
            this.markMutationUncertain();
        // One read-only 401 recovery is safe. Never replay writes, upload-session
        // creation, chunk uploads, or any uncertain operation after a 401.
        if (response.status === 401 && method === 'GET' && typeof this.tokenSource !== 'string') {
            response = await request(true);
        }
        if (response.status === 401)
            this.onUnauthorized?.();
        if (!response.ok && !(allowNotModified && response.status === 304)) {
            let code = '';
            try {
                const json = await response.json();
                code = typeof json.error?.code === 'string' ? json.error.code.slice(0, 80) : '';
            }
            catch { /* Errors can be HTML or empty. */ }
            throw new GraphError(response.status, code);
        }
        return response;
    }
    async downloadItemInfo(id, maxBytes, supplied, fresh = false) {
        let item = supplied;
        // Named-path lookups often already include the temporary download URL.
        // Otherwise fetch by ID exactly once (also gets the freshest ETag).
        if (!item?.['@microsoft.graph.downloadUrl'] || !item.eTag) {
            const response = await this.graph(`/me/drive/items/${encodeURIComponent(id)}`, fresh ? { cache: 'no-store' } : {});
            item = await response.json();
        }
        if (!item?.id)
            throw new Error('OneDriveのファイルIDを取得できませんでした。');
        if (item.size && item.size > maxBytes)
            throw new Error('OneDriveのファイルがサイズ上限を超えています。');
        const url = item['@microsoft.graph.downloadUrl'];
        if (!url || new URL(url).protocol !== 'https:')
            throw new Error('安全なダウンロードURLを取得できませんでした。');
        // Originals may be up to 200 MiB. Give only these downloads a longer,
        // bounded full-body deadline; small encrypted files retain 30 seconds.
        const timeoutMs = maxBytes >= 100 * 1024 * 1024
            ? Math.min(180000, Math.max(90000, Math.ceil((item.size ?? maxBytes) / (1024 * 1024)) * 1000))
            : 30000;
        countFinanceRequest('graph.download');
        const bytes = await measureFinancePhase('graph.encrypted-download', async () => {
            for (let attempt = 0;; attempt++) {
                const result = await this.withReadDeadline(url, { method: 'GET', credentials: 'omit', ...(fresh ? { cache: 'no-store' } : {}) }, async (response) => {
                    if (response.status === 429 && attempt < 3) {
                        const delay = throttlingDelay(response, attempt);
                        if (delay !== null) {
                            try {
                                await response.body?.cancel();
                            }
                            catch { /* no retry body is needed */ }
                            return { delay };
                        }
                    }
                    if (!response.ok)
                        throw new Error(`OneDriveからの取得に失敗しました (HTTP ${response.status})。`);
                    return { bytes: await this.readResponseBytes(response, maxBytes) };
                }, timeoutMs);
                if ('bytes' in result && result.bytes)
                    return result.bytes;
                await wait(result.delay ?? 0);
            }
        });
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), item };
    }
    async downloadItem(id, maxBytes) {
        return (await this.downloadItemInfo(id, maxBytes)).text;
    }
    async listVaultSnapshots() {
        const folder = await this.appFolderId();
        const response = await this.graph(`/me/drive/items/${encodeURIComponent(folder)}/children?$select=id,name,size,createdDateTime&$top=200`);
        const data = await response.json();
        // No implicit traversal to arbitrary URLs and no silent incomplete listing.
        if (data['@odata.nextLink'])
            throw new Error('スナップショットが200件を超えました。手動整理が必要です。');
        return asSnapshots(data.value);
    }
    async uploadVaultSnapshot(text) {
        validateBackupText(text);
        const folder = await this.appFolderId();
        const name = snapshotName(new Date(), crypto.randomUUID());
        const namePath = `/me/drive/items/${encodeURIComponent(folder)}:/${encodeURIComponent(name)}:`;
        const payload = new TextEncoder().encode(text);
        let item;
        if (payload.byteLength <= 4 * 1024 * 1024) {
            // Graph's conflictBehavior=fail disallows accidental replacement of an existing filename.
            const response = await this.graph(`${namePath}/content?@microsoft.graph.conflictBehavior=fail`, {
                method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: payload,
            });
            item = await response.json();
        }
        else {
            // Large PDF-backed vaults use Graph upload sessions. 3,276,800 bytes = 10 x 320 KiB.
            const sessionResponse = await this.graph(`${namePath}/createUploadSession`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }),
            });
            const session = await sessionResponse.json();
            if (!session.uploadUrl || new URL(session.uploadUrl).protocol !== 'https:') {
                throw new Error('OneDriveの安全なアップロードURLを取得できませんでした。');
            }
            const chunkSize = 320 * 1024 * 10;
            item = {};
            for (let start = 0; start < payload.byteLength; start += chunkSize) {
                const end = Math.min(start + chunkSize, payload.byteLength);
                const chunk = payload.slice(start, end);
                // Preauthenticated uploadUrl: never pass the Graph bearer token.
                const part = await this.http(session.uploadUrl, {
                    method: 'PUT', credentials: 'omit',
                    headers: { 'Content-Range': `bytes ${start}-${end - 1}/${payload.byteLength}` },
                    body: chunk,
                });
                if (!part.ok)
                    throw new Error(`分割アップロードに失敗しました (HTTP ${part.status})。`);
                if (end < payload.byteLength) {
                    if (part.status !== 202)
                        throw new Error('OneDriveのアップロードが途中で終了しました。');
                }
                else {
                    if (part.status !== 200 && part.status !== 201)
                        throw new Error('OneDriveがアップロード完了を返しませんでした。');
                    item = await part.json();
                }
            }
        }
        if (!item.id)
            throw new Error('OneDriveの保存結果を確認できませんでした。');
        return { id: item.id, name, size: new TextEncoder().encode(text).byteLength, createdDateTime: item.createdDateTime ?? new Date().toISOString() };
    }
    async downloadVaultSnapshot(snapshot) {
        if (!isSnapshotName(snapshot.name) || snapshot.size > MAX_SNAPSHOT_BYTES)
            throw new Error('選択されたバックアップが不正です。');
        // Never download an arbitrary OneDrive file id without verifying it is still one of our files.
        const current = (await this.listVaultSnapshots()).find(item => item.id === snapshot.id && item.name === snapshot.name);
        if (!current)
            throw new Error('選択されたスナップショットがOneDriveに見つかりません。');
        const text = await this.downloadItem(current.id, MAX_SNAPSHOT_BYTES);
        validateBackupText(text);
        return text;
    }
    /** The live encrypted document is independent from immutable v0.9 backups. */
    async readLiveVault() {
        const folder = await this.appFolderId();
        let item;
        try {
            const response = await this.graph(`/me/drive/items/${encodeURIComponent(folder)}:/finance-v1-vault.enc`);
            item = await response.json();
        }
        catch (error) {
            if (error instanceof GraphError && error.status === 404)
                return null;
            throw error;
        }
        if (!item.id || !item.eTag)
            throw new Error('OneDriveの更新情報（ETag）を取得できません。');
        return { text: await this.downloadItem(item.id, 25_000_000), id: item.id, etag: item.eTag };
    }
    async uploadSession(path, bytes, etag) {
        if (bytes.byteLength > 200 * 1024 * 1024)
            throw new Error('アップロードサイズが200MBを超えています。');
        const response = await this.graph(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
            body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': etag ? 'replace' : 'fail' } }),
        }, false, false, true);
        const session = await response.json();
        if (!session.uploadUrl || new URL(session.uploadUrl).protocol !== 'https:')
            throw new Error('安全なアップロードセッションを取得できません。');
        // 3,276,800 is a multiple of 320KiB; upload sequentially without the Graph bearer token.
        const size = 3276800;
        for (let start = 0; start < bytes.byteLength; start += size) {
            const end = Math.min(start + size, bytes.byteLength);
            countFinanceRequest('graph.upload-chunk');
            let part;
            const final = end === bytes.byteLength;
            for (let attempt = 0;; attempt++) {
                this.checkMutationGuard();
                try {
                    part = await this.http(session.uploadUrl, {
                        method: 'PUT', credentials: 'omit',
                        headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.byteLength}` },
                        body: bytes.slice(start, end),
                    });
                }
                catch (error) {
                    if (final)
                        this.markMutationUncertain();
                    throw error;
                }
                if (part.status !== 429 || attempt >= 3)
                    break;
                const delay = throttlingDelay(part, attempt);
                if (delay === null)
                    break;
                await wait(delay);
            }
            if (final && (part.status === 408 || part.status >= 500))
                this.markMutationUncertain();
            if (!part.ok) {
                if (part.status >= 400 && part.status < 500)
                    throw new GraphError(part.status, part.status === 429 ? 'throttled' : 'uploadRejected');
                throw new Error(`OneDriveへのアップロードが失敗しました (HTTP ${part.status})。`);
            }
            if (end < bytes.byteLength) {
                if (part.status !== 202) {
                    this.markMutationUncertain();
                    throw new Error('OneDriveのアップロードが途中で終了しました。');
                }
            }
            else {
                if (part.status !== 200 && part.status !== 201) {
                    this.markMutationUncertain();
                    throw new Error('OneDriveが保存完了を返しませんでした。');
                }
                const item = await part.json();
                if (!item.id)
                    throw new Error('OneDriveの保存IDを取得できません。');
                return item;
            }
        }
        throw new Error('空のアップロードは許可されません。');
    }
    async writeLiveVault(text, existing) {
        if (!text || new TextEncoder().encode(text).byteLength > 25_000_000)
            throw new Error('暗号化明細がサイズ上限を超えています。');
        const bytes = new TextEncoder().encode(text);
        const folder = await this.appFolderId();
        const path = existing
            ? `/me/drive/items/${encodeURIComponent(existing.id)}/createUploadSession`
            : `/me/drive/items/${encodeURIComponent(folder)}:/finance-v1-vault.enc:/createUploadSession`;
        await this.uploadSession(path, bytes, existing?.etag);
    }
    async originalsFolder(create) {
        const parent = await this.appFolderId();
        const path = `/me/drive/items/${encodeURIComponent(parent)}:/finance-v1-originals`;
        try {
            const response = await this.graph(path);
            const item = await response.json();
            return item.id;
        }
        catch (error) {
            if (!(error instanceof GraphError && error.status === 404))
                throw error;
        }
        if (!create)
            return null;
        try {
            const response = await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'finance-v1-originals', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
            }, false, false, true);
            const item = await response.json();
            if (!item.id)
                throw new Error('PDF保存フォルダの作成を確認できません。');
            return item.id;
        }
        catch (error) {
            if (error instanceof GraphError && error.status === 409) {
                const response = await this.graph(path);
                const item = await response.json();
                return item.id;
            }
            throw error;
        }
    }
    originalName(id) {
        if (!/^[0-9a-f-]{36}$/i.test(id))
            throw new Error('PDFの識別子が不正です。');
        return `${id}.enc`;
    }
    async uploadOriginal(id, encrypted) {
        const folder = await this.originalsFolder(true);
        if (!folder)
            throw new Error('PDF保存フォルダがありません。');
        const name = this.originalName(id);
        // Immutable object: existing originals are never overwritten.
        await this.uploadSession(`/me/drive/items/${encodeURIComponent(folder)}:/${name}:/createUploadSession`, new TextEncoder().encode(encrypted));
    }
    async downloadOriginal(id) {
        const folder = await this.originalsFolder(false);
        if (!folder)
            throw new Error('クラウドにPDF原本がありません。');
        const response = await this.graph(`/me/drive/items/${encodeURIComponent(folder)}:/${this.originalName(id)}`);
        const item = await response.json();
        if (!item.id)
            throw new Error('PDF原本の参照IDが不正です。');
        return this.downloadItem(item.id, 200 * 1024 * 1024);
    }
    /**
     * Some Graph/OneDrive responses can advertise HTTP 200 + JSON but contain
     * invalid metadata JSON. Resolve only the named child through the parent's
     * children collection when the direct named-path metadata cannot be parsed.
     * This fallback is READ ONLY; it never creates or modifies anything.
     */
    async findChildFolderByListing(parent, name) {
        const response = await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children?$select=id,name,folder&$top=200`);
        let listing;
        try {
            listing = await response.json();
        }
        catch (error) {
            if (error instanceof SyntaxError)
                throw new Error('OneDriveのフォルダ情報を両方の方法で解析できませんでした。');
            throw error;
        }
        if (!Array.isArray(listing.value))
            throw new Error('OneDriveのフォルダ一覧の形式が不正です。');
        const folder = listing.value.find(item => item?.name === name && typeof item.id === 'string' && item.id.length > 0 && item.folder && typeof item.folder === 'object');
        if (folder)
            return folder.id;
        // Never silently treat an incomplete listing as an absent folder.
        if (listing['@odata.nextLink'])
            throw new Error('OneDriveのフォルダ一覧が200件を超えたため参照できません。');
        return null;
    }
    /** Create/check one folder. Only successful IDs are cached (never a 404). */
    async childFolder(parent, name, create) {
        const location = `/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}`;
        let item;
        // `:/versions` conflicts with the Microsoft Graph driveItem version-history route.
        // Resolve this particular folder by the parent's children collection, regardless
        // of whether the reserved route returns 200 with a different JSON shape or 400.
        if (name === 'versions') {
            const found = await this.findChildFolderByListing(parent, name);
            if (found)
                item = { id: found };
        }
        else {
            try {
                const response = await this.graph(location);
                try {
                    item = await response.json();
                }
                catch (error) {
                    if (!(error instanceof SyntaxError))
                        throw error;
                    const recovered = await this.findChildFolderByListing(parent, name);
                    if (recovered)
                        item = { id: recovered };
                }
            }
            catch (error) {
                if (!(error instanceof GraphError && error.status === 404))
                    throw error;
            }
        }
        if (!item) {
            if (!create)
                return null;
            try {
                const response = await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
                }, false, false, true);
                item = await response.json();
            }
            catch (collision) {
                if (!(collision instanceof GraphError && collision.status === 409))
                    throw collision;
                if (name === 'versions') {
                    const recovered = await this.findChildFolderByListing(parent, name);
                    if (!recovered)
                        throw new Error('OneDriveのフォルダ作成結果を確認できません。');
                    item = { id: recovered };
                }
                else {
                    const response = await this.graph(location);
                    try {
                        item = await response.json();
                    }
                    catch (error) {
                        if (!(error instanceof SyntaxError))
                            throw error;
                        const recovered = await this.findChildFolderByListing(parent, name);
                        if (!recovered)
                            throw new Error('OneDriveのフォルダ作成結果を確認できません。');
                        item = { id: recovered };
                    }
                }
            }
        }
        if (!item?.id)
            throw new Error('OneDriveフォルダの識別子を確認できません。');
        return item.id;
    }
    /** Reuse IDs and coalesce concurrent lookups, without assuming a missing folder exists. */
    async folderPath(parts, create) {
        let parent = await this.appFolderId();
        let prefix = '';
        for (const name of parts) {
            if (!/^[a-z0-9-]{1,64}$/i.test(name))
                throw new Error('不正なクラウドフォルダ名です。');
            prefix += `/${name}`;
            const cached = this.directoryIds.get(prefix);
            if (cached) {
                parent = cached;
                continue;
            }
            const key = `${prefix}:${create ? 'create' : 'read'}`;
            // A concurrent creation is useful to both readers and writers.
            let pending = this.resolvingDirectories.get(create ? key : `${prefix}:create`) ?? this.resolvingDirectories.get(key);
            if (!pending) {
                pending = this.childFolder(parent, name, create);
                this.resolvingDirectories.set(key, pending);
            }
            let result;
            try {
                result = await pending;
            }
            finally {
                if (this.resolvingDirectories.get(key) === pending)
                    this.resolvingDirectories.delete(key);
            }
            if (!result)
                return null;
            this.directoryIds.set(prefix, result);
            parent = result;
        }
        return parent;
    }
    async findNamedFile(parts, name, fresh = false) {
        // A cached directory ID may become stale when a folder is moved outside
        // Finance. Resolve its path again once, then fail closed on an actual miss.
        let item = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const hadCachedPath = parts.some((_, i) => this.directoryIds.has(`/${parts.slice(0, i + 1).join('/')}`));
            const parent = await this.folderPath(parts, false);
            if (!parent) {
                if (attempt === 0 && hadCachedPath) {
                    this.clearDirectoryCache();
                    continue;
                }
                return null;
            }
            try {
                const response = await this.graph(`/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}`, fresh ? { cache: 'no-store' } : {});
                item = await response.json();
                break;
            }
            catch (error) {
                if (!(error instanceof GraphError && error.status === 404))
                    throw error;
                if (attempt === 0 && hadCachedPath) {
                    this.clearDirectoryCache();
                    continue;
                }
                return null;
            }
        }
        if (typeof item?.id !== 'string' || !item.id || typeof item.eTag !== 'string' || !item.eTag)
            throw new Error('OneDriveの更新情報を取得できません。');
        return item;
    }
    async readNamedFile(parts, name, maxBytes, fresh = false, reuseVerified = false) {
        const key = JSON.stringify([parts, name, maxBytes]);
        const epoch = this.encryptedReadEpoch;
        const waiting = this.encryptedReadJobs.get(key);
        if (waiting && !fresh)
            return waiting;
        const job = (async () => {
            const item = await this.findNamedFile(parts, name, fresh);
            if (!item) {
                if (epoch === this.encryptedReadEpoch)
                    this.encryptedReadCache.delete(key);
                return null;
            }
            const useCache = !parts.includes('originals') && name.endsWith('.enc') && maxBytes <= 25_000_000;
            const cached = (!fresh || reuseVerified) && useCache && epoch === this.encryptedReadEpoch ? this.encryptedReadCache.get(key) : undefined;
            if (cached && cached.id === item.id && cached.etag === item.eTag) {
                // Simple LRU: ETag-verified hits move to the end of the bounded map.
                this.encryptedReadCache.delete(key);
                this.encryptedReadCache.set(key, cached);
                return { ...cached };
            }
            const downloaded = await this.downloadItemInfo(item.id, maxBytes, item, fresh);
            const value = { text: downloaded.text, id: item.id, etag: downloaded.item.eTag ?? item.eTag };
            if (epoch === this.encryptedReadEpoch) {
                this.encryptedReadCache.delete(key);
                const limit = OneDriveTestClient.MAX_ENCRYPTED_CACHE_BYTES;
                if (useCache && value.text.length * 2 <= limit) {
                    this.encryptedReadCache.set(key, value);
                    let total = [...this.encryptedReadCache.values()].reduce((sum, file) => sum + file.text.length * 2, 0);
                    while (this.encryptedReadCache.size > 12 || total > limit) {
                        const oldest = this.encryptedReadCache.keys().next().value;
                        if (oldest === undefined)
                            break;
                        total -= this.encryptedReadCache.get(oldest).text.length * 2;
                        this.encryptedReadCache.delete(oldest);
                    }
                }
            }
            return { ...value };
        })();
        if (!fresh)
            this.encryptedReadJobs.set(key, job);
        try {
            return await job;
        }
        finally {
            if (this.encryptedReadJobs.get(key) === job)
                this.encryptedReadJobs.delete(key);
        }
    }
    async writeNamedFile(parts, name, text, existing, maxBytes) {
        const bytes = new TextEncoder().encode(text);
        if (!bytes.byteLength || bytes.byteLength > maxBytes)
            throw new Error('暗号ファイルの容量が不正です。');
        const parent = await this.folderPath(parts, true);
        if (!parent)
            throw new Error('クラウド保存フォルダを作れませんでした。');
        const path = existing
            ? `/me/drive/items/${encodeURIComponent(existing.id)}/createUploadSession`
            : `/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}:/createUploadSession`;
        const lease = this.mutationLease, wasUncertain = lease?.uncertain;
        try {
            // Upload sessions retain the documented If-Match/409/412 flow for live data.
            // Direct PUT on Personal OneDrive lacks a documented final-boundary ETag guarantee.
            const result = await measureFinancePhase('vault.encrypted-upload', () => this.uploadSession(path, bytes, existing?.etag));
            this.encryptedReadCache.delete(JSON.stringify([parts, name, maxBytes]));
            // Some Graph variants omit ETag on upload completion. The caller will
            // perform a safe read-back only in that case.
            return result.eTag ? { id: result.id, etag: result.eTag } : null;
        }
        catch (error) {
            // A folder can be renamed/deleted outside Finance. Next attempt must
            // re-resolve its path rather than keep an invalid directory ID.
            if (error instanceof GraphError && error.status === 404)
                this.clearDirectoryCache();
            if (lease && this.mutationLease === lease && !wasUncertain && lease.uncertain && !lease.released) {
                // A final response can be lost after Graph committed the encrypted file.
                // Read the precise target, never resend an ambiguous write. The ETag
                // must have advanced for a replacement; do not clear prior uncertainty.
                try {
                    this.checkMutationGuard();
                    const verified = await this.readNamedFile(parts, name, maxBytes, true);
                    this.checkMutationGuard();
                    if (verified && verified.text === text && (!existing || (verified.id === existing.id && verified.etag !== existing.etag))) {
                        lease.uncertain = false;
                        return { id: verified.id, etag: verified.etag };
                    }
                }
                catch { /* Keep the original failure and fence. */ }
            }
            throw error;
        }
    }
    /** finance/index.enc contains only encrypted shard discovery metadata. */
    async readFinanceIndex(fresh = false) {
        // A fresh metadata lookup must not join an earlier in-flight read.
        // Identical ID/ETag still proves the cached encrypted index is current.
        return this.readNamedFile([FINANCE_DIR], 'index.enc', 1_000_000, fresh, true);
    }
    async writeFinanceIndex(text, existing) {
        await this.writeNamedFile([FINANCE_DIR], 'index.enc', text, existing, 1_000_000);
    }
    /** Independent encrypted merchant display rules, shared across billing years. */
    async readMerchantRules(fresh = false) {
        return this.readNamedFile(this.financeDataPath('rules'), 'merchants.enc', 2_000_000, fresh);
    }
    async writeMerchantRules(text, existing) {
        return this.writeNamedFile(this.financeDataPath('rules'), 'merchants.enc', text, existing, 2_000_000);
    }
    /** Independent encrypted asset settings, never stored in the statement index. */
    async readAssetSettings(fresh = false) {
        return this.readNamedFile(this.financeDataPath('settings'), 'assets.enc', 2_000_000, fresh);
    }
    async writeAssetSettings(text, existing) {
        return this.writeNamedFile(this.financeDataPath('settings'), 'assets.enc', text, existing, 2_000_000);
    }
    /** Only strict YYYY-MM encrypted report files are accepted in this generation. */
    async listMonthlyReports() {
        const parent = await this.folderPath(this.financeDataPath('reports'), false);
        if (!parent)
            return [];
        const r = await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children?$select=id,name,eTag&$top=400`);
        const json = await r.json();
        if (json['@odata.nextLink'] || !Array.isArray(json.value))
            throw new Error('レポート一覧をすべて取得できませんでした。');
        const found = json.value.filter(item => /^(19|20|21)\d{2}-(0[1-9]|1[0-2])\.enc$/.test(item.name ?? ''));
        if (found.some(item => !item.id || !item.eTag) || new Set(found.map(x => x.name)).size !== found.length)
            throw new Error('レポート一覧が不正です。');
        return found.map(item => ({ period: item.name.slice(0, -4), id: item.id, etag: item.eTag })).sort((a, b) => b.period.localeCompare(a.period));
    }
    async readMonthlyReport(period, fresh = false) {
        if (!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(period))
            throw new Error('年月が不正です。');
        return this.readNamedFile(this.financeDataPath('reports'), `${period}.enc`, 2_000_000, fresh);
    }
    async writeMonthlyReport(period, text, existing) {
        if (!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(period))
            throw new Error('年月が不正です。');
        return this.writeNamedFile(this.financeDataPath('reports'), `${period}.enc`, text, existing, 2_000_000);
    }
    /** One listing provides both year discovery and ETags, so unchanged years need no download. */
    async listYearFiles() {
        const parent = await this.folderPath(this.financeDataPath('statements'), false);
        if (!parent)
            return [];
        const r = await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children?$select=id,name,eTag&$top=400`);
        const json = await r.json();
        if (json['@odata.nextLink'])
            throw new Error('保存年度が多すぎるため一覧を取得できません。');
        if (!Array.isArray(json.value))
            throw new Error('年別明細の一覧が不正です。');
        return json.value.filter(x => /^(19|20|21)\d\d\.enc$|^undated\.enc$/.test(x.name ?? ''))
            .map(x => ({ year: checkBucket(x.name.slice(0, -4)), id: x.id, etag: x.eTag ?? '' }));
    }
    async listYearBuckets() { return (await this.listYearFiles()).map(x => x.year); }
    /** Each year is independently encrypted and concurrency-controlled. */
    async readYearVault(year, fresh = false) {
        return this.readNamedFile(this.financeDataPath('statements'), `${checkBucket(year)}.enc`, 25_000_000, fresh);
    }
    /** Before a save, ask only for metadata if our existing decrypted year is current.
     * Microsoft Graph 304 avoids downloading and decrypting an unchanged shard.
     * If the file changed, download it and preserve its actual server ETag. */
    async readYearVaultForSave(year, known) {
        checkBucket(year);
        if (!known?.id || !known.etag)
            return { kind: 'remote', file: await this.readYearVault(year, true) };
        let response;
        try {
            response = await this.graph(`/me/drive/items/${encodeURIComponent(known.id)}`, {
                headers: { 'If-None-Match': known.etag }, cache: 'no-store',
            }, true);
        }
        catch (error) {
            if (error instanceof GraphError && error.status === 404) {
                // A file may have been replaced with a different drive ID.
                return { kind: 'remote', file: await this.readYearVault(year, true) };
            }
            throw error;
        }
        if (response.status === 304)
            return { kind: 'unchanged' };
        const item = await response.json();
        if (!item.id || !item.eTag)
            throw new Error('年別ファイルの更新情報が不正です。');
        if (item.id === known.id && item.eTag === known.etag)
            return { kind: 'unchanged' };
        const downloaded = await this.downloadItemInfo(item.id, 25_000_000, item, true);
        if (!downloaded.item.eTag)
            throw new Error('年別ファイルのETagを取得できません。');
        return { kind: 'remote', file: { text: downloaded.text, id: item.id, etag: downloaded.item.eTag } };
    }
    async writeYearVault(year, text, existing) {
        return this.writeNamedFile(this.financeDataPath('statements'), `${checkBucket(year)}.enc`, text, existing, 25_000_000);
    }
    /** Read a shard via the ID already returned by the year listing. */
    async readListedYearVault(file) {
        checkBucket(file.year);
        if (!file.id)
            throw new Error('年別ファイルの識別子が不正です。');
        const value = await this.downloadItemInfo(file.id, 25_000_000);
        if (!value.item.eTag)
            throw new Error('年別ファイルのETagを取得できません。');
        return { text: value.text, id: file.id, etag: value.item.eTag };
    }
    /** PDF originals are immutable; only the encrypted original bytes are uploaded. */
    async uploadDatedOriginal(id, encrypted, billingMonth) {
        const [year, month] = originalParts(billingMonth);
        checkOriginalMonth(month);
        return this.writeNamedFile(this.financeDataPath('originals', year, month), this.originalName(id), encrypted, null, 200 * 1024 * 1024);
    }
    async downloadDatedOriginal(id, billingMonth) {
        const [year, month] = originalParts(billingMonth);
        checkOriginalMonth(month);
        const file = await this.readNamedFile(this.financeDataPath('originals', year, month), this.originalName(id), 200 * 1024 * 1024);
        if (!file)
            throw new Error('指定年月に暗号化PDF原本が見つかりません。');
        return file.text;
    }
    payrollPublishedPath(folder, name) {
        if (folder.length > 4 || folder.some(part => !(/^[a-z0-9-]{1,64}$/i.test(part))) ||
            !(['index.enc'].includes(name) || /^(19|20|21)\d{2}\.enc$/.test(name)))
            throw new Error('Payroll参照パスが不正です。');
        if (folder.length === 0 && name !== 'index.enc')
            throw new Error('Payroll参照パスが不正です。');
        if (folder.length > 0 && name === 'index.enc')
            throw new Error('Payroll参照パスが不正です。');
        if (folder.length > 0 && !(folder.length === 1 && folder[0] === 'income') &&
            !(folder.length === 3 && folder[0] === 'versions' && folder[2] === 'income' && /^[0-9a-f-]{36}$/i.test(folder[1])))
            throw new Error('Payroll参照先は収入公開ファイルに限定されています。');
        return [PAYROLL_DIR, ...folder];
    }
    /** Finance may READ Payroll's published income data, never mutate its namespace. */
    async readPayrollPublishedFile(folder, name, maxBytes) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 30_000_000)
            throw new Error('Payroll参照パスが不正です。');
        return this.readNamedFile(this.payrollPublishedPath(folder, name), name, maxBytes);
    }
    /** Revalidate identity/version without downloading encrypted income again. */
    async readPayrollPublishedMetadata(folder, name) {
        const item = await this.findNamedFile(this.payrollPublishedPath(folder, name), name, true);
        return item ? { id: item.id, etag: item.eTag } : null;
    }
    /** Pre-create the namespace reserved for Payroll, without writing any payroll data. */
    async ensurePayrollNamespace() { await this.folderPath([PAYROLL_DIR], true); }
    /** Strict, complete listings only. Never clean up a truncated folder or unexpected file. */
    async listCleanupFolder(parts) {
        const parent = await this.folderPath(parts, false);
        if (!parent)
            return [];
        const response = await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children?$select=id,name,eTag,folder,size,createdDateTime&$top=400`);
        const page = await response.json();
        if (page['@odata.nextLink'] || !Array.isArray(page.value))
            throw new Error('削除対象の全件確認ができません。安全のため中止しました。');
        if (page.value.some(x => !x.id || !x.name || !x.eTag))
            throw new Error('OneDriveのファイル情報を確認できません。削除を中止しました。');
        if (new Set(page.value.map(x => x.name)).size !== page.value.length || new Set(page.value.map(x => x.id)).size !== page.value.length)
            throw new Error('ファイル識別子が重複しています。削除を中止しました。');
        return page.value;
    }
    /** Only exact names at the Finance app root are eligible. Never match arbitrary backup files. */
    async listRetiredRootData() {
        const root = await this.listCleanupFolder([]);
        const legacy = root.filter(item => (!item.folder && item.name === 'finance-v1-vault.enc') ||
            (item.folder && item.name === 'finance-v1-originals'));
        if (legacy.length > 2)
            throw new Error('旧v1保管庫が重複しています。削除できません。');
        const snapshots = root.filter(item => !item.folder && isSnapshotName(item.name));
        for (const item of snapshots) {
            if (!Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_SNAPSHOT_BYTES ||
                typeof item.createdDateTime !== 'string' || !Number.isFinite(Date.parse(item.createdDateTime)))
                throw new Error('スナップショットのメタデータが不正です。削除を中止しました。');
        }
        return {
            legacyV1: legacy.map(item => ({ id: item.id, name: item.name, etag: item.eTag })),
            snapshots: snapshots.map(item => ({ id: item.id, name: item.name, etag: item.eTag, size: item.size, createdDateTime: item.createdDateTime }))
                .sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime) || b.name.localeCompare(a.name)),
        };
    }
    /** Only directories directly under finance/versions are candidates. */
    async listOldVaultGenerations() {
        const items = await this.listCleanupFolder([FINANCE_DIR, 'versions']);
        return items.filter(x => x.folder && GENERATION_NAME.test(x.name))
            .map(x => ({ id: x.id, name: x.name, etag: x.eTag }));
    }
    /** Versioned vaults never read these old unversioned paths. Never include index.enc or versions. */
    async listUnversionedFinanceFolders() {
        const candidates = new Set(['statements', 'originals', 'settings', 'rules', 'reports']);
        return (await this.listCleanupFolder([FINANCE_DIR]))
            .filter(item => item.folder && candidates.has(item.name))
            .map(item => ({ id: item.id, name: item.name, etag: item.eTag }));
    }
    /** Enumerate originals under finance/originals/YYYY/MM without following other namespaces. */
    async listDatedOriginals() {
        const result = [];
        const years = await this.listCleanupFolder(this.financeDataPath('originals'));
        for (const year of years) {
            if (!year.folder || !(/^(19|20|21)\d{2}$|^undated$/).test(year.name))
                continue;
            const months = await this.listCleanupFolder(this.financeDataPath('originals', year.name));
            for (const month of months) {
                if (!month.folder || !(/^(0[1-9]|1[0-2])$/.test(month.name) || (year.name === 'undated' && month.name === '00')))
                    continue;
                const files = await this.listCleanupFolder(this.financeDataPath('originals', year.name, month.name));
                for (const file of files) {
                    if (file.folder || !GENERATION_NAME.test((file.name ?? '').slice(0, -4)) || !file.name.endsWith('.enc'))
                        continue;
                    result.push({ id: file.id, name: file.name, etag: file.eTag, year: year.name, month: month.name });
                }
            }
        }
        return result;
    }
    /** Graph DELETE puts the item in OneDrive recycle bin. Require a matching ETag. */
    async deleteCleanupItem(file) {
        if (!file.id || !file.etag || !file.name)
            throw new Error('削除対象の識別情報が不正です。');
        await this.graph(`/me/drive/items/${encodeURIComponent(file.id)}`, { method: 'DELETE', headers: { 'If-Match': file.etag } });
    }
    async appFolderId() {
        if (!this.appRoot) {
            this.appRoot = (async () => {
                const response = await this.graph('/me/drive/special/approot');
                const folder = await response.json();
                if (!folder.id)
                    throw new Error('OneDriveのアプリ専用領域を取得できませんでした。');
                return folder.id;
            })();
        }
        try {
            return await this.appRoot;
        }
        catch (error) {
            this.appRoot = null;
            throw error;
        }
    }
    async uploadEncryptedProbe(encrypted) {
        if (encrypted.length > 24000)
            throw new Error('テストファイルのサイズが不正です。');
        const folderId = await this.appFolderId();
        const path = `/me/drive/items/${encodeURIComponent(folderId)}:/${PROBE_FILE_NAME}:/content`;
        await this.graph(path, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted });
    }
    async downloadEncryptedProbe() {
        const folderId = await this.appFolderId();
        const path = `/me/drive/items/${encodeURIComponent(folderId)}:/${PROBE_FILE_NAME}`;
        const response = await this.graph(path);
        const item = await response.json();
        let downloadUrl = item['@microsoft.graph.downloadUrl'];
        if (!downloadUrl && item.id) {
            const metadataResponse = await this.graph(`/me/drive/items/${encodeURIComponent(item.id)}`);
            const metadata = await metadataResponse.json();
            downloadUrl = metadata['@microsoft.graph.downloadUrl'];
        }
        if (!downloadUrl || new URL(downloadUrl).protocol !== 'https:')
            throw new Error('安全なダウンロードURLを取得できませんでした。');
        // The preauthenticated URL MUST NOT receive a Bearer token. Avoid /content's CORS-hostile 302.
        return this.withReadDeadline(downloadUrl, { method: 'GET', credentials: 'omit' }, async (response) => {
            if (!response.ok)
                throw new Error(`暗号化テストファイルの取得に失敗しました (HTTP ${response.status})。`);
            // Enforce the limit while streaming; a missing or dishonest Content-Length is not trusted.
            if (!response.body)
                throw new Error('安全なストリーム受信ができません。');
            const bytes = await this.readResponseBytes(response, 24000);
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        });
    }
}
