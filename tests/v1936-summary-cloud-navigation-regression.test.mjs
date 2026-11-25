import {shippedSheet} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const src=read('src/main.ts'), compiled=read('dist/src/main.js');
const summary=read('src/ui/monthly-summary.ts');
const html=read('public/index.html');
const css=read('public/styles/style.css');
const monthlyCss=read('public/styles/monthly-summary.css');

function navigationHarness(rect={left:0,top:0,right:72,bottom:300}) {
  const classes=new Set(['nav-collapsed','nav-peeking']);
  const shell={classList:{
    contains:name=>classes.has(name),
    add:(...names)=>names.forEach(name=>classes.add(name)),
    remove:(...names)=>names.forEach(name=>classes.delete(name)),
    toggle:(name,yes)=>{if(yes)classes.add(name);else classes.delete(name);return yes;},
  }};
  const sidebar={getBoundingClientRect:()=>rect};
  const timers=new Map();let serial=0;
  const context={
    document:{querySelector:()=>shell,getElementById:()=>null},
    window:{innerHeight:900,matchMedia:()=>({matches:false}),setTimeout:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clearTimeout:id=>timers.delete(id)},
  };
  const start=compiled.indexOf('let desktopMenuPeekTimer = null;');
  const end=compiled.indexOf('/** Mobile disclosure uses one state',start);
  assert.ok(start>=0&&end>start);
  vm.runInNewContext(`${compiled.slice(start,end)}\nthis.nav={blockDesktopMenuHoverUntilExit,releaseDesktopMenuHoverOnMove,scheduleDesktopMenuPeek,clearDesktopMenuPeek};`,context);
  return {...context.nav,classes,timers,sidebar};
}

test('summary does not show redundant future-vs-actual disclaimer',()=>{
  assert.doesNotMatch(summary,/定期入出金は登録内容に基づく予定です。/);
  assert.match(summary,/if\(report\.recurringCardOverlap\)/); // retain genuine double-count warnings
});

test('points card has same gap as other monthly summary panels',()=>{
  assert.match(monthlyCss,/#monthly-content > \.points-benefits\{margin:0 0 17px\}/);
  assert.match(monthlyCss,/\.monthly-panel\{margin:0 0 17px/);
  assert.equal(shippedSheet('monthly-summary.css'),monthlyCss);
});

test('cloud connects and syncs in primary grid, account switching in its own group',()=>{
  const primary=html.match(/<div class="cloud-primary-actions"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  const account=html.match(/<div class="cloud-account-actions"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(primary&&account);
  for(const id of ['cloud-login','cloud-live-refresh','cloud-live-lock'])assert.match(primary,new RegExp(`id="${id}"`));
  for(const id of ['cloud-switch-account','cloud-logout']){
    assert.doesNotMatch(primary,new RegExp(`id="${id}"`));
    assert.match(account,new RegExp(`id="${id}"`));
  }
  assert.match(css,/\.cloud-primary-actions\{display:grid/);
  assert.match(css,/\.cloud-account-actions\{display:flex/);
  assert.match(css,/@container cloud-connection \(min-width:240px\)/);
  assert.match(css,/@container cloud-connection \(min-width:520px\)/);
  assert.doesNotMatch(css,/\.cloud-primary-actions #cloud-login\{grid-column/);
  assert.equal(read('dist/index.html'),html);
});

test('collapsed overlay geometry never shrinks the hover guard to the 72px rail',()=>{
  const n=navigationHarness();n.blockDesktopMenuHoverUntilExit(n.sidebar);
  n.clearDesktopMenuPeek();
  n.releaseDesktopMenuHoverOnMove(120,400); // outside 72px rail, inside original drawer
  n.scheduleDesktopMenuPeek();
  assert.equal([...n.timers.values()].filter(x=>x.ms===340).length,0);
  assert.equal(n.classes.has('nav-peeking'),false);
});

test('layout-induced pointer motion on the old menu cannot release hover suppression',()=>{
  const n=navigationHarness({left:0,top:250,right:244,bottom:260});
  n.blockDesktopMenuHoverUntilExit(n.sidebar);
  n.clearDesktopMenuPeek();
  n.releaseDesktopMenuHoverOnMove(60,600); // below the transient sidebar rect, inside viewport
  n.scheduleDesktopMenuPeek();
  assert.equal([...n.timers.values()].filter(x=>x.ms===340).length,0);
  n.releaseDesktopMenuHoverOnMove(250,600); // physical exit from expanded region
  n.scheduleDesktopMenuPeek();
  assert.equal([...n.timers.values()].filter(x=>x.ms===340).length,1);
});

test('navigation suppresses hover before retract, and pointerleave does not rearm',()=>{
  assert.match(src,/function showView\(view: FinanceView\): void \{[\s\S]*?blockDesktopMenuHoverUntilExit\(sidebar\);[\s\S]*?closeDesktopMenuPeek\(\)/);
  assert.doesNotMatch(src,/document\.documentElement\.addEventListener\('pointerleave'/);
  assert.match(src,/if\(desktopMenuNavigationHoverBlock\|\|!shell\?\.classList\.contains\('nav-collapsed'\)\)return;/);
  assert.match(src,/if\(desktopMenuNavigationHoverBlock\|\|event\.pointerType/);
});
