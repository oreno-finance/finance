import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { LiveVault } from './helpers/coordinated-vault.mjs';
import { GraphError } from '../dist/src/cloud/onedrive-api.js';
import { emptyDocument } from '../dist/src/cloud/merge.js';
import { encryptDocument, deriveCloudKey, freshSalt } from '../dist/src/cloud/cloud-crypto.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const secret='password-of-test-12345';
const statement=(month='2026-11', merchant='base')=>({provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'web',billingMonth:month,paymentDate:null,statedTotal:100,confirmation:'confirmed',warnings:[],rows:[{id:'r',usedOn:'2026-11-01',merchant,amount:100}]});

class MockGraph {
  constructor(store){this.store=store;this.failYear=null;this.failIndex=false;this.calls=[];}
  file(kind,key){return this.store.files.get(`${kind}:${key}`)??null;}
  read(kind,key){const data=this.file(kind,key);if(kind==='year')this.calls.push(`read:${key}`);return data?{text:data.text,id:`${kind}-${key}`,etag:`"${data.revision}"`}:null;}
  write(kind,key,text,ref){
    const old=this.file(kind,key);
    if(ref?(!old||ref.etag!==`"${old.revision}"`):!!old)throw new GraphError(412,'etagMismatch');
    const revision=(old?.revision??0)+1;this.store.files.set(`${kind}:${key}`,{text,revision});
    this.calls.push(`${kind}:${key}`);
  }
  async readFinanceIndex(){return this.read('index','finance');}
  async writeFinanceIndex(text,ref){if(this.failIndex)throw new Error('simulated index outage');this.write('index','finance',text,ref);}
  async listYearFiles(){return [...this.store.files.keys()].filter(x=>x.startsWith('year:')).map(x=>({year:x.slice(5),id:`year-${x.slice(5)}`,etag:`"${this.file('year',x.slice(5)).revision}"`}));}
  async listYearBuckets(){return (await this.listYearFiles()).map(x=>x.year);}
  async readYearVault(year){return this.read('year',year);}
  async writeYearVault(year,text,ref){if(year===this.failYear)throw new Error('simulated year outage');this.write('year',year,text,ref);}
  async readLiveVault(){return this.read('legacy','root');}
  async writeLiveVault(text,ref){this.write('legacy','root',text,ref);}
  async ensurePayrollNamespace(){this.store.payroll=true;}
  async uploadDatedOriginal(id,text,month){const k=`${month??'undated'}:${id}`;if(this.store.originals.has(k))throw new GraphError(409,'nameAlreadyExists');this.store.originals.set(k,text);this.calls.push(`original:${k}`);}
  async downloadDatedOriginal(id,month){const value=this.store.originals.get(`${month??'undated'}:${id}`);if(!value)throw new Error('missing dated PDF');return value;}
  async uploadOriginal(id,text){this.store.legacyOriginals.set(id,text);}
  async downloadOriginal(id){const value=this.store.legacyOriginals.get(id);if(!value)throw new Error('missing legacy PDF');return value;}
}
function drivers(){const store={files:new Map(),originals:new Map(),legacyOriginals:new Map(),payroll:false};const mock=new MockGraph(store);return [new LiveVault(mock),new LiveVault(mock),mock,store];}

test('year-sharded vault creates encrypted index, and separate 2025/2026 files',async()=>{
  const [a,,mock,store]=drivers();await a.create(secret);
  assert.deepEqual([...store.files.keys()],['index:finance']);assert.equal(store.payroll,true);
  await a.saveBatch([{id:'one',statement:statement('2025-10')},{id:'two',statement:statement('2026-11')}]);
  assert.deepEqual([...store.files.keys()].sort(),['index:finance','year:2025','year:2026']);
  assert.equal(a.records().length,2);
  const newWrites=mock.calls.length;
  await a.saveBatch([{id:'two',statement:{...statement('2026-11'),statedTotal:200}}]);
  assert.ok(mock.calls.slice(newWrites).includes('year:2026'));
  assert.ok(!mock.calls.slice(newWrites).includes('year:2025'),'editing 2026 must never rewrite 2025');
  const [b]=[new LiveVault(mock)];await b.unlock(secret);
  assert.deepEqual(b.records().map(r=>r.id).sort(),['one','two']);
});

test('two clients auto-merge independent changes in the same year and across years',async()=>{
  const [a,b]=drivers();await a.create(secret);await b.unlock(secret);
  await a.saveBatch([{id:'first',statement:statement('2026-10')}]);
  await b.saveBatch([{id:'second',statement:statement('2026-11')}]);
  await a.refresh();assert.deepEqual(a.records().map(r=>r.id).sort(),['first','second']);
  await a.saveBatch([{id:'older',statement:statement('2025-01')}]);
  await b.saveBatch([{id:'newer',statement:statement('2027-03')}]);
  await a.refresh();assert.deepEqual(a.records().map(r=>r.id).sort(),['first','newer','older','second']);
});

test('same-year same-field conflict retains the losing value in encrypted audit',async()=>{
  const [a,b]=drivers();await a.create(secret);
  await a.saveBatch([{id:'one',statement:statement()}]);await b.unlock(secret);
  const sa=a.records()[0].statement,sb=b.records()[0].statement;
  sa.statedTotal=200;sb.statedTotal=300;
  await a.saveBatch([{id:'one',statement:sa}]);
  b.setStatementConflictResolver(items=>{assert.equal(items.length,1);assert.equal(items[0].path,'record.statement.statedTotal');return true;});
  await b.saveBatch([{id:'one',statement:sb}]);
  await a.refresh();assert.equal(a.records()[0].statement.statedTotal,300);assert.equal(a.conflicts(),1);
});

test('PDF originals are under immutable bill-month folder, even after correcting billing month',async()=>{
  const [a,,mock,store]=drivers();await a.create(secret);
  const bytes=new Uint8Array([37,80,68,70,1,2,3,4]);
  const pdf={...statement('2026-11'),sourceKind:'pdf'};
  await a.saveBatch([{id:'pdf',statement:pdf,source:{bytes,mime:'application/pdf'}}]);
  const files=[...store.originals.keys()];assert.equal(files.length,1);
  assert.match(files[0],/^2026-11:/);
  assert.deepEqual(await a.original('pdf'),bytes);
  const changed=a.records()[0].statement;changed.billingMonth='2027-01';
  await a.saveBatch([{id:'pdf',statement:changed}]);
  assert.deepEqual(await a.original('pdf'),bytes);
  assert.deepEqual(a.records().map(r=>r.statement.billingMonth),['2027-01']);
  assert.equal(store.originals.size,1,'the immutable PDF should not move or reupload');
  assert.equal(store.files.get('year:2026').text.includes('originalId'),false,'ciphertext must conceal metadata');
  await a.refresh();assert.equal(a.records().length,1,'no duplicate record during year move');
  assert.ok(mock.calls.includes('year:2027')&&mock.calls.includes('year:2026'));
});

test('deletions persist across stale clients without resurrection',async()=>{
  const [a,b]=drivers();await a.create(secret);
  await a.saveBatch([{id:'gone',statement:statement()}]);await b.unlock(secret);
  await a.delete('gone');await b.saveBatch([{id:'other',statement:statement('2026-10')}]);
  await a.refresh();assert.deepEqual(a.records().map(r=>r.id),['other']);
});

test('cloud upload outage does not acknowledge an uncommitted record',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  mock.failYear='2026';
  await assert.rejects(a.saveBatch([{id:'new',statement:statement()}]),error=>error.name==='CloudWriteUncertainError'&&/outage/.test(String(error.reason)));
  assert.equal(a.records().length,0);
});

test('unregistered year file is recovered on next unlock after index outage',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  mock.failIndex=true;
  await assert.rejects(a.saveBatch([{id:'new',statement:statement('2026-11')}]),error=>error.name==='CloudWriteUncertainError'&&/index outage/.test(String(error.reason)));
  assert.ok(mock.file('year','2026'),'encrypted shard was saved');
  mock.failIndex=false;
  const restarted=new LiveVault(mock);
  await restarted.unlock(secret);
  assert.deepEqual(restarted.records().map(x=>x.id),['new'],'orphan year discovered from folder listing');
  await restarted.saveBatch([{id:'second',statement:statement('2026-10')}]);
  assert.ok(mock.file('index','finance'));
});

test('legacy v1 single vault and PDF are migrated and verified, never deleted',async()=>{
  const [a,,mock,store]=drivers();
  const salt=freshSalt(),key=await deriveCloudKey(secret,salt),doc=emptyDocument();
  const bytes=new Uint8Array([37,80,68,70,1]);
  const {encryptOriginal}=await import('../dist/src/cloud/cloud-crypto.js');
  const orig=await encryptOriginal(bytes,key);
  const id='12345678-1234-1234-1234-123456789abc';
  store.legacyOriginals.set(id,orig);
  doc.records.push({id:'a',statement:statement('2025-12')},{id:'b',statement:{...statement('2026-11'),sourceKind:'pdf'},originalId:id});
  doc.deleted.push('deleted-id');
  await mock.writeLiveVault(await encryptDocument(doc,key,salt),null);
  assert.equal(await a.discover(),true);assert.equal(a.needsLayoutMigration,true);
  await a.unlock(secret);
  assert.equal(a.needsLayoutMigration,false);
  assert.deepEqual(a.records().map(x=>x.id).sort(),['a','b']);
  assert.deepEqual(await a.original('b'),bytes);
  assert.ok(mock.file('legacy','root'),'legacy v1 ciphertext must remain untouched');
  assert.ok(mock.file('year','2025')&&mock.file('year','2026')&&mock.file('year','undated'));
  assert.ok(mock.file('index','finance'),'manifest published only after all shards');
  assert.ok(store.originals.has(`2026-11:${id}`));
  const newClient=new LiveVault(mock);await newClient.unlock(secret);
  assert.equal(newClient.records().length,2);
});

test('legacy migration retries after interruption without deleting old data',async()=>{
  const [a,,mock]=drivers();
  const salt=freshSalt(),key=await deriveCloudKey(secret,salt),doc=emptyDocument();
  doc.records.push({id:'a',statement:statement('2025-12')},{id:'b',statement:statement('2026-11')});
  await mock.writeLiveVault(await encryptDocument(doc,key,salt),null);
  mock.failYear='2026';
  await assert.rejects(a.unlock(secret),/year outage/);
  assert.ok(mock.file('legacy','root'));assert.equal(mock.file('index','finance'),null);
  mock.failYear=null;
  await a.unlock(secret);assert.equal(a.records().length,2);
});

test('invalid passphrase never starts migration',async()=>{
  const [a,,mock]=drivers();const salt=freshSalt(),key=await deriveCloudKey(secret,salt);
  await mock.writeLiveVault(await encryptDocument(emptyDocument(),key,salt),null);
  await assert.rejects(a.unlock('incorrect'),/パスフレーズ/);
  assert.equal(mock.file('index','finance'),null);
});

test('unknown billing month is stored under undated shard rather than lost',async()=>{
  const [a]=drivers();await a.create(secret);await a.saveBatch([{id:'bad-month',statement:statement(null)}]);
  assert.equal(a.records()[0].id,'bad-month');
});

test('multi-year partial save retries with the same IDs and no duplicate records',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  const first=statement('2025-11'),second=statement('2026-11');
  mock.failYear='2026';
  await assert.rejects(a.saveBatch([{statement:first},{statement:second}]),error=>error.name==='CloudWriteUncertainError'&&/year outage/.test(String(error.reason)));
  assert.equal(a.records().length,1,'one year committed, no false all-success state');
  mock.failYear=null;
  await assert.rejects(a.saveBatch([{statement:first},{statement:second}]), /保存を再開/);
  const ids=await a.resumePendingYearBatch();
  assert.equal(new Set(ids).size,2);
  await a.refresh();
  assert.deepEqual(a.records().map(x=>x.id).sort(),ids.sort());
});

test('refresh checks unchanged years with ETag and avoids their ciphertext downloads',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  await a.saveBatch([{id:'old',statement:statement('2025-12')},{id:'new',statement:statement('2026-11')}]);
  mock.calls.length=0;
  await a.saveBatch([{id:'new',statement:{...statement('2026-11'),statedTotal:200}}]);
  assert.ok(mock.calls.includes('read:2026'));
  assert.equal(mock.calls.includes('read:2025'),false,'2025 must only be checked by ETag, not downloaded');
});

test('committed ETag skips redundant read-back while preserving conflict merge and refresh',async()=>{
  const [a,b,mock]=drivers();
  // Emulate real Graph upload-session completion, which returns file ID and ETag.
  mock.writeYearVault=async function(year,text,ref){
    this.write('year',year,text,ref);
    return {id:`year-${year}`,etag:`"${this.file('year',year).revision}"`};
  };
  await a.create(secret);
  mock.calls.length=0;
  await a.saveBatch([{id:'first',statement:statement('2026-11')}]);
  assert.equal(mock.calls.filter(x=>x==='read:2026').length,1,'read remote once; no immediate read-back');
  await b.unlock(secret);
  await a.saveBatch([{id:'second',statement:statement('2026-10')}]);
  await b.saveBatch([{id:'third',statement:statement('2026-09')}]);
  await a.refresh();
  assert.deepEqual(a.records().map(x=>x.id).sort(),['first','second','third']);
});

test('newly opened vault downloads annual shards concurrently, at most four at a time',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  const years=['2022','2023','2024','2025','2026','2027'];
  await a.saveBatch(years.map(year=>({id:year,statement:statement(`${year}-11`)})));
  const read=mock.readYearVault.bind(mock);
  let active=0,peak=0;
  mock.readYearVault=async year=>{
    active++;peak=Math.max(active,peak);
    try{await new Promise(resolve=>setTimeout(resolve,8));return read(year);}
    finally{active--;}
  };
  const other=new LiveVault(mock);await other.unlock(secret);
  assert.equal(other.records().length,6);
  assert.equal(peak,4,'four annual shards should be in flight concurrently');
});

test('conditional 304 fast-path keeps all concurrent edits and tombstones',async()=>{
  const [a,b,mock]=drivers();
  mock.readYearVaultForSave=async function(year,ref){
    const current=this.file('year',year);
    if(current&&ref?.etag===`"${current.revision}"`)return {kind:'unchanged'};
    return {kind:'remote',file:this.read('year',year)};
  };
  mock.writeYearVault=async function(year,text,ref){
    this.write('year',year,text,ref);
    return {id:`year-${year}`,etag:`"${this.file('year',year).revision}"`};
  };
  await a.create(secret);
  await a.saveBatch([{id:'first',statement:statement()}]);
  await b.unlock(secret);
  mock.calls.length=0;
  await a.saveBatch([{id:'second',statement:statement('2026-10')}]);
  assert.equal(mock.calls.includes('read:2026'),false,'unchanged shard requires no ciphertext GET');
  await b.saveBatch([{id:'third',statement:statement('2026-09')}]);
  await a.delete('first');
  await b.refresh();
  assert.deepEqual(b.records().map(r=>r.id).sort(),['second','third']);
});

test('v1.6.16: year retry checks remote files and skips already confirmed years',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  const items=[{id:'confirmed-year',statement:statement('2025-04')},{id:'pending-year',statement:statement('2026-04')}];
  mock.failYear='2026';
  await assert.rejects(a.saveBatch(items),error=>error.name==='CloudWriteUncertainError');
  assert.equal(a.hasPendingYearBatch,true);
  mock.failYear=null;
  const earlier=mock.calls.filter(x=>x==='year:2025').length;
  const ids=await a.resumePendingYearBatch();
  assert.deepEqual(ids,['confirmed-year','pending-year']);
  assert.equal(mock.calls.filter(x=>x==='year:2025').length,earlier,'confirmed year is not uploaded again');
  assert.equal(a.hasPendingYearBatch,false);
  assert.deepEqual(a.records().map(x=>x.id).sort(),ids.sort());
});

test('v1.6.16: ambiguous year upload response is reconciled without repeating write',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  const original=mock.writeYearVault.bind(mock);
  let triggered=false;
  mock.writeYearVault=async(year,text,ref)=>{
    const value=await original(year,text,ref);
    if(!triggered){triggered=true;throw new Error('lost response after commit');}
    return value;
  };
  await assert.rejects(a.saveBatch([{id:'idempotent',statement:statement('2025-08')}]),/保存済みの可能性/);
  const count=mock.calls.filter(x=>x==='year:2025').length;
  assert.equal(count,1);
  await a.resumePendingYearBatch();
  assert.equal(mock.calls.filter(x=>x==='year:2025').length,count);
  assert.equal(a.records().length,1);
});

test('v1.6.16: year retry refuses to overwrite a concurrent edit',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  mock.failYear='2026';
  await assert.rejects(a.saveBatch([{id:'shared',statement:statement('2026-05','intended')}]),/保存済みの可能性/);
  mock.failYear=null;
  const other=new LiveVault(mock);
  await other.unlock(secret);
  await other.saveBatch([{id:'shared',statement:statement('2026-05','other-device')}]);
  await assert.rejects(a.resumePendingYearBatch(),/他の端末で明細が更新/);
  assert.equal(a.hasPendingYearBatch,true);
  await a.refresh();
  assert.equal(a.records().find(r=>r.id==='shared').statement.rows[0].merchant,'other-device');
});

test('v1.6.16: resuming a move to an earlier year removes the stale old-year copy',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  await a.saveBatch([{id:'move',statement:statement('2027-10')}]);
  mock.failYear='2027';
  await assert.rejects(a.saveBatch([{id:'move',statement:statement('2026-10')}]),/保存済みの可能性/);
  mock.failYear=null;
  assert.equal((await a.inspectPendingYearBatch())[0].status,'cleanup');
  await a.resumePendingYearBatch();
  assert.equal(a.records().length,1);
  assert.equal(a.records()[0].statement.billingMonth,'2026-10');
  const {decryptDocument,deriveCloudKey}=await import('../dist/src/cloud/cloud-crypto.js');
  const index=await mock.readFinanceIndex();
  const {parseIndexEnvelope}=await import('../dist/src/cloud/cloud-crypto.js');
  const key=await deriveCloudKey(secret,parseIndexEnvelope(index.text).salt);
  const stale=await decryptDocument((await import('../dist/src/cloud/cloud-crypto.js')).parseEnvelope(mock.read('year','2027').text),key);
  assert.equal(stale.records.length,0);
  assert.ok(stale.deleted.includes('move'));
});

test('v1.6.16: definitively rejected first-year write is not treated as partial success',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  mock.writeYearVault=async()=>{throw new GraphError(403,'accessDenied');};
  await assert.rejects(a.saveBatch([{id:'not-committed',statement:statement('2025-10')}]),error=>error instanceof GraphError&&error.status===403);
  assert.equal(a.hasPendingYearBatch,false);
});

test('CSV v1.9.2: simultaneous independent IDs for the same card/month are rejected at OneDrive commit',async()=>{
  const [a,b,mock]=drivers();
  await a.create(secret);await b.unlock(secret);
  await a.saveBatch([{id:'text-original',statement:{...statement('2026-11','テキスト明細'),cardId:'smbc-nl',provider:'smbc'}}]);
  await assert.rejects(
    b.saveBatch([{id:'different-id',statement:{...statement('2026-11','CSV明細'),cardId:'smbc-nl',provider:'smbc',sourceKind:'csv'}}]),
    /同じカード・請求月/,
  );
  const fresh=new LiveVault(mock);await fresh.unlock(secret);
  assert.deepEqual(fresh.records().map(record=>record.id),['text-original']);
  // A legitimate same-ID revision is still allowed and remains one record.
  await a.saveBatch([{id:'text-original',statement:{...a.records()[0].statement,sourceKind:'csv'}}]);
  await fresh.refresh();
  assert.equal(fresh.records().length,1);
  assert.equal(fresh.records()[0].statement.sourceKind,'csv');
});

test('Phase 6B: ロック中に保存再開が失敗しても平文の再開情報を復活させない',async()=>{
 for(const reopen of [false,true]){
  const [a,,mock]=drivers();await a.create(secret);
  const remembered=a.verifiedBrowserKey();mock.failYear='2026';
  await assert.rejects(a.saveBatch([{id:'pending',statement:statement('2026-10','pending-data')}]),/保存済みの可能性/);
  assert.equal(a.pendingYearBatchEntries().length,1);
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const write=mock.writeYearVault.bind(mock);
  mock.writeYearVault=async()=>{entered();await new Promise(resolve=>{release=resolve;});throw new Error('retry interrupted');};
  const retry=a.resumePendingYearBatch();const rejected=assert.rejects(retry,error=>error.name==='CloudWriteUncertainError');
  await started;a.lock();
  if(reopen)await a.unlockBrowserKey(remembered);
  release();await rejected;
  assert.equal(a.unlocked,reopen);assert.equal(a.hasPendingYearBatch,false);assert.deepEqual(a.pendingYearBatchEntries(),[]);
  if(reopen)assert.equal(a.records().length,0);else assert.throws(()=>a.records(),/ロック/);
  mock.writeYearVault=write;mock.failYear=null;
  if(!reopen)await a.unlock(secret);
  await a.saveBatch([{id:'fresh',statement:statement('2026-11')}]);assert.equal(a.records()[0].id,'fresh');
 }
});
test('Phase 6B: 同じブラウザ鍵で再解除した後の新しい再開計画を旧処理が上書きしない',async()=>{
 const [a,,mock]=drivers();await a.create(secret);const remembered=a.verifiedBrowserKey();mock.failYear='2026';
 await assert.rejects(a.saveBatch([{id:'old',statement:statement('2026-10')}]),/保存済みの可能性/);
 let entered,release;const started=new Promise(resolve=>{entered=resolve;});
 const write=mock.writeYearVault.bind(mock);
 mock.writeYearVault=async()=>{entered();await new Promise(resolve=>{release=resolve;});throw new Error('old retry interrupted');};
 const retry=a.resumePendingYearBatch();const rejected=assert.rejects(retry,error=>error.name==='CloudWriteUncertainError');
 await started;a.lock();await a.unlockBrowserKey(remembered);mock.writeYearVault=write;
 await assert.rejects(a.saveBatch([{id:'new',statement:statement('2026-11')}]),/別の保存処理|操作中/);
 assert.equal(a.hasPendingYearBatch,false);
 release();await rejected;assert.equal(a.hasPendingYearBatch,false);
 await assert.rejects(a.saveBatch([{id:'new',statement:statement('2026-11')}]),/保存済みの可能性/);
 assert.deepEqual(a.pendingYearBatchEntries().map(x=>x.id),['new']);
 mock.failYear=null;assert.deepEqual(await a.resumePendingYearBatch(),['new']);assert.equal(a.records()[0].id,'new');
});
test('Phase 6B: 同じ解除状態で通信が失敗した場合は再開計画を維持する',async()=>{
 const [a,,mock]=drivers();await a.create(secret);mock.failYear='2026';
 await assert.rejects(a.saveBatch([{id:'pending',statement:statement('2026-11')}]),/保存済みの可能性/);
 await assert.rejects(a.resumePendingYearBatch(),error=>error.name==='CloudWriteUncertainError');
 assert.deepEqual(a.pendingYearBatchEntries().map(x=>x.id),['pending']);
 mock.failYear=null;assert.deepEqual(await a.resumePendingYearBatch(),['pending']);assert.equal(a.hasPendingYearBatch,false);
});
test('Phase 6B: ロックと同一鍵の再解除をまたぐ旧refreshは読込結果を公開しない',async()=>{
 const [a,,mock]=drivers();await a.create(secret);const remembered=a.verifiedBrowserKey();
 let entered,release;const started=new Promise(resolve=>{entered=resolve;});
 const read=mock.listYearFiles.bind(mock);let once=true;
 mock.listYearFiles=async()=>{const result=await read();if(once){once=false;entered();await new Promise(resolve=>{release=resolve;});}return result;};
 const refresh=a.refresh();const rejected=assert.rejects(refresh,/世代|保管庫|変更/);
 await started;a.lock();await a.unlockBrowserKey(remembered);
 await a.saveBatch([{id:'new',statement:statement('2026-10')}]);
 release();await rejected;assert.deepEqual(a.records().map(r=>r.id),['new']);
});

test('Phase 6C: PDF原本の取得は同じブラウザ鍵で再解除しても旧要求に返さない',async()=>{
 const [a,,mock]=drivers();await a.create(secret);const bytes=new Uint8Array([37,80,68,70,1,2,3,4]);
 await a.saveBatch([{id:'pdf',statement:{...statement('2026-11'),sourceKind:'pdf'},source:{bytes,mime:'application/pdf'}}]);
 const remembered=a.verifiedBrowserKey(),read=mock.downloadDatedOriginal.bind(mock);let entered,release;const started=new Promise(r=>{entered=r;});
 mock.downloadDatedOriginal=async(...args)=>{const result=await read(...args);entered();await new Promise(r=>{release=r;});return result;};
 const pending=a.original('pdf'),rejected=assert.rejects(pending,/保管庫|ロック|変更/);await started;a.lock();await a.unlockBrowserKey(remembered);release();await rejected;
 mock.downloadDatedOriginal=read;assert.deepEqual(await a.original('pdf'),bytes);
});


test('一括保存の準備件数と年度書込みを区別し通知失敗でも保存を妨げない',async()=>{
  const [vault]=drivers();await vault.create(secret);const progress=[];
  const ids=await vault.saveBatch([{id:'first',statement:statement('2025-10')},{id:'second',statement:statement('2026-11')}],(phase,done,total)=>{progress.push([phase,done,total]);if(done===1)throw new Error('UI callback failure');});
  assert.deepEqual(ids,['first','second']);assert.equal(vault.records().length,2);
  assert.ok(progress.some(([phase,done,total])=>phase==='原本の暗号化・送信と明細準備'&&done===2&&total===2));
  assert.ok(progress.some(([phase,done,total])=>phase==='年度データ保存・原本検証'&&done===2&&total===2));
  assert.equal(progress.at(-1)[0],'保存結果の同期確認');
});


test('45件の一括保存で準備件数を追跡し年度保存の前に成功扱いしない',async()=>{
 const [vault,,mock]=drivers();await vault.create(secret);const progress=[];let earlyWrite=false;
 const items=Array.from({length:45},(_,i)=>({id:'batch-'+i,statement:{...statement(`${2020+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`),sourceKind:'pdf'},source:{mime:'application/pdf',bytes:new Uint8Array([37,80,68,70,i])}}));
 // Real crypto and fixture Graph: no live account, no actual personal statement.
 const result=await vault.saveBatch(items,(phase,done,total)=>{progress.push([phase,done,total]);if(phase==='原本の暗号化・送信と明細準備'&&mock.calls.some(x=>x.startsWith('year:')))earlyWrite=true;});
 assert.equal(earlyWrite,false);assert.equal(result.length,45);assert.equal(vault.records().length,45);assert.ok(progress.some(([p,d,t])=>p==='原本の暗号化・送信と明細準備'&&d===45&&t===45));
});

 test('確定差し替えは同じIDと新原本を保持し、再取込した暫定を保存層で拒否する',async()=>{
 const [a,b,mock,store]=drivers();await a.create(secret);
 const old={...statement(),confirmation:'provisional',sourceKind:'pdf',paymentDate:'2026-11-27'};
 const source=bytes=>({bytes:new Uint8Array(bytes),mime:'application/pdf'});
 await a.saveBatch([{id:'same-bill',statement:old,source:source([1,2])}]);await b.unlock(secret);
 const final={...old,confirmation:'confirmed',rows:[{...old.rows[0],merchant:'FINAL'}]};
 await a.saveBatch([{id:'same-bill',statement:final,source:source([3,4]),replace:true}]);
 const committed=structuredClone(a.records()[0]);assert.equal(committed.id,'same-bill');assert.equal(committed.statement.confirmation,'confirmed');assert.deepEqual(await a.original('same-bill'),new Uint8Array([3,4]));
 const writes=mock.calls.filter(x=>x==='year:2026').length;
 await assert.rejects(a.saveBatch([{id:'same-bill',statement:old,source:source([1,2]),replace:true}]),/確定明細/);
 b.setStatementConflictResolver(()=>true);await assert.rejects(b.saveBatch([{id:'same-bill',statement:{...old,rows:[{...old.rows[0],merchant:'STALE'}]},source:source([5,6]),replace:true}]),/確定明細/);
 await a.refresh();assert.deepEqual(a.records()[0],committed);assert.equal(mock.calls.filter(x=>x==='year:2026').length,writes);assert.ok(store.originals.size>=2);
 });
 test('別端末の確定版に古い確定版の原本・取引を混合しない。独立明細は残る',async()=>{
 const [a,b,mock]=drivers();await a.create(secret);const original={...statement(),sourceKind:'pdf',paymentDate:'2026-11-27'};
 const source=n=>({bytes:new Uint8Array([n]),mime:'application/pdf'});
 await a.saveBatch([{id:'same-bill',statement:original,source:source(1)}]);await b.unlock(secret);
 const newer={...original,rows:[{...original.rows[0],merchant:'NEW'}]};await a.saveBatch([{id:'same-bill',statement:newer,source:source(2),replace:true}]);
 b.setStatementConflictResolver(()=>true);await assert.rejects(b.saveBatch([{id:'same-bill',statement:{...original,sourceName:'other'},source:source(3),replace:true}]),/差し替え元/);
 await assert.rejects(b.saveBatch([{id:'same-bill',statement:{...original,rows:[{...original.rows[0],merchantOverride:'STALE'}]}}]),/差し替え元/);
 await b.refresh();assert.deepEqual(await b.original('same-bill'),new Uint8Array([2]));assert.equal(b.records()[0].statement.rows[0].merchant,'NEW');
 await b.saveBatch([{id:'other-bill',statement:statement('2026-10')}]);await a.refresh();assert.equal(a.records().length,2);assert.deepEqual(await a.original('same-bill'),new Uint8Array([2]));
 });

 test('保存再開は同一明細のPDF原本差し替えも照合し、旧原本だけでは成功扱いしない',async()=>{
 const [a,,mock]=drivers();await a.create(secret);const bill={...statement(),sourceKind:'pdf',paymentDate:'2026-11-27'};const source=n=>({bytes:new Uint8Array([n]),mime:'application/pdf'});
 await a.saveBatch([{id:'same-bill',statement:bill,source:source(1)}]);mock.failYear='2026';
 await assert.rejects(a.saveBatch([{id:'same-bill',statement:bill,source:source(2),replace:true}]),/保存済みの可能性/);assert.equal(a.hasPendingYearBatch,true);assert.deepEqual(await a.original('same-bill'),new Uint8Array([1]));
 mock.failYear=null;assert.equal((await a.inspectPendingYearBatch())[0].status,'unsaved');await a.resumePendingYearBatch();assert.equal(a.hasPendingYearBatch,false);assert.deepEqual(await a.original('same-bill'),new Uint8Array([2]));assert.equal(a.records().length,1);
 });

test('PDF batch checks generation under its lock and both boundaries of final sync',async()=>{
  const [vault,,mock]=drivers();await vault.create(secret);
  await vault.saveBatch([{id:'existing',statement:statement('2026-10')}]);
  const reads=[];const read=mock.readFinanceIndex.bind(mock);
  mock.readFinanceIndex=async(fresh)=>{reads.push(fresh);return read();};
  await vault.saveBatch([{id:'pdf-new',statement:{...statement(),sourceKind:'pdf'},source:{bytes:new Uint8Array([37,80,68,70,1]),mime:'application/pdf'}}]);
  assert.deepEqual(reads,[true,true,true,true,true,true]); // Lock, cross-year scope, one-time writer upgrade and both sync boundaries.
  assert.equal(vault.records().length,2);
});

test('generation is checked after lock acquisition before original upload',async()=>{
  const store={files:new Map(),originals:new Map(),legacyOriginals:new Map()};const mock=new MockGraph(store);
  const other=drivers();await other[0].create(secret);let switchAtAcquire=false;
  mock.acquireVaultMutation=async()=>{if(switchAtAcquire)mock.readFinanceIndex=()=>other[2].readFinanceIndex();return async()=>{};};
  const vault=new LiveVault(mock);await vault.create(secret);const read=mock.readFinanceIndex.bind(mock);switchAtAcquire=true;
  try{await assert.rejects(vault.saveBatch([{id:'new',statement:{...statement(),sourceKind:'pdf'},source:{bytes:new Uint8Array([37,80,68,70]),mime:'application/pdf'}}]),/現行世代/);}
  finally{mock.readFinanceIndex=read;}
  assert.equal(store.originals.size,0);assert.equal(vault.hasPendingYearBatch,false);
});

for(const count of [45,100])test(`Phase 3A-2: ${count}件の部分成功を読取りで分類し、完了年度を再送しない`,async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  const items=Array.from({length:count},(_,i)=>({id:`batch-${i}`,statement:statement(`${2018+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`)}));
  mock.failYear='2020';
  await assert.rejects(a.saveBatch(items),error=>error.name==='CloudWriteUncertainError');
  const writes=()=>mock.calls.filter(x=>!x.startsWith('read:'));
  const before=writes();const result=await a.inspectPendingYearBatch();
  assert.deepEqual(result.map(x=>x.id),items.map(x=>x.id));
  assert.equal(result.filter(x=>x.status==='saved').length,24);
  assert.equal(result.filter(x=>x.status==='unsaved').length,count-24);
  assert.deepEqual(writes(),before);assert.equal(a.hasPendingYearBatch,true);
  mock.failYear=null;await a.resumePendingYearBatch();
  assert.equal(a.records().length,count);assert.equal(a.hasPendingYearBatch,false);
  for(const year of ['2018','2019'])assert.equal(writes().filter(x=>x===`year:${year}`).length,1);
});

test('Phase 3A-2: 応答消失後の全件確認は書込みもロック取得もせず再開完了',async()=>{
  const [a,,mock]=drivers();await a.create(secret);const write=mock.writeYearVault.bind(mock);
  mock.writeYearVault=async(...args)=>{await write(...args);throw new Error('lost response');};
  await assert.rejects(a.saveBatch([{id:'saved',statement:statement()}]),error=>error.name==='CloudWriteUncertainError');
  const writes=mock.calls.filter(x=>!x.startsWith('read:'));
  assert.deepEqual((await a.inspectPendingYearBatch()).map(x=>x.status),['saved']);
  assert.equal(a.hasPendingYearBatch,true);
  // Another client holds the operation right: a read-only completion needs no write.
  const release=await mock.acquireVaultMutation();
  try{assert.deepEqual(await a.resumePendingYearBatch(),['saved']);}finally{await release();}
  assert.deepEqual(mock.calls.filter(x=>!x.startsWith('read:')),writes);
});

test('Phase 3A-2: 初回照合後に別端末が更新した明細はロック後の再照合で拒否',async()=>{
  const [a,b,mock]=drivers();await a.create(secret);await b.unlock(secret);
  mock.failYear='2026';await assert.rejects(a.saveBatch([{id:'race',statement:statement()}]),error=>error.name==='CloudWriteUncertainError');mock.failYear=null;
  const inspect=a.inspectPendingYearBatch.bind(a);let changed=false;
  a.inspectPendingYearBatch=async()=>{const result=await inspect();if(!changed){changed=true;await b.saveBatch([{id:'race',statement:statement('2026-11','other')}]);}return result;};
  await assert.rejects(a.resumePendingYearBatch(),/他の端末で明細が更新/);
  assert.equal(a.hasPendingYearBatch,true);assert.equal(a.records()[0].statement.rows[0].merchant,'other');
  assert.equal((await inspect())[0].status,'conflict');
});

test('Phase 3A-2: 書込み後に削除された新規IDは再送対象にしない',async()=>{
  const [a,b,mock]=drivers();await a.create(secret);const write=mock.writeYearVault.bind(mock);
  mock.writeYearVault=async(...args)=>{await write(...args);throw new Error('lost response');};
  await assert.rejects(a.saveBatch([{id:'deleted',statement:statement()}]),error=>error.name==='CloudWriteUncertainError');
  mock.writeYearVault=write;await b.unlock(secret);await b.delete('deleted');
  assert.equal((await a.inspectPendingYearBatch())[0].status,'conflict');
  await assert.rejects(a.resumePendingYearBatch(),/他の端末で明細が更新/);assert.equal(a.records().length,0);
});

test('Phase 3A-2: 照合の読取り失敗は再開情報を維持する',async()=>{
  const [a,,mock]=drivers();await a.create(secret);mock.failYear='2026';
  await assert.rejects(a.saveBatch([{id:'pending',statement:statement()}]),error=>error.name==='CloudWriteUncertainError');
  const read=mock.readFinanceIndex.bind(mock);mock.readFinanceIndex=async()=>{throw new Error('offline');};
  await assert.rejects(a.inspectPendingYearBatch(),/offline/);assert.equal(a.hasPendingYearBatch,true);
  mock.readFinanceIndex=read;mock.failYear=null;assert.equal((await a.inspectPendingYearBatch())[0].status,'unsaved');
  await a.resumePendingYearBatch();assert.equal(a.records().length,1);
});

// Synthetic timing and storage-call counts; no real Graph endpoints or financial data.
for(const count of [1,45,100])test(`Phase 4A: ${count}件の新規PDFと年度変更の保存呼出し`,async t=>{
  const [a,,mock,store]=drivers();await a.create(secret);
  const write=mock.writeYearVault.bind(mock);
  mock.writeYearVault=async(year,text,ref)=>{await write(year,text,ref);const file=mock.file('year',year);return {id:`year-${year}`,etag:`"${file.revision}"`};};
  const upload=mock.uploadDatedOriginal.bind(mock);
  mock.uploadDatedOriginal=async(...args)=>{await upload(...args);return {id:args[0],etag:'verified'};};
  const calls={index:0,list:0,read:0,write:0,upload:0,download:0};
  for(const [name,k] of Object.entries({readFinanceIndex:'index',listYearFiles:'list',readYearVault:'read',writeYearVault:'write',uploadDatedOriginal:'upload',downloadDatedOriginal:'download'})){
    const original=mock[name].bind(mock);mock[name]=async(...args)=>{calls[k]++;return original(...args);};
  }
  const measure=async(items)=>{for(const k of Object.keys(calls))calls[k]=0;const start=performance.now();await a.saveBatch(items);return {...calls,ms:Math.round(performance.now()-start)};};
  const items=Array.from({length:count},(_,i)=>({id:`perf-${i}`,statement:{...statement(`${2010+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`),sourceKind:'pdf'},source:{bytes:new Uint8Array([37,80,68,70,i]),mime:'application/pdf'}}));
  const inserted=await measure(items);
  const moved=await measure(a.records().map(r=>({id:r.id,statement:{...r.statement,billingMonth:String(Number(r.statement.billingMonth.slice(0,4))+20)+r.statement.billingMonth.slice(4)}})));
  const years=Math.ceil(count/12);t.diagnostic(JSON.stringify({count,inserted,moved}));
  assert.equal(inserted.write,years);assert.equal(inserted.upload,count);assert.equal(inserted.download,0);
  assert.equal(moved.write,years*2);assert.equal(moved.upload,0);assert.equal(moved.download,count);
  assert.equal(a.records().length,count);assert.equal(store.originals.size,count);
  for(const item of items)assert.deepEqual(await a.original(item.id),item.source.bytes);
  for(const [year,shard] of a.shards)if(Number(year)<2030){assert.equal(shard.document.records.length,0);assert.equal(shard.document.deleted.length,items.filter(x=>x.statement.billingMonth.startsWith(year)).length);}
});

// A grouped cleanup failure keeps the verified destinations and all unfinished old copies.
test('Phase 4A: 旧年度の一括整理を再開しても移動先を再送しない',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  const items=Array.from({length:5},(_,i)=>({id:`move-${i}`,statement:statement(`2025-0${i+1}`)}));
  await a.saveBatch(items);mock.failYear='2025';
  await assert.rejects(a.saveBatch(items.map(item=>({...item,statement:{...item.statement,billingMonth:item.statement.billingMonth.replace('2025','2026')}}))),/保存済みの可能性/);
  assert.deepEqual((await a.inspectPendingYearBatch()).map(r=>r.status),Array(5).fill('cleanup'));
  mock.failYear=null;mock.calls.length=0;await a.resumePendingYearBatch();
  assert.deepEqual(mock.calls.filter(x=>x.startsWith('year:')),['year:2025']);
  assert.equal(a.shards.get('2025').document.records.length,0);
  assert.equal(a.shards.get('2025').document.deleted.length,5);
  assert.equal(a.records().length,5);assert.equal(a.hasPendingYearBatch,false);
});

// Phase 4B: count full editable snapshots, not just the wall-clock runtime.
test('Phase 4B: 保存準備・原本閲覧で全明細の編集用コピーを作らない',async t=>{
  const [a]=drivers();await a.create(secret);
  const bytes=new Uint8Array([37,80,68,70,4]);
  const items=Array.from({length:45},(_,i)=>({id:`copy-${i}`,statement:{...statement(`${2010+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`),sourceKind:'pdf',rows:Array.from({length:20},(_,j)=>({id:`r-${j}`,usedOn:'2026-11-01',merchant:'SYNTHETIC',amount:5}))},source:{bytes:new Uint8Array(bytes),mime:'application/pdf'}}));
  await a.saveBatch(items);
  const records=a.records.bind(a);let copies=0,rows=0;
  a.records=()=>{const result=records();copies++;rows+=result.reduce((n,r)=>n+r.statement.rows.length,0);return result;};
  const start=performance.now();for(let i=0;i<10;i++)assert.deepEqual(await a.original(`copy-${i}`),bytes);
  const original={copies,rows,ms:Math.round(performance.now()-start)};
  copies=0;rows=0;
  const edit={...records()[0].statement,statedTotal:100};
  await a.saveBatch([{id:'copy-0',statement:edit}]);
  const save={copies,rows};t.diagnostic(JSON.stringify({original,save}));
  assert.equal(original.copies,0);assert.equal(save.copies,1,'only the refresh return needs an editable full snapshot');
  assert.deepEqual(await a.original('copy-0'),bytes);
});

test('Phase 4B: 変更なしの同期は不変明細ビューを再利用し、更新・ロックで破棄する',async()=>{
  const [a,b]=drivers();await a.create(secret);await a.saveBatch([{id:'stable',statement:statement()}]);
  const before=a.readonlyRecords();await a.refresh();assert.strictEqual(a.readonlyRecords(),before);
  await b.unlock(secret);await b.saveBatch([{id:'other',statement:statement('2026-10')}]);
  await a.refresh();const changed=a.readonlyRecords();assert.notStrictEqual(changed,before);assert.equal(changed.length,2);
  const editable=a.records();editable[0].statement.rows[0].amount=999;assert.equal(changed[0].statement.rows[0].amount,100);
  a.lock();assert.equal(a.recordsViewCache,null);assert.throws(()=>a.readonlyRecords(),/ロック/);
});

// v2.0.3 recovery: the user's consent applies to exact remote copies, never to
// a newly conflicting record. All data are synthetic and encrypted in memory.
test('v2.0.3: mixed saved / unsaved / cleanup / conflict recovery excludes only the approved conflict',async()=>{
  const [a,b,mock]=drivers();await a.create(secret);
  await a.saveBatch([{id:'move',statement:statement('2024-02')}]);await b.unlock(secret);
  const items=[{id:'move',statement:statement('2025-02')},{id:'already',statement:statement('2026-01')},{id:'other-edit',statement:statement('2027-01','local')},{id:'remaining',statement:statement('2028-02')}];
  mock.failYear='2027';await assert.rejects(a.saveBatch(items),/保存済みの可能性/);mock.failYear=null;
  await b.saveBatch([{id:'other-edit',statement:statement('2027-01','remote')}]);
  assert.deepEqual((await a.inspectPendingYearBatch()).map(x=>x.status),['cleanup','saved','conflict','unsaved']);
  const before=mock.calls.filter(x=>x.startsWith('year:'));
  await assert.rejects(a.resumePendingYearBatch(async()=>false),/他の端末/);
  assert.deepEqual(mock.calls.filter(x=>x.startsWith('year:')),before);
  assert.equal(a.hasPendingYearBatch,true);
  let approved=0,refreshes=0;
  const refresh=a.refresh.bind(a);a.refresh=async(...args)=>{refreshes++;return refresh(...args);};
  assert.deepEqual(await a.resumePendingYearBatch(async rows=>{approved++;assert.deepEqual(rows.filter(x=>x.status==='conflict').map(x=>x.id),['other-edit']);return true;}),['move','already','remaining']);
  assert.equal(approved,1);assert.equal(refreshes,2,'initial read and final sync only');
  assert.deepEqual(mock.calls.filter(x=>x.startsWith('year:')).slice(before.length),['year:2028','year:2024']);
  assert.equal(a.hasPendingYearBatch,false);assert.equal(a.records().find(x=>x.id==='other-edit').statement.rows[0].merchant,'remote');
  await a.saveBatch([{id:'next',statement:statement('2026-03')}]);assert.equal(a.records().length,5);assert.equal(a.shards.get('2024').document.records.length,0);
});

test('v2.0.3: a new remote ID for the same month is a conflict, not an endless retry',async()=>{
  const [a,b,mock]=drivers();await a.create(secret);await b.unlock(secret);
  mock.failYear='2026';await assert.rejects(a.saveBatch([{id:'local-only',statement:statement()}]),/保存済みの可能性/);mock.failYear=null;
  await b.saveBatch([{id:'remote-only',statement:statement('2026-11','remote')}]);
  assert.equal((await a.inspectPendingYearBatch())[0].status,'conflict');
  const writes=mock.calls.filter(x=>x.startsWith('year:'));
  assert.deepEqual(await a.resumePendingYearBatch(async()=>true),[]);
  assert.deepEqual(mock.calls.filter(x=>x.startsWith('year:')),writes);
  assert.equal(a.hasPendingYearBatch,false);assert.deepEqual(a.records().map(x=>x.id),['remote-only']);
});

test('v2.0.3: a changed conflict after consent requires a new confirmation, without writing',async()=>{
  const [a,b,mock]=drivers();await a.create(secret);await b.unlock(secret);
  mock.failYear='2026';await assert.rejects(a.saveBatch([{id:'race',statement:statement('2026-11','local')},{id:'remaining',statement:statement('2026-12')}]),/保存済みの可能性/);mock.failYear=null;
  await b.saveBatch([{id:'race',statement:statement('2026-11','remote')}]);
  await assert.rejects(a.resumePendingYearBatch(async()=>{await b.saveBatch([{id:'race',statement:statement('2026-11','new remote')}]);return true;}),/他の端末/);
  assert.equal(a.hasPendingYearBatch,true);assert.equal(a.records().some(x=>x.id==='remaining'),false);
  assert.deepEqual(await a.resumePendingYearBatch(async()=>true),['remaining']);
  assert.equal(a.records().find(x=>x.id==='race').statement.rows[0].merchant,'new remote');
});

test('v2.0.3: failure at final sync preserves the plan and retry never resends confirmed writes',async()=>{
  const [a,,mock]=drivers();await a.create(secret);
  mock.failYear='2026';await assert.rejects(a.saveBatch([{id:'retry',statement:statement()}]),/保存済みの可能性/);mock.failYear=null;
  const refresh=a.refresh.bind(a);let reads=0;
  a.refresh=async(...args)=>{if(++reads===2)throw new Error('synthetic final sync outage');return refresh(...args);};
  await assert.rejects(a.resumePendingYearBatch(),error=>error.name==='CloudWriteUncertainError');
  assert.equal(a.hasPendingYearBatch,true);assert.equal(mock.calls.filter(x=>x==='year:2026').length,1);
  a.refresh=refresh;assert.deepEqual(await a.resumePendingYearBatch(),['retry']);
  assert.equal(mock.calls.filter(x=>x==='year:2026').length,1);assert.equal(a.hasPendingYearBatch,false);
});

test('v2.0.3: a deleted pending ID can be explicitly excluded and is never resurrected',async()=>{
  const [a,b,mock]=drivers();await a.create(secret);const write=mock.writeYearVault.bind(mock);
  mock.writeYearVault=async(...args)=>{await write(...args);throw new Error('lost response');};
  await assert.rejects(a.saveBatch([{id:'gone',statement:statement()}]),error=>error.name==='CloudWriteUncertainError');
  mock.writeYearVault=write;await b.unlock(secret);await b.delete('gone');
  assert.deepEqual(await a.resumePendingYearBatch(async rows=>{assert.equal(rows[0].status,'conflict');return true;}),[]);
  assert.equal(a.records().length,0);assert.equal(a.hasPendingYearBatch,false);
});

test('Phase B: upload without a receipt still requires original download and decrypt',async()=>{
  const [a,,mock,store]=drivers();await a.create(secret);
  const bytes=new Uint8Array([37,80,68,70]);const item={id:'no-receipt',statement:{...statement(),sourceKind:'pdf'},source:{bytes,mime:'application/pdf'}};
  const download=mock.downloadDatedOriginal.bind(mock);let reads=0;
  mock.downloadDatedOriginal=async()=>{reads++;throw new Error('original not available');};
  await assert.rejects(a.saveBatch([item]),/PDF原本の存在と復号/);assert.equal(a.records().length,0);assert.equal(store.files.has('year:2026'),false);assert.equal(reads,1);
  mock.downloadDatedOriginal=async(...args)=>{reads++;return download(...args);};
  await a.saveBatch([item]);assert.equal(reads,3,'retry collision and new reference still checked');assert.deepEqual(await a.original(item.id),bytes);
});
test('Phase B: a conflicting immutable original is never accepted as an upload receipt',async()=>{
  const [a,,mock,store]=drivers();await a.create(secret);
  const upload=mock.uploadDatedOriginal.bind(mock);
  mock.uploadDatedOriginal=async(id,text,month)=>{await upload(id,text+'different',month);throw new GraphError(409,'conflict');};
  await assert.rejects(a.saveBatch([{id:'collision',statement:{...statement(),sourceKind:'pdf'},source:{bytes:new Uint8Array([1]),mime:'application/pdf'}}]),/識別子が既存ファイルと衝突/);
  assert.equal(store.files.has('year:2026'),false);
});
test('Phase B: upload proof is not reused in a later operation when moving a PDF reference',async()=>{
  const [a,,mock,store]=drivers();await a.create(secret);
  const upload=mock.uploadDatedOriginal.bind(mock);
  mock.uploadDatedOriginal=async(...args)=>{await upload(...args);return {id:args[0],etag:'verified'};};
  const item={id:'scoped-proof',statement:{...statement(),sourceKind:'pdf'},source:{bytes:new Uint8Array([1,2]),mime:'application/pdf'}};
  await a.saveBatch([item]);store.originals.clear();
  await assert.rejects(a.saveBatch([{id:item.id,statement:{...item.statement,billingMonth:'2027-01'}}]),/PDF原本の存在と復号/);
  assert.equal(a.records()[0].statement.billingMonth,'2026-11');assert.equal(store.files.has('year:2027'),false);
});

test('H201: interrupted move after restart preserves both copies, excludes both and resolves the explicitly chosen year',async()=>{
 const [a,,mock,store]=drivers();await a.create(secret);
 const initial={...statement('2025-11'),paymentDate:'2025-11-27',rows:[{id:'row-a',usedOn:'2025-10-01',merchant:'SAMPLE',amount:100}]};
 await a.saveBatch([{id:'move-restart',statement:initial}]);
 const next={...initial,billingMonth:'2026-11',paymentDate:'2026-11-27',statedTotal:200,rows:[{...initial.rows[0],amount:200}]};
 mock.failYear='2025';await assert.rejects(a.saveBatch([{id:'move-restart',statement:next}]),/保存済みの可能性/);mock.failYear=null;
 a.lock();const restarted=new LiveVault(mock);await restarted.unlock(secret);
 const reviewed=restarted.yearConflictCopies('move-restart');assert.deepEqual(reviewed.map(x=>x.year),['2025','2026']);
 assert.equal(restarted.records().length,2);assert.equal(restarted.hasYearConflict('move-restart'),true);
 const {confirmedRecords}=await import('../dist/src/importers/batch-policy.js');assert.equal(confirmedRecords(restarted.readonlyRecords()).length,0);
 await assert.rejects(restarted.delete('move-restart'),/年度間/);await assert.rejects(restarted.saveBatch([{id:'move-restart',statement:next}]),/年度間/);await assert.rejects(restarted.original('move-restart'),/年度間/);
 const before=store.files.get('year:2025');
 // Unrelated edits in a reviewed shard invalidate the user's old approval.
 store.files.set('year:2025',{...before,revision:before.revision+1});const writes=mock.calls.filter(x=>x.startsWith('year:')).length;
 await assert.rejects(restarted.resolveYearConflict('move-restart','2026',reviewed),/別端末で変更/);assert.equal(mock.calls.filter(x=>x.startsWith('year:')).length,writes);
 await restarted.refresh();const current=restarted.yearConflictCopies('move-restart');
 mock.failYear='2025';await assert.rejects(restarted.resolveYearConflict('move-restart','2026',current),/復旧結果/);mock.failYear=null;
 await restarted.refresh();assert.equal(restarted.records().length,2);
 await restarted.resolveYearConflict('move-restart','2026',restarted.yearConflictCopies('move-restart'));
 assert.equal(restarted.records().length,1);assert.equal(restarted.records()[0].statement.statedTotal,200);assert.equal(restarted.hasYearConflict('move-restart'),false);
 const reopened=new LiveVault(mock);await reopened.unlock(secret);assert.deepEqual(reopened.records(),restarted.records());
});

test('M201: final metadata detects a change to an earlier year and keeps the old snapshot',async()=>{
 const [a,b,mock,store]=drivers();await a.create(secret);await a.saveBatch([{id:'early',statement:statement('2025-11')},{id:'late',statement:statement('2026-11')}]);await b.unlock(secret);
 const original=b.readonlyRecords();const list=mock.listYearFiles.bind(mock);let calls=0;
 mock.listYearFiles=async()=>{if(++calls===2){const old=store.files.get('year:2025');store.files.set('year:2025',{...old,revision:old.revision+1});}return list();};
 await assert.rejects(b.refresh(),/取得中にOneDrive保管庫が更新/);assert.strictEqual(b.readonlyRecords(),original);
 mock.listYearFiles=list;await b.refresh();assert.equal(b.records().length,2);
});

test('M201: an active foreign save prevents ordinary refresh from publishing its intermediate snapshot',async()=>{
 const [a,b,mock]=drivers();await a.create(secret);await b.unlock(secret);const prior=b.readonlyRecords();
 mock.inspectVaultMutationLock=async()=>({state:'present',createdAt:null});
 await assert.rejects(b.refresh(),/保存操作が進行中/);assert.strictEqual(b.readonlyRecords(),prior);
 mock.inspectVaultMutationLock=async()=>({state:'absent',createdAt:null});await b.refresh();
});

test('M201: unlocking under a residual marker authenticates only for recovery, never publishes intermediate finances',async()=>{
 const [a,,mock]=drivers();await a.create(secret);await a.saveBatch([{id:'previous',statement:statement()}]);
 mock.inspectVaultMutationLock=async()=>({state:'present',createdAt:null});
 const reopened=new LiveVault(mock);await reopened.unlock(secret);assert.equal(reopened.unlocked,true);assert.equal(reopened.recoveryOnly,true);assert.deepEqual(reopened.records(),[]);
 const before=mock.calls.filter(x=>x.startsWith('year:')).length;
 await assert.rejects(reopened.saveBatch([{id:'blocked',statement:statement('2027-01')}]),/復旧/);
 assert.equal(mock.calls.filter(x=>x.startsWith('year:')).length,before);
 mock.inspectVaultMutationLock=async()=>({state:'absent',createdAt:null});await reopened.refresh();assert.equal(reopened.recoveryOnly,false);assert.equal(reopened.records()[0].id,'previous');
});

test('M203: encrypted originals cannot be substituted; digest survives ordinary edit and year movement',async()=>{
  const [a,b,,store]=drivers();await a.create(secret);
  const bytes=new Uint8Array([37,80,68,70,11]),other=new Uint8Array([37,80,68,70,22]);
  await a.saveBatch([{id:'pdf-a',statement:{...statement('2026-11'),sourceKind:'pdf'},source:{bytes,mime:'application/pdf'}},{id:'pdf-b',statement:{...statement('2026-10'),sourceKind:'pdf'},source:{bytes:other,mime:'application/pdf'}}]);
  const first=a.records().find(r=>r.id==='pdf-a'),second=a.records().find(r=>r.id==='pdf-b');
  assert.match(first.originalSha256,/^[a-f0-9]{64}$/);assert.notEqual(first.originalSha256,second.originalSha256);
  assert.ok(!store.files.get('year:2026').text.includes(first.originalSha256));
  const key=`${first.originalMonth}:${first.originalId}`,otherKey=`${second.originalMonth}:${second.originalId}`,original=store.originals.get(key);
  store.originals.set(key,store.originals.get(otherKey));
  await assert.rejects(a.original('pdf-a'),/一致しません/);assert.equal(store.originals.size,2);
  store.originals.set(key,original);
  const edited=structuredClone(first.statement);edited.billingMonth='2027-01';
  await a.saveBatch([{id:'pdf-a',statement:edited}]);await b.unlock(secret);
  assert.equal(b.records().find(r=>r.id==='pdf-a').originalSha256,first.originalSha256);
  assert.deepEqual(await b.original('pdf-a'),bytes);
});

test('M203: refresh refuses known PDF digest downgrade by an old writer in the same session',async()=>{
  const [a,,,store]=drivers();await a.create(secret);
  await a.saveBatch([{id:'pdf',statement:{...statement(),sourceKind:'pdf'},source:{bytes:new Uint8Array([7,8]),mime:'application/pdf'}}]);
  const record=a.records()[0],key=a.verifiedBrowserKey();
  const old=structuredClone(record);delete old.originalSha256;
  const cipher=await encryptDocument({...emptyDocument(),records:[old]},key.key,key.salt);
  const remote=store.files.get('year:2026');store.files.set('year:2026',{text:cipher,revision:remote.revision+1});
  await assert.rejects(a.refresh(),/検証情報が変更または消失/);
  assert.equal(a.records()[0].originalSha256,record.originalSha256);
});

test('H201 integration: stale clients cannot edit or delete an ID with a remote cross-year conflict',async()=>{
  const [a,b,mock,store]=drivers();await a.create(secret);
  const old=statement('2025-11');await a.saveBatch([{id:'stale-move',statement:old}]);await b.unlock(secret);
  mock.failYear='2025';await assert.rejects(a.saveBatch([{id:'stale-move',statement:statement('2026-11')}]),/保存済みの可能性/);mock.failYear=null;
  const before=structuredClone(store.files),writes=mock.calls.filter(x=>x.startsWith('year:')).length;
  await assert.rejects(b.saveBatch([{id:'stale-move',statement:{...old,sourceName:'stale edit'}}]),/年度間/);
  await assert.rejects(b.delete('stale-move'),/年度間/);
  assert.equal(mock.calls.filter(x=>x.startsWith('year:')).length,writes);assert.deepEqual(store.files,before);
  await b.refresh();assert.equal(b.yearConflictCopies('stale-move').length,2);
});
test('H201 integration: a stale move must not remove a remotely edited source or resurrect a completed move',async()=>{
  const [a,b,mock,store]=drivers();await a.create(secret);
  const old=statement('2025-11');await a.saveBatch([{id:'move-guard',statement:old}]);await b.unlock(secret);
  await a.saveBatch([{id:'move-guard',statement:{...old,sourceName:'remote edit'}}]);
  const before=structuredClone(store.files);
  await assert.rejects(b.saveBatch([{id:'move-guard',statement:statement('2026-11')}]),/移動元の明細/);
  assert.deepEqual(store.files,before);await a.saveBatch([{id:'move-guard',statement:statement('2026-11')}]);
  const after=structuredClone(store.files);
  b.setStatementConflictResolver(()=>true);
  await assert.rejects(b.saveBatch([{id:'move-guard',statement:{...old,sourceName:'stale edit'}}]),/年度間/);
  await assert.rejects(b.delete('move-guard'),/年度間/);
  assert.deepEqual(store.files,after);await b.refresh();assert.equal(b.records().length,1);assert.equal(b.records()[0].statement.billingMonth,'2026-11');
});

test('M203 integration: writer compatibility fence upgrades only on new metadata and is retained across year registration',async()=>{
 const [a,b,mock,store]=drivers();await a.create(secret);
 const initial=await mock.readFinanceIndex();assert.equal(JSON.parse(initial.text).format,'finance-cloud-index-envelope-v3');
 await b.unlock(secret);await b.refresh();assert.deepEqual(await mock.readFinanceIndex(),initial);
 await a.saveBatch([{id:'new-digest',statement:{...statement(),sourceKind:'pdf'},source:{bytes:new Uint8Array([37,80,68,70]),mime:'application/pdf'}}]);
 const upgraded=await mock.readFinanceIndex();assert.equal(JSON.parse(upgraded.text).format,'finance-cloud-index-envelope-v4');
 // A client implementing the preceding index format cannot proceed through its generation guard.
 const oldIndexParser=text=>{const v=JSON.parse(text);if(!['finance-cloud-index-envelope-v1','finance-cloud-index-envelope-v2','finance-cloud-index-envelope-v3'].includes(v.format))throw new Error('old format');return v;};
 assert.throws(()=>oldIndexParser(upgraded.text),/old format/);
 const writes=mock.calls.filter(x=>x==='index:finance').length;
 await b.saveBatch([{id:'other-year',statement:statement('2027-01')}]);assert.equal(JSON.parse((await mock.readFinanceIndex()).text).format,'finance-cloud-index-envelope-v4');
 assert.equal(mock.calls.filter(x=>x==='index:finance').length,writes+1,'only register the new year; do not repeat the compatibility upgrade');
 const reopened=new LiveVault(mock);await reopened.unlock(secret);assert.equal(reopened.records().length,2);assert.equal(store.originals.size,1);
});

test('H201: denied ordinary edit in mixed PDF batch never uploads the new original',async()=>{
 const [a,b,mock,store]=drivers();await a.create(secret);
 const initial=statement('2027-01','initial');await a.saveBatch([{id:'conflict-edit',statement:initial}]);await b.unlock(secret);
 await a.saveBatch([{id:'conflict-edit',statement:statement('2027-01','remote')}]);
 const before=structuredClone(store.files),originals=structuredClone(store.originals);let called=0;
 b.setStatementConflictResolver(()=>{called++;return false;});
 await assert.rejects(b.saveBatch([{id:'new-pdf',statement:{...statement('2026-11'),sourceKind:'pdf'},source:{bytes:new Uint8Array([37,80,68,70]),mime:'application/pdf'}},{id:'conflict-edit',statement:statement('2027-01','local')}]),/中止/);
 assert.equal(called,1);assert.deepEqual(store.files,before);assert.deepEqual(store.originals,originals);assert.equal(b.hasPendingYearBatch,false);
});
