import { DATA_STATUS, formatYen, formatPoints, formatRate, formatRateList } from './formatters.js';
/** No statement is evidence of zero usage only after explicit confirmation. */
export function pointCoverage(reports) {
    return reports.some(report => report.cardLines.length > 0) ? 'registered' : reports.length > 0 && reports.every(report => report.cardNoUseConfirmed) ? 'no-use' : 'missing';
}
export function archivedPointCoverage(snapshot) {
    return snapshot.cards.length ? 'registered' : snapshot.cardOutflow === 0 ? 'no-use' : 'missing';
}
export function pointBenefitsSection(title, data, coverage) {
    const section = document.createElement('section');
    section.className = 'panel points-benefits';
    const heading = document.createElement('div');
    heading.className = 'points-benefits-heading';
    const name = document.createElement('h2');
    name.textContent = title;
    const total = document.createElement('strong');
    total.textContent = coverage === 'missing' ? `明細${DATA_STATUS.missing}` : formatPoints(data.total);
    heading.append(name, total);
    section.append(heading);
    if (coverage === 'missing') {
        section.classList.add('points-benefits-compact', 'points-benefits-missing');
        return section;
    }
    const list = document.createElement('div');
    list.className = 'points-benefits-list';
    if (!data.cards.length) {
        const empty = document.createElement('p');
        empty.className = 'points-benefits-empty';
        empty.textContent = coverage === 'no-use' ? '利用なし確認済み' : '算出対象の明細なし';
        list.append(empty);
    }
    for (const item of data.cards) {
        const row = document.createElement('div');
        row.className = 'points-benefits-row';
        const name = document.createElement('span');
        name.textContent = item.name;
        const detail = document.createElement('small');
        detail.textContent = `${formatYen(item.amount)} · ${item.rateLabel ? formatRateList(item.rateLabel) : formatRate(item.ratePercent)}`;
        const left = document.createElement('div');
        left.className = 'points-benefits-card';
        left.append(name, detail);
        const points = document.createElement('strong');
        points.textContent = formatPoints(item.points);
        row.append(left, points);
        list.append(row);
    }
    section.append(list);
    if (coverage === 'registered') {
        const caption = document.createElement('p');
        caption.className = 'points-benefits-empty';
        caption.textContent = '登録済み明細分';
        section.append(caption);
    }
    return section;
}
