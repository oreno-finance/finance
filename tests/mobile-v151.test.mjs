import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const html=readFileSync(new URL('public/index.html',root),'utf8');
const css=readFileSync(new URL('public/styles/mobile-v151.css',root),'utf8');
const script=readFileSync(new URL('src/main.ts',root),'utf8');

test('mobile: CSV/PDF picker is a single visible button while desktop keeps native drag/drop',()=>{
  assert.match(html,/id="dropzone"[^>]+for="file-input"/);
  assert.match(html,/class="drop-mobile-label">CSV・PDFを選択/);
  assert.match(html,/class="drop-desktop-label">CSV・PDFをここへドロップ/);
  assert.match(html,/id="file-input"[^>]+multiple/);
  assert.match(css,/\.drop-mobile-label\{display:none\}/);
  assert.match(css,/#pdf-pane \.dropzone \ .drop-mobile-label|#pdf-pane \.dropzone \.drop-mobile-label/);
  assert.match(css,/#pdf-pane \.dropzone[^}]*height:44px/);
});

test('mobile and desktop both offer explicit icon toggles without a system selector',()=>{
  assert.match(html,/id="mobile-theme-toggle"[^>]*aria-label="ダークモードに切り替える"/);
  assert.match(html,/id="desktop-theme-toggle"/);
  assert.doesNotMatch(html,/id="theme-mode"|<option value="system"/);
  assert.match(css,/#finance-sidebar \.mobile-nav-panel \.sidebar-theme\{display:none!important\}/);
  assert.match(script,/const toggles = \[document\.getElementById\('mobile-theme-toggle'\),document\.getElementById\('desktop-theme-toggle'\)\]/);
});

test('mobile: hamburger and X are only icons, without text replacement',()=>{
  assert.match(html,/id="mobile-nav-toggle"[^>]*aria-controls="mobile-nav-panel"/);
  assert.match(html,/class="mobile-nav-top"/);
  assert.match(html,/class="mobile-nav-middle"/);
  assert.match(html,/class="mobile-nav-bottom"/);
  assert.doesNotMatch(script,/textContent='☰ メニュー'|textContent=expanded\?'✕ 閉じる'/);
  assert.match(css,/#mobile-theme-toggle,#mobile-nav-toggle\{[^}]*border:0!important/);
});

test('mobile: menu is animated, keyboard dismissible and does not shift the page',()=>{
  assert.match(css,/position:absolute;[\s\S]*top:100%/);
  assert.match(css,/transition:max-height \.34s/);
  assert.match(css,/@media \(prefers-reduced-motion:reduce\)/);
  assert.match(script,/if\(panel\)panel\.inert=isMobile&&!expanded/);
  assert.match(script,/event\.key==='Escape'/);
  assert.match(script,/addEventListener\('pointerdown'/);
});

test('mobile: menu items retain standard 13px instead of 10/11px',()=>{
  assert.match(css,/\.mobile-nav-panel>\.nav-entry\{[^}]*font-size:13px!important/);
  assert.match(css,/\.sidebar-subnav>\.nav-entry\{[^}]*font-size:13px!important/);
  assert.match(css,/\.sidebar-bottom-actions>\.nav-entry\{[^}]*font-size:13px!important/);
});

test('mobile: no finance data model, encryption or salary rules are touched',()=>{
  assert.doesNotMatch(css,/@media \(min-width:/);
  assert.doesNotMatch(html,/id="nav-payroll"/);
  assert.match(styleOrder,/styles\/mobile-v151\.css/);
});
