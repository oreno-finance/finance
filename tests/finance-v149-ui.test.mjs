import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const html=readFileSync(new URL('public/index.html',root),'utf8');
const main=readFileSync(new URL('src/main.ts',root),'utf8');
const monthly=readFileSync(new URL('src/ui/monthly-summary.ts',root),'utf8');
const css=readFileSync(new URL('public/styles/layout-v149.css',root),'utf8');
const sidebar=html.slice(html.indexOf('<aside id="finance-sidebar" class="sidebar">'),html.indexOf('</aside>'));

test('sidebar exposes both statement routes directly, with settings and Payroll at bottom',()=>{
  assert.doesNotMatch(sidebar,/id="nav-statements-group"/);
  assert.match(sidebar,/id="mobile-nav-toggle"/);
  for(const name of ['nav-import','nav-manage'])assert.equal(sidebar.split(`id="${name}"`).length-1,1);
  assert.ok(sidebar.indexOf('id="nav-import"')<sidebar.indexOf('id="nav-manage"'));
  assert.match(sidebar,/id="nav-manage"[^>]*>[\s\S]*?<span class="nav-text">明細管理<\/span><\/button>/);
  assert.match(sidebar,/id="nav-rules"[^>]*>[\s\S]*?<span class="nav-text">ルール<\/span><\/button>/);
  const bottom=sidebar.slice(sidebar.indexOf('class="sidebar-bottom-actions"'),sidebar.indexOf('class="sidebar-footer"'));
  assert.match(bottom,/id="nav-settings"/);
  assert.match(bottom,/id="nav-payroll"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(css,/\.sidebar \.sidebar-bottom-actions\{[^}]*margin-top:auto/);
});

test('management pager navigates by a whole calendar month without rewriting imported statements',()=>{
  for(const id of ['manage-prev-month','manage-next-month','manage-period','manage-current-month','manage-show-all']){
    assert.equal(html.split(`id="${id}"`).length-1,1,id);
  }
  assert.doesNotMatch(html,/id="manage-filter-(year|month)"/);
  assert.match(main,/function manageShiftMonth\(offset:number\)/);
  assert.match(main,/new Date\(Date\.UTC\(year,month-1\+offset,1\)\)/);
  assert.match(main,/return managerIndices\(context\)/);
});

test('aliases have explicit add and remove controls, not a separator convention',()=>{
  assert.match(html,/<input id="rule-pattern" type="text"/);
  assert.match(html,/id="rule-pattern-alternatives"/);
  assert.match(html,/id="rule-pattern-add"/);
  assert.doesNotMatch(html,/<textarea id="rule-pattern"/);
  assert.match(main,/function renderRulePatternAlternatives/);
  assert.match(main,/rulePatternInputs\(\)\.map\(input=>input\.value\)/);
  assert.match(main,/patterns\.slice\(1\)/);
});

test('salary estimate displays a short source label instead of a paragraph',()=>{
  assert.match(monthly,/本業 · 給与見込み（\$\{estimate\.sourcePeriod\.slice\(5\)\}月実績）/);
  assert.doesNotMatch(monthly,/前月の手取りをそのまま利用（内訳不足）/);
  assert.doesNotMatch(monthly,/見込みは前回の通常給与を参考にした額です。/);
});

test('merchant rows remain one-line editable with secondary original and rule details',()=>{
  assert.match(main,/manage-merchant-control manage-merchant-quiet/);
  assert.match(main,/manage-merchant-main/);
  assert.match(main,/manage-merchant-secondary/);
  assert.match(main,/原文：\$\{row\.merchant\}/);
  assert.match(main,/s\.rows\.splice\(index, 1\)/);
  assert.match(css,/@media\(max-width:800px\)/);
});
