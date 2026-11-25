import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FINANCE_CLOUD_GATE_PAGES} from '../dist/src/ui/cloud-gate.js';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const pages=['home-view','import-view','manage-view','rules-view','assets-page','future-view',
  'summary-view','analysis-view','reports-view','subscriptions-view'];

test('one canonical heading and subtitle exists for all ten data routes',()=>{
  assert.deepEqual(FINANCE_CLOUD_GATE_PAGES.map(page=>page.id),pages);
  assert.equal(new Set(FINANCE_CLOUD_GATE_PAGES.map(page=>page.id)).size,10);
  for(const page of FINANCE_CLOUD_GATE_PAGES){
    assert.ok(page.title.trim(),page.id);
    assert.ok(page.subtitle.trim(),page.id);
    assert.ok(page.eyebrow.trim(),page.id);
    assert.ok(read('public/index.html').includes(`id="${page.id}"`),page.id);
  }
  assert.ok(!FINANCE_CLOUD_GATE_PAGES.some(page=>page.id==='settings-view'));
});

test('the disconnected view hides original headings and gives every page full width',()=>{
  const css=read('public/styles/cloud-gate-v1980.css');
  const module=read('src/ui/cloud-gate.ts');
  const main=read('src/main.ts');
  assert.match(css,/finance-cloud-gated > :not\(\.finance-cloud-gate\)/);
  assert.match(css,/\.finance-cloud-gate\{[^}]*width:100%;max-width:none!important/s);
  assert.match(css,/\.finance-cloud-gate-panel\{[^}]*width:100%;max-width:none/s);
  assert.match(css,/#import-view\.finance-cloud-gated:not\(\.hidden\)/);
  assert.match(css,/#assets-page/);
  assert.match(module,/view\.prepend\(gate\)/);
  assert.match(module,/gate\.replaceChildren\(heading,panel\)/);
  assert.match(module,/if\(!state\.blocked\)\{gate\?\.remove\(\);continue;\}/);
  assert.match(main,/syncFinanceCloudGates\(\{/);
  assert.doesNotMatch(main,/maxWidth\s*=\s*650/);
});

test('locked and checking states preserve an explicit accessible title and safe actions',()=>{
  const module=read('src/ui/cloud-gate.ts');
  assert.match(module,/state\.locked\?'OneDrive保管庫はロックされています'/);
  assert.match(module,/state\.checking\?'OneDriveを確認中'/);
  assert.match(module,/appendAction\(actions,'保管庫を解除',state\.onUnlock,true\)/);
  assert.match(module,/appendAction\(actions,'Microsoft認証をやり直す',state\.onReauthenticate\)/);
  assert.match(module,/const description=document\.createElement\('p'\);description\.textContent=displayMessage/);
  assert.doesNotMatch(module,/\.innerHTML\s*=/);
});

test('only the disconnected manager stops stretching; authenticated scroll rules stay intact',()=>{
  const gateCss=read('public/styles/cloud-gate-v1980.css');
  const appCss=read('public/styles/app.css');
  assert.match(gateCss, /@media \(min-width:981px\) \{\s*#manage-view\.finance-cloud-gated:not\(\.hidden\) \{\s*flex:0 0 auto!important;/s);
  assert.match(appCss, /#manage-view \.manage-index > \.statement-list \{[^}]*overflow-y:auto!important;/s);
  assert.match(appCss, /#manage-view #manage-content > \.table-scroll \{[^}]*overflow-y:auto!important;/s);
  assert.doesNotMatch(gateCss, /#manage-view:not\(\.hidden\)\s*\{\s*flex:0 0 auto/);
});

test('checking takes precedence over locked on every page, then manual unlock returns',async()=>{
  const {syncFinanceCloudGates}=await import('../dist/src/ui/cloud-gate.js');
  const node=()=>({dataset:{},classList:{toggle(){}},children:[],textContent:'',append(...items){this.children.push(...items);},prepend(item){this.children.unshift(item);},replaceChildren(...items){this.children=items;},setAttribute(){},addEventListener(_,fn){this.click=fn;},querySelector(){return this.children.find(x=>x.className==='finance-cloud-gate')??null;}});
  const roots=new Map(pages.map(id=>[id,node()]));const old=globalThis.document;
  globalThis.document={getElementById:id=>roots.get(id),createElement:node,createTextNode:text=>({textContent:text,children:[]})};
  const flatten=n=>[n,...n.children.flatMap(flatten)];let unlocks=0;
  const base={blocked:true,locked:true,notice:{kind:'connected',message:''},onRetry(){},onReauthenticate(){},onUnlock(){unlocks++;},onSettings(){}};
  try{
    syncFinanceCloudGates({...base,checking:true});
    for(const root of roots.values()){const items=flatten(root);assert.ok(items.some(n=>n.textContent==='OneDriveを確認中'));assert.ok(!items.some(n=>n.textContent==='保管庫を解除'));}
    syncFinanceCloudGates({...base,checking:false});
    for(const root of roots.values()){const action=flatten(root).find(n=>n.textContent==='保管庫を解除');assert.ok(action);action.click();}
    assert.equal(unlocks,pages.length);
  }finally{globalThis.document=old;}
});
