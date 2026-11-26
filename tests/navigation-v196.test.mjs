import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const html=readFileSync(new URL('public/index.html',root),'utf8');
const css=readFileSync(new URL('public/styles/layout-v196.css',root),'utf8');
const js=readFileSync(new URL('src/main.ts',root),'utf8');
test('sidebar supports desktop collapse, persistent accessibility labels, and distinct icons',()=>{
  assert.match(html,/id="sidebar-collapse-toggle"[^>]*aria-expanded="true"/);
  assert.match(js,/function setDesktopMenuCollapsed/);
  assert.match(css,/\.app-shell\.nav-collapsed/);
  assert.match(html,/id="sidebar-tooltip" class="sidebar-tooltip" role="tooltip"/);
  const ids=['home','import','manage','summary','analysis','subscriptions','reports','rules','assets','future','settings'];
  const icons=ids.map(id=>{
    const match=html.match(new RegExp(`id="nav-${id}"[^>]*>[\\s\\S]*?<span class="nav-symbol"[^>]*>([\\s\\S]*?)<\\/span>`));
    assert.ok(match,id);return match[1];
  });
  assert.equal(new Set(icons).size,icons.length);
  assert.match(css,/\.sidebar-subnav\{display:flex!important/);
});
test('only import page is switched to full-height document content scrolling',()=>{
  assert.match(css,/\.content:has\(#import-view:not\(\.hidden\)\)/);
  assert.match(css,/overflow-y:auto!important/);
  assert.doesNotMatch(css,/#manage-view:not\(\.hidden\).*?display:block!important/);
});
test('menu icons distinguish recurring payments, bank accounts, rules and settings with shared outline styling',()=>{
  const icon=id=>html.match(new RegExp(`id="nav-${id}"[^>]*>[\\s\\S]*?<svg([\\s\\S]*?)<\\/svg>`))[1];
  for(const id of ['home','summary','analysis','import','manage','subscriptions','assets','reports','future','rules','settings']){
    const svg=icon(id);
    for(const attr of ['viewBox="0 0 24 24"','width="20"','height="20"','fill="none"','stroke="currentColor"','stroke-width="1.85"','stroke-linecap="round"','stroke-linejoin="round"','aria-hidden="true"'])assert.ok(svg.includes(attr),`${id}: ${attr}`);
    assert.doesNotMatch(svg,/fill="(?:var\(|#|currentColor)/);
  }
  assert.match(icon('subscriptions'),/<circle cx="16\.5" cy="17\.5" r="4\.5"\/>/);
  assert.match(icon('assets'),/m3 10 9-6 9 6H3Z/);
  assert.match(icon('rules'),/M3 3h8l10 10/);
  assert.match(icon('settings'),/<circle cx="12" cy="12" r="3"\/>/);
  assert.equal(html,readFileSync(new URL('dist/index.html',root),'utf8'));
});
