import {shippedSheet} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const script=read('dist/src/main.js');
const source=read('src/main.ts');
const css=read('public/styles/navigation-payroll-v1915.css');
const combined=read('public/styles/app.css');

function navHarness(initial=['nav-collapsed','nav-peeking']) {
  const names=new Set(initial);
  const classList={
    contains:name=>names.has(name),
    add:(...values)=>values.forEach(value=>names.add(value)),
    remove:(...values)=>values.forEach(value=>names.delete(value)),
    toggle:(name,enabled)=>{
      if(enabled)names.add(name);else names.delete(name);
      return enabled;
    },
  };
  const shell={classList};
  const button={setAttribute(){},title:''};
  const label={textContent:''};
  const timeouts=new Map();
  let nextTimeout=0;
  const context={
    document:{
      querySelector(selector){assert.equal(selector,'.app-shell');return shell;},
      getElementById(id){return id==='sidebar-collapse-toggle'?button:id==='sidebar-collapse-label'?label:null;},
    },
    window:{
      clearTimeout(id){timeouts.delete(id);},
      setTimeout(callback,ms){timeouts.set(++nextTimeout,{callback,ms});return nextTimeout;},
      localStorage:{setItem(){}},
    },
  };
  const from=script.indexOf('let desktopMenuPeekTimer = null;');
  const to=script.indexOf('/** Only mouse hover',from);
  assert.ok(from>=0&&to>from,'Compiled menu functions are present');
  vm.runInNewContext(`${script.slice(from,to)}\nthis.actions={clearDesktopMenuPeek,setDesktopMenuCollapsed};`,context);
  return {names,timeouts,...context.actions};
}

test('pinning an open hover preview does not leave the transition suppression active',()=>{
  const menu=navHarness();
  menu.setDesktopMenuCollapsed(false);
  assert.equal(menu.names.has('nav-peeking'),false);
  assert.equal(menu.names.has('nav-collapsed'),false);
  assert.equal(menu.names.has('nav-peek-resetting'),false);
  assert.equal(menu.timeouts.size,0);
});

test('manual toggle during the hover reset window cancels the suppression timer',()=>{
  const menu=navHarness();
  menu.clearDesktopMenuPeek();
  assert.equal(menu.names.has('nav-peek-resetting'),true);
  assert.equal(menu.timeouts.size,1);
  menu.setDesktopMenuCollapsed(false);
  assert.equal(menu.names.has('nav-peek-resetting'),false);
  assert.equal(menu.timeouts.size,0);
});

test('hover-only close keeps its no-transition cleanup when not manually toggled',()=>{
  const menu=navHarness();
  menu.clearDesktopMenuPeek();
  assert.equal(menu.names.has('nav-collapsed'),true);
  assert.equal(menu.names.has('nav-peek-resetting'),true);
  const {callback,ms}=[...menu.timeouts.values()][0];
  assert.equal(ms,40);
  callback();
  assert.equal(menu.names.has('nav-peek-resetting'),false);
});

test('normal expand and hover-to-pin animate distinct layout properties with reduced-motion support',()=>{
  assert.match(source,/function setDesktopMenuCollapsed\(collapsed:boolean\):void \{[\s\S]*?clearDesktopMenuPeek\(true\)/);
  assert.match(css,/transition:width 260ms[\s\S]*?margin-right 260ms/);
  assert.match(combined,/margin-right 260ms cubic-bezier\(\.22,1,\.36,1\)/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.equal(shippedSheet('navigation-payroll-v1915.css'),css);
  assert.equal(read('dist/styles/app.css'),combined);
});
