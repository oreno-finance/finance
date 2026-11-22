import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=name=>readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
const html=src('public/index.html');
const css=src('public/styles/navigation-polish-v1916.css');
const main=src('src/main.ts');

test('初期描画前に保存済み開閉設定を復元し、初期値は折りたたみ',()=>{
  const boot=src('public/scripts/nav-boot.js');
  assert.match(html,/<html lang="ja" class="finance-nav-boot-collapsed">/);
  assert.ok(html.indexOf('scripts/nav-boot.js')<html.indexOf('styles/app.css') && styleOrder.includes('navigation-polish-v1916.css'));
  assert.match(boot,/localStorage\.getItem\('finance-sidebar-collapsed'\) === '0'/);
  assert.match(main,/getItem\('finance-sidebar-collapsed'\)!=='0'/);
  assert.match(main,/setDesktopMenuCollapsed\(sidebarCollapsed\);\s*document\.documentElement\.classList\.remove\('finance-nav-boot-collapsed'\)/);
  assert.match(css,/html\.finance-nav-boot-collapsed[^\n]*#finance-sidebar\.sidebar/);
});

test('ホバー展開は340msで、収納時もワークスペース幅を変えない',()=>{
  assert.match(main,/desktopMenuPeekTimer=window\.setTimeout\([\s\S]*?},340\)/);
  assert.match(main,/wasPeeking&&!preserveManualTransition\)shell\?\.classList\.add\('nav-peek-resetting'\)/);
  assert.match(main,/else shell\?\.classList\.remove\('nav-peek-resetting'\)/);
  assert.match(css,/\.app-shell\.nav-collapsed\.nav-peeking #finance-sidebar\.sidebar\{[\s\S]*?position:sticky!important/);
  assert.match(css,/margin-right:-172px!important/);
  assert.match(css,/\.app-shell\.nav-collapsed\.nav-peeking \.workspace\{margin-left:0!important\}/);
  assert.match(css,/\.nav-peek-resetting #finance-sidebar\.sidebar\{transition:none!important\}/);
  assert.match(main,/if\(shell\?\.classList\.contains\('nav-peek-closing'\)\)return/);
});

test('開閉ボタンは他のナビゲーションと同じ下部領域に置く',()=>{
  const nav=html.slice(html.indexOf('class="sidebar-bottom-actions"'),html.indexOf('class="sidebar-footer"'));
  assert.match(nav,/id="nav-settings"[\s\S]*id="nav-payroll"[\s\S]*id="sidebar-collapse-toggle"/);
  assert.match(nav,/id="sidebar-collapse-toggle" class="nav-entry sidebar-collapse-toggle"/);
  assert.match(main,/sidebar-collapse-label/);
  assert.match(css,/\.sidebar-bottom-actions #sidebar-collapse-toggle\{[\s\S]*?position:static!important/);
});

test('Payrollの3カードには固定最小高さ・高さストレッチが残らない',()=>{
  assert.match(css,/\.assets-payroll-layout\{align-items:start!important\}/);
  assert.match(css,/\.assets-payroll-layout>form,\s*\.settings-view \.assets-payroll-layout>\.assets-payroll-history-card\{\s*min-height:0!important;height:auto!important/);
  for(const path of ['index.html','styles/navigation-polish-v1916.css','scripts/nav-boot.js']){
    assert.equal(src('public/'+path),src('dist/'+path),path);
  }
});
