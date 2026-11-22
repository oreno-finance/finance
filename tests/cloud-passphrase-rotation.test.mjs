import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {LiveVault} from '../dist/src/cloud/live-vault.js';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
import {parseIndexEnvelope, decryptIndex, deriveCloudKey} from '../dist/src/cloud/cloud-crypto.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const oldPass='correct horse battery staple old';
const nextPass='correct horse battery staple NEW';
const thirdPass='even newer a long phrase 2027';
const statement=(month='2026-11',kind='paste')=>({provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:kind,sourceName:'file',billingMonth:month,paymentDate:null,statedTotal:100,confirmation:'confirmed',warnings:[],rows:[{id:'row1',usedOn:'2026-11-01',merchant:'TEST',amount:100}]});
class FakeVersionedGraph{
  constructor(store,id=null){this.store=store;this.id=id;}
  setVaultDataSet(id){this.id=id;}
  forVaultDataSet(id){return new FakeVersionedGraph(this.store,id);}
  key(name){return `${this.id??'legacy'}:${name}`;}
  read(name){const v=this.store.files.get(this.key(name));return v?{text:v.text,id:this.key(name),etag:`${v.rev}`}:null;}
  write(name,text,existing){
    if(this.store.failWrite?.(this.key(name)))throw new Error('network timeout');
    const k=this.key(name),old=this.store.files.get(k);
    if((existing&&(!old||existing.etag!==`${old.rev}`))||(!existing&&old))throw new GraphError(412,'etag');
    const rev=(old?.rev??0)+1;
    this.store.files.set(k,{text,rev});return {id:k,etag:`${rev}`};
  }
  async readFinanceIndex(){return new FakeVersionedGraph(this.store).read('index');}
  async writeFinanceIndex(cipher,ref){const result=new FakeVersionedGraph(this.store).write('index',cipher,ref);if(this.store.failAfterIndexWrite)throw new Error('response lost after committed upload');return result;}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async listYearFiles(){return [...this.store.files.entries()].filter(([k])=>k.startsWith(this.key('year:'))).map(([k,v])=>({year:k.split('year:')[1],id:k,etag:`${v.rev}`}));}
  async readYearVault(year){return this.read(`year:${year}`);}
  async writeYearVault(year,cipher,ref){return this.write(`year:${year}`,cipher,ref);}
  async readListedYearVault(file){return this.readYearVault(file.year);}
  async readMerchantRules(){return this.read('rules');}
  async writeMerchantRules(cipher,ref){return this.write('rules',cipher,ref);}
  async readAssetSettings(){return this.read('assets');}
  async writeAssetSettings(cipher,ref){return this.write('assets',cipher,ref);}
  async uploadDatedOriginal(id,cipher,month){this.write(`original:${month??'undated'}:${id}`,cipher,null);}
  async downloadDatedOriginal(id,month){const file=this.read(`original:${month??'undated'}:${id}`);if(!file)throw new Error('original missing');return file.text;}
}
const setup=()=>{const store={files:new Map(),failWrite:null};const graph=new FakeVersionedGraph(store);return {store,graph,vault:new LiveVault(graph)};};
const snapshot={id:'snapshot-rotation',accountId:'rakuten-bank',balance:123456,observedAt:'2026-11-16T00:00:00.000Z'};

test('rotation stages encrypted statements, original PDF, rules and assets before switching index',async()=>{
  const {store,vault}=setup();await vault.create(oldPass);
  const pdf=new Uint8Array([37,80,68,70,0,255,123]);
  await vault.saveBatch([{id:'doc2025',statement:statement('2025-12')},{id:'doc2026',statement:statement('2026-11','pdf'),source:{bytes:pdf,mime:'application/pdf'}}]);
  await vault.addBalanceSnapshot(snapshot);
  await vault.upsertMerchantRule({id:'rotation-rule',pattern:'TEST',mode:'exact',cardId:null,displayName:'テスト',categoryId:null,priority:100,enabled:true});
  const oldData=new Map(store.files);
  const steps=[];
  await vault.changePassphrase(oldPass,nextPass,s=>steps.push(s));
  assert.match(steps.at(-1),/切り替え中/);
  assert.equal(vault.records().length,2);
  assert.equal(vault.assetSettings().snapshots[0].balance,123456);
  assert.equal(vault.merchantRules().length,1);
  assert.deepEqual(await vault.original('doc2026'),pdf);
  const index=parseIndexEnvelope((await new FakeVersionedGraph(store).readFinanceIndex()).text);
  assert.equal(index.format,'finance-cloud-index-envelope-v2');
  assert.ok(index.dataSetId);
  assert.deepEqual([...oldData].filter(([k])=>k.startsWith('legacy:')&&!k.endsWith(':index')), [...store.files].filter(([k])=>k.startsWith('legacy:')&&!k.endsWith(':index')),'old ciphertext is intact');
  assert.ok([...store.files.keys()].filter(k=>k.startsWith(`${index.dataSetId}:`)).length>=5);
  await assert.rejects(new LiveVault(new FakeVersionedGraph(store)).unlock(oldPass),/パスフレーズ/);
  const second=new LiveVault(new FakeVersionedGraph(store));await second.unlock(nextPass);
  assert.equal(second.records().length,2);
  assert.deepEqual(await second.original('doc2026'),pdf);
  await second.saveBatch([{id:'newDoc',statement:statement('2027-01')}]);
  assert.ok(store.files.has(`${index.dataSetId}:year:2027`),'future writes must remain within the new generation');
  const index2=parseIndexEnvelope((await new FakeVersionedGraph(store).readFinanceIndex()).text);
  assert.equal(index2.dataSetId,index.dataSetId);
});

test('incorrect old password and a too-short new password do not alter OneDrive',async()=>{
  const {store,vault}=setup();await vault.create(oldPass);await vault.addBalanceSnapshot(snapshot);
  const before=[...store.files];
  await assert.rejects(vault.changePassphrase('wrong old password',nextPass),/パスフレーズ/);
  await assert.rejects(vault.changePassphrase(oldPass,'123'),/12文字/);
  assert.deepEqual([...store.files],before);
  assert.equal(vault.assetSettings().snapshots.length,1);
});

test('upload failure does not publish new index; old password and all data survive',async()=>{
  const {store,vault}=setup();await vault.create(oldPass);
  await vault.saveBatch([{id:'doc1',statement:statement('2025-12')},{id:'doc2',statement:statement('2026-11')}]);
  const oldIndex=(await new FakeVersionedGraph(store).readFinanceIndex()).text;
  store.failWrite=k=>k.endsWith('year:2026')&&!k.startsWith('legacy:');
  await assert.rejects(vault.changePassphrase(oldPass,nextPass),/network timeout/);
  assert.equal((await new FakeVersionedGraph(store).readFinanceIndex()).text,oldIndex);
  store.failWrite=null;
  const oldReader=new LiveVault(new FakeVersionedGraph(store));await oldReader.unlock(oldPass);
  assert.equal(oldReader.records().length,2);
  await oldReader.changePassphrase(oldPass,nextPass);
  const newReader=new LiveVault(new FakeVersionedGraph(store));await newReader.unlock(nextPass);
  assert.equal(newReader.records().length,2);
});

test('index write failure keeps existing vault and old passphrase available',async()=>{
  const {store,vault}=setup();await vault.create(oldPass);
  const originalIndex=(await new FakeVersionedGraph(store).readFinanceIndex()).text;
  store.failWrite=k=>k==='legacy:index';
  await assert.rejects(vault.changePassphrase(oldPass,nextPass),/network timeout/);
  assert.equal((await new FakeVersionedGraph(store).readFinanceIndex()).text,originalIndex);
  assert.equal(vault.unlocked,true);
  const other=new LiveVault(new FakeVersionedGraph(store));await other.unlock(oldPass);
  assert.equal(other.unlocked,true);
});

test('another device with old key must not overwrite new generation',async()=>{
  const {store,vault}=setup();await vault.create(oldPass);
  const stale=new LiveVault(new FakeVersionedGraph(store));await stale.unlock(oldPass);
  await vault.changePassphrase(oldPass,nextPass);
  await assert.rejects(stale.saveBatch([{id:'stale',statement:statement()}]),/パスフレーズが変更/);
  await assert.rejects(stale.refresh(),/パスフレーズが変更/);
  await assert.rejects(stale.addBalanceSnapshot(snapshot),/パスフレーズが変更/);
  assert.ok(![...store.files.keys()].some(k=>k.endsWith('year:2026')));
});

test('second rotation reencrypts again, preserves originals and invalidates previous password',async()=>{
  const {store,vault}=setup();await vault.create(oldPass);
  await vault.addBalanceSnapshot(snapshot);
  await vault.changePassphrase(oldPass,nextPass);
  const first=parseIndexEnvelope((await new FakeVersionedGraph(store).readFinanceIndex()).text).dataSetId;
  await vault.changePassphrase(nextPass,thirdPass);
  const second=parseIndexEnvelope((await new FakeVersionedGraph(store).readFinanceIndex()).text).dataSetId;
  assert.notEqual(first,second);
  await assert.rejects(new LiveVault(new FakeVersionedGraph(store)).unlock(nextPass),/パスフレーズ/);
  const newer=new LiveVault(new FakeVersionedGraph(store));await newer.unlock(thirdPass);
  assert.equal(newer.assetSettings().snapshots[0].balance,123456);
});

test('remembered browser key is invalid after rotation; a newly verified key is usable',async()=>{
  const {store,vault}=setup();await vault.create(oldPass);
  const initial=vault.verifiedBrowserKey();
  assert.equal(initial.key.extractable,false);
  await vault.changePassphrase(oldPass,nextPass);
  const oldBrowser=new LiveVault(new FakeVersionedGraph(store));
  await assert.rejects(oldBrowser.unlockBrowserKey(initial),/generation|変更/);
  const newBrowser=new LiveVault(new FakeVersionedGraph(store));
  await newBrowser.unlockBrowserKey(vault.verifiedBrowserKey());
  assert.equal(newBrowser.unlocked,true);
});

test('password rotation UI is present and readable with masked password fields',async()=>{
  const {readFile}=await import('node:fs/promises');
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  for(const id of ['cloud-rotate-form','cloud-current-secret','cloud-next-secret','cloud-next-confirm','cloud-rotate-submit','cloud-rotate-status'])
    assert.ok(html.includes(`id="${id}"`),`missing ${id}`);
  assert.match(html,/id="cloud-current-secret" type="password"/);
});


test('a completed index upload with lost HTTP response is detected, requiring the new passphrase',async()=>{
  const {store,vault}=setup();await vault.create(oldPass);
  store.failAfterIndexWrite=true;
  await assert.rejects(vault.changePassphrase(oldPass,nextPass),/切り替えは完了/);
  assert.equal(vault.unlocked,false,'do not retain an unlocked, stale object after uncertain response');
  const newer=new LiveVault(new FakeVersionedGraph(store));await newer.unlock(nextPass);
  assert.equal(newer.unlocked,true);
  await assert.rejects(new LiveVault(new FakeVersionedGraph(store)).unlock(oldPass),/パスフレーズ/);
});

test('concurrent modification discovered at final check aborts generation activation',async()=>{
  const {store,vault}=setup();await vault.create(oldPass);
  await vault.saveBatch([{id:'doc',statement:statement()}]);
  const original=(await new FakeVersionedGraph(store).readFinanceIndex()).text;
  let touched=false;
  await assert.rejects(vault.changePassphrase(oldPass,nextPass,message=>{
    if(!touched&&message.includes('再暗号化して保存中… 1/')){
      touched=true;
      const v=store.files.get('legacy:year:2026');
      store.files.set('legacy:year:2026',{text:v.text,rev:v.rev+1});
    }
  }),/作業中に明細が更新/);
  assert.equal((await new FakeVersionedGraph(store).readFinanceIndex()).text,original);
  const oldReader=new LiveVault(new FakeVersionedGraph(store));await oldReader.unlock(oldPass);
  assert.equal(oldReader.records().length,1);
});
