import { DATA_STATUS, financialStatusClass, formatYen as sharedYen, formatMonth, formatRate, formatNumber } from './formatters.js';
import { currentSavingMonthly, futureProjection, suggestedNisaMonthly, targetMonthForAge, projectionAgeBounds } from '../cloud/future-projection.js';
import { matchingNisaRows } from '../cloud/asset-projection.js';
const yen = (value) => sharedYen(value, 0, DATA_STATUS.unavailable);
const short = (n) => n === null ? DATA_STATUS.unavailable : Math.abs(n) >= 10000 ? `${formatNumber(n / 10000, 1)}万円` : yen(n);
function el(tag, className = '', text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function incrementYearMonth(month, years) {
    return `${Number(month.slice(0, 4)) + years}-${month.slice(5)}`;
}
function monthAfter(month) {
    const y = Number(month.slice(0, 4)), m = Number(month.slice(5));
    return `${y + (m === 12 ? 1 : 0)}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
}
const dateTitle = formatMonth;
const svgNS = 'http://www.w3.org/2000/svg';
function svgNode(tag, attrs) {
    const node = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs))
        node.setAttribute(k, v);
    return node;
}
function ageText(month, born) {
    if (!born)
        return '';
    const age = Number(month.slice(0, 4)) - Number(born.slice(0, 4)) - (Number(month.slice(5)) < Number(born.slice(5)) ? 1 : 0);
    return age >= 0 ? `（${age}歳）` : '';
}
/** Map SVG viewBox x, not the CSS element width, to a month. */
export function nearestProjectionIndexSvgX(x, count) {
    if (count <= 1 || !Number.isFinite(x))
        return 0;
    const relative = Math.max(0, Math.min(1, (x - 50) / (840 - 50 - 16)));
    return Math.max(0, Math.min(count - 1, Math.round(relative * (count - 1))));
}
/** Kept for existing callers and tests that work with a simple 840-unit viewport. */
export function nearestProjectionIndex(clientX, left, width, count) {
    if (!Number.isFinite(width) || width <= 0)
        return 0;
    return nearestProjectionIndexSvgX((clientX - left) * 840 / width, count);
}
/** Invert the actual screen CTM, including SVG preserveAspectRatio letterboxing. */
export function chartXFromScreenPoint(clientX, clientY, matrix) {
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
        return null;
    const x = (matrix.d * (clientX - matrix.e) - matrix.c * (clientY - matrix.f)) / determinant;
    return Number.isFinite(x) ? x : null;
}
function drawChart(container, points, born, compare, filter, selectedMonth, onFilter, onSelect) {
    container.replaceChildren();
    const names = [
        ['cash', '現金貯金', 'cash'],
        ['nisa', 'NISA', 'nisa'],
        ['combined', '現金＋NISA', 'base'],
        ...(compare ? [['combinedScenario', '積立変更後の合計', 'scenario']] : []),
    ];
    const buttons = el('div', 'future-chart-filters');
    buttons.setAttribute('role', 'group');
    buttons.setAttribute('aria-label', 'グラフの表示切り替え');
    const options = [['all', 'すべて'], ['cash', '現金'], ['nisa', 'NISA'], ['combined', '合計'], ...(compare ? [['combinedScenario', '変更後']] : [])];
    for (const [key, title] of options) {
        const button = el('button', 'future-chart-filter', title);
        button.type = 'button';
        button.dataset.series = key;
        button.setAttribute('aria-pressed', String(filter === key));
        button.addEventListener('click', () => {
            const hadFocus = document.activeElement === button;
            onFilter(key);
            // Repaint replaces the control: restore keyboard focus to its successor.
            if (hadFocus) {
                const next = [...container.querySelectorAll('.future-chart-filter')]
                    .find(candidate => candidate.dataset.series === key);
                next?.focus({ preventScroll: true });
            }
        });
        buttons.append(button);
    }
    container.append(buttons);
    const shown = filter === 'all' ? names : names.filter(([key]) => key === filter);
    const values = points.flatMap(p => shown.flatMap(([key]) => typeof p[key] === 'number' ? [p[key]] : []));
    if (!points.length || values.length < 2) {
        container.append(el('p', 'future-help', '残高を登録すると推移グラフを表示します。'));
        return;
    }
    const min = Math.min(0, ...values), max = Math.max(1, ...values), range = max - min;
    const w = 840, h = 270, padX = 50, padTop = 18, padBottom = 38;
    const x = (i) => padX + (i / (points.length - 1 || 1)) * (w - padX - 16);
    const y = (value) => padTop + (max - value) / range * (h - padTop - padBottom);
    const svg = svgNode('svg', { viewBox: `0 0 ${w} ${h}`, role: 'slider', tabindex: '0',
        'aria-label': '予測年月を選択', 'aria-valuemin': '0', 'aria-valuemax': String(points.length - 1),
        class: 'future-chart-svg' });
    const description = svgNode('title', {});
    description.textContent = 'グラフをタップまたは左右矢印キーで年月を選択';
    svg.append(description);
    for (let i = 0; i <= 4; i++) {
        const value = min + range * i / 4;
        const yy = y(value);
        svg.append(svgNode('line', { x1: String(padX), x2: String(w - 16), y1: String(yy), y2: String(yy), class: 'future-gridline' }));
        const label = svgNode('text', { x: String(padX - 8), y: String(yy + 4), 'text-anchor': 'end', class: 'future-axis-text' });
        label.textContent = Math.round(value / 10000).toLocaleString('ja-JP') + '万';
        svg.append(label);
    }
    for (const [key, , cls] of shown) {
        const finite = points.map((p, i) => ({ i, value: p[key] })).filter((p) => typeof p.value === 'number');
        if (finite.length < 2)
            continue;
        svg.append(svgNode('polyline', { points: finite.map(p => `${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' '),
            fill: 'none', class: `future-path future-path-${cls}`, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    const tickIndices = [0, Math.floor((points.length - 1) / 2), points.length - 1];
    for (const i of [...new Set(tickIndices)]) {
        const label = svgNode('text', { x: String(x(i)), y: String(h - 12), 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle', class: 'future-axis-text' });
        label.textContent = points[i].month.slice(0, 4) + '年' + ageText(points[i].month, born);
        svg.append(label);
    }
    const indicator = svgNode('g', { 'aria-hidden': 'true', class: 'future-chart-indicator' });
    svg.append(indicator);
    container.append(svg);
    const help = el('p', 'future-chart-help', 'グラフをタップ・ドラッグして年月を確認できます。左右矢印キーにも対応。');
    container.append(help);
    const detail = el('div', 'future-chart-selection');
    detail.setAttribute('role', 'status');
    detail.setAttribute('aria-live', 'polite');
    container.append(detail);
    const remembered = selectedMonth ? points.findIndex(p => p.month === selectedMonth) : -1;
    let selectedIndex = remembered >= 0 ? remembered : points.length - 1;
    const select = (index) => {
        if (index === selectedIndex && detail.childElementCount)
            return;
        selectedIndex = Math.max(0, Math.min(points.length - 1, index));
        const selected = points[selectedIndex];
        onSelect(selected.month);
        svg.setAttribute('aria-valuenow', String(selectedIndex));
        svg.setAttribute('aria-valuetext', dateTitle(selected.month));
        indicator.replaceChildren();
        indicator.append(svgNode('line', { x1: String(x(selectedIndex)), x2: String(x(selectedIndex)), y1: String(padTop), y2: String(h - padBottom), class: 'future-chart-guide' }));
        for (const [key, , cls] of shown) {
            const v = selected[key];
            if (typeof v !== 'number')
                continue;
            indicator.append(svgNode('circle', { cx: String(x(selectedIndex)), cy: String(y(v)), r: '6', class: `future-chart-dot future-chart-dot-${cls}` }));
        }
        detail.replaceChildren();
        detail.append(el('strong', 'future-chart-selection-date', dateTitle(selected.month) + ageText(selected.month, born)));
        const valuesList = el('div', 'future-chart-selection-values');
        for (const [key, title, cls] of shown) {
            const item = el('div', `future-chart-selection-item future-chart-selection-${cls}`);
            item.append(el('span', '', title), el('strong', '', yen(selected[key])));
            valuesList.append(item);
        }
        detail.append(valuesList);
    };
    const atPointer = (event) => {
        const ctm = svg.getScreenCTM();
        const mapped = ctm ? chartXFromScreenPoint(event.clientX, event.clientY, ctm) : null;
        if (mapped !== null) {
            select(nearestProjectionIndexSvgX(mapped, points.length));
            return;
        }
        // CTM may be unavailable for a detached SVG. Mirror the default
        // preserveAspectRatio="xMidYMid meet" sizing rather than using its box width.
        const rect = svg.getBoundingClientRect();
        const scale = Math.min(rect.width / w, rect.height / h);
        if (!Number.isFinite(scale) || scale <= 0)
            return;
        const paintedLeft = rect.left + (rect.width - w * scale) / 2;
        select(nearestProjectionIndexSvgX((event.clientX - paintedLeft) / scale, points.length));
    };
    let dragId = null;
    svg.addEventListener('pointerdown', event => {
        dragId = event.pointerId;
        atPointer(event);
        // Capture a touch drag without disabling normal vertical page scrolling.
        if (event.pointerType === 'mouse')
            svg.setPointerCapture?.(event.pointerId);
    });
    svg.addEventListener('pointermove', event => {
        if (event.pointerType === 'mouse' || dragId === event.pointerId)
            atPointer(event);
    });
    const stop = (event) => { if (dragId === event.pointerId)
        dragId = null; };
    svg.addEventListener('pointerup', stop);
    svg.addEventListener('pointercancel', stop);
    svg.addEventListener('keydown', event => {
        const increment = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
        if (increment) {
            event.preventDefault();
            select(selectedIndex + increment);
        }
        else if (event.key === 'Home') {
            event.preventDefault();
            select(0);
        }
        else if (event.key === 'End') {
            event.preventDefault();
            select(points.length - 1);
        }
    });
    select(selectedIndex);
    const legend = el('div', 'future-legend');
    for (const [, name, cls] of shown)
        legend.append(el('span', `future-legend-item future-legend-${cls}`, name));
    container.append(legend);
}
export function initFutureProjection(getSource) {
    const find = (id) => {
        const n = document.getElementById(id);
        if (!n)
            throw Error(`Future UI missing: ${id}`);
        return n;
    };
    const target = find('future-target');
    const age = find('future-age');
    const from = find('future-change-month');
    const saving = find('future-saving-amount');
    const nisaScenarioInput = find('future-scenario-nisa');
    const nisaRate = find('future-nisa-rate');
    const results = find('future-results');
    const scenarioPanel = find('future-scenario-settings');
    const scenarioAccordion = find('future-scenario-accordion');
    const cashChoice = find('future-compare-cash');
    const nisaChoice = find('future-compare-nisa');
    let compare = false;
    let chartFilter = 'all';
    let chosenMonth = null;
    let yearListOpen = false;
    // Only reuse within the same immutable vault snapshot and NISA-rule version.
    let cachedNisa = null;
    let renderTimer = null;
    const scheduleRender = () => { if (renderTimer !== null)
        clearTimeout(renderTimer); renderTimer = setTimeout(() => { renderTimer = null; render(); }, 90); };
    const updateScenarioControls = () => {
        const cash = cashChoice.checked, nisa = nisaChoice.checked;
        find('future-cash-amount-wrap').hidden = !cash;
        find('future-nisa-amount-wrap').hidden = !nisa;
        saving.disabled = !cash;
        nisaScenarioInput.disabled = !nisa;
    };
    for (const choice of [cashChoice, nisaChoice])
        choice.addEventListener('change', () => {
            // The closed accordion is the "no changes" state. Keep one or both active while open.
            if (!cashChoice.checked && !nisaChoice.checked)
                choice.checked = true;
            updateScenarioControls();
            render();
        });
    const syncScenarioAccordion = () => {
        compare = scenarioAccordion.open;
        scenarioPanel.hidden = !compare;
        updateScenarioControls();
        render();
    };
    scenarioAccordion.addEventListener('toggle', syncScenarioAccordion);
    scenarioPanel.hidden = !scenarioAccordion.open;
    compare = scenarioAccordion.open;
    updateScenarioControls();
    const hint = find('future-hint');
    const today = localToday();
    target.value = incrementYearMonth(today.slice(0, 7), 18);
    from.value = monthAfter(today.slice(0, 7));
    from.min = from.value;
    saving.value = '20000';
    nisaScenarioInput.value = '20000';
    nisaRate.value = '3';
    let scenarioCashEdited = false;
    let scenarioNisaEdited = false;
    let lastBirthMonth = null;
    const birthSettings = find('future-birth-settings');
    birthSettings.addEventListener('click', () => {
        document.getElementById('nav-settings')?.click();
        document.getElementById('settings-nisa-panel')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    const moneyField = (input) => input.value.trim() && Number.isSafeInteger(Number(input.value)) && Number(input.value) >= 0 ? Number(input.value) : null;
    const updateAgeTarget = () => {
        const calculated = targetMonthForAge(getSource()?.assets.birthMonth ?? '', Number(age.value));
        if (calculated)
            target.value = calculated;
        render();
    };
    age.addEventListener('input', updateAgeTarget);
    nisaRate.addEventListener('input', scheduleRender);
    from.addEventListener('input', render);
    saving.addEventListener('input', () => { scenarioCashEdited = true; scheduleRender(); });
    nisaScenarioInput.addEventListener('input', () => { scenarioNisaEdited = true; scheduleRender(); });
    function makeMetric(title, value, style, sub) {
        const card = el('div', `future-metric future-metric-${style}`);
        const label = el('div', 'future-metric-label');
        label.append(el('span', `future-color-key future-color-key-${style}`), el('span', '', title));
        card.append(label, el('strong', financialStatusClass(short(value)), short(value)));
        if (sub)
            card.append(el('small', 'future-muted', sub));
        return card;
    }
    function render() {
        if (renderTimer !== null) {
            clearTimeout(renderTimer);
            renderTimer = null;
        }
        const source = getSource();
        const previousList = results.querySelector('.future-annual-list');
        if (previousList)
            yearListOpen = previousList.open;
        results.replaceChildren();
        find('future-scenario-hint').textContent = '';
        if (!source) {
            find('future-age-value').textContent = '—';
            find('future-target-label').textContent = '';
            hint.textContent = 'OneDrive保管庫の解除後に将来資産を試算できます。';
            return;
        }
        const birthMonth = source.assets.birthMonth ?? '';
        const bounds = projectionAgeBounds(birthMonth, localToday().slice(0, 7));
        if (lastBirthMonth !== birthMonth) {
            lastBirthMonth = birthMonth;
            age.value = String(bounds ? Math.max(bounds.min, Math.min(40, bounds.max)) : 40);
        }
        if (bounds) {
            age.min = String(bounds.min);
            age.max = String(bounds.max);
            const clamped = Math.max(bounds.min, Math.min(Number(age.value) || bounds.min, bounds.max));
            age.value = String(clamped);
            target.value = targetMonthForAge(birthMonth, clamped) ?? '';
        }
        else
            target.value = '';
        age.disabled = !bounds;
        birthSettings.hidden = !!birthMonth;
        find('future-age-value').textContent = bounds ? `${age.value}歳` : birthMonth ? DATA_STATUS.unavailable : DATA_STATUS.unset;
        find('future-nisa-rate-value').textContent = formatRate(Number(nisaRate.value));
        find('future-target-label').textContent = bounds ? `目標年月：${dateTitle(target.value)}` : '';
        if (!birthMonth) {
            hint.textContent = '生年月を設定してください。';
            return;
        }
        if (!bounds) {
            hint.textContent = '生年月と現在年月から、50年以内に選べる目標年齢がありません。';
            return;
        }
        const todayValue = localToday();
        const ruleFingerprint = JSON.stringify([source.assets.nisaCardRule, source.assets.nisaCardRuleHistory ?? []]);
        if (!cachedNisa || cachedNisa.records !== source.records || cachedNisa.rules !== ruleFingerprint)
            cachedNisa = { records: source.records, rules: ruleFingerprint, rows: matchingNisaRows(source.assets, source.records) };
        const nisaRows = cachedNisa.rows;
        const suggested = suggestedNisaMonthly(source.assets, source.records, todayValue, nisaRows);
        const { cash: cashMonthly, nisa: nisaBase } = currentSavingMonthly(source.assets, todayValue, suggested.amount);
        if (!scenarioCashEdited)
            saving.value = String(Math.ceil((cashMonthly + 5000) / 5000) * 5000);
        if (!scenarioNisaEdited)
            nisaScenarioInput.value = String(Math.ceil((nisaBase + 5000) / 5000) * 5000);
        find('future-scenario-hint').textContent = `現在の月額目安：現金 ${yen(cashMonthly)} · NISA ${yen(nisaBase)}`;
        const todayPeriod = todayValue.slice(0, 7);
        const amount = moneyField(saving), scenarioNisaAmount = moneyField(nisaScenarioInput);
        const changesCash = compare && cashChoice.checked;
        const changesNisa = compare && nisaChoice.checked;
        const changeMonth = compare ? from.value : monthAfter(todayPeriod);
        if (!target.value || target.value < todayPeriod || !changeMonth || changeMonth < todayPeriod ||
            !Number.isFinite(Number(nisaRate.value)) ||
            (changesCash && amount === null) || (changesNisa && scenarioNisaAmount === null)) {
            hint.textContent = '年月と積立額を確認してください。';
            return;
        }
        try {
            const report = futureProjection(source.assets, source.records, {
                today: todayValue, targetMonth: target.value, changeMonth, savingsRuleId: null,
                savingsAmount: amount ?? 0, nisaMonthly: suggested.amount, nisaAnnualReturn: Number(nisaRate.value) / 100,
                cashScenarioMonthly: changesCash ? amount : null,
                nisaScenarioMonthly: changesNisa ? scenarioNisaAmount : null,
            }, nisaRows);
            hint.textContent = '';
            const totals = el('div', `future-totals${compare ? ' is-comparing' : ''}`);
            totals.append(makeMetric('合計', report.target.combined, 'base', compare ? '現在の積立ペース' : ''));
            if (compare)
                totals.append(makeMetric('変更後の合計', report.target.combinedScenario, 'scenario', `${dateTitle(from.value)}から`));
            results.append(totals);
            const breakdown = el('div', 'future-breakdown');
            breakdown.append(makeMetric('現金貯金', report.target.cash, 'cash', changesCash ? `変更後 ${short(report.target.cashScenario)}` : undefined));
            breakdown.append(makeMetric('NISA', report.target.nisa, 'nisa', changesNisa ? `変更後 ${short(report.target.nisaScenario)}` : undefined));
            results.append(breakdown);
            if (report.oneTimeOverlapStartingBalance)
                results.append(el('p', 'future-warning', '単発入出金と定期予定の重複候補を含む開始残高による参考値です。'));
            if (report.overdueStartingBalance)
                results.append(el('p', 'future-warning', '期限経過・未確認の入出金を除いた開始残高による参考値です。'));
            if (report.conflictingNisaSources)
                results.append(el('p', 'future-warning', 'NISAの積立設定が重複している可能性があります。開始残高・将来予測は参考値です。'));
            if (report.cashStart === null || report.nisaStart === null)
                results.append(el('p', 'future-warning', '口座管理で現在の残高を登録してください。'));
            const graph = el('div', 'future-chart');
            const repaint = () => drawChart(graph, report.points, birthMonth, compare, chartFilter, chosenMonth, next => { chartFilter = next; repaint(); }, month => { chosenMonth = month; });
            if (!compare && chartFilter === 'combinedScenario')
                chartFilter = 'all';
            repaint();
            results.append(graph);
            const tableWrap = el('div', 'future-table-scroll');
            const table = document.createElement('table');
            table.className = 'future-table';
            const thead = document.createElement('thead');
            const tr = document.createElement('tr');
            const columns = compare ? ['年月', '現金貯金', 'NISA', '合計', '変更後の合計'] : ['年月', '現金貯金', 'NISA', '合計'];
            for (const label of columns)
                tr.append(el('th', '', label));
            thead.append(tr);
            table.append(thead);
            const tbody = document.createElement('tbody');
            const selected = report.points.filter((p, i) => i === 0 || i === report.points.length - 1 || p.month.endsWith('-12'));
            for (const point of selected) {
                const row = document.createElement('tr');
                const vals = compare ? [dateTitle(point.month) + ageText(point.month, birthMonth), yen(point.cash), yen(point.nisa), yen(point.combined), yen(point.combinedScenario)]
                    : [dateTitle(point.month) + ageText(point.month, birthMonth), yen(point.cash), yen(point.nisa), yen(point.combined)];
                for (const value of vals)
                    row.append(el('td', '', value));
                tbody.append(row);
            }
            table.append(tbody);
            tableWrap.append(table);
            const annual = el('details', 'future-annual-list');
            annual.open = yearListOpen;
            annual.append(el('summary', '', '年別一覧'), tableWrap);
            annual.addEventListener('toggle', () => { if (annual.isConnected)
                yearListOpen = annual.open; });
            results.append(annual);
        }
        catch (error) {
            hint.textContent = error instanceof Error ? error.message : '将来予測を計算できませんでした。';
        }
    }
    const reset = () => {
        if (renderTimer !== null) {
            clearTimeout(renderTimer);
            renderTimer = null;
        }
        cachedNisa = null;
        lastBirthMonth = null;
        age.disabled = true;
        birthSettings.hidden = false;
        target.value = incrementYearMonth(localToday().slice(0, 7), 18);
        from.value = monthAfter(localToday().slice(0, 7));
        saving.value = '20000';
        nisaScenarioInput.value = '20000';
        scenarioCashEdited = false;
        scenarioNisaEdited = false;
        results.replaceChildren();
        hint.textContent = '保管庫を解除してください。';
        find('future-scenario-hint').textContent = '';
        find('future-age-value').textContent = '—';
        find('future-target-label').textContent = '';
        compare = false;
        chartFilter = 'all';
        chosenMonth = null;
        yearListOpen = false;
        scenarioAccordion.open = false;
        scenarioPanel.hidden = true;
        cashChoice.checked = true;
        nisaChoice.checked = false;
        updateScenarioControls();
    };
    return { render, reset };
}
