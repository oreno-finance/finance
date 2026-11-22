import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const script=read('dist/src/main.js');
const source=read('src/main.ts');
const style=read('public/styles/style.css');
const bundled=read('public/styles/app.css');
const html=read('public/index.html');

function createHarness(initial=['nav-collapsed','nav-peeking']) {
  const classes=new Set(initial);
  const shell={classList:{
    contains:name=>classes.has(name),
    add:(...args)=>args.forEach(x=>classes.add(x)),
    remove:(...args)=>args.forEach(x=>classes.delete(x)),
    toggle:(name,on)=>{if(on)classes.add(name);else classes.delete(name);return on;},
  }};
  const sidebar={getBoundingClientRect:()=>({left:0,top:0,right:244,bottom:800})};
  const timers=new Map();let serial=0;
  const context={
    document:{
      querySelector(selector){assert.equal(selector,'.app-shell');return shell;},
      getElementById(id){return id==='finance-sidebar'?sidebar:id==='sidebar-collapse-toggle'?{setAttribute(){},title:''}:id==='sidebar-collapse-label'?{textContent:''}:null;},
    },
    window:{
      innerHeight:800,
      matchMedia:()=>({matches:false}),
      setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},
      clearTimeout:id=>timers.delete(id),
      localStorage:{setItem(){}},
    },
  };
  const from=script.indexOf('let desktopMenuPeekTimer = null;');
  const to=script.indexOf('/** Mobile disclosure uses one state',from);
  assert.ok(from>=0&&to>from,'Compiled sidebar handlers are present');
  vm.runInNewContext(`${script.slice(from,to)}\nthis.menu={blockDesktopMenuHoverUntilExit,releaseDesktopMenuHoverOnMove,scheduleDesktopMenuPeek,closeDesktopMenuPeek,clearDesktopMenuPeek,setDesktopMenuCollapsed};`,context);
  const fire=(ms)=>{
    const entry=[...timers.entries()].find(([,v])=>v.ms===ms);
    assert.ok(entry,`Expected timer of ${ms}ms`);timers.delete(entry[0]);entry[1].fn();
  };
  return {classes,sidebar,timers,fire,...context.menu};
}

test('a hover navigation blocks reopening even after the 190ms close animation',()=>{
  const m=createHarness();
  m.blockDesktopMenuHoverUntilExit(m.sidebar);
  m.closeDesktopMenuPeek();
  m.fire(190);
  m.fire(40);
  m.scheduleDesktopMenuPeek();
  assert.equal(m.classes.has('nav-peeking'),false);
  assert.equal(m.timers.size,0);
});

test('mouse motion within the original expanded region does not release navigation suppression',()=>{
  const m=createHarness();
  m.blockDesktopMenuHoverUntilExit(m.sidebar);
  m.clearDesktopMenuPeek();
  m.releaseDesktopMenuHoverOnMove(70,180); // original overlay border, outside collapsed rail edge
  m.scheduleDesktopMenuPeek();
  assert.equal([...m.timers.values()].some(t=>t.ms===340),false);
});

test('moving fully beyond the old drawer and returning arms a normal 340ms hover',()=>{
  const m=createHarness();
  m.blockDesktopMenuHoverUntilExit(m.sidebar);
  m.clearDesktopMenuPeek();
  m.releaseDesktopMenuHoverOnMove(260,180);
  m.scheduleDesktopMenuPeek();
  m.fire(340);
  assert.equal(m.classes.has('nav-peeking'),true);
});

test('leaving at the top or bottom releases the hover suppression',()=>{
  for(const [x,y] of [[50,-1],[50,800],[-1,200]]){
    const m=createHarness();m.blockDesktopMenuHoverUntilExit(m.sidebar);
    m.clearDesktopMenuPeek();m.releaseDesktopMenuHoverOnMove(x,y);
    m.scheduleDesktopMenuPeek();m.fire(340);
    assert.equal(m.classes.has('nav-peeking'),true);
  }
});

test('manual pin clears navigation suppression and retains animation behavior',()=>{
  const m=createHarness();m.blockDesktopMenuHoverUntilExit(m.sidebar);
  m.setDesktopMenuCollapsed(false);
  assert.equal(m.classes.has('nav-collapsed'),false);
  m.setDesktopMenuCollapsed(true);
  m.scheduleDesktopMenuPeek();m.fire(340);
  assert.equal(m.classes.has('nav-peeking'),true);
});

test('regular collapsed navigation without a hover preview does not block subsequent hover',()=>{
  const m=createHarness(['nav-collapsed']);
  m.blockDesktopMenuHoverUntilExit(m.sidebar);
  m.scheduleDesktopMenuPeek();m.fire(340);
  assert.equal(m.classes.has('nav-peeking'),true);
});

test('event registration captures navigation before route handling and avoids layout-triggered pointerleave',()=>{
  assert.match(source,/desktopSidebar\?\.addEventListener\('click',event=>\{[\s\S]*?blockDesktopMenuHoverUntilExit\(desktopSidebar\);\s*\},true\);/);
  assert.match(source,/document\.addEventListener\('pointermove',event=>/);
  assert.match(source,/desktopSidebar\?\.addEventListener\('pointerleave',\(\)=>\{closeDesktopMenuPeek\(\);\}\)/);
  assert.match(source,/if\(desktopMenuNavigationHoverBlock\|\|!shell\?/);
});

test('browser memory settings register and forget actions have complete scoped button styles',()=>{
  assert.match(html,/id="cloud-remember-register"/);
  assert.match(html,/id="cloud-remember-forget"/);
  assert.match(style,/\.cloud-remember-actions button\{[\s\S]*?appearance:none/);
  assert.match(style,/\.cloud-remember-actions #cloud-remember-register\{/);
  assert.match(style,/\.cloud-remember-actions #cloud-remember-forget:hover\{/);
  assert.match(style,/\.cloud-remember-actions button:focus-visible\{/);
  assert.equal(read('dist/styles/style.css'),style);
  assert.equal(read('dist/styles/app.css'),bundled);
});
