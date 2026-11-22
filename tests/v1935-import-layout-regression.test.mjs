import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const emptyCss = read('public/styles/import-v192.css');
const draftCss = read('public/styles/points-workspace-v1914.css');
const disclosureCss = read('public/styles/ui-v152.css');
const main = read('src/main.ts');
const markup = read('public/index.html');

test('empty import fills workspace; a drafted import exposes only a compact modal opener',()=>{
  assert.match(emptyCss, /\.import-inline-entry\{width:100%;min-width:0\}/);
  assert.match(emptyCss, /#import-view:not\(\.has-import-drafts\) \.import-inline-entry \.dropzone/);
  assert.match(emptyCss, /min-height:156px!important/);
  assert.match(emptyCss, /#import-view:not\(\.has-import-drafts\)>\.results-grid,[\s\S]*?\.batch-bar\{display:none!important\}/);
  assert.match(markup, /id="import-add-open"/);
  assert.match(markup, /<dialog id="import-add-dialog"/);
  assert.doesNotMatch(markup, /id="entry-accordion"/);
});

test('native modal replaces the floating import accordion and shares one input',()=>{
  assert.doesNotMatch(draftCss, /#entry-accordion|position:absolute;z-index:5/);
  assert.match(emptyCss, /\.import-add-dialog\[open\]\{display:flex;flex-direction:column\}/);
  assert.match(main, /\$\('import-dialog-content'\)\.append\(\$\('import-upload-panel'\)\)/);
  assert.match(main, /\$\('import-inline-entry'\)\.append\(\$\('import-upload-panel'\)\)/);
  assert.equal((markup.match(/id="file-input"/g)??[]).length,1);
  assert.equal((markup.match(/id="paste-input"/g)??[]).length,1);
});

test('mobile imported draft permits document scrolling and visible transaction rows', () => {
  const mobile=draftCss.slice(draftCss.lastIndexOf('@media(max-width:800px){'));
  assert.match(mobile, /body:has\(#import-view\.has-import-drafts:not\(\.hidden\)\)\{height:auto!important;[^}]*overflow-y:auto!important/);
  assert.match(mobile, /#import-view\.has-import-drafts>\.results-grid\{[^}]*grid-template-rows:auto auto/);
  assert.match(mobile, /#import-view\.has-import-drafts \.detail-panel \.detail-summary-block\{[^}]*max-height:none!important/);
  assert.match(mobile, /#import-view\.has-import-drafts \.transactions-panel-inner>\.table-scroll\{[^}]*min-height:190px!important/);
  assert.doesNotMatch(mobile, /grid-template-rows:minmax\(0,35fr\)|[;{]height:100dvh!important/);
});

test('failed-only imports leave the first uploader visible and error persists locally',()=>{
  assert.match(main, /const hasDrafts=importQueue\(\)\.length>0;/);
  assert.match(main, /\$\('import-inline-entry'\)\.classList\.toggle\('hidden',compact\)/);
  assert.match(main, /function updateImportUploadFeedback\(\):void/);
  assert.match(main, /if\(importBatchIsClean\(accepted,rejected,failed\)\)closeImportAddDialog\(\)/);
  assert.match(main, /'import-clear-errors'\)\.addEventListener/);
  for(const id of ['file-input','paste-input','parse-paste','statement-list','preview-content','transaction-rows','batch-import'])
    assert.match(markup,new RegExp(`id="${id}"`));
});
