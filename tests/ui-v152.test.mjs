import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(new URL('../'+p, import.meta.url), 'utf8');
const html=read('public/index.html'), css=read('public/styles/ui-v152.css');
test('disclosure icons use separate SVG states without transforming the chevron',()=>{
  assert.match(css,/details > summary::after/);
  assert.match(css,/details\[open\] > summary::after/);
  assert.match(css,/transform:none!important;transition:none!important/);
  assert.match(css,/\.sidebar \.sidebar-group-chevron/);
});
test('mobile menu X uses its own static, unclipped path',()=>{
  assert.match(html,/class="mobile-nav-close" d="M6 6L18 18 M18 6L6 18"/);
  assert.match(css,/#mobile-nav-toggle svg\{overflow:visible!important\}/);
  assert.match(css,/#finance-sidebar\.mobile-open #mobile-nav-toggle \.mobile-nav-close\{opacity:1/);
});
test('main merchant input remains one line and multiple options remain',()=>{
  assert.match(css,/input#rule-pattern\{height:var\(--finance-action-height\)!important;min-height:var\(--finance-action-height\)!important/);
  assert.match(html,/id="rule-pattern-alternatives"/);
  assert.match(html,/id="rule-pattern-add"/);
  assert.match(css,/#rule-pattern-help\{padding:0!important/);
});
test('category draft form is before list and actions distinguish adding to the draft from final save',()=>{
  const modal=html.slice(html.indexOf('<dialog id="categories-dialog"'),html.indexOf('</dialog>',html.indexOf('<dialog id="categories-dialog"')));
  assert.ok(modal.indexOf('class="rules-category-create"')<modal.indexOf('id="rules-category-list"'));
  assert.match(modal,/id="rules-category-add"[^>]+>＋ 一覧に追加/);
  assert.match(modal,/id="categories-dialog-save"[^>]+>保存/);
  assert.equal((modal.match(/id="rules-category-add"/g)||[]).length,1);
});
