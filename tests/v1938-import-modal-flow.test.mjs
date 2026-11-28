import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
const sourceTs=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const markup=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/styles/import-v192.css',import.meta.url),'utf8');
const draftCss=readFileSync(new URL('../public/styles/points-workspace-v1914.css',import.meta.url),'utf8');
const handleFilesSource=source.slice(source.indexOf('function importBatchIsClean('),source.indexOf('const THEME_KEY =',source.indexOf('function importBatchIsClean(')));

function createHarness({accept=()=>true,decode=()=>'',parse=()=>({}),pdf=()=>({})}={}){
  const events={accepted:[],closed:0,rendered:0,feedback:0,notices:[],activity:[]};
  const env={
    filesBusy:false,batchBusy:false,revisionBusy:false,lockSequence:0,importAbort:null,AbortController,importUploadFeedback:'',failedImports:[],currentUploadFailures:[],
    updateImportUploadFeedback:()=>events.feedback++,updateBatchStatus:()=>{},
    showActivity:(...args)=>events.activity.push(args),finishActivity:(...args)=>events.activity.push(args),render:()=>events.rendered++,
    closeImportAddDialog:()=>events.closed++,
    toast:text=>events.notices.push(text),
    decodeCardCsv:decode,identifyCardCsv:()=>({cardId:'smbc-nl',billingMonth:'2026-11'}),
    csvPaymentDate:()=>null,parseCardCsv:parse,parsePdfFile:pdf,assertPdfLimits:()=>{},
    acceptStatement:async row=>{events.accepted.push(row);return accept(row);},
    Uint8Array,Error,Array,
  };
  const context=vm.createContext(env);
  vm.runInContext(handleFilesSource+'\nthis.handleFiles=handleFiles;',context);
  return {context,events,run:files=>context.handleFiles(files)};
}
const fakeFile=(name,raw=new Uint8Array([1,2]))=>({name,size:raw.byteLength,arrayBuffer:async()=>raw.buffer});

test('first upload and later modal use one file input; modal never overlays the result as an absolute accordion',()=>{
  assert.equal((markup.match(/id="file-input"/g)||[]).length,1);
  assert.equal((markup.match(/id="paste-input"/g)||[]).length,1);
  assert.match(markup,/id="import-inline-entry"/);
  assert.match(markup,/id="import-add-dialog" class="import-add-dialog finance-modal"/);
  assert.match(markup,/id="import-add-open"/);
  assert.doesNotMatch(markup,/id="entry-accordion"/);
  assert.doesNotMatch(draftCss,/#entry-accordion|position:absolute;z-index:5/);
  assert.match(readFileSync(new URL('../public/styles/cloud-gate-v1980.css',import.meta.url),'utf8'),/\.finance-modal::backdrop/);
  assert.match(sourceTs,/\$\('import-dialog-content'\)\.append\(\$\('import-upload-panel'\)\)/);
  assert.match(sourceTs,/\$\('import-inline-entry'\)\.append\(\$\('import-upload-panel'\)\)/);
});

test('successfully parsing multiple files closes the add dialog only after all have been processed',async()=>{
  const {run,events,context}=createHarness({parse:(_raw,name)=>({name})});
  await run([fakeFile('a.csv'),fakeFile('b.csv'),fakeFile('c.csv')]);
  assert.deepEqual(events.accepted.map(row=>row.name),['a.csv','b.csv','c.csv']);
  assert.equal(events.closed,1);
  assert.equal(context.filesBusy,false);
  assert.equal(context.failedImports.length,0);
  assert.deepEqual(events.activity,[]);
  assert.deepEqual(events.notices,[]);
});

test('PDF and CSV local parsing never issue global progress or success notifications',async()=>{
  const {run,events,context}=createHarness({pdf:async file=>({name:file.name}),parse:(_raw,name)=>({name})});
  await run([fakeFile('sample.pdf'),fakeFile('sample.csv')]);
  assert.deepEqual(events.accepted.map(row=>row.name),['sample.pdf','sample.csv']);
  assert.deepEqual(events.activity,[]);assert.deepEqual(events.notices,[]);
  assert.equal(context.filesBusy,false);assert.equal(events.closed,1);
});

test('one invalid file among valid statements does not close the modal or discard error information',async()=>{
  const {run,events,context}=createHarness({parse:(_raw,name)=>({name})});
  await run([fakeFile('valid.csv'),fakeFile('bad.txt')]);
  assert.equal(events.closed,0);
  assert.equal(events.accepted.length,1);
  assert.match(context.failedImports[0],/bad\.txt/);
  assert.equal(context.filesBusy,false);
});

test('all invalid files keep the upload screen and error message available',async()=>{
  const {run,events,context}=createHarness();
  await run([fakeFile('invalid.xyz')]);
  assert.equal(events.closed,0);
  assert.equal(context.failedImports.length,1);
  assert.ok(events.feedback>0);
  assert.equal(context.filesBusy,false);
});

test('duplicate or cancelled statement replacement does not automatically close the modal',async()=>{
  const {run,events,context}=createHarness({accept:()=>false});
  await run([fakeFile('duplicate.csv')]);
  assert.equal(events.closed,0);
  assert.equal(context.importUploadFeedback,'追加できる新しい明細はありませんでした。');
});

test('parser failure preserves the error and permits retry without entering a busy state',async()=>{
  const {run,events,context}=createHarness({decode:()=>{throw new Error('CSVデータを解析できません');}});
  await run([fakeFile('broken.csv')]);
  assert.equal(events.closed,0);
  assert.match(context.failedImports[0],/broken\.csv: CSVデータを解析できません/);
  assert.equal(events.notices.length,1,'real parser errors remain visible');
  assert.deepEqual(events.activity,[]);
  assert.equal(context.filesBusy,false);
});

test('input change snapshots FileList before clearing input; compact presentation follows the current queue',()=>{
  assert.match(sourceTs,/const chosen=Array\.from\(input\.files\?\?\[\]\);\s*input\.value = '';\s*if\(chosen\.length\)void handleFiles\(chosen\)/);
  assert.match(sourceTs,/const compact=hasDrafts;/);
  assert.match(sourceTs,/\$\('import-compact-empty'\)\.classList\.toggle\('hidden',!compact\|\|hasDrafts\)/);
  assert.match(sourceTs,/activeIndex=statements.indexOf\(revised\);render/);
  assert.match(sourceTs,/statements\.unshift\(s\);activeIndex=0;/);
});

test('Phase 6C: ロック中にCSV読込が終了しても明細やファイル名を再登録しない',async()=>{
 const {context,events,run}=createHarness();let release,entered;const started=new Promise(r=>{entered=r;});let later=0;
 const pending=run([{name:'old.csv',size:2,arrayBuffer:()=>{entered();return new Promise(r=>{release=r;});}},{name:'later.csv',size:2,arrayBuffer:async()=>{later++;return new Uint8Array([1,2]).buffer;}}]);
 await started;context.lockSequence++;context.importAbort.abort();release(new Uint8Array([1,2]).buffer);await pending;
 assert.equal(later,0);assert.equal(events.accepted.length,0);assert.equal(events.closed,0);assert.equal(context.failedImports.length,0);assert.equal(events.notices.length,0);
});
