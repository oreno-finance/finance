import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeDocuments,emptyDocument} from '../dist/src/cloud/merge.js';
function record(id='A') {return {id,statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'paste',billingMonth:'2026-11',paymentDate:null,statedTotal:100,confirmation:'confirmed',warnings:[],rows:[{id:'r1',usedOn:'2026-11-01',merchant:'store',amount:100,description:''},{id:'r2',usedOn:'2026-11-02',merchant:'B',amount:0,description:''}]}}}
const doc=(...records)=>({...emptyDocument(),records});
const clone=structuredClone;
test('disjoint concurrent imports are both retained',()=>{
  const result=mergeDocuments(emptyDocument(),doc(record('A')),doc(record('B')));
  assert.deepEqual(result.records.map(r=>r.id).sort(),['A','B']);
});
test('same statement, different fields and separate row edits merge',()=>{
  const base=doc(record()),local=clone(base),remote=clone(base);
  local.records[0].statement.paymentDate='2026-11-27';
  local.records[0].statement.rows[0].merchant='new store';
  remote.records[0].statement.statedTotal=150;
  remote.records[0].statement.rows[1].amount=50;
  const result=mergeDocuments(base,local,remote);
  const s=result.records[0].statement;
  assert.equal(s.paymentDate,'2026-11-27');assert.equal(s.statedTotal,150);
  assert.equal(s.rows[0].merchant,'new store');assert.equal(s.rows[1].amount,50);
  assert.equal(result.conflicts.length,0);
});
test('same-field conflict retains discarded value encrypted inside audit log',()=>{
  const base=doc(record()),local=clone(base),remote=clone(base);
  local.records[0].statement.statedTotal=120;remote.records[0].statement.statedTotal=130;
  const result=mergeDocuments(base,local,remote);
  assert.equal(result.records[0].statement.statedTotal,120);
  assert.ok(result.conflicts.some(x=>x.discarded===130&&x.chosen===120));
});
test('delete against unchanged remote wins',()=>{
  const base=doc(record()),local=doc(),remote=clone(base);local.deleted=['A'];
  const result=mergeDocuments(base,local,remote);
  assert.equal(result.records.length,0);assert.deepEqual(result.deleted,['A']);
});
test('delete/edit race preserves edit and records conflict',()=>{
  const base=doc(record()),local=doc(),remote=clone(base);local.deleted=['A'];
  remote.records[0].statement.rows[0].merchant='updated';
  const result=mergeDocuments(base,local,remote);
  assert.equal(result.records[0].statement.rows[0].merchant,'updated');
  assert.equal(result.deleted.length,0);
  assert.ok(result.conflicts.length);
});
test('remote deletion against local update preserves local update',()=>{
  const base=doc(record()),local=clone(base),remote=doc();remote.deleted=['A'];
  local.records[0].statement.rows[0].merchant='local';
  const result=mergeDocuments(base,local,remote);
  assert.equal(result.records[0].statement.rows[0].merchant,'local');
});
test('concurrent row insertion and row deletion are reconciled by row id',()=>{
  const base=doc(record()),local=clone(base),remote=clone(base);
  local.records[0].statement.rows.push({id:'r3',usedOn:'2026-11-03',merchant:'C',amount:9});
  remote.records[0].statement.rows.splice(0,1);
  const result=mergeDocuments(base,local,remote);
  assert.deepEqual(result.records[0].statement.rows.map(r=>r.id),['r2','r3']);
});

test('L203: structural validation separates repairable financial errors from unsafe JSON',async()=>{
 const {validateCloudDocument}=await import('../dist/src/cloud/merge.js');
 const normal=doc(record());normal.records[0].statement.billingMonth=null;normal.records[0].statement.confirmation='unknown';
 normal.records[0].statement.rows[0].amount=-100;normal.records[0].statement.rows[0].usedOn='invalid';normal.records[0].statement.extra={harmless:true};
 assert.deepEqual(validateCloudDocument(normal),normal);
 for(const mutate of [
  d=>d.records.push(clone(d.records[0])),
  d=>d.records[0].statement.rows.push(null),
  d=>d.records[0].statement.rows[0].amount='10',
  d=>d.records[0].statement.rows[0].amount=Number.MAX_SAFE_INTEGER+1,
  d=>d.records[0].originalId='../invalid',
  d=>d.deleted.push(d.records[0].id),
  d=>d.deleted.push(null),
  d=>d.conflicts.push({recordId:'A',path:'record',at:'invalid',discarded:null,chosen:null}),
  d=>d.records[0].statement.extra=JSON.parse('{"__proto__":{"synthetic":true}}'),
 ]){const invalid=clone(normal);mutate(invalid);assert.throws(()=>validateCloudDocument(invalid));}
 assert.equal({}.synthetic,undefined);
});

test('M203: original reference fields are merged atomically and malformed digests are rejected',async()=>{
  const {validateCloudDocument,detectDocumentEditCollisions}=await import('../dist/src/cloud/merge.js');
  const base=doc({...record(),originalId:'00000000-0000-4000-8000-000000000001',originalMonth:'2026-10',originalSha256:'a'.repeat(64)});
  const local=clone(base),remote=clone(base);
  local.records[0].originalId='00000000-0000-4000-8000-000000000002';local.records[0].originalSha256='b'.repeat(64);
  remote.records[0].originalId='00000000-0000-4000-8000-000000000003';remote.records[0].originalMonth='2026-09';remote.records[0].originalSha256='c'.repeat(64);
  const result=mergeDocuments(base,local,remote).records[0];
  for(const k of ['originalId','originalMonth','originalSha256'])assert.equal(result[k],local.records[0][k]);
  assert.ok(detectDocumentEditCollisions(base,local,remote).some(c=>c.path==='record.originalReference'));
  const wrong=clone(base);wrong.records[0].originalSha256='invalid';assert.throws(()=>validateCloudDocument(wrong));
  delete wrong.records[0].originalId;wrong.records[0].originalSha256='a'.repeat(64);assert.throws(()=>validateCloudDocument(wrong));
  const legacy=clone(base);delete legacy.records[0].originalSha256;assert.deepEqual(validateCloudDocument(legacy),legacy);
});
