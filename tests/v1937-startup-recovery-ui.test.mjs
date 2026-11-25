import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const script=readFileSync('public/scripts/startup-recovery.js','utf8');
const css=readFileSync('public/styles/startup-recovery.css','utf8');
const bundle=readFileSync('public/styles/app.css','utf8');

test('recovery panel follows Finance palette instead of the legacy yellow warning box',()=>{
  assert.match(css,/#startup-recovery\s*\{/);
  assert.match(css,/background:#fff;color:#17283b/);
  assert.match(css,/startup-recovery-reload/);
  assert.doesNotMatch(css,/#fff9ed|#f0ba67|#352912/);
  assert.match(css,/:root\[data-theme="dark"\]/);
  assert.match(css,/@media \(max-width:520px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.ok(bundle.includes(css.trimEnd()), 'Generated CSS must include the source stylesheet');
});

test('startup fallback keeps its diagnostic and recovery actions without using main app code',async()=>{
  let delayed;
  let clipboardContent='';
  let reloads=0;
  const handlers={};
  const elements=new Map();
  class FakeElement {
    constructor(){this.children=[];this.events={};this.classList={add(){},remove(){}};this.dataset={};}
    addEventListener(type,handler){this.events[type]=handler;}
    append(...nodes){this.children.push(...nodes);}
    setAttribute(name,value){this[name]=value;}
    querySelector(selector){return selector==='.startup-recovery-note'?this.children.find(item=>item.className==='startup-recovery-note'):null;}
  }
  const document={
    querySelector(selector){return selector==='.sidebar-meta > span'?{textContent:'Finance v2.0.2'}:null;},
    documentElement:{dataset:{}},body:new FakeElement(),
    addEventListener(type,handler){handlers[type]=handler;},
    getElementById(id){return elements.get(id)??null;},
    createElement(){return new FakeElement();},
  };
  const window={addEventListener(){}};
  vm.runInNewContext(script,{document,window,Element:FakeElement,
    setTimeout(fn,ms){assert.equal(ms,9000);delayed=fn;},
    navigator:{onLine:true,clipboard:{async writeText(value){clipboardContent=value;}}},
    location:{reload(){reloads++;}},
  });
  handlers.DOMContentLoaded();delayed();
  const panel=document.body.children[0];
  assert.equal(panel.id,'startup-recovery');
  assert.equal(panel.role,'alert');
  assert.equal(panel.children[0].className,'startup-recovery-header');
  assert.equal(panel.children[0].children[1].children[0].textContent,'Financeを起動できませんでした');
  const [reload,settings,copy]=panel.children[2].children;
  assert.equal(reload.textContent,'再読み込み');
  assert.equal(settings.textContent,'設定を表示');
  assert.equal(copy.textContent,'起動診断をコピー');
  reload.events.click();assert.equal(reloads,1);
  await copy.events.click();
  assert.match(clipboardContent,/Finance 起動診断/);
  assert.match(clipboardContent,/appReady: false/);
  assert.match(clipboardContent,/version: 2\.0\.2/);
  document.querySelector=()=>({textContent:'unexpected diagnostic value'});
  await copy.events.click();assert.match(clipboardContent,/version: unknown/);
  assert.doesNotMatch(clipboardContent,/unexpected diagnostic value/);
  assert.doesNotMatch(clipboardContent,/token|passphrase|clientId|メール/);
});

test('successful startup never shows recovery UI',()=>{
  let delayed;
  const events={};let inserts=0;
  const document={documentElement:{dataset:{financeReady:'true'}},
    addEventListener(type,fn){events[type]=fn;},getElementById(){return null;},
    body:{append(){inserts++;}},createElement(){throw new Error('must not create recovery elements');}};
  vm.runInNewContext(script,{document,window:{addEventListener(){}},
    setTimeout(fn){delayed=fn;},navigator:{onLine:true}});
  events.DOMContentLoaded();delayed();assert.equal(inserts,0);
});
