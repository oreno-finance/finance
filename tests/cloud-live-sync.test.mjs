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
