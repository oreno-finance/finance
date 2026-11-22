import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile, mkdtemp, mkdir, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {LiveVault} from '../dist/src/cloud/live-vault.js';
import {emptyAssets, detectAssetsEditCollisions} from '../dist/src/cloud/assets.js';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const secret='test-only encrypted finance password for concurrency';
const once=(name='first',amount=1000)=>({id:'once-test-a',date:'2026-11-18',name,amount,kind:'expense',status:'done',fromAccountId:'rakuten-bank',toAccountId:null});
class Graph {
  constructor(state){this.state=state;}
  read(k){const v=this.state.get(k);return v?{text:v.text,id:k,etag:`"${v.rev}"`}:null;}
  write(k,text,ref){const prior=this.state.get(k);if((prior&&(!ref||ref.etag!==`"${prior.rev}"`))||(!prior&&ref))throw new GraphError(412,'simulated concurrent update');const rev=(prior?.rev??0)+1;this.state.set(k,{text,rev});return {id:k,etag:`"${rev}"`};}
  async readFinanceIndex(){return this.read('index');}
  async writeFinanceIndex(text,ref){this.write('index',text,ref);}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async listYearFiles(){return [];}
  async readMerchantRules(){return this.read('rules');}
  async writeMerchantRules(text,ref){return this.write('rules',text,ref);}
  async readAssetSettings(){return this.read('assets');}
  async writeAssetSettings(text,ref){return this.write('assets',text,ref);}
}
test('confirmed cloud statements always need confirmation, including failed validation state',async()=>{
  const code=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  const operation=code.slice(code.indexOf('async function deleteStatement('),code.indexOf('function notice('));
  assert.match(operation,/const mustConfirm\s*=\s*!!storedId\s*\|\|\s*!needsReview\(statement\)/);
  assert.match(operation,/if\s*\(mustConfirm\s*&&\s*!window\.confirm\(message\)\)\s*return;/);
  assert.match(operation,/暗号化PDF原本はOneDriveに保持/);
  assert.doesNotMatch(operation,/if\s*\(!needsReview\(statement\)\s*&&\s*!window\.confirm/);
});
test('same field edits and delete/edit conflicts are identified, disjoint edits do not block',()=>{
  const base={...emptyAssets(),oneTime:[once()]},left=structuredClone(base),right=structuredClone(base);
  left.oneTime[0].amount=2000;right.oneTime[0].name='name changed';
  assert.deepEqual(detectAssetsEditCollisions(base,left,right),[]);
  right.oneTime[0].amount=3000;
  assert.deepEqual(detectAssetsEditCollisions(base,left,right),[{itemId:'once-test-a',field:'amount'}]);
  left.oneTime=[];left.deletedOneTime=['once-test-a'];
  assert.deepEqual(detectAssetsEditCollisions(base,left,right),[{itemId:'once-test-a',field:'delete'}]);
  const l={...emptyAssets(),payrollAutoPassphrase:'TEST SECRET A'},r={...emptyAssets(),payrollAutoPassphrase:'TEST SECRET B'};
  const collisions=detectAssetsEditCollisions(emptyAssets(),l,r);
  assert.deepEqual(collisions,[{itemId:'payroll-auto-credential',field:'payrollAutoPassphrase'}]);
  assert.equal(JSON.stringify(collisions).includes('TEST SECRET'),false);
});
test('stale device never overwrites same field without explicit user approval',async()=>{
  const state=new Map(),a=new LiveVault(new Graph(state)),b=new LiveVault(new Graph(state));
  await a.create(secret);
  await a.upsertOneTime(once('base'));
  await b.unlock(secret);
  await a.upsertOneTime(once('Mac',2000));
  const current=state.get('assets');
  await assert.rejects(b.upsertOneTime(once('Galaxy',3000)),/保存を停止/);
  assert.equal(state.get('assets'),current);
  let prompted=0;
  b.setAssetConflictResolver(collisions=>{prompted++;assert.deepEqual(collisions,[{itemId:'once-test-a',field:'name'},{itemId:'once-test-a',field:'amount'}]);return false;});
  await assert.rejects(b.upsertOneTime(once('Galaxy',3000)),/保存を中止/);
  assert.equal(prompted,1);
  assert.equal(state.get('assets'),current);
  b.setAssetConflictResolver(collisions=>{prompted++;return collisions.length===2;});
  await b.upsertOneTime(once('Galaxy',3000));
  assert.equal(prompted,2);
  const reopened=new LiveVault(new Graph(state));await reopened.unlock(secret);
  assert.equal(reopened.assetSettings().oneTime[0].amount,3000);
  assert.equal(reopened.assetSettings().oneTime[0].name,'Galaxy');
});
test('safe edits in different fields merge without asking the user',async()=>{
  const state=new Map(),a=new LiveVault(new Graph(state)),b=new LiveVault(new Graph(state));
  await a.create(secret);await a.upsertOneTime(once());await b.unlock(secret);
  await a.upsertOneTime(once('Mac',1000));
  b.setAssetConflictResolver(()=>{throw new Error('unneeded prompt');});
  await b.upsertOneTime(once('first',3300));
  const reopened=new LiveVault(new Graph(state));await reopened.unlock(secret);
  assert.equal(reopened.assetSettings().oneTime[0].amount,3300);
  assert.equal(reopened.assetSettings().oneTime[0].name,'Mac');
});
test('CSP restricts scripts and theme initialization is externalized',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/<meta http-equiv="Content-Security-Policy"/);
  assert.match(html,/script-src 'self'/);
  assert.match(html,/object-src 'none'/);
  assert.match(html,/connect-src[^\"]*https:\/\/\*\.1drv\.com/);
  assert.match(html,/<script src="\.\/scripts\/theme-boot\.js"><\/script>/);
  assert.doesNotMatch(html,/<script\s*>/);
  const boot=await readFile(new URL('../public/scripts/theme-boot.js',import.meta.url),'utf8');
  assert.match(boot,/finance-theme/);
});
test('clean build removes stale published artifacts instead of reusing old output',async()=>{
  const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.match(packageJson.scripts.build,/^npm run build:meta && npm run build:styles && node scripts\/clean-dist\.mjs && tsc && node scripts\/copy-static\.mjs/);
  const dir=await mkdtemp(join(tmpdir(),'finance-clean-v166-'));
  await mkdir(join(dir,'dist'),{recursive:true});await writeFile(join(dir,'dist','stale.js'),'stale');
  execFileSync(process.execPath,[new URL('../scripts/clean-dist.mjs',import.meta.url).pathname],{cwd:dir});
  await assert.rejects(access(join(dir,'dist','stale.js')));
});
