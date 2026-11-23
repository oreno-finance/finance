import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {LiveVault} from '../dist/src/cloud/live-vault.js';
import {GraphError,OneDriveTestClient} from '../dist/src/cloud/onedrive-api.js';
import {emptyAssets} from '../dist/src/cloud/assets.js';
import {emptyIndex} from '../dist/src/cloud/layout.js';
import {deriveCloudKey,encryptIndex,encryptAssets,decryptAssets,freshSalt} from '../dist/src/cloud/cloud-crypto.js';
import {financePerformanceReport,clearFinancePerformance} from '../dist/src/cloud/performance-diagnostics.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const passphrase='finance-phase-two-test-only';
const recurring=(id,amount=1000)=>({id,name:'テスト用保険料',amount,kind:'expense',
  fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',
  dayOfMonth:27,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,
  categoryId:null,enabled:true});

async function vaultDriver(){
  const salt=freshSalt(),key=await deriveCloudKey(passphrase,salt);
  const state={index:await encryptIndex(emptyIndex(),key,salt),
    assetCipher:await encryptAssets(emptyAssets(),key,salt),etag:'"1"',writes:0,indexReads:0,
    writeConflict:false};
  const driver={
    setVaultDataSet(){},
    async readFinanceIndex(){state.indexReads++;return {text:state.index,id:'index-id',etag:'"1"'};},
    async listYearFiles(){return [];},
    async readMerchantRules(){return null;},
    async readAssetSettings(){return {text:state.assetCipher,id:'asset-id',etag:state.etag};},
    async writeAssetSettings(cipher,ref){
      assert.equal(ref?.id,'asset-id');
      assert.equal(ref?.etag,state.etag);
      if(state.writeConflict){state.writeConflict=false;throw new GraphError(412,'preconditionFailed');}
      const priorRevision=Number(state.etag.replace(/[^0-9]/g,''))||0;
      state.writes++;state.assetCipher=cipher;
      state.etag=`"${priorRevision+1}"`;
      return {id:'asset-id',etag:state.etag};
    },
  };
  const vault=new LiveVault(driver);
  await vault.unlock(passphrase);
  return {state,driver,key,salt,vault};
}

test('refresh verifies index once and still rejects cross-generation changes',async()=>{
  const {vault,state,driver,key,salt}=await vaultDriver();
  state.indexReads=0;
  await vault.refresh();
  assert.equal(state.indexReads,1,'no redundant generation-check GET before readCurrent');
  const otherSalt=freshSalt();
  state.index=await encryptIndex(emptyIndex(),key,otherSalt);
  await assert.rejects(vault.refresh(),/異なる保管庫|パスフレーズ|世代/);
  assert.equal(vault.unlocked,true);
  assert.deepEqual(vault.assetSettings().recurring,[],'failed refresh must not publish partial data');
});

test('manual lock during refresh leaves the vault locked without publishing stale records',async()=>{
  const {vault,driver,state}=await vaultDriver();
  let beginReading;
  let resume;
  const started=new Promise(resolve=>{beginReading=resolve;});
  const original=driver.readAssetSettings;
  driver.readAssetSettings=async()=>{
    beginReading();
    await new Promise(resolve=>{resume=resolve;});
    return original();
  };
  const refresh=vault.refresh();
  await started;
  vault.lock();
  resume();
  await assert.rejects(refresh,/世代|保管庫|変更/);
  assert.equal(vault.unlocked,false,'manual lock must remain effective');
});

test('unchanged asset ETag reuses verified baseline, writes with precondition, and reports saved time',async()=>{
  clearFinancePerformance();
  const {vault,state,key,salt}=await vaultDriver();
  // The server-supplied ETag is authoritative. A same-ETag document should not
  // need to be decrypted a second time during the write path.
  state.assetCipher='unreadable-ciphertext-with-unchanged-etag';
  await vault.upsertRecurring(recurring('insurance-0001'));
  assert.equal(state.writes,1);
  const saved=await decryptAssets(state.assetCipher,key,salt);
  assert.equal(saved.recurring.length,1);
  assert.equal(saved.recurring[0].amount,1000);
  const measurements=financePerformanceReport();
  assert.equal(measurements.phases['vault.asset-commit'].count,1);
  assert.ok(measurements.phases['vault.asset-commit'].totalMs>=0);
});

test('changed ETag always triggers remote decrypt and conflict-aware merge',async()=>{
  const {vault,state,key,salt}=await vaultDriver();
  const edited={...emptyAssets(),birthMonth:'2003-03'};
  state.assetCipher=await encryptAssets(edited,key,salt);
  state.etag='"2"';
  await vault.upsertRecurring(recurring('insurance-0002'));
  const stored=await decryptAssets(state.assetCipher,key,salt);
  assert.equal(stored.birthMonth,'2003-03','remote unrelated change must survive');
  assert.equal(stored.recurring[0].id,'insurance-0002');
  const written=state.writes;
  state.assetCipher='invalid-remote-ciphertext';state.etag='"99"';
  await assert.rejects(vault.upsertRecurring(recurring('insurance-0003')));
  assert.equal(state.writes,written,'never replace a changed but undecryptable remote file');
});

test('412 conflict retries with a fresh remote read rather than blind overwrite',async()=>{
  const {vault,state,key,salt}=await vaultDriver();
  state.writeConflict=true;
  await vault.upsertRecurring(recurring('insurance-0004'));
  const saved=await decryptAssets(state.assetCipher,key,salt);
  assert.equal(saved.recurring.length,1);
  assert.equal(state.writes,1);
});

test('encrypted uploads retain If-Match upload sessions and record upload chunks',async()=>{
  clearFinancePerformance();
  const graph='https://graph.microsoft.com/v1.0';
  const seen=[];
  const fake=async(url,init={})=>{
    seen.push({url,method:init.method??'GET',headers:init.headers??{}});
    if(url===graph+'/me/drive/special/approot')return Response.json({id:'root'});
    if(url===graph+'/me/drive/items/root:/finance')return Response.json({id:'finance-folder',folder:{}});
    if(url===graph+'/me/drive/items/finance-folder:/index.enc:/createUploadSession'){
      assert.equal(init.method,'POST');
      return Response.json({uploadUrl:'https://example.test/upload-session'});
    }
    if(url==='https://example.test/upload-session'){
      assert.equal(init.method,'PUT');
      assert.equal(init.credentials,'omit');
      assert.equal(init.headers?.Authorization,undefined);
      return Response.json({id:'encrypted-index',eTag:'"1"'});
    }
    throw new Error('Unexpected URL type');
  };
  const client=new OneDriveTestClient('fake-token',fake);
  await client.writeFinanceIndex('encrypted-only',null);
  assert.equal(seen.filter(x=>x.method==='POST').length,1);
  assert.equal(seen.filter(x=>x.method==='PUT').length,1);
  assert.equal(financePerformanceReport().requests['graph.upload-chunk'],1);
  assert.equal(financePerformanceReport().phases['vault.encrypted-upload'].count,1);
  assert.ok(!seen.some(x=>x.url.endsWith('/content')),'no unverified direct content PUT');
});

test('phase two never disables generation checks, encryption, write uncertainty or merge protections',()=>{
  const source=readFileSync(new URL('../src/cloud/live-vault.ts',import.meta.url),'utf8');
  const api=readFileSync(new URL('../src/cloud/onedrive-api.ts',import.meta.url),'utf8');
  assert.match(source,/private async assertActiveGeneration\(\)/);
  assert.match(source,/const collisions=detectAssetsEditCollisions\(base,local,current\)/);
  assert.match(source,/const collisions=detectRuleEditCollisions\(base,local,remoteDoc\)/);
  assert.match(source,/this\.uncertainWrite\('assets',error\)/);
  assert.match(source,/this\.uncertainWrite\('rules',error\)/);
  assert.match(source,/await this\.client\.writeYearVault\(year,await encryptDocument\(/);
  assert.match(api,/uploadSession\(path,bytes,existing\?\.etag\)/);
  assert.match(api,/'If-Match':etag/);
});
