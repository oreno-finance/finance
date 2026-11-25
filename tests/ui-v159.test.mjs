import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../'+file, import.meta.url),'utf8');
const html=read('public/index.html');
const css=read('public/styles/ui-v159.css');
const future=read('src/ui/future-projection.ts');
const assetUi=read('src/ui/assets-settings.ts');

test('forecast comparison offers independent cash/NISA checkboxes with optional simultaneous changes',()=>{
  assert.match(html, /id="future-compare-cash" type="checkbox" checked/);
  assert.match(html, /id="future-compare-nisa" type="checkbox"/);
  assert.doesNotMatch(html, /name="future-compare-type"/);
  assert.doesNotMatch(html, /<legend>変更する積立<\/legend>/);
  assert.match(future,/const changesCash=compare&&cashChoice\.checked/);
  assert.match(future,/const changesNisa=compare&&nisaChoice\.checked/);
  assert.match(future,/if\(!cashChoice\.checked&&!nisaChoice\.checked\)choice\.checked=true/);
  assert.match(future,/cashScenarioMonthly:changesCash\?amount:null/);
  assert.match(future,/nisaScenarioMonthly:changesNisa\?scenarioNisaAmount:null/);
});
test('forecast keeps annual return control, but derives baseline NISA from recorded data',()=>{
  assert.doesNotMatch(html,/id="future-nisa-monthly"/);
  assert.match(html,/id="future-nisa-rate"/);
  assert.match(css,/#future-scenario-accordion>summary::after/);
  assert.match(future,/suggestedNisaMonthly\(source.assets,source.records,todayValue,nisaRows\)/);
  assert.match(future,/nisaMonthly:suggested.amount/);
});
test('NISA linkage stays in settings and card debit mapping moves into card settings form',()=>{
  assert.doesNotMatch(html,/id="assets-card-debits-form"/);
  assert.doesNotMatch(html,/id="assets-card-links"/);
  const settings=html.slice(html.indexOf('id="settings-nisa-panel"'),html.indexOf('class="panel assets-payroll-panel"'));
  assert.match(settings,/id="assets-nisa-link-form"/);
  assert.match(settings,/id="assets-birth-form"/);
  assert.match(settings,/id="settings-card-form"/);
  assert.match(settings,/id="assets-nisa-save"/);
  assert.match(settings,/id="assets-birth-save"/);
  assert.match(css,/\.assets-links-panel:not\(\[open\]\)>\.assets-links-grid\{display:none!important\}/);
});
test('Mizuho prediction closed in details yet its form and controls remain available',()=>{
  assert.match(html, /<details class="panel mizuho-plan-panel" id="mizuho-plan-panel">/);
  assert.match(html, /<summary id="mizuho-plan-title">みずほ銀行への送金予測<\/summary>/);
  assert.match(html, /id="mizuho-plan-form"/);
  assert.match(css,/#mizuho-plan-panel:not\(\[open\]\)>form\{display:none!important\}/);
});
test('recurring form shows amount and bank routes in same responsive row, expenses use fixed costs',()=>{
  const section=html.slice(html.indexOf('<div class="recurring-account-row">'),html.indexOf('<div class="recurring-schedule-row">'));
  assert.ok(section.includes('id="assets-recurring-amount"'));
  assert.ok(section.includes('id="assets-recurring-from"'));
  assert.ok(section.includes('id="assets-recurring-to"'));
  assert.ok(!section.includes('id="assets-recurring-category"'));
  assert.match(html, /id="assets-fixed-cost-list"/);
  assert.match(css,/\.recurring-account-row\{display:grid!important;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});
test('one-time modal confirms changed drafts on close and freezes background scroll',()=>{
  assert.doesNotMatch(assetUi, /入力途中の変更を破棄しますか/);
  assert.match(assetUi, /onceDialog\.addEventListener\('close',unlockOncePage\)/);
  assert.match(assetUi, /onceDialog\.showModal\(\);\s*lockOncePage\(\)/);
  assert.match(assetUi, /async function closeOnce\(\):Promise<void> \{[\s\S]*?if\(onceHasChanges\(\)\)\{[\s\S]*?await requestConfirmation/);
  assert.match(css, /html\.assets-once-page-locked,html\.assets-once-page-locked body\{overflow:hidden!important/);
  assert.match(read('public/styles/cloud-gate-v1980.css'), /body dialog \.finance-modal-x\{/);
  assert.doesNotMatch(css, /#categories-dialog-close,#recent-merchants-close/);
});
