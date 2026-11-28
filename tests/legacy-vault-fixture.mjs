// Historical v1 writer/restore only: test fixtures and encrypted recovery compatibility, never published.
const DB_NAME = 'finance-local-vault-v1';
const META_STORE = 'meta';
const STATEMENTS_STORE = 'statements';
const VERIFIER = 'finance-vault-v1-check';
const KDF_ITERATIONS = 310_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
let key = null;
let cachedDb = null;
function openDatabase() {
    if (!cachedDb)
        cachedDb = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(META_STORE))
                    db.createObjectStore(META_STORE, { keyPath: 'id' });
                if (!db.objectStoreNames.contains(STATEMENTS_STORE))
                    db.createObjectStore(STATEMENTS_STORE, { keyPath: 'id' });
            };
            req.onerror = () => reject(req.error ?? new Error('IndexedDBを開けません。'));
            req.onsuccess = () => resolve(req.result);
        }).catch(error => { cachedDb = null; throw error; });
    return cachedDb;
}
async function read(storeName, recordKey) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(recordKey);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
async function write(storeName, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const txn = db.transaction(storeName, 'readwrite');
        txn.objectStore(storeName).put(value);
        txn.oncomplete = () => resolve();
        txn.onerror = () => reject(txn.error ?? new Error('保存に失敗しました。'));
        txn.onabort = () => reject(txn.error ?? new Error('保存を中断しました。'));
    });
}
async function erase(id) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const txn = db.transaction(STATEMENTS_STORE, 'readwrite');
        txn.objectStore(STATEMENTS_STORE).delete(id);
        txn.oncomplete = () => resolve();
        txn.onerror = () => reject(txn.error ?? new Error('削除に失敗しました。'));
        txn.onabort = () => reject(txn.error ?? new Error('削除を中断しました。'));
    });
}
async function derive(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new Uint8Array(salt), iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(data, cryptKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptKey, new Uint8Array(data));
    return { iv: Array.from(iv), data: encrypted };
}
async function decrypt(encrypted, cryptKey) {
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(encrypted.iv) }, cryptKey, encrypted.data);
    return new Uint8Array(raw);
}
async function unlockedKey() {
    if (!key)
        throw new Error('暗号化ストレージがロックされています。');
    return key;
}
export async function hasVault() {
    return !!await read(META_STORE, 'vault');
}
export async function createVault(passphrase) {
    if (await hasVault())
        throw new Error('暗号化ストレージは既に存在します。');
    if (passphrase.length < 12)
        throw new Error('パスフレーズは12文字以上にしてください。');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const freshKey = await derive(passphrase, salt, KDF_ITERATIONS);
    const verifier = await encrypt(encoder.encode(VERIFIER), freshKey);
    await write(META_STORE, { id: 'vault', version: 1, iterations: KDF_ITERATIONS, salt: Array.from(salt), verifier });
    key = freshKey;
}
export async function saveStatement(statement, source, id) {
    const cryptKey = await unlockedKey();
    const recordId = id ?? crypto.randomUUID();
    const existing = id ? await read(STATEMENTS_STORE, id) : undefined;
    const sourceMime = source?.mime ?? (existing ? (statement.sourceKind === 'pdf' ? 'application/pdf' : 'text/plain') : undefined);
    const document = { statement: structuredClone(statement), sourceMime };
    const encryptedStatement = await encrypt(encoder.encode(JSON.stringify(document)), cryptKey);
    const encryptedSource = source ? await encrypt(source.bytes, cryptKey) : existing?.source;
    await write(STATEMENTS_STORE, { id: recordId, statement: encryptedStatement, source: encryptedSource });
    return recordId;
}
/** Encrypt all records before opening the write transaction, then commit in one IDB transaction. */
export async function saveStatementsBatch(items) {
    const cryptKey = await unlockedKey();
    if (!items.length)
        return [];
    const records = [];
    const ids = new Set();
    for (const item of items) {
        const id = item.id ?? crypto.randomUUID();
        if (ids.has(id))
            throw new Error('一括取込対象に同じ保存IDが重複しています。');
        ids.add(id);
        const old = item.id ? await read(STATEMENTS_STORE, item.id) : undefined;
        if (item.id && !old)
            throw new Error('更新対象の保存済み明細が見つかりません。');
        // Pasted text is represented by its normalized parsed rows, not a second raw source copy.
        const pdf = item.statement.sourceKind === 'pdf';
        const original = pdf ? (item.source ? await encrypt(item.source.bytes, cryptKey) : old?.source) : undefined;
        if (pdf && (!original || (item.source && item.source.mime !== 'application/pdf'))) {
            throw new Error('PDF原本がないため保存できません。');
        }
        const document = {
            statement: structuredClone(item.statement),
            sourceMime: pdf ? 'application/pdf' : undefined,
        };
        records.push({ id, statement: await encrypt(encoder.encode(JSON.stringify(document)), cryptKey), source: original });
    }
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
        const txn = db.transaction(STATEMENTS_STORE, 'readwrite');
        const store = txn.objectStore(STATEMENTS_STORE);
        for (const record of records)
            store.put(record);
        txn.oncomplete = () => resolve();
        txn.onerror = () => reject(txn.error ?? new Error('一括保存に失敗しました。'));
        txn.onabort = () => reject(txn.error ?? new Error('一括保存を中断しました。'));
    });
    return records.map(record => record.id);
}
export async function deleteSaved(id) {
    await unlockedKey();
    await erase(id);
}
/** Restores an exported ciphertext-only backup into a fresh vault. Never merges or overwrites. */
export async function restoreEncryptedBackup(file, passphrase) {
    if (await hasVault())
        throw new Error('既存の保存領域があるため復元できません。誤った上書きを防ぐ仕様です。');
    if (file.size > 150 * 1024 * 1024)
        throw new Error('バックアップが大きすぎます（150MB上限）。');
    const backup = JSON.parse(await file.text());
    if (backup.format !== 'finance-encrypted-backup-v1' || !backup.meta || !Array.isArray(backup.records) || backup.records.length > 5000) {
        throw new Error('Financeの暗号化バックアップ形式ではありません。');
    }
    const meta = backup.meta;
    if (meta.version !== 1 || !Array.isArray(meta.salt) || meta.salt.length !== 16 || meta.iterations !== KDF_ITERATIONS) {
        throw new Error('対応していない暗号化形式です。');
    }
    const from64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;
    const dec = (v) => {
        if (!Array.isArray(v?.iv) || v.iv.length !== 12 || typeof v.data !== 'string')
            throw new Error('バックアップの暗号データが不正です。');
        return { iv: v.iv, data: from64(v.data) };
    };
    const verifier = dec(meta.verifier);
    const testKey = await derive(passphrase, new Uint8Array(meta.salt), meta.iterations);
    try {
        if (decoder.decode(await decrypt(verifier, testKey)) !== VERIFIER)
            throw new Error('bad');
    }
    catch {
        throw new Error('バックアップの復号パスフレーズが違います。');
    }
    const seen = new Set();
    const records = [];
    for (const entry of backup.records) {
        if (typeof entry?.id !== 'string' || !entry.id || seen.has(entry.id))
            throw new Error('バックアップの明細IDが不正です。');
        seen.add(entry.id);
        const ciphertext = dec(entry.statement);
        // Verify every statement before writing anything to IndexedDB.
        const payload = JSON.parse(decoder.decode(await decrypt(ciphertext, testKey)));
        if (!payload.statement || !Array.isArray(payload.statement.rows))
            throw new Error('バックアップの明細が不正です。');
        const sourceCipher = entry.source ? dec(entry.source) : undefined;
        if (sourceCipher)
            await decrypt(sourceCipher, testKey);
        records.push({ id: entry.id, statement: ciphertext, source: sourceCipher });
    }
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
        const txn = db.transaction([META_STORE, STATEMENTS_STORE], 'readwrite');
        txn.objectStore(META_STORE).put({ id: 'vault', version: 1, salt: meta.salt, iterations: meta.iterations, verifier });
        for (const entry of records)
            txn.objectStore(STATEMENTS_STORE).put(entry);
        txn.oncomplete = () => resolve();
        txn.onerror = () => reject(txn.error ?? new Error('復元に失敗しました。'));
        txn.onabort = () => reject(txn.error ?? new Error('復元に失敗しました。'));
    });
    key = testKey;
}
