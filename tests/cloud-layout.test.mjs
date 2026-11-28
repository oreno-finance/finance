import test from 'node:test';
import assert from 'node:assert/strict';
import { statementBucket, originalParts, emptyIndex, validateIndex } from '../dist/src/cloud/layout.js';
import { encryptIndex, decryptIndex, deriveCloudKey, freshSalt, parseIndexEnvelope } from '../dist/src/cloud/cloud-crypto.js';

test('billing-year path rejects malformed months and routes undated records safely',()=>{
  assert.equal(statementBucket('2026-11'),'2026');
  assert.equal(statementBucket('2026-13'),'undated');
  assert.equal(statementBucket(null),'undated');
  assert.deepEqual(originalParts('2026-11'),['2026','11']);
  assert.deepEqual(originalParts(null),['undated','00']);
});
test('encrypted index is authenticated and never contains raw year list as plaintext',async()=>{
  const salt=freshSalt(),key=await deriveCloudKey('safe-passphrase-for-test',salt);
  const index={...emptyIndex(),years:['2025','2026']};
  const text=await encryptIndex(index,key,salt);
  assert.ok(!text.includes('2025'));
  assert.deepEqual(await decryptIndex(parseIndexEnvelope(text),key),index);
  const wrong=await deriveCloudKey('wrong-passphrase',salt);
  await assert.rejects(decryptIndex(parseIndexEnvelope(text),wrong),/パスフレーズ/);
  const changed=JSON.parse(text);changed.iv=changed.iv.replace(/^./,changed.iv[0]==='A'?'B':'A');
  await assert.rejects(decryptIndex(parseIndexEnvelope(JSON.stringify(changed)),key),/破損/);
});
test('cloud index rejects unsafe folder keys and duplicate years',()=>{
  assert.throws(()=>validateIndex({format:'finance-cloud-index-v1',years:['2026','2026']}),/重複/);
  assert.throws(()=>validateIndex({format:'finance-cloud-index-v1',years:['../payroll']}),/不正/);
  assert.throws(()=>validateIndex({format:'finance-cloud-index-v1',years:['2026/11']}),/不正/);
});

test('writer v4 index authenticates its format and generation, and keeps old indexes readable',async()=>{
 const salt=freshSalt(),key=await deriveCloudKey('safe-passphrase-for-test',salt),generation=crypto.randomUUID();
 const index={...emptyIndex(),years:['2026']};
 for(const coordinated of [false,true,'v4']){
  const text=await encryptIndex(index,key,salt,generation,coordinated);const env=parseIndexEnvelope(text);
  assert.deepEqual(await decryptIndex(env,key),index);
  if(coordinated==='v4'){
   assert.equal(env.format,'finance-cloud-index-envelope-v4');
   await assert.rejects(decryptIndex({...env,format:'finance-cloud-index-envelope-v3'},key),/破損/);
   await assert.rejects(decryptIndex({...env,dataSetId:crypto.randomUUID()},key),/破損/);
  }
 }
});
