import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {OneDriveTestClient} from '../dist/src/cloud/onedrive-api.js';
import {LiveVault} from '../dist/src/cloud/live-vault.js';
import {emptyIndex} from '../dist/src/cloud/layout.js';
import {deriveCloudKey,freshSalt,encryptIndex} from '../dist/src/cloud/cloud-crypto.js';
import {clearFinancePerformance,financePerformanceReport} from '../dist/src/cloud/performance-diagnostics.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const GRAPH='https://graph.microsoft.com/v1.0';
function mockDrive(){
  const file={etag:'"1"',text:'ciphertext-v1',fail:false};
  const calls={metadata:0,downloads:0};
  const http=async (url,init={})=>{
    if(url===GRAPH+'/me/drive/special/approot')return Response.json({id:'root'});
    if(url===GRAPH+'/me/drive/items/root:/finance')return Response.json({id:'folder',folder:{}});
    if(url===GRAPH+'/me/drive/items/folder:/index.enc'){
      calls.metadata++;
      return Response.json({id:'index-item',eTag:file.etag,'@microsoft.graph.downloadUrl':'https://download.test/finance-index'});
    }
    if(url==='https://download.test/finance-index'){
      calls.downloads++;
      assert.equal(init.headers?.Authorization,undefined,'no token on signed download URL');
      assert.equal(init.credentials,'omit');
      if(file.fail)return new Response('unavailable',{status:503});
      return new Response(file.text,{status:200});
    }
    throw new Error(`Unexpected Graph route: ${url}`);
  };
  return {file,calls,client:new OneDriveTestClient('example-token',http)};
}

test('Concurrent identical encrypted reads use one Graph lookup and one download',async()=>{
  const {client,calls}=mockDrive();
  const [a,b,c]=await Promise.all([client.readFinanceIndex(),client.readFinanceIndex(),client.readFinanceIndex()]);
  assert.equal(a.text,'ciphertext-v1');assert.deepEqual(a,b);assert.deepEqual(b,c);
  assert.deepEqual(calls,{metadata:1,downloads:1});
});

test('Sequential reads always revalidate ETag but skip unchanged ciphertext download',async()=>{
  const {client,file,calls}=mockDrive();
  assert.equal((await client.readFinanceIndex()).text,'ciphertext-v1');
  assert.equal((await client.readFinanceIndex()).text,'ciphertext-v1');
  assert.deepEqual(calls,{metadata:2,downloads:1});
  file.etag='"2"';file.text='ciphertext-v2';
  assert.equal((await client.readFinanceIndex()).text,'ciphertext-v2');
  assert.deepEqual(calls,{metadata:3,downloads:2});
});

test('Failed changed ciphertext downloads do not fall back to old ETag cache',async()=>{
  const {client,file,calls}=mockDrive();
  await client.readFinanceIndex();
  file.etag='"2"';file.fail=true;
  await assert.rejects(client.readFinanceIndex(),/取得に失敗/);
  file.fail=false;file.text='ciphertext-v2';
  assert.equal((await client.readFinanceIndex()).text,'ciphertext-v2');
  assert.equal(calls.downloads,3);
});

test('Generation changes and new account clients never reuse in-memory ciphertext',async()=>{
  const {client,calls}=mockDrive();
  await client.readFinanceIndex();
  const generation='12345678-1234-1234-1234-123456789abc';
  client.setVaultDataSet(generation);
  await client.readFinanceIndex();
  assert.equal(calls.downloads,2);
  const other=mockDrive();
  await other.client.readFinanceIndex();
  assert.equal(other.calls.downloads,1);
});

test('Perf diagnostics expose only bounded timing names and Graph counters',async()=>{
  clearFinancePerformance();
  await mockDrive().client.readFinanceIndex();
  const report=financePerformanceReport();
  assert.ok(report.requests['graph.get']>=2);
  assert.equal(report.requests['graph.download'],1);
  assert.ok(report.phases['graph.request'].count>=2);
  assert.ok(report.phases['graph.encrypted-download'].count>=1);
  assert.doesNotMatch(JSON.stringify(report),/token|https:\/\/|index-item|ciphertext/i);
});

const PASSPHRASE='finance-performance-mock-passphrase';
test('Unlock fetches year records, rules and assets concurrently; refresh retains atomic state on failure',async()=>{
  const salt=freshSalt(),key=await deriveCloudKey(PASSPHRASE,salt);
  const encrypted=await encryptIndex(emptyIndex(),key,salt);
  let rulesStarted,assetsStarted;
  let started=0;let both;
  const bothStarted=()=>new Promise(resolve=>{both=resolve;started=0;});
  const pending=()=>{started++;if(started===2)both();return new Promise(resolve=>{
    if(!rulesStarted)rulesStarted=resolve;else assetsStarted=resolve;
  });};
  const source={
    failAsset:false,
    async readFinanceIndex(){return {text:encrypted,id:'index',etag:'"1"'};},
    setVaultDataSet(){},async listYearFiles(){return [];},
    async readMerchantRules(){return pending();},
    async readAssetSettings(){if(this.failAsset)throw new Error('asset read failed');return pending();},
  };
  const vault=new LiveVault(source);
  const gate=bothStarted();
  const unlock=vault.unlock(PASSPHRASE);
  let timer;
  try{
    await Promise.race([gate,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Readers were serial')),3000);})]);
  }finally{clearTimeout(timer);}
  rulesStarted(null);assetsStarted(null);
  await unlock;
  assert.deepEqual(vault.records(),[]);
  const original=vault.assetSettings();
  source.failAsset=true;
  await assert.rejects(vault.refresh(),/asset read failed/);
  assert.deepEqual(vault.assetSettings(),original,'failed refresh must not partially adopt data');
});
