/** Finance P1-A: in-browser multi-month / annual analysis, no additional persistence. */
import { annualAnalytics, comparableDelta, priorYearAnalytics, rollingAnalytics } from '../analysis/period-analytics.js';
import { monthNavigator, yearNavigator } from './period-navigator.js';
import { periodPointBenefitsFromReports } from '../summary/point-benefits.js';
import { pointBenefitsSection } from './point-benefits.js';
import { measureFinanceSync } from '../cloud/performance-diagnostics.js';
const formatYen = (amount, digits = 0) => amount === null ? '未取得' : `${amount.toLocaleString('ja-JP', { maximumFractionDigits: digits })}円`;
const signedYen = (value) => `${value > 0 ? '+' : ''}${formatYen(value)}`;
const monthLabel = (period) => `${Number(period.slice(5))}月`;
const labelYearMonth = (period) => `${period.slice(0, 4)}年${monthLabel(period)}`;
const currentLocal = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; };
function el(tag, className = '', text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function action(text, handler, className = '') {
    const button = el('button', className, text);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
}
function title(text) { return el('h2', 'analysis-heading', text); }
function panel(heading) {
    const root = el('section', 'panel analysis-panel');
    root.append(title(heading));
    const body = el('div', 'analysis-panel-body');
    root.append(body);
    return { root, body };
}
const quality = (month) => month.coverage === 'missing' ? '未取得' : month.coverage === 'provisional' ? '暫定' : month.coverage === 'review' ? '要確認' : '登録済み';
const amountText = (value, month) => value === null ? '未取得' : formatYen(value);
function metric(label, value, sub) {
    const root = el('div', 'analysis-metric');
    root.append(el('span', 'analysis-muted', label), el('strong', '', value), el('small', 'analysis-muted', sub));
    return root;
}
function note(text) { return el('p', 'analysis-muted analysis-note', text); }
export function initAnalysis(deps) {
    const root = document.getElementById('analysis-content');
    if (!root)
        throw new Error('収支分析画面が見つかりません。');
    let mode = 'month';
    let count = 6;
    let end = currentLocal();
    let year = Number(end.slice(0, 4));
    let dimension = 'category';
    const go = (period) => deps.openMonth(period);
    let reportContext = null;
    const drill = (dimension, id, label, periods) => deps.openDrilldown({ dimension, value: id, label, periods }, reportContext);
    function controls(today, source) {
        const area = el('div', 'analysis-controls');
        const modes = el('div', 'analysis-switch');
        for (const [value, label] of [['month', '月次'], ['year', '年間']]) {
            const button = action(label, () => { mode = value; render(); }, 'analysis-switch-button' + (mode === value ? ' selected' : ''));
            button.setAttribute('aria-pressed', String(mode === value));
            modes.append(button);
        }
        area.append(modes);
        if (mode === 'month') {
            const options = el('div', 'analysis-switch analysis-duration');
            for (const len of [3, 6, 12]) {
                const button = action(`${len}か月`, () => { count = len; render(); }, 'analysis-switch-button' + (count === len ? ' selected' : ''));
                button.setAttribute('aria-pressed', String(count === len));
                options.append(button);
            }
            area.append(options);
            area.append(monthNavigator(end, (next) => { end = next; render(); }, { label: '分析終了月', max: today, min: '1900-12', today }));
        }
        else {
            const years = [...(source?.records ?? []).map(r => Number(r.statement.paymentDate?.slice(0, 4))),
                ...(source?.payroll.entries ?? []).map(p => Number(p.paidOn.slice(0, 4))), year, Number(today.slice(0, 4)) - 5];
            const first = Math.max(1900, Math.min(...years.filter(y => Number.isInteger(y) && y >= 1900)));
            area.append(yearNavigator(year, (next) => { year = next; render(); }, { min: first, max: Number(today.slice(0, 4)) }));
        }
        return area;
    }
    function summary(data) {
        const result = el('div', 'analysis-metrics');
        const totals = data.totals;
        const range = `${data.months[0].period}〜${data.months.at(-1).period}`;
        result.append(metric('収入（実績・見込み）', formatYen(totals.income), `${totals.knownIncomeMonths}/${data.months.length}か月 · ${range}`), metric('支出（明細・予定）', formatYen(totals.expense), `${totals.knownExpenseMonths}/${data.months.length}か月 · NISAを含む`), metric('収支（実績・見込み）', formatYen(totals.balance), totals.comparable ? '対象期間の登録済み集計' : '欠測・暫定などを含む参考値'), metric('平均支出', formatYen(totals.avgExpense, 0), `${totals.knownExpenseMonths}か月分の平均`));
        return result;
    }
    function qualitySummary(data) {
        const { missingMonths, provisionalMonths, reviewMonths } = data.totals;
        if (!missingMonths && !provisionalMonths && !reviewMonths)
            return null;
        const bits = [missingMonths ? `未取得 ${missingMonths}か月` : '', provisionalMonths ? `暫定 ${provisionalMonths}か月` : '', reviewMonths ? `要確認 ${reviewMonths}か月` : ''].filter(Boolean);
        const text = el('div', 'analysis-coverage');
        text.append(el('strong', '', bits.join(' · ')), el('span', '', '集計は登録済みの情報を使用しています。未取得月を0円としていません。'));
        return text;
    }
    function chart(data) {
        const block = panel('収入・支出の推移');
        const legend = el('div', 'analysis-chart-legend');
        legend.append(el('span', 'analysis-income-key', '収入'), el('span', 'analysis-expense-key', '支出'));
        block.body.append(legend);
        const values = data.months.flatMap(m => [m.income, m.expense]).filter((v) => v !== null && v >= 0);
        const max = Math.max(1, ...values);
        const scroll = el('div', 'analysis-chart-scroll');
        const bars = el('div', 'analysis-chart-bars');
        for (const month of data.months) {
            const cell = action('', () => go(month.period), 'analysis-chart-month');
            cell.setAttribute('aria-label', `${labelYearMonth(month.period)} · 収入 ${amountText(month.income, month)} · 支出 ${amountText(month.expense, month)} · ${quality(month)}`);
            const pair = el('span', 'analysis-bar-pair');
            for (const [value, cls] of [[month.income, 'income'], [month.expense, 'expense']]) {
                const slot = el('span', 'analysis-bar-slot');
                if (value === null)
                    slot.append(el('span', 'analysis-bar-missing', '·'));
                else if (value < 0)
                    slot.append(el('span', 'analysis-bar-negative', '−'));
                else {
                    const bar = el('span', `analysis-bar analysis-bar-${cls}`);
                    bar.style.height = `${value === 0 ? 2 : Math.max(3, Math.min(100, value / max * 100))}%`;
                    slot.append(bar);
                }
                pair.append(slot);
            }
            cell.append(pair, el('span', 'analysis-bar-label', monthLabel(month.period)), el('small', 'analysis-muted', month.coverage === 'missing' ? '未取得' : month.coverage === 'provisional' ? '暫定' : month.coverage === 'review' ? '要確認' : ''));
            bars.append(cell);
        }
        scroll.append(bars);
        block.body.append(scroll);
        block.body.append(note('月を選択すると月別サマリーへ移動します。登録済みの収入・支出を表示しています。'));
        return block.root;
    }
    function monthTable(data) {
        const block = panel('月ごとの収支');
        const scroll = el('div', 'analysis-table-scroll');
        const table = el('table', 'analysis-table');
        const header = el('thead');
        const tr = el('tr');
        for (const label of ['月', '収入', '支出', '収支', 'NISA', '状態'])
            tr.append(el('th', '', label));
        header.append(tr);
        table.append(header);
        const body = el('tbody');
        for (const month of [...data.months].reverse()) {
            const row = el('tr');
            const first = el('td');
            first.append(action(labelYearMonth(month.period), () => go(month.period), 'analysis-link'));
            row.append(first);
            for (const amount of [month.income, month.expense, month.balance, month.nisa])
                row.append(el('td', 'analysis-number', formatYen(amount)));
            row.append(el('td', '', quality(month)));
            body.append(row);
        }
        table.append(body);
        scroll.append(table);
        block.body.append(scroll);
        block.body.append(note('支出はカード引落月基準。NISA積立は支出に含め、生活費とは分けて表示します。'));
        return block.root;
    }
    function rangeInsights(data) {
        const block = panel('期間の特徴');
        const totals = data.totals;
        const grid = el('div', 'analysis-insights');
        grid.append(metric('支出が最大の月', totals.maxExpense ? labelYearMonth(totals.maxExpense.period) : '未取得', totals.maxExpense ? formatYen(totals.maxExpense.amount) : '登録済み明細なし'), metric('支出が最小の月', totals.minExpense ? labelYearMonth(totals.minExpense.period) : '未取得', totals.minExpense ? formatYen(totals.minExpense.amount) : '登録済み明細なし'));
        block.body.append(grid);
        const latest = data.months.at(-1), previous = data.months.at(-2);
        if (latest && previous) {
            const change = latest.expense === null || previous.expense === null ? null : latest.expense - previous.expense;
            block.body.append(el('p', 'analysis-insight-line', `直近の前月比：${change === null ? '比較不可' : signedYen(change)}`));
        }
        if (data.categoryChanges.length || data.merchantChanges.length) {
            const changes = el('div', 'analysis-change-columns');
            for (const [heading, entries] of [['カテゴリーの増減', data.categoryChanges], ['利用先の増減', data.merchantChanges]]) {
                const section = el('section');
                section.append(el('h3', '', heading));
                if (!entries.length)
                    section.append(note('比較できる増減はありません。'));
                else
                    entries.slice(0, 4).forEach(entry => {
                        const line = el('div', 'analysis-change-item');
                        const dimension = heading === 'カテゴリーの増減' ? 'category' : 'merchant';
                        const periods = data.months.slice(-2).map(m => m.period);
                        line.append(action(entry.name, () => drill(dimension, entry.id, entry.name, periods), 'analysis-link'), el('strong', entry.delta > 0 ? 'analysis-increase' : '', signedYen(entry.delta)));
                        section.append(line);
                    });
                changes.append(section);
            }
            block.body.append(changes);
        }
        return block.root;
    }
    function ranking(data) {
        const block = panel('カード・カテゴリー・利用先');
        const switcher = el('div', 'analysis-switch analysis-group-switch');
        for (const [value, label] of [['card', 'カード'], ['category', 'カテゴリー'], ['merchant', '利用先']]) {
            const button = action(label, () => { dimension = value; render(); }, 'analysis-switch-button' + (dimension === value ? ' selected' : ''));
            button.setAttribute('aria-pressed', String(dimension === value));
            switcher.append(button);
        }
        block.body.append(switcher);
        const groups = data.groups[dimension].slice(0, 12);
        if (!groups.length) {
            block.body.append(note('分析できる取引がありません。'));
            return block.root;
        }
        const scroll = el('div', 'analysis-table-scroll');
        const table = el('table', 'analysis-table analysis-detail-table');
        const head = el('thead'), row = el('tr');
        row.append(el('th', '', '名称'), el('th', '', '登録済み合計'));
        for (const month of data.months)
            row.append(el('th', '', monthLabel(month.period)));
        head.append(row);
        table.append(head);
        const body = el('tbody');
        for (const group of groups) {
            const item = el('tr');
            const nameCell = el('th');
            nameCell.append(action(group.label, () => drill(dimension, group.id, group.label, data.months.map(m => m.period)), 'analysis-link'));
            const totalCell = el('td', 'analysis-number');
            totalCell.append(action(formatYen(group.total), () => drill(dimension, group.id, group.label, data.months.map(m => m.period)), 'analysis-link'));
            item.append(nameCell, totalCell);
            for (let index = 0; index < data.months.length; index++) {
                const cell = el('td', 'analysis-number');
                const amount = group.amounts[index] ?? null;
                if (amount === null || amount === 0)
                    cell.textContent = amount === null ? '未取得' : formatYen(0);
                else
                    cell.append(action(formatYen(amount), () => drill(dimension, group.id, group.label, [data.months[index].period]), 'analysis-link'));
                item.append(cell);
            }
            body.append(item);
        }
        table.append(body);
        scroll.append(table);
        block.body.append(scroll);
        const caveat = dimension === 'card' ? 'カードごとの引落月で集計しています。' : dimension === 'category' ? 'カード利用と定期支出の分類。NISA・単発支出はこの内訳に含みません。' : 'カード利用先だけを集計しています。';
        block.body.append(note(`${caveat} 利用先・金額を選ぶと該当明細へ移動します。未取得月は空白扱いです。`));
        return block.root;
    }
    function annualCompare(data, prior) {
        const block = panel('前年との比較');
        const years = [data, prior].filter((item) => item !== null);
        const yearTable = el('div', 'analysis-table-scroll'), table = el('table', 'analysis-table');
        const head = el('thead'), tr = el('tr');
        ['期間', '収入・見込み', '支出・予定', '収支', '明細登録月'].forEach(name => tr.append(el('th', '', name)));
        head.append(tr);
        table.append(head);
        const body = el('tbody');
        for (const item of years) {
            const line = el('tr');
            line.append(el('td', '', `${item.months[0].period.slice(0, 4)}年 1〜${item.months.length}月`), el('td', 'analysis-number', formatYen(item.totals.income)), el('td', 'analysis-number', formatYen(item.totals.expense)), el('td', 'analysis-number', formatYen(item.totals.balance)), el('td', '', `${item.totals.knownExpenseMonths}/${item.months.length}か月`));
            body.append(line);
        }
        table.append(body);
        yearTable.append(table);
        block.body.append(yearTable);
        const delta = comparableDelta(data, prior, 'expense');
        block.body.append(note(delta ? `登録済み支出の前年比：${signedYen(delta.amount)}${delta.percent === null ? '' : `（${delta.percent > 0 ? '+' : ''}${delta.percent.toFixed(1)}%）`}` :
            '前年比：比較できる明細が揃っていません。'));
        if (prior && data.months.length === prior.months.length &&
            [data, prior].every(item => item.months.every(m => m.coverage === 'registered'))) {
            const comparisons = el('div', 'analysis-change-columns');
            for (const [dimension, heading] of [['category', 'カテゴリーの登録分前年比'], ['merchant', '利用先の登録分前年比']]) {
                const old = new Map(prior.groups[dimension].map(g => [g.id, g.total]));
                const current = new Map(data.groups[dimension].map(g => [g.id, g.total]));
                const labels = new Map([...prior.groups[dimension], ...data.groups[dimension]].map(g => [g.id, g.label]));
                const changes = [...new Set([...old.keys(), ...current.keys()])].map(id => ({ id, name: labels.get(id) ?? id, delta: (current.get(id) ?? 0) - (old.get(id) ?? 0) }))
                    .filter(item => item.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);
                const section = el('section');
                section.append(el('h3', '', heading));
                if (!changes.length)
                    section.append(note('大きな変化はありません。'));
                for (const change of changes) {
                    const line = el('div', 'analysis-change-item');
                    line.append(action(change.name, () => drill(dimension, change.id, change.name, data.months.map(m => m.period)), 'analysis-link'), el('strong', change.delta > 0 ? 'analysis-increase' : '', signedYen(change.delta)));
                    section.append(line);
                }
                comparisons.append(section);
            }
            block.body.append(comparisons);
        }
        return block.root;
    }
    function render() {
        return measureFinanceSync('ui.analysis.render', () => {
            root.replaceChildren();
            const today = currentLocal();
            if (end > today)
                end = today;
            if (year > Number(today.slice(0, 4)))
                year = Number(today.slice(0, 4));
            const source = deps.source();
            reportContext = null;
            root.append(controls(today, source));
            if (!source) {
                const locked = panel('OneDrive保管庫を開く');
                locked.body.append(action('設定を開く', deps.openSettings, 'analysis-primary'));
                root.append(locked.root);
                return;
            }
            try {
                const data = measureFinanceSync('ui.analysis.aggregate', () => mode === 'month'
                    ? rollingAnalytics(source, end, count, today) : annualAnalytics(source, year, today));
                reportContext = { source, reports: new Map(data.months.map(m => [m.period, m.report])) };
                const header = el('div', 'analysis-range');
                header.append(el('strong', '', mode === 'month' ? `${labelYearMonth(data.months[0].period)}〜${labelYearMonth(data.months.at(-1).period)}` : `${year}年の収支`));
                root.append(header, summary(data), pointBenefitsSection('獲得ポイント', measureFinanceSync('ui.analysis.points', () => periodPointBenefitsFromReports(data.months.map(m => m.report), source))));
                const warning = qualitySummary(data);
                if (warning)
                    root.append(warning);
                root.append(measureFinanceSync('ui.analysis.chart', () => chart(data)), monthTable(data));
                if (mode === 'year')
                    root.append(annualCompare(data, priorYearAnalytics(source, year, today)));
                root.append(rangeInsights(data), ranking(data));
            }
            catch (error) {
                const problem = panel('収支分析を表示できません');
                problem.body.append(note(error instanceof Error ? error.message : 'データを確認してください。'));
                root.append(problem.root);
            }
        });
    }
    return { render, reset: () => { reportContext = null; end = currentLocal(); year = Number(end.slice(0, 4)); mode = 'month'; count = 6; dimension = 'category'; render(); } };
}
