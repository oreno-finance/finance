import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('src/main.ts','utf8');
const auth = readFileSync('src/cloud/cloud-settings.ts','utf8');
const api = readFileSync('src/cloud/onedrive-api.ts','utf8');
const recovery = readFileSync('dist/scripts/startup-recovery.js','utf8');

test('navigation is connected before complex setup and automatic auth never redirects',()=>{
  const init=source.split('function init(): void {')[1];
  assert.ok(init.indexOf("$('nav-settings').addEventListener") < init.indexOf('initAssetsSettings('));
  assert.ok(init.indexOf("$('nav-settings').addEventListener") < init.indexOf('initCloudSettings('));
  assert.ok(init.indexOf("document.documentElement.dataset.financeReady='true'") > init.indexOf('  render();'));
  const startup=source.split('async function startCloud()')[1]?.split('async function refreshCloud()')[0]??'';
  assert.match(startup,/await graphClientWithoutRedirect\(\)/);
  assert.doesNotMatch(startup,/await graphClient\(\)/);
  assert.match(startup,/setTimeout\(/);
  assert.match(auth,/export async function graphClientWithoutRedirect\(/);
  assert.match(auth,/if\(id&&validId\(id\)\)void ensureMsal\(\)\.then\(/);
  assert.doesNotMatch(auth,/if\(id&&validId\(id\)\)void action\(/);
});

test('network read deadline does not time out writes or silently retry them',()=>{
  assert.match(api,/if\(\(init\.method\?\?'GET'\)\.toUpperCase\(\)!=='GET'\)return this\.http\(url,init\)/);
  assert.match(api,/withReadDeadline/);
  assert.match(api,/controller\.abort\(\)/);
  assert.match(api,/readResponseBytes\(response,maxBytes\)/);
  assert.match(api,/credentials:'omit'/);
});

test('independent recovery script remains available when main application fails to load',async()=>{
  for(const path of ['public/index.html','dist/index.html']){
    const html=readFileSync(path,'utf8');
    assert.match(html,/<script src="\.\/scripts\/startup-recovery\.js"><\/script>/);
    assert.match(html,/<script type="module" src="\.\/src\/main\.js"><\/script>/);
    assert.ok(html.indexOf('scripts/startup-recovery.js')<html.indexOf('src/main.js'));
  }
  const handlers={};let scheduled;const elements=new Map();
  class FakeElement {
    constructor(){this.children=[];this.events={};this.classList={add(){},remove(){}};this.dataset={};}
    addEventListener(type,callback){this.events[type]=callback;}
    append(...children){this.children.push(...children);}
    setAttribute(name,value){this[name]=value;}
    querySelector(selector){if(selector==='.startup-recovery-note')return this.children.find(item=>item.className==='startup-recovery-note');return null;}
  }
  const doc={
    documentElement:{dataset:{}},body:new FakeElement(),
    addEventListener(type,callback){handlers[type]=callback;},
    createElement(){return new FakeElement();},
    getElementById(id){return elements.get(id)??null;},
  };
  const win={addEventListener(){}};
  vm.runInNewContext(recovery,{document:doc,window:win,setTimeout(fn){scheduled=fn;},Element:FakeElement,navigator:{onLine:true}});
  handlers.DOMContentLoaded();scheduled();
  assert.equal(doc.body.children.length,1);
  const panel=doc.body.children[0];
  assert.equal(panel.id,'startup-recovery');
  const [reload,settings,copy]=panel.children[2].children;
  assert.equal(settings.textContent,'設定を表示');
  assert.equal(copy.textContent,'起動診断をコピー');
  assert.equal(reload.textContent,'再読み込み');
  assert.equal(reload.className,'startup-recovery-reload');
  assert.equal(panel.children[0].className,'startup-recovery-header');
});
