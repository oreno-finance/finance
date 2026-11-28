import { combinePayrollIncome, validatePayrollIncome } from './payroll-income.js';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const indexAAD = encoder.encode('Payroll OneDrive index v1');
const incomeAAD = encoder.encode('Payroll OneDrive income v1');
const maxYears = 300;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const year = /^(19|20|21)\d{2}$/;
function obj(raw) { return raw !== null && typeof raw === 'object' && !Array.isArray(raw); }
function b64(value, limit = 30_000_000) {
    if (typeof value !== 'string' || value.length > Math.ceil(limit * 4 / 3) + 8 || !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
        throw Error('Payroll暗号データの形式が不正です。');
    const plain = atob(value);
    if (plain.length > limit)
        throw Error('Payroll暗号データが容量上限を超えています。');
    return Uint8Array.from(plain, c => c.charCodeAt(0));
}
function envelope(text, kind) {
    let raw;
    try {
        raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    }
    catch {
        throw Error('Payrollの暗号ファイルがJSONではありません。');
    }
    if (!obj(raw) || raw.format !== 'payroll-cloud-envelope-v1' || raw.kind !== kind || typeof raw.data !== 'string' ||
        b64(raw.iv, 32).length !== 12 || (raw.salt !== undefined && (raw.iterations !== 310000 || b64(raw.salt, 32).length !== 16)))
        throw Error('Payrollの暗号ファイルの形式が一致しません。');
    return raw;
}
async function keyFrom(passphrase, salt) {
    if ([...passphrase].length < 12)
        throw Error('Payrollのパスフレーズは12文字以上が必要です。');
    const raw = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(salt, 32), iterations: 310000, hash: 'SHA-256' }, raw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function decoded(e, key, aad) {
    let bytes;
    try {
        bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(e.iv, 32), additionalData: new Uint8Array(aad) }, key, b64(e.data));
    }
    catch {
        throw Error('Payrollのパスフレーズが一致しないか、暗号ファイルが破損しています。');
    }
    try {
        return JSON.parse(decoder.decode(bytes));
    }
    catch {
        throw Error('Payrollの復号内容がJSONとして読み取れません。');
    }
}
function indexCheck(raw) {
    if (!raw || raw.format !== 'payroll-index-v1' || !Array.isArray(raw.years) || !Array.isArray(raw.incomeYears) ||
        raw.incomeYears.length > maxYears || raw.years.length > maxYears || raw.incomeYears.some(y => typeof y !== 'string' || !year.test(y)) ||
        (raw.generation !== undefined && !uuid.test(raw.generation)) || raw.rotation)
        throw Error('Payrollの索引が不正またはパスフレーズ変更中です。');
    return raw;
}
export function adaptPayrollSource(doc) {
    if (!obj(doc) || doc.format !== 'payroll-income-v1' || typeof doc.year !== 'string' || !year.test(doc.year) ||
        !Array.isArray(doc.records) || doc.records.length > 5000)
        throw Error('Payrollの収入ファイル形式が不正です。');
    const seen = new Set();
    const entries = doc.records.map((item) => {
        if (!obj(item) || !Number.isSafeInteger(item.id) || item.id <= 0 || seen.has(item.id) ||
            typeof item.paymentDate !== 'string' || typeof item.targetMonth !== 'string' ||
            !(['main', 'side'].includes(String(item.job))) || !(['salary', 'bonus'].includes(String(item.kind))) ||
            (item.employerId !== undefined && (typeof item.employerId !== 'string' || !/^emp_[0-9a-f]{32}$/.test(item.employerId))) ||
            !Number.isSafeInteger(item.netPaymentYen) || item.netPaymentYen < 0 ||
            (item.grossPaymentYen !== undefined && (!Number.isSafeInteger(item.grossPaymentYen) || item.grossPaymentYen < 0)) ||
            (item.taxablePaymentYen !== undefined && (!Number.isSafeInteger(item.taxablePaymentYen) || item.taxablePaymentYen < 0)) ||
            !Number.isSafeInteger(item.revision) || item.revision < 1)
            throw Error('Payrollの給与レコードに不正なデータがあります。');
        const id = item.id;
        seen.add(id);
        return { id: `pay-${id}`, employerId: (item.employerId ?? item.job),
            ...(item.employerId ? { job: item.job } : {}), payPeriod: item.targetMonth, paidOn: item.paymentDate,
            grossPay: item.grossPaymentYen === undefined ? null : item.grossPaymentYen,
            netPay: item.netPaymentYen, taxablePay: item.taxablePaymentYen === undefined ? null : item.taxablePaymentYen,
            currency: 'JPY', kind: item.kind, revision: item.revision };
    });
    return validatePayrollIncome({ format: 'payroll-income-v1', year: Number(doc.year), updatedAt: new Date(0).toISOString(), entries, deletedIds: [] });
}
/** Key is non-extractable and lives in memory until Finance is locked/closed. */
export class PayrollReadSession {
    client;
    key;
    salt;
    constructor(client, key, salt) {
        this.client = client;
        this.key = key;
        this.salt = salt;
    }
    static async open(client, passphrase) {
        const file = await client.readPayrollPublishedFile([], 'index.enc', 1_000_000);
        if (!file)
            throw Error('Payrollの暗号保管庫がOneDriveにありません。Payrollで同期してください。');
        const head = envelope(file.text, 'index');
        if (!head.salt || head.iterations !== 310000)
            throw Error('Payrollの暗号索引のソルトが不正です。');
        const key = await keyFrom(passphrase, head.salt);
        const ix = indexCheck(await decoded(head, key, indexAAD));
        return { session: new PayrollReadSession(client, key, head.salt), file, ix };
    }
    static async connect(client, passphrase) {
        return (await this.open(client, passphrase)).session;
    }
    static async connectAndRefresh(client, passphrase, guard) {
        const { session, file, ix } = await this.open(client, passphrase);
        guard();
        const items = await session.readIncome(file, ix);
        guard();
        return { session, items };
    }
    async refresh() {
        const file = await this.client.readPayrollPublishedFile([], 'index.enc', 1_000_000);
        if (!file)
            throw Error('Payrollの索引が見つかりません。');
        const head = envelope(file.text, 'index');
        if (head.salt !== this.salt)
            throw Error('Payroll側でパスフレーズが変更されました。再接続してください。');
        const ix = indexCheck(await decoded(head, this.key, indexAAD));
        return this.readIncome(file, ix);
    }
    async readIncome(file, ix) {
        const paths = ix.generation ? ['versions', ix.generation, 'income'] : ['income'];
        const docs = [];
        const versions = [];
        // Index is authoritative. Never silently skip missing years.
        const years = [...new Set(ix.incomeYears)].sort();
        // Income files can be large. Limit independent reads/decryption to four,
        // like Finance annual shards, and retain deterministic publication order.
        for (let start = 0; start < years.length; start += 4) {
            const group = await Promise.all(years.slice(start, start + 4).map(async (y) => {
                const encrypted = await this.client.readPayrollPublishedFile(paths, `${y}.enc`, 30_000_000);
                if (!encrypted)
                    throw Error(`Payrollの${y}年の収入ファイルが見つかりません。`);
                const env = envelope(encrypted.text, 'income');
                if (env.salt !== this.salt || env.iterations !== 310000)
                    throw Error(`Payrollの${y}年の収入ファイルの鍵情報が一致しません。`);
                const doc = adaptPayrollSource(await decoded(env, this.key, incomeAAD));
                if (doc.year !== Number(y))
                    throw Error('Payrollの収入ファイルの年度が一致しません。');
                return { doc, version: { name: `${y}.enc`, id: encrypted.id, etag: encrypted.etag } };
            }));
            for (const { doc, version } of group) {
                docs.push(doc);
                versions.push(version);
            }
        }
        // Existing years may change without changing the index. Recheck each file
        // and the root index last; this detects observed changes, not an atomic snapshot.
        const unchanged = (before, after) => !!before.id && !!before.etag && !!after && before.id === after.id && before.etag === after.etag;
        for (let start = 0; start < versions.length; start += 4) {
            const checks = await Promise.all(versions.slice(start, start + 4).map(async (before) => unchanged(before, await this.client.readPayrollPublishedMetadata(paths, before.name))));
            if (checks.some(valid => !valid))
                throw Error('Payrollの収入ファイルが同期中に更新されました。再同期してください。');
        }
        if (!unchanged(file, await this.client.readPayrollPublishedMetadata([], 'index.enc')))
            throw Error('Payrollの索引が同期中に更新されました。再同期してください。');
        return combinePayrollIncome(docs);
    }
}
