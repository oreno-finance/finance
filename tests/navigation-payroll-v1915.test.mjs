import {shippedSheet} from './helpers/css-loading.mjs';
import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {payrollPassphraseUpdate} from '../dist/src/ui/assets-settings.js';
const src=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const html=src('public/index.html'), main=src('src/main.ts'), payroll=src('src/ui/assets-settings.ts');
const css=src('public/styles/navigation-payroll-v1915.css');

test('明細インポートと明細管理は独立したトップレベルメニュー',()=>{
  const nav=html.slice(html.indexOf('id="mobile-nav-panel" class="mobile-nav-panel"'),html.indexOf('class="sidebar-bottom-actions"'));
  assert.doesNotMatch(nav,/<details|sidebar-subnav|id="nav-statements-group"/);
  assert.match(nav, /id="nav-home"[\s\S]*?id="nav-summary"[\s\S]*?id="nav-analysis"[\s\S]*?id="nav-import"[\s\S]*?id="nav-manage"/);
  for(const id of ['nav-import','nav-manage'])assert.equal((html.match(new RegExp(`id="${id}"`,'g'))||[]).length,1);
  assert.doesNotMatch(main,/getElementById\('nav-statements-group'\)/);
});

test('通常の折りたたみは幅をアニメーションさせ、ホバー時の画面遷移は閉じる演出を使う',()=>{
  assert.match(styleOrder,/styles\/navigation-payroll-v1915\.css/);
  assert.match(css,/transition:width 260ms/);
  assert.match(css,/#finance-sidebar #sidebar-collapse-toggle\{transition:none!important\}/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(main,/function showView\(view: FinanceView\): void \{[\s\S]*?if\(document\.querySelector\('\.app-shell\.nav-peeking'\)\)closeDesktopMenuPeek\(\)/);
  assert.match(src('public/styles/layout-v1911.css'),/finance-peek-close 190ms/);
});

test('Payroll連携はカードに保存されたパスフレーズで常時自動取得',()=>{
  assert.doesNotMatch(html,/id="assets-payroll-remember"|id="assets-payroll-auto-status"/);
  assert.doesNotMatch(payroll,/keepAuto|assets-payroll-remember|assets-payroll-auto-status/);
  assert.equal(payrollPassphraseUpdate('', 'EXISTING PASSWORD 2026'),undefined);
  assert.equal(payrollPassphraseUpdate('NEW PASSWORD 2027','EXISTING PASSWORD 2026'),'NEW PASSWORD 2027');
  assert.equal(payrollPassphraseUpdate('EXISTING PASSWORD 2026','EXISTING PASSWORD 2026'),undefined);
  assert.match(payroll,/if\(action!==undefined\)await vault\.setPayrollAutoPassphrase\(action\)/);
  assert.match(payroll,/if\(!vault\.assetSettings\(\)\.payrollAutoPassphrase\)return;/);
  assert.match(payroll,/window\.setInterval\(\(\)=>\{if\(!document\.hidden\)void refreshPayroll\(\);\},10\*60\*1000\)/);
  assert.match(html,/id="assets-payroll-forget"[^>]*>連携を解除<\/button>/);
});

test('Payroll同期状況は件数と最終同期だけ。未同期では0件と表示',()=>{
  const section=html.slice(html.indexOf('id="assets-payroll-summary"'),html.indexOf('</section>',html.indexOf('id="assets-payroll-summary"')));
  assert.match(section,/id="assets-payroll-count"/);
  assert.match(section,/id="assets-payroll-last"/);
  assert.doesNotMatch(section,/assets-payroll-months|取得履歴/);
  assert.doesNotMatch(payroll,/incomeByMonth|assets-payroll-months/);
  assert.match(payroll,/haveLast\?`\$\{payrollIncome\.length\}件`:'0件'/);
  assert.match(payroll,/payrollStale\?'（更新失敗・古いデータ）'/);
  assert.match(section,/class="settings-payroll-metrics"/);
  assert.doesNotMatch(section,/assets-payroll-history-card/);
});

test('公開用HTMLとCSSは編集元と一致する',()=>{
  for(const path of ['index.html','styles/navigation-payroll-v1915.css','styles/ui-v165.css'])
    assert.equal(src('public/'+path),(path.endsWith('.css')?shippedSheet(path.split('/').pop()):src('dist/'+path)));
});
