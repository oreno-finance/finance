import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=(p)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('public/index.html');
const assets=read('src/ui/assets-settings.ts');
const summary=read('src/ui/monthly-summary.ts');
const future=read('src/ui/future-projection.ts');
const bankData=read('src/ui/bank-chart-data.ts');
const css=read('public/styles/ui-v153.css');
const main=read('src/main.ts');
test('three account cards share one details panel, not per-card footnotes',()=>{
  assert.match(html,/id="assets-account-info"/);
  assert.match(assets,/accountDetails\.set\(account\.id,detail\)/);
  assert.match(css,/assets-account-grid\{align-items:stretch!important\}/);
  assert.doesNotMatch(assets,/label\.append\(make\('small','assets-balance-hint'/);
});
test('bank account balances remain in accounts, while card debit mappings belong to card settings',()=>{
  assert.match(html,/id="assets-account-main"/);
  assert.doesNotMatch(html,/id="assets-card-debits-form"/);
  const cardSettings=read('src/ui/card-settings.ts');
  assert.match(cardSettings,/field\('引落口座',debit\)/);
  assert.match(cardSettings,/setCardConfiguration\(next,nextDebit\)/);
  assert.doesNotMatch(assets,/async function saveCardDebitAccounts/);
  assert.doesNotMatch(summary,/monthly-bank-mapping/);
  assert.doesNotMatch(main,/saveCardAccounts:async accounts/);
});
test('bank balance chart uses dated step positions and a baseline-aware first point',()=>{
  assert.match(summary,/function bankChart\(/);
  assert.match(bankData,/const openDate = timeline\.startDay > first/);
  assert.match(summary,/path\.push\(`H\$\{x\(point\.day\)/);
  assert.match(summary,/const chart=bankChart\(timeline,period\)/);
  assert.doesNotMatch(summary,/残高は同日の入出金を合算した日末時点の予測です/);
  assert.match(read('public/styles/bank-chart-v184.css'),/\.monthly-balance-svg\{[^}]*min-width:0/);
  assert.match(summary,/observeChartWidth\(svg,paint,630\)/);
});
test('projection defaults to cash + NISA + combined, scenario is optional',()=>{
  assert.match(html,/id="future-scenario-settings" hidden/);
  assert.match(html,/id="future-scenario-accordion"/);
  assert.match(future,/scenarioAccordion\.addEventListener\('toggle'/);
  assert.match(future,/\['cash','現金貯金','cash'\]/);
  assert.match(future,/\['nisa','NISA','nisa'\]/);
  assert.match(future,/\['combined','現金＋NISA','base'\]/);
  assert.match(future,/if\(compare\)totals\.append/);
});
test('merchant editor and sidebar are purposefully compact',()=>{
  assert.match(css,/\.manage-editor \.manage-merchant-main\{display:grid/);
  assert.match(css,/\.sidebar \.sidebar-subnav,.sidebar\.mobile-open \.sidebar-subnav\{border-left:0!important/);
  assert.doesNotMatch(html,/sidebar-group-chevron/);
});
