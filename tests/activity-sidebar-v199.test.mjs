import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {showActivity,finishActivity,simpleActivity} from '../dist/src/ui/activity-feedback.js';
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('sidebar text is a single nowrap layer and all icons keep a fixed horizontal rail',()=>{
 const html=read('public/index.html'),css=read('public/styles/layout-v196.css');
 for(const id of ['home','import','manage','summary','analysis','subscriptions','reports','rules','assets','future','settings','payroll']){
  const tag=html.match(new RegExp(`id="nav-${id}"[^>]*>[\\s\\S]*?<span class="nav-text">([^<]+)</span>`));
  assert.ok(tag,`the ${id} label must be wrapped independently of its SVG`);
 }
 assert.match(css,/#finance-sidebar \.nav-text\{[^}]*white-space:nowrap/);
 assert.match(css,/#finance-sidebar :is\(\.nav-entry,\.sidebar-group>summary\)\{[^}]*width:220px!important/);
 assert.match(css,/#finance-sidebar \.nav-symbol\{[^}]*flex:0 0 20px/);
 assert.match(css,/transition:width 320ms/);
 assert.match(css,/#finance-sidebar #sidebar-collapse-toggle\{position:absolute;top:23px/);
 assert.match(css,/\.app-shell\.nav-collapsed #finance-sidebar #sidebar-collapse-toggle\{top:69px/);
 assert.match(css,/#finance-sidebar\.sidebar\{[^}]*overflow:clip/);
 assert.match(html,/id="sidebar-tooltip" class="sidebar-tooltip"/);
});

test('only the floating bottom-right card owns global save and loading feedback',()=>{
 const html=read('public/index.html'),css=read('public/styles/activity-v199.css');
 const main=read('src/main.ts'),cards=read('src/ui/card-settings.ts');
 const assets=read('src/ui/assets-settings.ts'),cloud=read('src/cloud/cloud-settings.ts');
 const reports=read('src/ui/monthly-reports.ts'),subs=read('src/ui/subscriptions.ts');
 assert.match(html,/id="toast" class="toast activity-toast" role="status"/);
 assert.match(css,/#cloud-live-bar,#operation-result \{display:none!important\}/);
 assert.match(css,/right:22px!important;bottom:calc\(16px \+ env\(safe-area-inset-bottom,0px\)\)!important;top:auto!important/);
 assert.match(css,/translateX\(24px\)/);
 assert.match(css,/prefers-reduced-motion:reduce/);
 assert.match(main,/operationResult\([^)]*[\s\S]*?showActivity\(message,kind\)/);
 assert.match(main,/showActivity\('明細を読み込み中…','working'\)/);
 assert.match(cards,/showActivity\('カード設定を保存中…','working'\)/);
 assert.match(assets,/simpleActivity\(message,error\)/);
 assert.match(cloud,/if\(text\)simpleActivity\(text,kind==='error'\)/);
 assert.match(reports,/showActivity\('月次レポートを保存中…','working'\)/);
  assert.match(subs,/showActivity\('固定費の設定をOneDriveに保存中…','working'\)/);
});

test('feedback state changes do not show fake success and unrelated completion does not hide a task',()=>{
 let label={textContent:''};
 const props=new Map();
 let panel={dataset:{},classList:{values:new Set(),add(k){this.values.add(k)},remove(k){this.values.delete(k)},contains(k){return this.values.has(k)}},querySelector(sel){return sel==='.activity-message'?label:null},setAttribute(k,v){props.set(k,v)}};
 const previous=globalThis.document;
 globalThis.document={getElementById(id){return id==='toast'?panel:null}};
 try{
  showActivity('OneDriveの読み込み中…','working');
  assert.equal(panel.dataset.kind,'working');
  assert.equal(panel.classList.contains('visible'),true);
  finishActivity('月次レポート');
  assert.equal(panel.classList.contains('visible'),true,'unrelated completion must not hide OneDrive loading');
  finishActivity('OneDrive');
  assert.equal(panel.classList.contains('visible'),false);
  showActivity('明細の保存に失敗しました。','bad');
  assert.equal(panel.dataset.kind,'bad');
  assert.equal(props.get('role'),'alert');
  simpleActivity('カード設定を保存中…');
  assert.equal(panel.dataset.kind,'working');
  simpleActivity('カード設定を保存しました。');
  assert.equal(panel.dataset.kind,'good');
  assert.equal(props.get('role'),'status');
 }finally{globalThis.document=previous;}
});
