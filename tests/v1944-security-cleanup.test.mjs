import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {LiveVault} from '../dist/src/cloud/live-vault.js';
import {OneDriveTestClient} from '../dist/src/cloud/onedrive-api.js';
import {parseIndexEnvelope} from '../dist/src/cloud/cloud-crypto.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const secret='secret vault phase 2026 test';
class MemoryClient {
  constructor(shared={items:new Map()},generation=null){this.shared=shared;this.generation=generation;}
  setVaultDataSet(id){this.generation=id;}
  forVaultDataSet(id){return new MemoryClient(this.shared,id);}
  key(name){return `${this.generation??'root'}:${name}`;}
  read(name){const key=this.key(name),item=this.shared.items.get(key);return item?{text:item.text,id:key,etag:`${item.rev}`}:null;}
  write(name,text,ref){const key=this.key(name),old=this.shared.items.get(key);if(ref&&(!old||ref.etag!==`${old.rev}`))throw new Error('etag mismatch');if(!ref&&old)throw new Error('exists');this.shared.items.set(key,{text,rev:(old?.rev??0)+1});return this.read(name);}
  async readFinanceIndex(){return new MemoryClient(this.shared).read('index');}
  async writeFinanceIndex(text,ref){new MemoryClient(this.shared).write('index',text,ref);}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async readMerchantRules(){return this.read('rules');}
  async writeMerchantRules(text,ref){return this.write('rules',text,ref);}
  async readAssetSettings(){return this.read('assets');}
  async writeAssetSettings(text,ref){return this.write('assets',text,ref);}
  async listMonthlyReports(){return [];}
  async listYearFiles(){return [...this.shared.items.entries()].filter(([key])=>key.startsWith(this.key('year:'))).map(([id,item])=>({year:id.split('year:')[1],id,etag:`${item.rev}`}));}
  async readYearVault(year){return this.read(`year:${year}`);}
  async readListedYearVault(file){return this.readYearVault(file.year);}
  async writeYearVault(year,text,ref){return this.write(`year:${year}`,text,ref);}
  async uploadDatedOriginal(id,text,month){this.write(`original:${month??'undated'}:${id}`,text,null);}
  async downloadDatedOriginal(id,month){return this.read(`original:${month??'undated'}:${id}`)?.text??null;}
  async listOldVaultGenerations(){
    const ids=new Set([...this.shared.items.keys()].map(x=>x.split(':')[0]).filter(x=>x!=='root'));
    return [...ids].map(name=>({id:name,name,etag:'1'}));
  }
  async listRetiredRootData(){return {legacyV1:[],snapshots:[]};}
  async listUnversionedFinanceFolders(){
    if(!this.shared.items.has('root:assets'))return [];
    return [{id:'root:assets',name:'settings',etag:`${this.shared.items.get('root:assets').rev}`}];
  }
  async listDatedOriginals(){
    const result=[];
    for(const [key,item] of this.shared.items){
      if(!key.startsWith(this.key('original:')))continue;
      const parts=key.split(':');
      const period=parts[2],uuid=parts[3];
      if(!uuid)continue;
      const [year,month]=period==='undated'?['undated','00']:period.split('-');
      result.push({id:key,name:`${uuid}.enc`,year,month,etag:`${item.rev}`});
    }
    return result;
  }
  async deleteCleanupItem(file){
    if(file.id===file.name){
      // A version folder deletes its entire contents in Graph.
      for(const key of [...this.shared.items.keys()])if(key.startsWith(`${file.name}:`))this.shared.items.delete(key);
    }else{
      if(`${this.shared.items.get(file.id)?.rev}`!==file.etag)throw new Error('etag mismatch');
      this.shared.items.delete(file.id);
    }
  }
}
const statement={provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'pdf',sourceName:'source.pdf',billingMonth:'2026-11',paymentDate:null,statedTotal:10,confirmation:'confirmed',warnings:[],rows:[{id:'r',usedOn:'2026-11-01',merchant:'test',amount:10}]};
const create=async()=>{const client=new MemoryClient();const vault=new LiveVault(client);await vault.create(secret);return {client,vault};};
test('cleanup only detects PDFs not referenced by any active statement',async()=>{
  const {client,vault}=await create();
  const uuid=crypto.randomUUID();
  await vault.saveBatch([{id:uuid,statement,source:{bytes:new Uint8Array([37,80,68,70]),mime:'application/pdf'}}]);
  const occupied=await vault.previewCleanup();
  assert.equal(occupied.unreferencedOriginalCount,0);
  await assert.rejects(vault.deletePreviewedCleanup({oldGenerations:false,unreferencedOriginals:false,unversionedFolders:false}),/削除対象/);
  await vault.delete(uuid);
  const plan=await vault.previewCleanup();
  assert.equal(plan.unreferencedOriginalCount,1);
  const result=await vault.deletePreviewedCleanup({oldGenerations:false,unreferencedOriginals:true,unversionedFolders:false});
  assert.equal(result,1);
  assert.equal((await client.listDatedOriginals()).length,0);
  assert.ok(await client.readFinanceIndex(),'never delete the active vault index');
});
test('a changed year revision invalidates a deletion preview',async()=>{
  const {client,vault}=await create();
  const uuid=crypto.randomUUID();
  await vault.saveBatch([{id:uuid,statement,source:{bytes:new Uint8Array([37,80,68,70]),mime:'application/pdf'}}]);
  await vault.delete(uuid);
  const plan=await vault.previewCleanup();assert.equal(plan.unreferencedOriginalCount,1);
  const old=client.read('year:2026');client.write('year:2026',old.text,{id:old.id,etag:old.etag});
  await assert.rejects(vault.deletePreviewedCleanup({oldGenerations:false,unreferencedOriginals:true,unversionedFolders:false}),/明細が更新/);
  assert.equal((await client.listDatedOriginals()).length,1);
});
test('only previous version directories can be deleted; current version survives',async()=>{
  const {client,vault}=await create();
  await vault.addBalanceSnapshot({id:'balance-cleanup-test',accountId:'rakuten-bank',balance:1000,observedAt:'2026-11-10T00:00:00.000Z'});
  await vault.changePassphrase(secret,'new passphrase for 2026');
  const firstId=parseIndexEnvelope((await client.readFinanceIndex()).text).dataSetId;
  await vault.changePassphrase('new passphrase for 2026','third passphrase for 2026');
  const secondId=parseIndexEnvelope((await client.readFinanceIndex()).text).dataSetId;
  const preview=await vault.previewCleanup();
  assert.equal(preview.generationCount,1);
  assert.equal(preview.legacyFolderCount,1);
  assert.notEqual(firstId,secondId);
  await vault.deletePreviewedCleanup({oldGenerations:true,unreferencedOriginals:false,unversionedFolders:false});
  assert.ok(!(await client.listOldVaultGenerations()).some(x=>x.name===firstId));
  assert.equal(parseIndexEnvelope((await client.readFinanceIndex()).text).dataSetId,secondId);
  assert.equal(vault.unlocked,true);
});
test('old unversioned folders are removable only after activating a versioned vault',async()=>{
  const {client,vault}=await create();
  await vault.addBalanceSnapshot({id:'balance-cleanup-test',accountId:'rakuten-bank',balance:1000,observedAt:'2026-11-10T00:00:00.000Z'});
  const activeRoot=await vault.previewCleanup();
  assert.equal(activeRoot.legacyFolderCount,0,'never delete folders used by an unversioned live vault');
  await vault.changePassphrase(secret,'new passphrase for 2026');
  const preview=await vault.previewCleanup();
  assert.equal(preview.legacyFolderCount,1);
  const deleted=await vault.deletePreviewedCleanup({oldGenerations:false,unreferencedOriginals:false,unversionedFolders:true});
  assert.equal(deleted,1);
  assert.ok(!(await client.listUnversionedFinanceFolders()).length);
  assert.equal(vault.assetSettings().snapshots[0].balance,1000);
  assert.ok(await client.readFinanceIndex(),'index is not an eligible legacy cleanup target');
});

test('probe download caps bytes even if Content-Length is missing or wrong',async()=>{
  const items=new Map();
  const fetcher=async(url)=>{
    if(url==='https://download.test/probe')return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(24001));controller.close();}}),{status:200,headers:{'Content-Length':'1'}});
    throw new Error(`unexpected URL ${url}`);
  };
  const client=new OneDriveTestClient('token',fetcher);
  client.appFolderId=async()=> 'someid';
  client.graph=async()=>new Response(JSON.stringify({id:'probe', '@microsoft.graph.downloadUrl':'https://download.test/probe'}),{status:200});
  await assert.rejects(client.downloadEncryptedProbe(),/サイズ上限/);
  assert.equal(items.size,0);
});
test('settings and lock notification controls are present in source',()=>{
  const html=readFileSync('public/index.html','utf8');
  const main=readFileSync('src/main.ts','utf8');
  for(const id of ['cloud-cleanup-scan','cloud-cleanup-originals','cloud-cleanup-versions','cloud-cleanup-backup','cloud-cleanup-delete'])
    assert.ok(html.includes(`id="${id}"`),id);
  assert.match(main,/addEventListener\('storage',[\s\S]*CROSS_TAB_LOCK_KEY/);
  assert.match(main,/onLock:\(\)=>\{[\s\S]*broadcastVaultLock\(\)/);
});

test('old v1 and backups are only deleted by explicit selection, not by other cleanup choices',async()=>{
  const {client,vault}=await create();
  const old={id:'old-root-v1',name:'finance-v1-vault.enc',etag:'v1'};
  const oldOriginals={id:'old-v1-originals',name:'finance-v1-originals',etag:'v1orig'};
  const s1={id:'snapshot-A',name:'finance-vault-2026-11-15T01-00-00-000Z-11111111-1111-4111-8111-111111111111.enc.json',etag:'s1',size:128,createdDateTime:'2026-11-15T01:00:00.000Z'};
  const s2={id:'snapshot-B',name:'finance-vault-2026-11-16T01-00-00-000Z-22222222-2222-4222-8222-222222222222.enc.json',etag:'s2',size:128,createdDateTime:'2026-11-16T01:00:00.000Z'};
  let root={legacyV1:[old,oldOriginals],snapshots:[s1,s2]};
  const deleted=[];
  client.listRetiredRootData=async()=>root;
  const originalDelete=client.deleteCleanupItem.bind(client);
  client.deleteCleanupItem=async file=>{
    if(file.id===old.id||file.id===oldOriginals.id||file.id===s1.id||file.id===s2.id){
      deleted.push(file.id);
      root={legacyV1:root.legacyV1.filter(x=>x.id!==file.id),snapshots:root.snapshots.filter(x=>x.id!==file.id)};
    }else await originalDelete(file);
  };
  const preview=await vault.previewCleanup();
  assert.equal(preview.legacyV1Count,2);
  assert.equal(preview.snapshots.length,2);
  assert.deepEqual(deleted,[]);
  await assert.rejects(vault.deletePreviewedCleanup({oldGenerations:false,unreferencedOriginals:false,unversionedFolders:false,snapshotIds:['unexpected']}),/確認していない/);
  assert.deepEqual(deleted,[]);
  await vault.previewCleanup();
  assert.equal(await vault.deletePreviewedCleanup({oldGenerations:false,unreferencedOriginals:false,unversionedFolders:false,legacyV1:true,snapshotIds:[s1.id]}),3);
  assert.deepEqual(deleted,[old.id,oldOriginals.id,s1.id]);
  assert.deepEqual(root.snapshots.map(x=>x.id),[s2.id]);
  assert.ok(await client.readFinanceIndex());
});

test('a snapshot ETag change after preview blocks deletion without touching files',async()=>{
  const {client,vault}=await create();
  const old={id:'snapshot-old',name:'finance-vault-2026-11-15T01-00-00-000Z-11111111-1111-4111-8111-111111111111.enc.json',etag:'1',size:100,createdDateTime:'2026-11-15T01:00:00.000Z'};
  let revision=old;
  client.listRetiredRootData=async()=>({legacyV1:[],snapshots:[revision]});
  client.deleteCleanupItem=async()=>{throw new Error('never reached');};
  await vault.previewCleanup();
  revision={...old,etag:'2'};
  await assert.rejects(vault.deletePreviewedCleanup({oldGenerations:false,unreferencedOriginals:false,unversionedFolders:false,snapshotIds:[old.id]}),/スナップショットが更新/);
});

test('cleanup UI requires individual snapshot selection and separately confirms legacy v1',()=>{
  const html=readFileSync('public/index.html','utf8');
  const settings=readFileSync('src/cloud/cloud-settings.ts','utf8');
  const graph=readFileSync('src/cloud/onedrive-api.ts','utf8');
  for(const id of ['cloud-cleanup-v1','cloud-cleanup-snapshot-list','cloud-cleanup-v1-count'])assert.ok(html.includes(`id="${id}"`));
  assert.match(settings,/snapshotList\.addEventListener\('change'/);
  assert.match(settings,/snapshotIds:selectedSnapshots\(\)/);
  assert.match(graph,/item\.name==='finance-v1-vault\.enc'/);
  assert.match(graph,/isSnapshotName\(item\.name!/);
  assert.match(graph,/If-Match/);
});
