import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {LiveVault} from './helpers/coordinated-vault.mjs';
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
  assert.equal(index.format,'finance-cloud-index-envelope-v4');
  assert.ok(index.dataSetId);
  assert.deepEqual([...oldData].filter(([k])=>k.startsWith('legacy:')&&!k.endsWith(':index')), [...store.files].filter(([k])=>k.startsWith('legacy:')&&!k.endsWith(':index')),'old ciphertext is intact');
  assert.ok([...store.files.keys()].filter(k=>k.startsWith(`${index.dataSetId}:`)).length>=5);
  // Concurrent authenticated reads may reject in different orders. All must fail closed.
  const beforeRejectedUnlock=new Map(store.files);
  const rejectedVault=new LiveVault(new FakeVersionedGraph(store));
  await assert.rejects(rejectedVault.unlock(oldPass),/パスフレーズ|復号または整合性確認に失敗/);
  assert.equal(rejectedVault.unlocked,false);
  assert.throws(()=>rejectedVault.records(),/ロックされています/);
  assert.deepEqual(store.files,beforeRejectedUnlock);
  const second=new LiveVault(new FakeVersionedGraph(store));await second.unlock(nextPass);
  assert.equal(second.records().length,2);
  assert.deepEqual(await second.original('doc2026'),pdf);
  await second.saveBatch([{id:'newDoc',statement:statement('2027-01')}]);
  assert.ok(store.files.has(`${index.dataSetId}:year:2027`),'future writes must remain within the new generation');
  const index2=parseIndexEnvelope((await new FakeVersionedGraph(store).readFinanceIndex()).text);
  assert.equal(index2.dataSetId,index.dataSetId);assert.equal(index2.format,index.format);
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
  const rejected=new LiveVault(new FakeVersionedGraph(store));
  await assert.rejects(rejected.unlock(nextPass),/パスフレーズ|復号または整合性確認に失敗/);
  assert.equal(rejected.unlocked,false);
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

const deferred=()=>{let enter,release;const entered=new Promise(r=>{enter=r;}),done=new Promise(r=>{release=r;});return {entered,release,wait:async()=>{enter();await done;}};};
test('Phase 6E: 再暗号化の最終確認後も別端末の書込みは索引切替まで拒否する',async()=>{
 const {store,graph,vault}=setup();await vault.create(oldPass);await vault.addBalanceSnapshot(snapshot);
 const peer=new LiveVault(new FakeVersionedGraph(store));await peer.unlock(oldPass);
 const oldIndex=await graph.readFinanceIndex();const barrier=deferred(),write=graph.writeFinanceIndex.bind(graph);
 graph.writeFinanceIndex=async(...args)=>{await barrier.wait();return write(...args);};
 const rotating=vault.changePassphrase(oldPass,nextPass);await barrier.entered;
 try{
   await assert.rejects(peer.addBalanceSnapshot({...snapshot,id:'additional',balance:2000}),/別の端末/);
   await assert.rejects(peer.upsertMerchantRule({id:'extra-rule',pattern:'OTHER',mode:'exact',cardId:null,displayName:'TEST',categoryId:null,priority:100,enabled:true}),/別の端末/);
   await assert.rejects(peer.saveBatch([{id:'new-record',statement:statement()}]),/別の端末/);
   assert.equal((await graph.readFinanceIndex()).text,oldIndex.text);
 }finally{barrier.release();await rotating;}
 const current=new LiveVault(new FakeVersionedGraph(store));await current.unlock(nextPass);
 assert.deepEqual(current.assetSettings().snapshots,[snapshot]);assert.equal(current.records().length,0);
 await assert.rejects(peer.addBalanceSnapshot({...snapshot,id:'additional',balance:2000}),/パスフレーズが変更/);
 await current.addBalanceSnapshot({...snapshot,id:'additional',balance:2000});assert.equal(current.assetSettings().snapshots.length,2);
});
test('Phase 6E: 保存中には再暗号化を開始せず、保存後の再暗号化は変更を維持する',async()=>{
 const {store,graph,vault}=setup();await vault.create(oldPass);
 const peer=new LiveVault(new FakeVersionedGraph(store));await peer.unlock(oldPass);
 const barrier=deferred(),write=graph.writeAssetSettings.bind(graph);graph.writeAssetSettings=async(...args)=>{await barrier.wait();return write(...args);};
 const saving=vault.addBalanceSnapshot(snapshot);await barrier.entered;
 try{await assert.rejects(peer.changePassphrase(oldPass,nextPass),/別の端末/);}
 finally{barrier.release();await saving;}
 await peer.changePassphrase(oldPass,nextPass);assert.deepEqual(peer.assetSettings().snapshots,[snapshot]);
});
test('Phase 6E: 最終切替の直前でロックされた場合は旧索引のまま停止する',async()=>{
 const {store,graph,vault}=setup();await vault.create(oldPass);await vault.addBalanceSnapshot(snapshot);const prior=await graph.readFinanceIndex();
 await assert.rejects(vault.changePassphrase(oldPass,nextPass,message=>{if(message.includes('切り替え中'))vault.lock();}),/ロック/);
 assert.equal(vault.unlocked,false);assert.equal((await graph.readFinanceIndex()).text,prior.text);
 const peer=new LiveVault(new FakeVersionedGraph(store));await peer.unlock(oldPass);assert.deepEqual(peer.assetSettings().snapshots,[snapshot]);
});
test('Phase 6E: 索引送信後のロックでは切替完了後も自動再解除しない',async()=>{
 const {store,graph,vault}=setup();await vault.create(oldPass);await vault.addBalanceSnapshot(snapshot);
 const barrier=deferred(),write=graph.writeFinanceIndex.bind(graph);graph.writeFinanceIndex=async(...args)=>{const result=await write(...args);await barrier.wait();return result;};
 const operation=vault.changePassphrase(oldPass,nextPass),rejected=assert.rejects(operation,error=>error.name==='CloudWriteUncertainError'&&/ロック/.test(error.message));
 await barrier.entered;vault.lock();barrier.release();await rejected;assert.equal(vault.unlocked,false);
 const peer=new LiveVault(new FakeVersionedGraph(store));await peer.unlock(nextPass);assert.deepEqual(peer.assetSettings().snapshots,[snapshot]);
});
test('Phase 6E: 旧索引の初回管理操作はv3への切替のみ、データ再暗号化は再操作時に行う',async()=>{
 const {graph,vault,store}=setup();await vault.create(oldPass);await vault.addBalanceSnapshot(snapshot);
 const {encryptIndex}=await import('../dist/src/cloud/cloud-crypto.js');
 const {key,salt}=vault.verifiedBrowserKey();const prior=await graph.readFinanceIndex(),decoded=await decryptIndex(parseIndexEnvelope(prior.text),key);
 await graph.writeFinanceIndex(await encryptIndex(decoded,key,salt),prior); // old supported layout
 const oldAssets=store.files.get('legacy:assets').text;
 await assert.rejects(vault.changePassphrase(oldPass,nextPass),/新版の保管庫索引に更新/);
 const newIndex=parseIndexEnvelope((await graph.readFinanceIndex()).text);
 assert.equal(newIndex.format,'finance-cloud-index-envelope-v3');assert.equal(newIndex.dataSetId,undefined);assert.deepEqual(await decryptIndex(newIndex,key),decoded);
 assert.equal(store.files.get('legacy:assets').text,oldAssets);
 assert.ok(![...store.files.keys()].some(k=>!k.startsWith('legacy:')));
 await assert.rejects(decryptIndex({...newIndex,format:'finance-cloud-index-envelope-v1'},key));
 await assert.rejects(decryptIndex({...newIndex,dataSetId:crypto.randomUUID()},key));
 await vault.changePassphrase(oldPass,nextPass);assert.deepEqual(vault.assetSettings().snapshots,[snapshot]);
});

test('M203: rotation refuses a swapped authenticated original before publishing the new index',async()=>{
  const {store,graph,vault}=setup();await vault.create(oldPass);
  await vault.saveBatch([{id:'a',statement:statement('2026-11','pdf'),source:{bytes:new Uint8Array([1,2]),mime:'application/pdf'}},{id:'b',statement:statement('2026-10','pdf'),source:{bytes:new Uint8Array([3,4]),mime:'application/pdf'}}]);
  const a=vault.records().find(r=>r.id==='a'),b=vault.records().find(r=>r.id==='b');
  const index=(await graph.readFinanceIndex()).text;
  store.files.set(graph.key(`original:${a.originalMonth}:${a.originalId}`),store.files.get(graph.key(`original:${b.originalMonth}:${b.originalId}`)));
  await assert.rejects(vault.changePassphrase(oldPass,nextPass),/一致しません/);
  assert.equal((await graph.readFinanceIndex()).text,index);
  const reader=new LiveVault(graph);await reader.unlock(oldPass);assert.equal(reader.records().length,2);
});
