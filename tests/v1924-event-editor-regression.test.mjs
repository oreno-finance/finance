import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {bindModalDismiss} from '../dist/src/ui/modal.js';

const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const compiled=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
const block=(text,start,end)=>{
  const from=text.indexOf(start);
  assert.notEqual(from,-1,`Missing ${start}`);
  const until=text.indexOf(end,from);
  assert.ok(until>from,`Missing end of ${start}`);
  return text.slice(from,until);
};

/** Execute the shipped registration and render functions against instrumented DOM nodes. */
test('cloud connection and pending-save controls are registered once, not per redraw',()=>{
  const src=block(compiled,'function initCloudActionControls()','function renderRows()');
  assert.doesNotMatch(block(main,'function renderSortControls(): void','function renderRows(): void'),/addEventListener/);
  assert.match(block(main,'function init(): void','init();'),/initCloudActionControls\(\)/);
  const nodes=new Map();
  const create=(id)=>{
    const listeners=new Map();
    return {
      dataset:{mode:'connect'},listeners,closeCount:0,clickCount:0,
      addEventListener(name,fn){const handlers=listeners.get(name)||[];handlers.push(fn);listeners.set(name,handlers);},
      close(){this.closeCount++;},
      click(){this.clickCount++;},
      classList:{toggle(){},add(){},remove(){}},setAttribute(){},
      querySelector(){return {textContent:''};},closest(){return {setAttribute(){}}},
    };
  };
  const $=(id)=>{if(!nodes.has(id))nodes.set(id,create(id));return nodes.get(id);};
  const context={$,bindModalDismiss,
    previewSort:null,cloudConnectDismissed:false,
    liveVault:null,batchBusy:false,filesBusy:false,
  };
  vm.createContext(context);
  vm.runInContext(src,context);
  vm.runInContext('initCloudActionControls(); for(let i=0;i<30;i++)renderSortControls();',context);
  for(const [id,name] of [['cloud-connect-later','click'],['cloud-connect-close','click'],['cloud-connect-dialog','cancel'],['cloud-connect-continue','click'],['cloud-resume-batch','click']]){
    assert.equal(nodes.get(id).listeners.get(name)?.length,1,`${id} must have exactly one listener`);
  }
  const dialog=nodes.get('cloud-connect-dialog');
  for(const fn of nodes.get('cloud-connect-continue').listeners.get('click'))fn();
  assert.equal(dialog.closeCount,1);
  assert.equal(nodes.get('cloud-login').clickCount,1);
});

test('editing a field preserves the edit row and its delete button through change and click',()=>{
  const change=block(compiled,'function makeInput(', 'function initCloudActionControls()');
  const mark=block(compiled,'function markManagerInlineDirty(', 'function dateDisplay(');
  assert.doesNotMatch(mark,/\brender\(/);
  const manager=block(main,'function renderManager(): void','function updateRuleCategoryVisual():void');
  assert.match(manager,/markManagerInlineDirty\(s\)/);
  assert.doesNotMatch(manager,/row\.usedOn = next; markDirty\(s\)/);
  assert.doesNotMatch(manager,/row\.amount = Number\(value\.replace/);
  assert.doesNotMatch(manager,/input\.value=dateDisplay\(row\.usedOn\); return; \}\s*row\.usedOn = next; markDirty/);
  const s={}; const dirty=new WeakSet(); const view={classList:{contains:()=>false}};
  let feedback=0,redraws=0,deleted=0;
  const $=id=>id==='manage-view'?view:null;
  const parent={removed:false,deleteButton:{click:()=>{deleted++;}}};
  const document={createElement:()=>({value:'',listeners:new Map(),className:'',setAttribute(){},addEventListener(name,fn){this.listeners.set(name,fn)}})};
  const context={document,$,dirty,s,active:()=>s,updateManagerEditState:()=>feedback++,render:()=>redraws++};
  vm.createContext(context);
  vm.runInContext(change+mark,context);
  const field=vm.runInContext("makeInput('100','numeric-input',()=>markManagerInlineDirty(s),'金額')",context);
  assert.ok(field.listeners.has('change'));
  field.value='200';
  field.listeners.get('change')();
  assert.ok(dirty.has(s));
  assert.equal(redraws,0,'input change must not replace table rows');
  assert.equal(feedback,1,'visible save state updates immediately');
  parent.deleteButton.click();
  assert.equal(deleted,1,'next click still reaches its original button');
});
