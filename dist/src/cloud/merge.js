import { statementMonthKey } from '../importers/import-policy.js';
import { isZeroUsage } from '../models/types.js';
export function emptyDocument() {
    return { format: 'finance-cloud-document-v1', records: [], deleted: [], conflicts: [] };
}
const clone = (v) => structuredClone(v);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function index(records) { return new Map(records.map(r => [r.id, r])); }
function rows(value) {
    return Array.isArray(value) && value.every(r => r && typeof r.id === 'string');
}
/** Three-way, row-ID-aware merge. Local (the explicitly saving editor) wins same-field ties;
 * the discarded remote value is retained in the encrypted audit log. */
export function mergeDocuments(base, local, remote, now = new Date().toISOString(), collisionSink, preferLocalDeletes = false) {
    const collided = (recordId, path, local, remote) => {
        collisionSink?.push({ recordId, path, local: clone(local), remote: clone(remote) });
    };
    const conflicts = [...remote.conflicts];
    for (const c of local.conflicts)
        if (!conflicts.some(other => eq(other, c)))
            conflicts.push(clone(c));
    const b = index(base.records), l = index(local.records), r = index(remote.records);
    const deleted = new Set([...base.deleted, ...local.deleted, ...remote.deleted]);
    const output = [];
    const missing = Symbol('missing');
    function mergeValue(path, id, bv, lv, rv) {
        if (eq(lv, bv))
            return rv === missing ? missing : clone(rv);
        if (eq(rv, bv) || eq(lv, rv))
            return lv === missing ? missing : clone(lv);
        if (lv !== missing && rv !== missing && bv !== missing &&
            lv && rv && bv && typeof lv === 'object' && typeof rv === 'object' && typeof bv === 'object') {
            if (rows(lv) && rows(rv) && rows(bv)) {
                const bm = new Map(bv.map(x => [x.id, x]));
                const lm = new Map(lv.map(x => [x.id, x]));
                const rm = new Map(rv.map(x => [x.id, x]));
                const merged = [];
                for (const rowId of new Set([...bm.keys(), ...rm.keys(), ...lm.keys()])) {
                    const child = mergeValue(`${path}[${rowId}]`, id, bm.get(rowId) ?? missing, lm.get(rowId) ?? missing, rm.get(rowId) ?? missing);
                    if (child !== missing)
                        merged.push(child);
                }
                return merged;
            }
            if (!Array.isArray(lv) && !Array.isArray(rv) && !Array.isArray(bv)) {
                const bo = bv, lo = lv, ro = rv;
                const out = {};
                for (const key of new Set([...Object.keys(bo), ...Object.keys(lo), ...Object.keys(ro)])) {
                    const value = mergeValue(`${path}.${key}`, id, Object.hasOwn(bo, key) ? bo[key] : missing, Object.hasOwn(lo, key) ? lo[key] : missing, Object.hasOwn(ro, key) ? ro[key] : missing);
                    if (value !== missing)
                        out[key] = value;
                }
                return out;
            }
        }
        // Delete versus edit: preserve the edited record/row; never silently lose information.
        if (lv === missing && rv !== missing) {
            collided(id, path, '削除', rv);
            if (preferLocalDeletes) {
                conflicts.push({ recordId: id, path, discarded: clone(rv), chosen: '削除', at: now });
                return missing;
            }
            conflicts.push({ recordId: id, path, discarded: '削除', chosen: clone(rv), at: now });
            return clone(rv);
        }
        if (rv === missing && lv !== missing) {
            collided(id, path, lv, '削除');
            conflicts.push({ recordId: id, path, discarded: '削除', chosen: clone(lv), at: now });
            return clone(lv);
        }
        collided(id, path, lv === missing ? '削除' : lv, rv === missing ? '削除' : rv);
        conflicts.push({ recordId: id, path, discarded: rv === missing ? '削除' : clone(rv), chosen: lv === missing ? '削除' : clone(lv), at: now });
        return lv === missing ? missing : clone(lv);
    }
    for (const id of new Set([...b.keys(), ...r.keys(), ...l.keys(), ...deleted])) {
        const bv = b.get(id) ?? missing, lv = l.get(id) ?? missing, rv = r.get(id) ?? missing;
        const result = mergeValue('record', id, bv, lv, rv);
        if (result === missing) {
            deleted.add(id);
            continue;
        }
        output.push(result);
        deleted.delete(id);
    }
    return { format: 'finance-cloud-document-v1', records: output, deleted: [...deleted], conflicts: conflicts.slice(-500) };
}
export function validateCloudDocument(raw) {
    if (!raw || typeof raw !== 'object')
        throw new Error('クラウド明細の形式が不正です。');
    const d = raw;
    if (d.format !== 'finance-cloud-document-v1' || !Array.isArray(d.records) || !Array.isArray(d.deleted) || !Array.isArray(d.conflicts) || d.records.length > 10000 || d.deleted.length > 20000 || d.conflicts.length > 1000)
        throw new Error('クラウド明細のバージョンが不正です。');
    const seen = new Set();
    for (const rec of d.records) {
        if (!rec || typeof rec.id !== 'string' || !rec.id || seen.has(rec.id) || !rec.statement || !Array.isArray(rec.statement.rows) || rec.statement.rows.length > 10000)
            throw new Error('クラウド明細に不正なレコードがあります。');
        if (rec.statement.zeroUsage !== undefined && (!isZeroUsage(rec.statement) || !rec.originalId))
            throw new Error('利用なし明細の形式が不正です。');
        seen.add(rec.id);
    }
    return d;
}
/** Check same statement, row ID and exact field before any OneDrive write. */
export function detectDocumentEditCollisions(base, local, remote) {
    const collisions = [];
    mergeDocuments(base, local, remote, new Date().toISOString(), collisions);
    return collisions;
}
/** Guard at the final merged OneDrive document, not just the import screen.
 * An independently added record in another browser tab must not double-count a bill. */
export function duplicateStatementMonths(records, protectedIds) {
    const target = new Set(records.filter(r => protectedIds.has(r.id)).map(r => statementMonthKey(r.statement)).filter(key => key !== null));
    if (!target.size)
        return [];
    const seen = new Set(), duplicates = new Set();
    for (const record of records) {
        const key = statementMonthKey(record.statement);
        if (!key || !target.has(key))
            continue;
        if (seen.has(key))
            duplicates.add(key);
        else
            seen.add(key);
    }
    return [...duplicates];
}
