import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
import {sourceSheets, buildStyles} from '../scripts/build-styles.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const main = read('src/main.ts');
const compiled = read('dist/src/main.js');
const html = read('public/index.html');

function functionBlock(source, start, end) {
  const from=source.indexOf(start), until=source.indexOf(end,from);
  assert.ok(from >= 0 && until>from, `Missing ${start}`);
  return source.slice(from,until);
}

test('amount uses phone numeric keyboard without losing signed and comma-grouped text editing',()=>{
  const fn=functionBlock(compiled,'function makeInput(','function initCloudActionControls()');
  const document={createElement:()=>({type:'',value:'',inputMode:'',setAttribute(){},
    listeners:new Map(),addEventListener(type,callback){this.listeners.set(type,callback);}})};
  const ctx={document};vm.createContext(ctx);vm.runInContext(fn,ctx);
  let amount='';const callback=value=>{amount=value;};ctx.callback=callback;
  const input=vm.runInContext("makeInput('-1,200','numeric-input',callback,'金額')",ctx);
  assert.equal(input.type,'text');assert.equal(input.inputMode,'numeric');
  assert.equal(input.value,'-1,200');
  input.value='-2,300';input.listeners.get('change')();
  assert.equal(amount,'-2,300');
});

test('date uses OS native picker with ISO format, preserving existing date semantics',()=>{
  const fn=functionBlock(compiled,'function makeInput(','function initCloudActionControls()');
  const document={createElement:()=>({type:'',value:'',inputMode:'',setAttribute(){},
    listeners:new Map(),addEventListener(type,callback){this.listeners.set(type,callback);}})};
  const ctx={document};vm.createContext(ctx);vm.runInContext(fn,ctx);
  ctx.callback=(value)=>{ctx.date=value;};
  const input=vm.runInContext("makeInput('2026/11/21','',callback,'利用日')",ctx);
  assert.equal(input.type,'date');assert.equal(input.value,'2026-11-21');
  input.value='2026-11-22';input.listeners.get('change')();
  assert.equal(ctx.date,'2026-11-22');
  assert.match(main,/\[row\.usedOn, '利用日'/);
  assert.match(main,/if \(!validDate\(next\)\)/);
  assert.match(read('public/styles/points-workspace-v1914.css'),/input\[type="date"\]/);
});

test('empty import hides Step 02, Step 03 and Save until draft or error is present',()=>{
  const css=read('public/styles/import-v192.css');
  assert.match(css,/#import-view:not\(\.has-import-drafts\)>\.results-grid,\s*#import-view:not\(\.has-import-drafts\)>\.batch-bar\{display:none!important\}/);
  const state=functionBlock(main,'function buildStatementList(): void','function discardImportDraft(');
  assert.match(state,/const hasDrafts=importQueue\(\)\.length>0/);
  assert.match(state,/classList\.toggle\('has-import-drafts',hasDrafts\)/);
  assert.match(state,/\$\('import-inline-entry'\)\.classList\.toggle\('hidden',compact\)/);
  for(const node of ['import-inline-entry','import-add-dialog','batch-bar','results-grid','preview-empty','preview-content'])
    assert.match(html,new RegExp(`(?:id="${node}"|class="[^"]*${node})`));
});

test('maintained CSS sources, including fixed costs, are delivered as one deterministic bundle',async()=>{
  assert.ok(sourceSheets.length>=50,'前回までのCSS登録を維持すること');
  assert.ok(sourceSheets.includes('fixed-costs-v1960.css'),'固定費CSSが配布物に含まれること');
  assert.equal(new Set(sourceSheets).size,sourceSheets.length);
  // The generated bundle is the only extra stylesheet; do not ship retired sources.
  for (const directory of ['public/styles','dist/styles']) {
    const cssFiles=readdirSync(new URL(`../${directory}/`,import.meta.url)).filter(name=>name.endsWith('.css')).sort();
    assert.deepEqual(cssFiles,[...sourceSheets,'app.css'].sort());
  }
  assert.equal((html.match(/<link rel="stylesheet"/g)||[]).length,1);
  assert.match(html,/<link rel="stylesheet" href="\.\/styles\/app\.css">/);
  const output=read('public/styles/app.css');
  assert.equal(output,await buildStyles());
  assert.equal(output,read('dist/styles/app.css'));
  assert.equal(read('public/index.html'),read('dist/index.html'));
  let offset=0;
  for(const filename of sourceSheets){
    const label=`/* SOURCE: ${filename} */`;
    const pos=output.indexOf(label,offset);
    assert.ok(pos>=offset,`Missing or unordered: ${filename}`);
    assert.ok(output.includes(read(`public/styles/${filename}`).trimEnd(),pos+label.length),filename);
    offset=pos+label.length;
  }
  assert.match(read('public/styles/style.css'),/--radius-control:9px;--radius-panel:14px;--radius-chip:20px/);
  assert.match(html,/<h2 id="cloud-rotate-title">パスフレーズを変更<\/h2>/);
});
