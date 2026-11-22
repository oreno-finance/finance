import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const js=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
const ts=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const funcs=js.slice(js.indexOf('function updateImportUploadFeedback('),js.indexOf('function buildStatementList('));
const batch=js.slice(js.indexOf('function importBatchIsClean('),js.indexOf('const THEME_KEY =',js.indexOf('function importBatchIsClean(')));

function dialogHarness() {
  const nodes=new Map();
  const el=(id)=>{
    if(!nodes.has(id))nodes.set(id,{
      id,open:false,hidden:false,textContent:'',value:'original-value',
      classList:{values:new Set(),toggle(k,enable){if(enable)this.values.add(k);else this.values.delete(k);},contains(k){return k==='import-compact' || this.values.has(k);}},
      append(node){node.parentId=id;},focus(){this.focused=true;},
      showModal(){this.open=true;},close(){this.open=false;},
    });
    return nodes.get(id);
  };
  const env={
    failedImports:['old-error.csv: 解析失敗'],currentUploadFailures:['old-error.csv: 解析失敗'],
    importUploadFeedback:'前回の操作が失敗しました',filesBusy:false,revisionBusy:false,batchBusy:false,
    document:{getElementById:el,querySelector:()=>null},$:el,
    clipboardHtml:'<div>old clipboard</div>',
  };
  const context=vm.createContext(env);
  vm.runInContext(funcs+'\nthis.actions={updateImportUploadFeedback,openImportAddDialog,closeImportAddDialog};',context);
  return {context,env,el,...context.actions};
}

test('opening add dialog clears old inline failure message but keeps the failure in review queue',()=>{
  const {env,el,updateImportUploadFeedback,openImportAddDialog}=dialogHarness();
  updateImportUploadFeedback();
  assert.match(el('import-upload-feedback').textContent,/old-error/);
  openImportAddDialog();
  assert.equal(el('import-add-dialog').open,true);
  assert.equal(el('import-upload-feedback').textContent,'');
  assert.equal(el('import-upload-feedback').classList.contains('hidden'),true);
  assert.equal(el('import-clear-errors').classList.contains('hidden'),true);
  assert.equal(el('import-upload-panel').parentId,'import-dialog-content');
  assert.deepEqual(Array.from(env.failedImports),['old-error.csv: 解析失敗']);
  assert.equal(env.importUploadFeedback,'');
  assert.equal(env.currentUploadFailures.length,0);
});

test('closing and reopening the add dialog does not reintroduce the earlier failure',()=>{
  const {env,el,openImportAddDialog,closeImportAddDialog}=dialogHarness();
  openImportAddDialog();
  env.currentUploadFailures.push('new-error.csv: 解析失敗');
  closeImportAddDialog();
  assert.equal(el('import-upload-panel').parentId,'import-inline-entry');
  assert.equal(el('import-add-dialog').open,false);
  openImportAddDialog();
  assert.equal(el('import-upload-feedback').textContent,'');
  assert.equal(env.failedImports.length,1);
});

function fileHarness(oldFailures=[]) {
  const env={
    filesBusy:false,batchBusy:false,revisionBusy:false,
    importUploadFeedback:'',failedImports:[...oldFailures],currentUploadFailures:[],
    updateImportUploadFeedback(){},updateBatchStatus(){},showActivity(){},finishActivity(){},render(){},
    closeImportAddDialog(){env.closed++},toast(){},closed:0,
    decodeCardCsv:()=>'',identifyCardCsv:()=>({cardId:'smbc-nl',billingMonth:'2026-11'}),
    csvPaymentDate:()=>null,parseCardCsv:(_text,name)=>({name}),parsePdfFile:()=>({}),
    acceptStatement:async()=>true,Uint8Array,Error,Array,
  };
  const context=vm.createContext(env);
  vm.runInContext(batch+'\nthis.handleFiles=handleFiles;',context);
  return {env,run:files=>context.handleFiles(files)};
}
const file=(name)=>({name,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer});

test('a clean new batch closes despite an old failed CSV retained in the pending list',async()=>{
  const {env,run}=fileHarness(['previous-invalid.csv: 解析失敗']);
  await run([file('good.csv'),file('another.csv')]);
  assert.equal(env.closed,1);
  assert.equal(env.failedImports.length,1);
  assert.equal(env.currentUploadFailures.length,0);
});

test('mixed new batch remains open and displays only the new failure',async()=>{
  const {env,run}=fileHarness(['previous-invalid.csv: 解析失敗']);
  await run([file('good.csv'),file('new-invalid.exe')]);
  assert.equal(env.closed,0);
  assert.equal(env.failedImports.length,2);
  assert.equal(env.currentUploadFailures.length,1);
  assert.match(env.currentUploadFailures[0],/new-invalid\.exe/);
  assert.doesNotMatch(env.currentUploadFailures.join(''),/previous-invalid/);
});

test('clean modal does not become an error merely because the user previously had a parsing failure',()=>{
  assert.match(ts,/const messages=\[\.\.\.currentUploadFailures,/);
  assert.match(ts,/failedImports\.push\(reason\);currentUploadFailures\.push\(reason\)/);
  assert.match(ts,/accepted>0 && rejected===0 && failed===0 && currentUploadFailures\.length===0/);
  assert.doesNotMatch(ts,/messages=\[\.\.\.failedImports,/);
});
