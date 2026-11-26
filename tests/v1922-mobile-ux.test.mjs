import {shippedSheet} from './helpers/css-loading.mjs';
import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');
const main=read('src/main.ts'), html=read('public/index.html');
const css=read('public/styles/mobile-finish-v1922.css');

test('startup always opens Home, including when OneDrive is unavailable',()=>{
  assert.match(main,/\bshowView\('home'\);\s*void refreshVaultControls\(\);\s*render\(\);/);
  const startup=main.split('async function startCloud()')[1].split('async function refreshCloud()')[0];
  assert.doesNotMatch(startup,/showView\('settings'\)/);
  assert.doesNotMatch(main,/showView\(lastView/);
});
test('unlock hides modal while loading and returns it on failure without replacing promise',()=>{
  assert.match(main,/if\(confirmationPending\(\)\|\|currentModal!==null\|\|\$<HTMLDialogElement>\('vault-dialog'\)\.open\)return Promise\.resolve\(false\)/);
  assert.match(main,/if\(vaultDialog\.open\)vaultDialog\.close\(\);\s*showActivity\('OneDriveの保管庫を開いています…','working'\);\s*try \{/);
  assert.match(main,/if\(currentModal===mode&&!vaultDialog\.open\)\{vaultDialog\.showModal\(\);/);
  assert.match(main,/modalClose\(true\);/);
  assert.match(main,/if\(cloudStartupRunning&&!fromStartup\)return Promise\.resolve\(false\)/);
  assert.match(main,/if\(!restored\)\{updateCloudStatus\(\);await askVault\('unlock',true\);\}/);
});
test('mobile menu uses remaining viewport, not 78% or fixed 680px',()=>{
  assert.match(css,/max-height:max\(0px,calc\(100dvh - var\(--finance-mobile-header-height,64px\)/);
  assert.match(main,/sidebar\.getBoundingClientRect\(\)\.height/);
  assert.match(css,/overflow-y:auto!important;overscroll-behavior:contain/);
  assert.doesNotMatch(css,/78dvh|680px/);
});
test('phone menu does not display desktop pin toggle',()=>{
  assert.match(css,/#finance-sidebar \.mobile-nav-panel #sidebar-collapse-toggle\{display:none!important\}/);
  assert.match(html,/id="sidebar-collapse-toggle"/);
});
test('home points share compact cards and right-aligned totals',()=>{
  assert.match(css,/#home-view \.points-benefits\{padding:18px 18px 14px/);
  assert.match(css,/#home-view \.points-benefits-list\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css,/#home-view \.points-benefits-row\{padding:12px 13px\}/);
});
test('analysis money stays on one line within horizontal-scrolling table',()=>{
  assert.match(css,/\.analysis-detail-table\{width:max-content;min-width:100%\}/);
  assert.match(css,/\.analysis-detail-table \.analysis-number \.analysis-link\{display:inline-block\}/);
  assert.match(css,/white-space:nowrap;word-break:normal;overflow-wrap:normal/);
});
test('dark mobile CSV/PDF button and monthly report quality warning are low-glare',()=>{
  assert.doesNotMatch(css,/#pdf-pane \.dropzone/);
  assert.match(read('public/styles/mobile-v151.css'),/background:var\(--finance-action-fill\)!important/);
  assert.match(read('public/styles/style.css'),/:root\[data-theme="dark"\]\{--finance-action-fill:#347f72/);
  assert.match(css,/:root\[data-theme="dark"\] \.reports-quality\{/);
  assert.match(css,/background:#3a3229/);
});
test('new presentation overrides are last and copied into production',()=>{
  assert.ok(styleOrder.indexOf("navigation-polish-v1916.css") < styleOrder.indexOf("mobile-finish-v1922.css"));
  assert.match(html,/href="\.\/styles\/app\.css"/);
  assert.equal(read('public/styles/mobile-finish-v1922.css'),shippedSheet('mobile-finish-v1922.css'));
  assert.equal(read('public/index.html'),read('dist/index.html'));
});
