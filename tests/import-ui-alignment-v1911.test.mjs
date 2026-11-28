import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync('public/index.html','utf8');
const main=readFileSync('src/main.ts','utf8');
const css=readFileSync('public/styles/layout-v1911.css','utf8');

test('new UI refinements load after the existing layout styles',()=>{
  assert.ok(styleOrder.indexOf('layout-v1910.css') < styleOrder.indexOf('layout-v1911.css'));
  assert.match(css,/#import-view \.transactions-panel-inner\s*\{border-top:0\}/);
});

test('import merchant cells keep badges on the same one-line row',()=>{
  assert.match(main,/const merchantContent=div\('preview-merchant-content'\)/);
  assert.match(main,/merchantContent\.append\(categoryChip\(meta\.category\)\)/);
  assert.match(css,/preview-merchant-content\s*\{[\s\S]*?display:flex/);
  assert.match(css,/transaction-table tbody td\s*\{[\s\S]*?height:44px/);
});

test('Rakuten card choice uses selected full-card design with no redundant card heading',()=>{
  assert.match(html,/class="card-setting-choice"[^>]*><input type="radio" name="import-rakuten-card"/);
  assert.match(main,/\$\('card-display'\)\.classList\.toggle\('hidden',s\.provider==='rakuten'\|\|s\.provider==='smbc'&&s\.sourceKind!=='csv'\)/);
  assert.match(css,/import-rakuten-choice label\.card-setting-choice:has\(input:checked\)/);
});

test('management month/date are shown as facts and are no longer editable',()=>{
  assert.match(html,/<output id="manage-month"/);
  assert.match(html,/<output id="manage-payment"/);
  assert.doesNotMatch(html,/<input id="manage-(?:month|payment)"/);
  assert.doesNotMatch(main,/\$<HTMLInputElement>\('manage-(?:month|payment)'\)\.addEventListener/);
  assert.match(main,/\$\('manage-month'\)\.textContent/);
  assert.match(main,/\$\('manage-payment'\)\.textContent/);
});

test('theme icon alignment is preserved across expanded and collapsed desktop navigation',()=>{
  assert.match(css,/#finance-sidebar \.sidebar-theme\s*\{[\s\S]*?padding:0 1px!important/);
  assert.match(css,/#finance-sidebar \.desktop-theme-toggle\s*\{[\s\S]*?width:42px;height:42px/);
  assert.match(css, /\.app-shell\.nav-collapsed:not\(\.nav-peeking\) #finance-sidebar \.sidebar-theme/);
});

test('sidebar expand/collapse controls have no position or width transitions',()=>{
  assert.match(css,/#finance-sidebar #sidebar-collapse-toggle,[\s\S]*?transition:none!important/);
});
