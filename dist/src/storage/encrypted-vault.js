const DB_NAME = 'finance-local-vault-v1';
const META_STORE = 'meta';
const STATEMENTS_STORE = 'statements';
const VERIFIER = 'finance-vault-v1-check';
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
async function listRecords() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const request = db.transaction(STATEMENTS_STORE, 'readonly').objectStore(STATEMENTS_STORE).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
async function derive(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new Uint8Array(salt), iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
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
export function lockVault() { key = null; }
export async function unlockVault(passphrase) {
    const meta = await read(META_STORE, 'vault');
    if (!meta || meta.version !== 1)
        throw new Error('対応していない保存形式です。');
    const derived = await derive(passphrase, new Uint8Array(meta.salt), meta.iterations);
    try {
        if (decoder.decode(await decrypt(meta.verifier, derived)) !== VERIFIER)
            throw new Error('invalid');
    }
    catch {
        throw new Error('パスフレーズが違うか、保存データが破損しています。');
    }
    key = derived;
}
export async function readStatements() {
    const cryptKey = await unlockedKey();
    const records = await listRecords();
    const result = [];
    for (const record of records) {
        const text = decoder.decode(await decrypt(record.statement, cryptKey));
        const payload = JSON.parse(text);
        result.push({ id: record.id, statement: payload.statement, hasSource: !!record.source });
    }
    return result;
}
export async function readOriginal(id) {
    const cryptKey = await unlockedKey();
    const record = await read(STATEMENTS_STORE, id);
    if (!record?.source)
        return null;
    const data = JSON.parse(decoder.decode(await decrypt(record.statement, cryptKey)));
    return { bytes: await decrypt(record.source, cryptKey), mime: data.sourceMime ?? 'application/octet-stream', name: data.statement.sourceName };
}
/** Encrypted backup: the passphrase is never included. Metadata is only KDF parameters and ciphertext. */
export async function exportEncryptedBackup() {
    await unlockedKey();
    const meta = await read(META_STORE, 'vault');
    if (!meta)
        throw new Error('保存済みデータがありません。');
    const records = await listRecords();
    const to64 = (bytes) => {
        const a = new Uint8Array(bytes);
        // Process in chunks to avoid argument limits for PDFs.
        let s = '';
        for (let start = 0; start < a.length; start += 0x4000)
            s += String.fromCharCode(...a.subarray(start, start + 0x4000));
        return btoa(s);
    };
    const cipherJson = (cipher) => ({ iv: cipher.iv, data: to64(cipher.data) });
    const backup = {
        format: 'finance-encrypted-backup-v1',
        createdAt: new Date().toISOString(),
        meta: { ...meta, verifier: cipherJson(meta.verifier) },
        records: records.map(rec => ({ id: rec.id, statement: cipherJson(rec.statement), source: rec.source ? cipherJson(rec.source) : undefined })),
    };
    return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}
/** Explicitly remove only the historical Finance IndexedDB after external verification. */
export async function deleteLegacyVault() {
    lockVault();
    const previous = cachedDb;
    cachedDb = null;
    if (previous) {
        // No other transaction should be running when the caller reaches here.
        try {
            (await previous).close();
        }
        catch { /* Opening failed; deletion can still proceed. */ }
    }
    await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('旧保管庫を削除できませんでした。'));
        request.onblocked = () => reject(new Error('別のタブで旧データが開かれています。ほかのFinanceタブを閉じてください。'));
    });
}
