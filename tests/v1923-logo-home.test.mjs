import {shippedSheet} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=(path)=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const html=read('public/index.html');
const main=read('src/main.ts');
const css=read('public/styles/mobile-finish-v1922.css');

test('Finance brand is a keyboard-accessible Home button on both desktop and mobile',()=>{
  assert.match(html,/<button id="brand-home" class="brand" type="button" aria-label="ホームへ戻る"/);
  assert.match(html,/id="brand-home"[^>]*data-nav-label="ホームへ戻る"/);
  assert.match(html,/<span class="brand-mark" aria-hidden="true">F<span>\.<\/span><\/span>/);
  assert.doesNotMatch(html,/<div class="brand">/);
});
test('brand navigates through existing Home router without reload',()=>{
  assert.match(main, /\$\('brand-home'\)\.addEventListener\('click',\(\)=>showView\('home'\)\)/);
  assert.match(main, /function showView\(view: FinanceView\): void/);
  assert.doesNotMatch(main, /\$\('brand-home'\)\.addEventListener\('click',[^\n]*(?:location|reload)/);
});
test('wordmark remains aligned, dark-mode-safe and keyboard focusable',()=>{
  assert.match(css, /#finance-sidebar #brand-home\{[\s\S]*?appearance:none;border:0;background:transparent/);
  assert.match(css, /#finance-sidebar #brand-home:focus-visible/);
  assert.doesNotMatch(css, /#finance-sidebar #brand-home\{[^}]*?(?:width:|padding-left:|position:)/);
  assert.equal(html,read('dist/index.html'));
  assert.equal(css,shippedSheet('mobile-finish-v1922.css'));
});
