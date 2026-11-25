import {shippedSheet} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const html=read('public/index.html');
const main=read('src/main.ts');
const css=read('public/styles/navigation-polish-v1916.css');

test('ロゴは通常展開・折りたたみ・ホバー・初期描画で同じ左余白',()=>{
  const stability=css.split('/* Finance v1.9.17:')[1];
  assert.ok(stability);
  for(const state of [
    'html.finance-nav-boot-collapsed .app-shell:not(.nav-collapsed) #finance-sidebar .brand',
    '.app-shell #finance-sidebar .brand',
    '.app-shell.nav-collapsed #finance-sidebar .brand',
    '.app-shell.nav-collapsed.nav-peeking #finance-sidebar .brand',
  ]) assert.ok(stability.includes(state),state);
  assert.match(stability,/padding-left:4px!important/);
});

test('開閉メニューの表示文字を短くし、ラベルが横幅を押し広げない',()=>{
  assert.match(html,/id="sidebar-collapse-label">折りたたむ<\/span>/);
  assert.match(main,/label\.textContent=collapsed\?'固定表示':'折りたたむ'/);
  // Keep accessible action names even though the visible label is abbreviated.
  assert.match(main,/button\.setAttribute\('aria-label',collapsed\?'メニューを固定表示する':'メニューを折りたたむ'\)/);
  assert.match(css,/#finance-sidebar #sidebar-collapse-label\{\s*flex:0 1 auto!important;min-width:0!important;max-width:100%!important;/);
  assert.match(css,/#finance-sidebar \.sidebar-bottom-actions #sidebar-collapse-toggle\{\s*overflow:hidden!important;/);
});

test('配布版のメニューとJavaScriptはソース版に一致する',()=>{
  for(const path of ['index.html','styles/navigation-polish-v1916.css','src/main.js']){
    const source=path==='src/main.js'?'dist/src/main.js':`public/${path}`;
    if(path==='src/main.js'){
      assert.match(read(source),/label\.textContent = collapsed \? ['"]固定表示['"] : ['"]折りたたむ['"]/);
    } else assert.equal(read(source),(path.endsWith('.css')?shippedSheet(path.split('/').pop()):read(`dist/${path}`)),path);
  }
});
