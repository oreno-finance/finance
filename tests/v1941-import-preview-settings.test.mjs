import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('src/main.ts');
const built = read('dist/src/main.js');
const markup = read('public/index.html');
const cloudCss = read('public/styles/style.css');
const draftCss = read('public/styles/points-workspace-v1914.css');

function isCompact(hasDrafts,hasImportedInThisSession) {
  const expression = /const compact=([^;]+);/.exec(source)?.[1];
  assert.ok(expression,'missing import presentation state');
  return vm.runInNewContext(expression,{hasDrafts,hasImportedInThisSession,
    // Even a nonempty cloud history must never decide the initial uploader.
    statements:[{id:'cloud-saved'}],savedIds:new Map([[{},'cloud-id']])});
}

test('new visit opens a full-width inline uploader even when OneDrive already has statements',()=>{
  assert.equal(isCompact(false,false),false);
  assert.equal(isCompact(true,false),true);
  assert.equal(isCompact(false,true),true);
  assert.equal(isCompact(true,true),true);
  assert.match(source,/const compact=hasDrafts\|\|hasImportedInThisSession;/);
  assert.match(source,/\$\('import-inline-entry'\)\.classList\.toggle\('hidden',compact\)/);
  assert.match(source,/\$\('import-add-open'\)\.classList\.toggle\('hidden',!compact\)/);
  assert.match(markup,/id="import-add-open"[^>]*class="[^"]*hidden/);
  assert.equal((markup.match(/id="file-input"/g)??[]).length,1);
  assert.equal((markup.match(/id="import-upload-panel"/g)??[]).length,1);
});

test('only accepted, error-free file and paste batches auto-close after parsing',()=>{
  const start=built.indexOf('function importBatchIsClean(');
  const end=built.indexOf('async function handleFiles(',start);
  assert.ok(start>0 && end>start);
  const code=built.slice(start,end);
  const run=(accepted,rejected,failed,errorCount=0,feedback='')=>{
    const context=vm.createContext({failedImports:['過去に失敗したCSV'],currentUploadFailures:Array.from({length:errorCount}),importUploadFeedback:feedback});
    return vm.runInContext(`${code}\nimportBatchIsClean(${accepted},${rejected},${failed})`,context);
  };
  assert.equal(run(2,0,0),true);
  assert.equal(run(0,0,0),false);
  assert.equal(run(1,1,0),false);
  assert.equal(run(1,0,1),false);
  assert.equal(run(1,0,0,1),false);
  assert.equal(run(1,0,0,0,'重複しています'),false);
  assert.match(source,/if\(importBatchIsClean\(accepted,rejected,failed\)\)closeImportAddDialog\(\)/);
  assert.match(source,/if\(added && importBatchIsClean\(1,0,0\)\)closeImportAddDialog\(\)/);
  assert.match(source,/for\(const file of chosen\)/);
  assert.match(source,/finally\{\s*if\(importAbort===controller\)importAbort=null;\s*filesBusy=false;finishActivity/);
});

test('card type and totals are never a nested scroll area, while transaction rows are',()=>{
  assert.match(draftCss,/#import-view\.has-import-drafts \.detail-panel \.detail-summary-block\{flex:0 0 auto;max-height:none;overflow:visible\}/);
  assert.doesNotMatch(draftCss,/\.detail-summary-block\{[^}]*overflow:auto/);
  assert.match(draftCss,/#import-view\.has-import-drafts \.transactions-panel-inner>\.table-scroll\{[^}]*overflow:auto/);
  assert.match(draftCss,/@media\(min-width:801px\) and \(max-width:980px\)/);
  assert.match(draftCss,/grid-template-rows:auto auto!important/);
  assert.match(draftCss,/height:clamp\(220px,35dvh,380px\)!important/);
  for(const id of ['amount-stated','card-display','detail-month','detail-date','transaction-rows']) {
    assert.match(markup,new RegExp(`id="${id}"`));
  }
});

test('account management links have no separator border, retain spacing and focus styles',()=>{
  const rule = cloudCss.match(/\.cloud-account-actions\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.doesNotMatch(rule,/border-top:/);
  assert.match(rule,/margin-top:7px/);
  assert.match(cloudCss,/\.cloud-account-actions \.cloud-link-action:focus-visible\{outline:2px solid var\(--accent\)/);
  assert.match(markup,/id="cloud-switch-account"/);
  assert.match(markup,/id="cloud-logout"/);
});

test('generated build matches version metadata and modular CSS sources',()=>{
  assert.match(markup,new RegExp(`Finance v${JSON.parse(read('package.json')).version.replaceAll('.','\\.')}`));
  assert.equal(read('public/index.html'),read('dist/index.html'));
  assert.equal(read('public/styles/app.css'),read('dist/styles/app.css'));
  assert.equal(read('src/main.ts').includes('const compact=hasDrafts||hasImportedInThisSession'),true);
  assert.match(read('dist/src/main.js'),/const compact = hasDrafts \|\| hasImportedInThisSession/);
});
