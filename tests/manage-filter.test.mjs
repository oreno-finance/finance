import test from 'node:test';
import assert from 'node:assert/strict';
import { availableYears, availableMonths, filteredStatementIndices } from '../dist/src/ui/manage-filter.js';

const statements = [
  {billingMonth:'2025-12', label:'A'},
  {billingMonth:'2026-01', label:'B'},
  {billingMonth:'2026-11', label:'C'},
  {billingMonth:'2025-04', label:'D'},
  {billingMonth:'2026-11', label:'E'},
  {billingMonth:null, label:'unknown'},
];

test('管理画面: 年・月の候補は実際に存在する請求月から生成する', () => {
  assert.deepEqual(availableYears(statements), ['2026','2025']);
  assert.deepEqual(availableMonths(statements, '2026'), ['11','01']);
  assert.deepEqual(availableMonths(statements, '2025'), ['12','04']);
});

test('管理画面: 年ごとのフィルターは明細を編集・統合せず元配列のindexを返す', () => {
  assert.deepEqual(filteredStatementIndices(statements, '2026', 'all'), [2,4,1]);
  assert.deepEqual(filteredStatementIndices(statements, '2026', '11'), [2,4]);
  assert.deepEqual(filteredStatementIndices(statements, '2025', '04'), [3]);
  assert.deepEqual(filteredStatementIndices(statements, 'all', '11'), [2,4]);
  assert.deepEqual(filteredStatementIndices(statements, '2025', '01'), []);
  assert.deepEqual(statements.map(s=>s.label), ['A','B','C','D','E','unknown']);
});

test('管理画面: 全年・全月なら年月未取得も含めて個別表示する', () => {
  assert.deepEqual(filteredStatementIndices(statements, 'all','all'), [2,4,1,0,3,5]);
});

test('管理画面: 取込画面と共通カード部品を使用しSTEP表記は取込だけに残す', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(html, /id="manage-prev-month"/);
  assert.match(html, /id="manage-period"/);
  assert.match(html, /STEP 01[\s\S]*STEP 02[\s\S]*STEP 03/);
  assert.doesNotMatch(html.slice(html.indexOf('id="manage-view"')), /STEP 0[1-9]/);
  assert.doesNotMatch(html, /id="manage-back"/);
  assert.match(js, /function createStatementEntry/);
  assert.match(js, /managerList\.append\(createStatementEntry\(index, false\)\)/);
  assert.match(js, /list\.append\(createStatementEntry\(index, true\)\)/);
  assert.doesNotMatch(html, /id="manage-total"/);
});
