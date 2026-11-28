import { CARDS } from '../models/types.js';
import { validatePauses } from '../fixed-costs/contracts.js';
/** Starter categories, editable/removable by the user. Their IDs stay stable. */
export const CATEGORIES = [
    { id: 'food', name: '食費', defaultColor: 'orange' },
    { id: 'subscription', name: 'サブスク', defaultColor: 'violet' },
    { id: 'fixed', name: '固定費', defaultColor: 'blue' },
    { id: 'investment', name: '資産形成', defaultColor: 'green' },
    { id: 'daily', name: '日用品', defaultColor: 'teal' },
    { id: 'transport', name: '交通費', defaultColor: 'yellow' },
    { id: 'housing', name: '住居・光熱', defaultColor: 'amber' },
    { id: 'communications', name: '通信費', defaultColor: 'indigo' },
    { id: 'health', name: '医療・健康', defaultColor: 'pink' },
    { id: 'leisure', name: '趣味・娯楽', defaultColor: 'red' },
    { id: 'social', name: '交際費', defaultColor: 'brown' },
    { id: 'other', name: 'その他', defaultColor: 'slate' },
];
export const PALETTE = [
    { id: 'blue', name: '青', hex: '#4285F4' },
    { id: 'indigo', name: '藍', hex: '#5C6BC0' },
    { id: 'violet', name: '紫', hex: '#8E62C7' },
    { id: 'pink', name: '桃', hex: '#D767A4' },
    { id: 'red', name: '赤', hex: '#DB5C62' },
    { id: 'orange', name: '橙', hex: '#D98245' },
    { id: 'amber', name: '琥珀', hex: '#C49B26' },
    { id: 'yellow', name: '黄', hex: '#B8A13C' },
    { id: 'green', name: '緑', hex: '#43A778' },
    { id: 'teal', name: '青緑', hex: '#2B9A9C' },
    { id: 'slate', name: '灰', hex: '#718096' },
    { id: 'brown', name: '茶', hex: '#9B7661' },
];
const categoryIds = new Set(CATEGORIES.map(item => item.id));
const paletteIds = new Set(PALETTE.map(item => item.id));
/** User categories use a namespaced immutable ID. Defaults keep their original IDs. */
const customCategoryId = /^cat-[a-zA-Z0-9-]{6,80}$/;
export function validateCategory(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' ||
        (!categoryIds.has(raw.id) && !customCategoryId.test(raw.id)) ||
        typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 60 ||
        typeof raw.color !== 'string' || !paletteIds.has(raw.color))
        throw new Error('カテゴリーの内容が不正です。');
    return { id: raw.id, name: raw.name.trim(), color: raw.color };
}
/** Resolves legacy v1.2.1 color overrides and new editable categories in one place. */
export function listCategories(doc) {
    const deleted = new Set(doc.deletedCategories ?? []);
    const definitions = new Map((doc.categoryDefinitions ?? []).map(item => [item.id, item]));
    const result = [];
    for (const original of CATEGORIES) {
        if (deleted.has(original.id))
            continue;
        const edited = definitions.get(original.id);
        result.push({ id: original.id, name: edited?.name ?? original.name, color: edited?.color ?? doc.categoryColors?.[original.id] ?? original.defaultColor });
    }
    for (const item of doc.categoryDefinitions ?? []) {
        if (!categoryIds.has(item.id) && !deleted.has(item.id))
            result.push({ ...item });
    }
    return result;
}
export function categoryMeta(id, overrides, definitions, deleted) {
    if (!id || deleted?.includes(id))
        return null;
    const custom = definitions?.find(item => item.id === id);
    const original = CATEGORIES.find(item => item.id === id);
    if (!original && !custom)
        return null;
    const color = custom?.color ?? overrides?.[id] ?? original?.defaultColor ?? 'slate';
    return { id, name: custom?.name ?? original?.name ?? '', color, hex: PALETTE.find(item => item.id === color)?.hex ?? '#718096' };
}
export function emptyRules() {
    return { format: 'finance-merchant-rules-v1', rules: [], deleted: [], conflicts: [] };
}
const clone = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const allowed = new Set(['exact', 'prefix', 'contains']);
export function normalizeMerchant(value) {
    return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}
const fixedDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
export const fixedRuleKey = (rule) => `${rule.cardId}|${normalizeMerchant(rule.pattern)}`;
export function fixedRuleEligible(rule) {
    return CARDS.some(c => c.id === rule.cardId) && rule.mode === 'exact' && !(rule.patterns?.length) && !!normalizeMerchant(rule.pattern) && normalizeMerchant(rule.pattern).length <= 160;
}
function validateRuleFixedCost(rule) {
    const f = rule.fixedCost;
    if (f === undefined)
        return undefined;
    if (!f || typeof f !== 'object' || !fixedRuleEligible(rule) || !['monthly', 'yearly', 'weekly'].includes(f.frequency) || !['active', 'paused', 'ended'].includes(f.state) || !fixedDay(f.startOn) ||
        (f.legacyId !== undefined && (typeof f.legacyId !== 'string' || !/^[a-zA-Z0-9-]{6,80}$/.test(f.legacyId))) ||
        (f.previous !== undefined && (!Array.isArray(f.previous) || f.previous.length > 128 || f.previous.some(x => !x || typeof x.key !== 'string' || x.key.length > 240 || !CARDS.some(c => x.key.startsWith(c.id + '|')) || !x.key.slice(x.key.indexOf('|') + 1) || normalizeMerchant(x.key.slice(x.key.indexOf('|') + 1)) !== x.key.slice(x.key.indexOf('|') + 1) || !fixedDay(x.through)))))
        throw new Error('カード固定費にはカード1枚と完全一致の利用先1件を指定してください。');
    if (f.endOn !== undefined && f.endOn !== null && (!fixedDay(f.endOn) || (f.endOn < f.startOn && f.state !== 'ended')))
        throw new Error('固定費の終了日が不正です。');
    const pauses = f.pauses === undefined ? undefined : validatePauses(f.pauses, f.startOn, f.endOn ?? null);
    const previous = f.previous?.map((x, i) => {
        if (x.startOn === undefined && x.frequency === undefined && x.pauses === undefined)
            return { key: x.key, through: x.through };
        if (!fixedDay(x.startOn) || x.startOn >= x.through || !x.frequency || !['monthly', 'yearly', 'weekly'].includes(x.frequency) || !Array.isArray(x.pauses) || x.through > f.startOn || (i > 0 && x.startOn < f.previous[i - 1].through))
            throw new Error('固定費の旧支払期間が不正です。');
        const end = new Date(Date.parse(x.through + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
        const pauses = validatePauses(x.pauses, x.startOn, end);
        if (pauses.some(p => p.endOn === null || p.endOn > end))
            throw new Error('固定費の旧停止期間が不正です。');
        return { key: x.key, through: x.through, startOn: x.startOn, frequency: x.frequency, pauses };
    });
    return { frequency: f.frequency, state: f.state, startOn: f.startOn, ...(f.endOn !== undefined ? { endOn: f.endOn } : {}), ...(pauses?.length ? { pauses } : {}), ...(f.previous?.length ? { previous } : {}), ...(f.legacyId ? { legacyId: f.legacyId } : {}) };
}
export function validateRule(rule) {
    if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || !/^[a-zA-Z0-9-]{6,80}$/.test(rule.id) ||
        typeof rule.pattern !== 'string' || !normalizeMerchant(rule.pattern) || rule.pattern.length > 200 ||
        !allowed.has(rule.mode) || typeof rule.displayName !== 'string' || !rule.displayName.trim() || rule.displayName.length > 120 ||
        (rule.cardId !== null && (typeof rule.cardId !== 'string' || !/^[a-z0-9-]{1,60}$/.test(rule.cardId))) ||
        typeof rule.enabled !== 'boolean' || !Number.isSafeInteger(rule.priority) || rule.priority < 0 || rule.priority > 1000 ||
        (rule.categoryId !== undefined && rule.categoryId !== null && !categoryIds.has(rule.categoryId) && !customCategoryId.test(rule.categoryId)))
        throw new Error('利用先ルールの内容が不正です。');
    // Backward compatible: old encrypted rules have only `pattern`. /* finance-v147 */
    const extra = rule.patterns;
    if (extra !== undefined && (!Array.isArray(extra) || extra.length > 19 ||
        extra.some(p => typeof p !== 'string' || !normalizeMerchant(p) || p.length > 200)))
        throw new Error('利用先の追加条件が不正です。');
    const list = [rule.pattern, ...(extra ?? [])];
    if (new Set(list.map(normalizeMerchant)).size !== list.length)
        throw new Error('同じ利用先条件は1度だけ登録してください。');
    const fixedCost = validateRuleFixedCost(rule);
    return { ...rule, ...(fixedCost ? { fixedCost } : {}), pattern: rule.pattern.trim(),
        ...(extra !== undefined ? { patterns: extra.map(p => p.trim()) } : {}),
        displayName: rule.displayName.trim() };
}
export function validateRules(raw) {
    if (!raw || typeof raw !== 'object')
        throw new Error('利用先ルールの形式が不正です。');
    const doc = raw;
    if (!['finance-merchant-rules-v1', 'finance-merchant-rules-v2'].includes(doc.format) || !Array.isArray(doc.rules) || !Array.isArray(doc.deleted) || !Array.isArray(doc.conflicts) ||
        doc.rules.length > 500 || doc.deleted.length > 2000 || doc.conflicts.length > 500)
        throw new Error('利用先ルールの形式が不正です。');
    const ids = new Set();
    const rules = doc.rules.map(item => {
        const validated = validateRule(item);
        if (ids.has(validated.id))
            throw new Error('利用先ルールIDが重複しています。');
        ids.add(validated.id);
        return validated;
    });
    if (doc.deleted.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{6,80}$/.test(id)))
        throw new Error('利用先ルール削除情報が不正です。');
    if (doc.conflicts.some(c => !c || typeof c.ruleId !== 'string' || typeof c.field !== 'string' || typeof c.at !== 'string'))
        throw new Error('利用先ルール競合履歴が不正です。');
    let categoryColors;
    if (doc.categoryColors !== undefined) {
        if (!doc.categoryColors || typeof doc.categoryColors !== 'object' || Array.isArray(doc.categoryColors))
            throw new Error('カテゴリーの色設定が不正です。');
        categoryColors = {};
        for (const [id, color] of Object.entries(doc.categoryColors)) {
            if (!categoryIds.has(id) || !paletteIds.has(color))
                throw new Error('カテゴリーの色設定が不正です。');
            categoryColors[id] = color;
        }
    }
    let categoryDefinitions;
    if (doc.categoryDefinitions !== undefined) {
        if (!Array.isArray(doc.categoryDefinitions) || doc.categoryDefinitions.length > 160)
            throw new Error('カテゴリー設定が不正です。');
        const defined = new Set();
        categoryDefinitions = doc.categoryDefinitions.map(raw => {
            const value = validateCategory(raw);
            if (defined.has(value.id))
                throw new Error('カテゴリーIDが重複しています。');
            defined.add(value.id);
            return value;
        });
    }
    let deletedCategories;
    if (doc.deletedCategories !== undefined) {
        if (!Array.isArray(doc.deletedCategories) || doc.deletedCategories.length > 300 ||
            doc.deletedCategories.some(id => typeof id !== 'string' || (!categoryIds.has(id) && !customCategoryId.test(id))))
            throw new Error('カテゴリー削除情報が不正です。');
        deletedCategories = [...new Set(doc.deletedCategories)];
    }
    if (categoryDefinitions?.some(item => deletedCategories?.includes(item.id)))
        throw new Error('削除されたカテゴリーが残っています。');
    const available = new Set(listCategories({ categoryColors, categoryDefinitions, deletedCategories }).map(item => item.id));
    if (rules.some(item => item.categoryId && !available.has(item.categoryId)))
        throw new Error('利用先ルールに存在しないカテゴリーが設定されています。');
    const fixedKeys = new Set(), legacyIds = new Set();
    for (const rule of rules) {
        if (!rule.fixedCost)
            continue;
        const key = fixedRuleKey(rule);
        if (fixedKeys.has(key))
            throw new Error('同じカードと利用先の固定費が重複しています。');
        fixedKeys.add(key);
        if (rule.fixedCost.legacyId) {
            if (legacyIds.has(rule.fixedCost.legacyId))
                throw new Error('固定費の移行先が重複しています。');
            legacyIds.add(rule.fixedCost.legacyId);
        }
    }
    const receipts = doc.fixedCostMigrations;
    if (receipts !== undefined && (!Array.isArray(receipts) || receipts.length > 2000 || receipts.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{6,80}$/.test(id))))
        throw new Error('固定費の移行情報が不正です。');
    const migrations = [...new Set([...(receipts ?? []), ...legacyIds])].sort();
    if (migrations.length > 2000)
        throw new Error('固定費の移行情報が多すぎます。');
    // Older clients must not silently drop rule-based fixed costs when merging.
    const format = doc.format === 'finance-merchant-rules-v2' || fixedKeys.size || migrations.length ? 'finance-merchant-rules-v2' : 'finance-merchant-rules-v1';
    return { format, rules, deleted: [...new Set(doc.deleted)], conflicts: clone(doc.conflicts), ...(migrations.length ? { fixedCostMigrations: migrations } : {}),
        ...(categoryColors ? { categoryColors } : {}), ...(categoryDefinitions ? { categoryDefinitions } : {}), ...(deletedCategories ? { deletedCategories } : {}) };
}
const modeRank = { exact: 3, prefix: 2, contains: 1 };
export function sortedRules(rules) {
    return [...rules].sort((a, b) => b.priority - a.priority || modeRank[b.mode] - modeRank[a.mode] ||
        Math.max(...[b.pattern, ...(b.patterns ?? [])].map(p => normalizeMerchant(p).length)) -
            Math.max(...[a.pattern, ...(a.patterns ?? [])].map(p => normalizeMerchant(p).length)) || a.id.localeCompare(b.id));
}
export function matchingRule(original, cardId, rules) {
    const merchant = normalizeMerchant(original);
    if (!merchant)
        return undefined;
    return sortedRules(rules).find(rule => {
        if (!rule.enabled || (rule.cardId && rule.cardId !== cardId))
            return false;
        return [rule.pattern, ...(rule.patterns ?? [])].some(term => {
            const pattern = normalizeMerchant(term);
            return rule.mode === 'exact' ? merchant === pattern : rule.mode === 'prefix' ? merchant.startsWith(pattern) : merchant.includes(pattern);
        });
    });
}
export function displayMerchant(original, cardId, rules, override) {
    return override?.trim() || matchingRule(original, cardId, rules)?.displayName || original;
}
/** Three-way merge of independent rules and fields. Saving editor wins same-field ties,
 * and the other value is retained in the encrypted conflict log. Deletions use tombstones. */
export function mergeRules(base, local, remote, now = new Date().toISOString(), collisionSink, preferLocalDeletes = false) {
    const collided = (ruleId, field, local, remote) => {
        collisionSink?.push({ ruleId, field, local: clone(local), remote: clone(remote) });
    };
    const b = new Map(base.rules.map(r => [r.id, r]));
    const l = new Map(local.rules.map(r => [r.id, r]));
    const r = new Map(remote.rules.map(r => [r.id, r]));
    const deleted = new Set([...base.deleted, ...local.deleted, ...remote.deleted]);
    const conflicts = [...remote.conflicts];
    for (const c of local.conflicts)
        if (!conflicts.some(x => same(x, c)))
            conflicts.push(clone(c));
    const result = [];
    const missing = Symbol('missing');
    const field = (id, path, bv, lv, rv) => {
        if (same(lv, bv))
            return rv === missing ? missing : clone(rv);
        if (same(rv, bv) || same(lv, rv))
            return lv === missing ? missing : clone(lv);
        if (lv === missing && rv !== missing) {
            collided(id, path, '削除', rv);
            if (preferLocalDeletes) {
                conflicts.push({ ruleId: id, field: path, discarded: clone(rv), chosen: '削除', at: now });
                return missing;
            }
            conflicts.push({ ruleId: id, field: path, discarded: '削除', chosen: clone(rv), at: now });
            return clone(rv);
        }
        if (rv === missing && lv !== missing) {
            collided(id, path, lv, '削除');
            conflicts.push({ ruleId: id, field: path, discarded: '削除', chosen: clone(lv), at: now });
            return clone(lv);
        }
        collided(id, path, lv, rv);
        conflicts.push({ ruleId: id, field: path, discarded: clone(rv), chosen: clone(lv), at: now });
        return clone(lv);
    };
    for (const id of new Set([...b.keys(), ...r.keys(), ...l.keys(), ...deleted])) {
        const bv = b.get(id), lv = l.get(id), rv = r.get(id);
        if (!lv && !rv) {
            deleted.add(id);
            continue;
        }
        // Treat an entire rule as the unit for delete-vs-edit conflicts.
        if (bv && !lv && local.deleted.includes(id)) {
            if (!rv || same(rv, bv)) {
                deleted.add(id);
                continue;
            }
            collided(id, 'rule', '削除', rv);
            if (preferLocalDeletes) {
                conflicts.push({ ruleId: id, field: 'rule', discarded: clone(rv), chosen: '削除', at: now });
                deleted.add(id);
                continue;
            }
            conflicts.push({ ruleId: id, field: 'rule', discarded: '削除', chosen: clone(rv), at: now });
            result.push(clone(rv));
            deleted.delete(id);
            continue;
        }
        if (bv && !rv && remote.deleted.includes(id)) {
            if (!lv || same(lv, bv)) {
                deleted.add(id);
                continue;
            }
            collided(id, 'rule', lv, '削除');
            conflicts.push({ ruleId: id, field: 'rule', discarded: '削除', chosen: clone(lv), at: now });
            result.push(clone(lv));
            deleted.delete(id);
            continue;
        }
        if (!bv && lv && !rv) {
            result.push(clone(lv));
            deleted.delete(id);
            continue;
        }
        if (!bv && rv && !lv) {
            result.push(clone(rv));
            deleted.delete(id);
            continue;
        }
        const merged = {};
        for (const key of ['id', 'pattern', 'patterns', 'mode', 'displayName', 'cardId', 'enabled', 'priority', 'categoryId', 'fixedCost']) {
            const value = field(id, key, bv ? bv[key] : missing, lv ? lv[key] : missing, rv ? rv[key] : missing);
            if (value !== missing)
                merged[key] = value;
        }
        if (!merged.id)
            continue;
        result.push(validateRule(merged));
        deleted.delete(id);
    }
    // Independently merge each category's color, not the entire palette map.
    const colors = {};
    for (const category of CATEGORIES) {
        const id = category.id;
        const value = field(`category:${id}`, 'color', base.categoryColors?.[id] ?? missing, local.categoryColors?.[id] ?? missing, remote.categoryColors?.[id] ?? missing);
        if (value !== missing)
            colors[id] = value;
    }
    // Merge editable category definitions by stable ID and field, including concurrent additions.
    const defaults = new Map(CATEGORIES.map(item => [item.id, { id: item.id, name: item.name, color: item.defaultColor }]));
    const definitions = (doc) => new Map((doc.categoryDefinitions ?? []).map(item => [item.id, item]));
    const cb = definitions(base), cl = definitions(local), cr = definitions(remote);
    const allIds = new Set([...defaults.keys(), ...cb.keys(), ...cl.keys(), ...cr.keys(),
        ...(base.deletedCategories ?? []), ...(local.deletedCategories ?? []), ...(remote.deletedCategories ?? [])]);
    const categoryDefinitions = [];
    const deletedCategories = new Set([...(base.deletedCategories ?? []), ...(local.deletedCategories ?? []), ...(remote.deletedCategories ?? [])]);
    for (const id of allIds) {
        const initial = defaults.get(id), bDef = cb.get(id) ?? initial, lDef = cl.get(id) ?? (local.deletedCategories?.includes(id) ? undefined : initial), rDef = cr.get(id) ?? (remote.deletedCategories?.includes(id) ? undefined : initial);
        const deletedL = !!local.deletedCategories?.includes(id), deletedR = !!remote.deletedCategories?.includes(id);
        // Delete wins over an unmodified other device; simultaneous edits are retained with audit history.
        if (deletedL || deletedR) {
            const survivor = deletedL ? rDef : lDef, original = bDef;
            if (!survivor || same(survivor, original)) {
                deletedCategories.add(id);
                continue;
            }
            collided(`category:${id}`, 'delete', deletedL ? '削除' : survivor, deletedR ? '削除' : survivor);
            if (deletedL && preferLocalDeletes) {
                conflicts.push({ ruleId: `category:${id}`, field: 'delete', discarded: clone(survivor), chosen: '削除', at: now });
                deletedCategories.add(id);
                continue;
            }
            conflicts.push({ ruleId: `category:${id}`, field: 'delete', discarded: '削除', chosen: clone(survivor), at: now });
            deletedCategories.delete(id);
        }
        const left = deletedL ? missing : (cl.get(id) ?? initial ?? missing);
        const right = deletedR ? missing : (cr.get(id) ?? initial ?? missing);
        const middle = bDef ?? missing;
        if (left === missing && right === missing) {
            if (!initial)
                deletedCategories.add(id);
            continue;
        }
        const merged = { id };
        for (const key of ['name', 'color']) {
            const value = field(`category:${id}`, key, middle === missing ? missing : middle[key], left === missing ? missing : left[key], right === missing ? missing : right[key]);
            if (value !== missing)
                merged[key] = value;
        }
        if (typeof merged.name !== 'string' || typeof merged.color !== 'string')
            continue;
        const category = validateCategory(merged);
        if (!initial || !same(category, initial))
            categoryDefinitions.push(category);
        deletedCategories.delete(id);
    }
    const effective = new Set(listCategories({ categoryColors: colors, categoryDefinitions, deletedCategories: [...deletedCategories] }).map(item => item.id));
    for (const rule of result) {
        if (rule.categoryId && !effective.has(rule.categoryId)) {
            collided(rule.id, 'categoryId', null, rule.categoryId);
            conflicts.push({ ruleId: rule.id, field: 'categoryId', discarded: rule.categoryId, chosen: null, at: now });
            rule.categoryId = null;
        }
    }
    const hasColors = Object.keys(colors).length > 0;
    const fixedCostMigrations = [...new Set([...(base.fixedCostMigrations ?? []), ...(local.fixedCostMigrations ?? []), ...(remote.fixedCostMigrations ?? [])])];
    return validateRules({ format: [base, local, remote].some(d => d.format === 'finance-merchant-rules-v2') ? 'finance-merchant-rules-v2' : 'finance-merchant-rules-v1', rules: result, deleted: [...deleted], conflicts: conflicts.slice(-300), ...(fixedCostMigrations.length ? { fixedCostMigrations } : {}),
        ...(hasColors ? { categoryColors: colors } : {}),
        ...(categoryDefinitions.length ? { categoryDefinitions } : {}),
        ...(deletedCategories.size ? { deletedCategories: [...deletedCategories] } : {}) });
}
/** Same-field/category collision detector; disjoint additions and edits pass freely. */
export function detectRuleEditCollisions(base, local, remote) {
    const collisions = [];
    mergeRules(base, local, remote, new Date().toISOString(), collisions);
    return collisions;
}
