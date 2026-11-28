/**
 * Opt-in device/browser key. Only a non-extractable Web Crypto AES-GCM CryptoKey
 * and minimum vault metadata live in IndexedDB. Financial records, passwords,
 * tokens and plaintext are never placed in this database.
 *
 * This is separate from the one-time legacy IndexedDB data import.
 */
import { validDataSetId } from './cloud-crypto.js';
const DATABASE = 'finance-remembered-browser-key-v1';
const STORE = 'keys';
const VERSION = 1;
const LOCK_FLAG = 'finance-browser-vault-manually-locked-v1';
const RETENTION_INTENT = 'finance-browser-retention-intent-v1';
export const CROSS_TAB_LOCK_KEY = 'finance-vault-lock-event-v1';
/** Every event is unique so repeated locks also notify already-open tabs. */
export function notifyOtherFinanceTabs(storage) {
    storage.setItem(CROSS_TAB_LOCK_KEY, crypto.randomUUID());
}
const encoder = new TextEncoder();
const clientIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const saltPattern = /^[A-Za-z0-9+/]{22}==$/;
export class InvalidRememberedBrowserKeyError extends Error {
    constructor() { super('このブラウザの保存鍵が破損しています。パスフレーズで解除し、再登録してください。'); this.name = 'InvalidRememberedBrowserKeyError'; }
}
/** Opaque, account-specific store identifier. Never persist MSAL account IDs. */
async function keyId(context) {
    if (!clientIdPattern.test(context.clientId) || !context.homeAccountId || context.homeAccountId.length > 512)
        throw new Error('Microsoftアカウントの確認後に操作してください。');
    const bytes = encoder.encode(`Finance remembered browser v1\0${context.clientId.toLowerCase()}\0${context.homeAccountId}`);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
}
function openDatabase() {
    if (typeof indexedDB === 'undefined')
        return Promise.reject(new Error('このブラウザでは鍵の永続保存を利用できません。'));
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, VERSION);
        let blocked = false;
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE))
                request.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        request.onsuccess = () => { if (blocked)
            request.result.close();
        else
            resolve(request.result); };
        request.onerror = () => reject(request.error ?? new Error('ブラウザの鍵保存領域を開けません。'));
        request.onblocked = () => { blocked = true; reject(new Error('別のタブが鍵保存領域を使用中です。')); };
    });
}
/** Resolve after transaction commit, not merely when the request succeeds. */
async function transaction(mode, run, guard = () => { }, onSuccess) {
    const db = await openDatabase();
    try {
        guard();
        return await new Promise((resolve, reject) => {
            let tx;
            try {
                tx = db.transaction(STORE, mode);
            }
            catch (error) {
                reject(error);
                return;
            }
            let output;
            guard();
            const store = tx.objectStore(STORE), request = run(store);
            request.onsuccess = () => {
                output = request.result;
                try {
                    onSuccess?.(store, output);
                }
                catch (error) {
                    try {
                        tx.abort();
                    }
                    catch { /* Already inactive. */ }
                    reject(error);
                }
            };
            tx.oncomplete = () => { try {
                guard();
                resolve(output);
            }
            catch (error) {
                reject(error);
            } };
            tx.onerror = () => reject(tx.error ?? new Error('鍵保存処理に失敗しました。'));
            tx.onabort = () => reject(tx.error ?? new Error('鍵保存が中断されました。'));
        });
    }
    finally {
        db.close();
    }
}
export function validRememberedCryptoKey(key) {
    return typeof CryptoKey !== 'undefined' && key instanceof CryptoKey &&
        key.type === 'secret' && !key.extractable && key.algorithm.name === 'AES-GCM' &&
        key.algorithm.length === 256 &&
        key.usages.includes('encrypt') && key.usages.includes('decrypt');
}
export async function readBrowserKey(context) {
    const id = await keyId(context);
    const entry = await transaction('readonly', store => store.get(id));
    if (!entry)
        return null;
    if (entry.version !== VERSION || entry.id !== id || !validRememberedCryptoKey(entry.key) ||
        !saltPattern.test(entry.salt) || (entry.dataSetId !== null && !validDataSetId(entry.dataSetId)))
        throw new InvalidRememberedBrowserKeyError();
    return { key: entry.key, salt: entry.salt, dataSetId: entry.dataSetId };
}
export async function isBrowserRemembered(context) {
    return (await readBrowserKey(context)) !== null;
}
export async function rememberBrowserKey(context, record, guard = () => { }) {
    const id = await keyId(context);
    if (!validRememberedCryptoKey(record.key) || !saltPattern.test(record.salt) ||
        (record.dataSetId !== null && !validDataSetId(record.dataSetId)))
        throw new Error('保存できない復号鍵です。');
    const operationId = crypto.randomUUID();
    const entry = { id, version: VERSION, key: record.key, salt: record.salt, dataSetId: record.dataSetId, operationId };
    let issued = false;
    try {
        await transaction('readwrite', store => { const request = store.put(entry); issued = true; return request; }, guard);
    }
    catch (error) {
        // The guard may fail after commit. Clean up only our own write in one
        // readwrite transaction: a newer remember operation must never be deleted.
        if (issued)
            try {
                await transaction('readwrite', store => store.get(id), () => { }, (store, current) => {
                    if (current?.operationId === operationId)
                        store.delete(id);
                });
            }
            catch { /* Shared lock/intent still prevents auto-unlock if cleanup fails. */ }
        throw error;
    }
}
export async function forgetBrowserKey(context, guard = () => { }) {
    const id = await keyId(context);
    await transaction('readwrite', store => store.delete(id), guard);
}
/** Exactly one policy for unlock: save a non-extractable browser key, or revoke any earlier one. */
export async function applyBrowserRetentionChoice(context, remember, record, guard = () => { }) {
    if (remember) {
        if (!record)
            throw new Error('記憶する鍵がありません。');
        await rememberBrowserKey(context, record, guard);
    }
    else {
        await forgetBrowserKey(context, guard);
    }
}
/** Manual lock survives reload/browser restart without storing any sensitive data. */
export function isManuallyLocked(storage) {
    try {
        const flag = storage.getItem(LOCK_FLAG), intent = storage.getItem(RETENTION_INTENT);
        if (intent === null)
            return flag === '1'; // legacy browser data
        return flag !== `ready:${intent}:${storage.getItem(CROSS_TAB_LOCK_KEY) ?? ''}`;
    }
    catch {
        return true;
    }
}
export function setManualLock(storage) { storage.setItem(LOCK_FLAG, '1'); }
export function clearManualLock(storage) { storage.removeItem(LOCK_FLAG); }
/** Shared intent and lock event contain random tokens only. Start by disabling
 * automatic unlock, and permit clearing that flag only for the latest intent. */
export function beginBrowserRetention(storage) {
    const epoch = storage.getItem(CROSS_TAB_LOCK_KEY), token = crypto.randomUUID();
    storage.setItem(RETENTION_INTENT, token);
    setManualLock(storage);
    const check = () => {
        if (storage.getItem(CROSS_TAB_LOCK_KEY) !== epoch || storage.getItem(RETENTION_INTENT) !== token)
            throw new Error('別のタブでロックまたは鍵記憶の変更がありました。操作を中止しました。');
    };
    return { check, resume: () => {
            check();
            storage.setItem(LOCK_FLAG, `ready:${token}:${epoch ?? ''}`);
            // Never overwrite the latest intent on completion. A concurrent lock or
            // newer intent makes this acknowledgement invalid even before its event arrives.
            check();
        } };
}
export function browserLockEpoch(storage) {
    const epoch = storage.getItem(CROSS_TAB_LOCK_KEY), intent = storage.getItem(RETENTION_INTENT);
    return () => { if (storage.getItem(CROSS_TAB_LOCK_KEY) !== epoch || storage.getItem(RETENTION_INTENT) !== intent || isManuallyLocked(storage))
        throw new Error('別のタブで保管庫がロックされました。'); };
}
