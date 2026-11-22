import test from 'node:test';
import assert from 'node:assert/strict';
import { asSnapshots, isSnapshotName, snapshotName, validateBackupText } from '../dist/src/cloud/vault-snapshots.js';
import { OneDriveTestClient, GraphError } from '../dist/src/cloud/onedrive-api.js';

const text = JSON.stringify({ format:'finance-encrypted-backup-v1', meta:{salt:[1]}, records:[{id:'s1',statement:{iv:[1],data:'cipher'}}] });
const name = snapshotName(new Date('2026-11-15T12:30:00Z'), '11111111-1111-4111-8111-111111111111');

test('Snapshot naming is unique and rejects unexpected names', () => {
  assert.equal(isSnapshotName(name), true);
  for (const bad of ['../../secret.txt', 'finance-vault-other.json', 'finance-vault-2026.enc.json']) assert.equal(isSnapshotName(bad), false);
  assert.throws(() => snapshotName(new Date(), '../'), /不正/);
});

test('Backup payload is validated before upload or restore', () => {
  assert.doesNotThrow(() => validateBackupText(text));
  assert.throws(() => validateBackupText('{bad'), /JSON/);
  assert.throws(() => validateBackupText(JSON.stringify({records:[]})), /バックアップ/);
});

test('Snapshot listing excludes foreign files, invalid metadata, and sorts newest first', () => {
  const items = [
    {id:'older',name,size:90,createdDateTime:'2026-11-14T00:00:00Z'},
    {id:'foreign',name:'secret.pdf',size:90,createdDateTime:'2026-11-15T00:00:00Z'},
    {id:'newer',name:snapshotName(new Date('2026-11-16T00:00:00Z'),'22222222-2222-4222-8222-222222222222'),size:100,createdDateTime:'2026-11-16T00:00:00Z'},
  ];
  assert.deepEqual(asSnapshots(items).map(v => v.id), ['newer','older']);
});

test('Graph creates immutable encrypted snapshot and downloads without exposing bearer token', async () => {
  const files = new Map();
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({url,init});
    if (url.endsWith('/me/drive/special/approot')) return Response.json({id:'appfolder'});
    if (url.includes('/children?')) return Response.json({value:[...files.values()].map(({id,name,size,createdDateTime}) => ({id,name,size,createdDateTime}))});
    if (url.includes(':/content?@microsoft.graph.conflictBehavior=fail') && init.method === 'PUT') {
      assert.ok(url.includes('conflictBehavior=fail'));
      assert.equal(init.headers.Authorization,'Bearer TOKEN');
      assert.ok(!init.body.includes('my-password'));
      const name = decodeURIComponent(url.match(/items\/appfolder:\/(.*):\/content\?/)[1]);
      const item = { id:'i1',name,size:new TextEncoder().encode(init.body).byteLength,createdDateTime:'2026-11-15T12:00:00Z',body:init.body };
      if (files.has(name)) return Response.json({error:{code:'nameAlreadyExists'}},{status:409});
      files.set(name,item);
      return Response.json(item);
    }
    if (url.endsWith('/me/drive/items/i1')) return Response.json({id:'i1',size:files.values().next().value.size,'@microsoft.graph.downloadUrl':'https://files.example.test/snapshot'});
    if (url === 'https://files.example.test/snapshot') {
      assert.equal(init.headers?.Authorization,undefined);
      assert.equal(init.credentials,'omit');
      return new Response(files.values().next().value.body,{status:200});
    }
    throw new Error('Unexpected '+url);
  };
  const api = new OneDriveTestClient('TOKEN',fakeFetch);
  const created = await api.uploadVaultSnapshot(text);
  const listed = await api.listVaultSnapshots();
  assert.equal(listed.length,1);
  assert.equal(listed[0].id,created.id);
  assert.equal(await api.downloadVaultSnapshot(listed[0]),text);
  await assert.rejects(api.downloadVaultSnapshot({...created,id:'unlisted'}), /見つかりません/);
  assert.equal(calls.filter(x => x.url.includes(':/content?')).length,1);
});

test('Graph refuses paginated listing instead of silently dropping older snapshots',async () => {
  const api = new OneDriveTestClient('TOKEN',async url => url.endsWith('/approot')
    ? Response.json({id:'root'}) : Response.json({value:[], '@odata.nextLink':'https://graph.microsoft.com/v1.0/next'}));
  await assert.rejects(api.listVaultSnapshots(), /200件/);
});

test('Graph surface returns 412 conflict without overwriting content',async () => {
  const api = new OneDriveTestClient('TOKEN',async url => url.endsWith('/approot')
    ? Response.json({id:'root'}) : Response.json({error:{code:'preconditionFailed'}},{status:412}));
  await assert.rejects(api.uploadVaultSnapshot(text),error => error instanceof GraphError && error.status === 412);
});

test('Large encrypted vault uploads via chunked session without sending bearer token to upload URL', async () => {
  const big = JSON.stringify({format:'finance-encrypted-backup-v1',meta:{salt:[1]},records:[{id:'s',statement:{iv:[1],data:'X'.repeat(4 * 1024 * 1024)}}]});
  let offset = 0;
  let chunks = 0;
  const api = new OneDriveTestClient('TOKEN',async (url,init={}) => {
    if (url.endsWith('/me/drive/special/approot')) return Response.json({id:'folder'});
    if (url.endsWith('/createUploadSession')) {
      assert.equal(init.method,'POST');
      assert.equal(JSON.parse(init.body).item['@microsoft.graph.conflictBehavior'],'fail');
      return Response.json({uploadUrl:'https://upload.example.test/private'});
    }
    if (url === 'https://upload.example.test/private') {
      assert.equal(init.headers.Authorization,undefined);
      assert.equal(init.credentials,'omit');
      const [_,a,b,total] = init.headers['Content-Range'].match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      assert.equal(+a,offset);
      assert.equal(+total,new TextEncoder().encode(big).byteLength);
      assert.equal(+b-+a+1,init.body.byteLength);
      offset += init.body.byteLength;
      chunks++;
      return offset === +total ? Response.json({id:'large-file',createdDateTime:'2026-11-15T01:00:00Z'},{status:201}) : new Response(null,{status:202});
    }
    throw new Error('Unexpected '+url);
  });
  const saved = await api.uploadVaultSnapshot(big);
  assert.equal(saved.id,'large-file');
  assert.ok(chunks >= 2);
  assert.equal(offset,new TextEncoder().encode(big).byteLength);
});

test('cleanup enumeration matches exact root names and requires valid snapshot metadata',async()=>{
  const known=snapshotName(new Date('2026-11-19T01:00:00Z'),'11111111-1111-4111-8111-111111111111');
  const api=new OneDriveTestClient('TOKEN',async (url)=>{
    if(url.endsWith('/approot'))return Response.json({id:'root'});
    if(url.includes('/children?'))return Response.json({value:[
      {id:'v1',name:'finance-v1-vault.enc',eTag:'v1'},
      {id:'v1orig',name:'finance-v1-originals',folder:{},eTag:'orig'},
      {id:'s1',name:known,eTag:'s1',size:500,createdDateTime:'2026-11-19T01:00:00Z'},
      {id:'other',name:'finance-v1-vault.enc.bak',eTag:'e3'},
      {id:'unrelated',name:'payroll-vault.enc',eTag:'e4'},
    ]});
    throw new Error('unrecognized path '+url);
  });
  const found=await api.listRetiredRootData();
  assert.deepEqual(found.legacyV1.map(item=>item.id),['v1','v1orig']);
  assert.deepEqual(found.snapshots.map(item=>item.id),['s1']);
});

test('cleanup rejects incomplete root enumeration and malformed snapshot metadata',async()=>{
  const known=snapshotName(new Date('2026-11-19T01:00:00Z'),'11111111-1111-4111-8111-111111111111');
  const create=(value)=>new OneDriveTestClient('TOKEN',async url=>
    url.endsWith('/approot')?Response.json({id:'root'}):Response.json(value));
  await assert.rejects(create({value:[], '@odata.nextLink':'https://graph.microsoft.com/next'}).listRetiredRootData(),/全件確認/);
  await assert.rejects(create({value:[{id:'s1',name:known,eTag:'one'}]}).listRetiredRootData(),/メタデータ/);
});
