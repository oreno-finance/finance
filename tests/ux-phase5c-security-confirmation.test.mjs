import {traceFinanceOperation} from '../dist/src/cloud/performance-diagnostics.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,readdirSync} from 'node:fs';
const main=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
const start=main.indexOf('const securityConfirmationOwner ='),end=main.indexOf('const ruleModes =',start);
assert.ok(start>=0&&end>start);
function fixture(){
 let decide,prompts=0;
 const draft=[{amount:1000}],state={busy:[],unsaved:['カード明細']},input={value:'synthetic draft'};
 const env={JSON,lockSequence:0,liveVault:{unlocked:true},account:'test-account',client:'test-client',currentModal:null,
  failedImports:[],categoryDraft:null,categoryBaseline:[],clipboardHtml:'',pending:()=>draft,ruleFormFingerprint:()=>'',
  $:id=>id==='paste-input'?input:{open:false},operationResult(){},interruptionState:()=>structuredClone(state),
  requestConfirmation(options){prompts++;assert.ok(options.destructive);return new Promise(resolve=>{decide=resolve;});}};
 env.activeMicrosoftAccountId=()=>env.account;env.clientIdForTab=()=>env.client;
 const context=vm.createContext(env);vm.runInContext(main.slice(start,end),context);
 return {env,context,draft,state,input,answer(value){decide(value);},prompts:()=>prompts};
}
test('認証・ロックの承認を同じアカウント・保管庫・下書きに限定する',async()=>{
 for(const scenario of ['cancel','epoch','vault','locked','account','client','draft','paste','input','busy','dialog','ok']){
  const f=fixture(),pending=f.context.confirmInterruption('ロック');assert.equal(f.prompts(),1);
  if(scenario==='epoch')f.env.lockSequence++;
  if(scenario==='vault')f.env.liveVault={unlocked:true};
  if(scenario==='locked')f.env.liveVault.unlocked=false;
  if(scenario==='account')f.env.account='another';
  if(scenario==='client')f.env.client='another';
  if(scenario==='draft')f.draft[0].amount=999;
  if(scenario==='paste')f.input.value='new draft';
  if(scenario==='input')vm.runInContext('draftInputRevision++',f.context);
  if(scenario==='busy')f.state.busy.push('保存中');
  if(scenario==='dialog')f.env.currentModal='unlock';
  f.answer(scenario!=='cancel');assert.equal(await pending,scenario==='ok',scenario);
 }
 const f=fixture();f.state.unsaved=[];assert.equal(await f.context.confirmInterruption('ロック'),true);assert.equal(f.prompts(),0);
 f.state.busy=['保存中'];assert.equal(await f.context.confirmInterruption('ロック'),false);assert.equal(f.prompts(),0);
});
test('アプリの標準確認ダイアログを廃止し、ブラウザ離脱時の保護と削除の文字入力を維持する',()=>{
 for(const dir of ['src','dist/src'])for(const entry of readdirSync(new URL('../'+dir+'/',import.meta.url),{recursive:true,withFileTypes:true})){
  if(!entry.isFile()||!/\.(ts|js)$/.test(entry.name))continue;
  const text=readFileSync(entry.parentPath+'/'+entry.name,'utf8');assert.doesNotMatch(text,/\bwindow\s*\.\s*(?:confirm|prompt)\s*\(/,entry.name);
 }
 assert.match(main,/window\.addEventListener\('beforeunload'/);
 const cloud=readFileSync(new URL('../src/cloud/cloud-settings.ts',import.meta.url),'utf8');
 assert.match(cloud,/requiredText:'削除'/);assert.match(cloud,/cleanupContext\?\.\(\)/);
 assert.match(cloud,/if\(cleanupCounts!==preview\|\|!cleanupContext\?\.\(\)\|\|!backupConfirmed.checked/);
});

test('PDF download URLs are revoked on timeout or vault lock and never retained twice',()=>{
 const start=main.indexOf('const originalDownloadUrls ='),end=main.indexOf('function setBadgeState(',start);
 assert.ok(start>=0&&end>start);
 const timers=new Map(),revoked=[],clicked=[];let seq=0,urlSeq=0;
 const env={Map,Blob,URL:{createObjectURL:()=>`blob:synthetic-${++urlSeq}`,revokeObjectURL:u=>revoked.push(u)},
  setTimeout(fn,ms){assert.equal(ms,60000);timers.set(++seq,fn);return seq;},clearTimeout(id){timers.delete(id);},
  document:{createElement:()=>({click(){clicked.push(this.href);},remove(){}}),body:{append(){}}}};
 const ctx=vm.createContext(env);vm.runInContext(main.slice(start,end),ctx);
 ctx.downloadFile('synthetic','application/pdf','sample.pdf');ctx.downloadFile('synthetic','application/pdf','sample.pdf');
 assert.equal(clicked.length,2);assert.equal(timers.size,2);
 timers.get(1)();assert.deepEqual(revoked,['blob:synthetic-1']);assert.equal(timers.size,1);
 ctx.revokeOriginalDownloadUrls();assert.deepEqual(revoked,['blob:synthetic-1','blob:synthetic-2']);assert.equal(timers.size,0);
 ctx.revokeOriginalDownloadUrls();assert.equal(revoked.length,2);
 assert.match(main,/function clearUnlockedFinanceViews\(\) \{\s*lockSequence\+\+;\s*revokeOriginalDownloadUrls\(\)/);
 assert.match(main,/revokeOriginalDownloadUrls\(\);\s*liveVault = vault;/);
});

test('a PDF read completed after vault lock or replacement cannot create a download URL',async()=>{
 const start=main.indexOf('async function downloadManagedOriginal('),end=main.indexOf('async function clearManagerChanges(',start);
 assert.ok(start>=0&&end>start);
 for(const mode of ['locked','replaced','normal']){
  let resolve;const s={};const btn={disabled:false};let downloads=0;
  const vault={unlocked:true,original:()=>new Promise(r=>resolve=r)};
  const env={traceFinanceOperation,active:()=>s,savedIds:new Map([[s,'sample']]),liveVault:vault,lockSequence:0,filesBusy:false,cloudRefreshing:false,$:()=>btn,
    Uint8Array,downloadFile:()=>downloads++,canonicalStatementFilename:()=> 'sample.pdf',toast(){}};
  const ctx=vm.createContext(env);vm.runInContext(main.slice(start,end),ctx);
  const promise=ctx.downloadManagedOriginal();
  if(mode==='locked'){ctx.lockSequence++;vault.unlocked=false;}
  if(mode==='replaced')ctx.liveVault={unlocked:true};
  resolve(new Uint8Array([37,80,68,70]));await promise;
  assert.equal(downloads,mode==='normal'?1:0,mode);assert.equal(ctx.filesBusy,false);
 }
});
