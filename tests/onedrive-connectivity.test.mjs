import test from 'node:test';
import assert from 'node:assert/strict';
import { OneDriveTestClient, GraphError } from '../dist/src/cloud/onedrive-api.js';

// The retired probe no longer ships. Exercise the actual encrypted backup and vault transport.
test('Graph appfolder backup upload and download use correct authorization boundaries', async () => {
  const payload=JSON.stringify({format:'finance-encrypted-backup-v1',meta:{},records:[]});
  let name, uploaded;
  const api=new OneDriveTestClient('TEST_TOKEN',async(url,init)=>{
    if(url.endsWith('/me/drive/special/approot'))return Response.json({id:'folder'});
    if(init.method==='PUT'){
      assert.equal(init.headers.Authorization,'Bearer TEST_TOKEN');
      name=decodeURIComponent(url.match(/folder:\/(.+):\/content/)[1]);
      uploaded=new TextDecoder().decode(init.body);return Response.json({id:'file',eTag:'e1',name,size:init.body.byteLength});
    }
    if(url.includes('/children?'))return Response.json({value:[{id:'file',name,size:payload.length,createdDateTime:'2026-11-01T00:00:00.000Z'}]});
    if(url.endsWith('/items/file'))return Response.json({id:'file',eTag:'e1','@microsoft.graph.downloadUrl':'https://files.example.test/payload'});
    if(url==='https://files.example.test/payload'){
      assert.equal(init.headers?.Authorization,undefined);assert.equal(init.credentials,'omit');return new Response(uploaded);
    }
    throw Error(`Unexpected request ${url}`);
  });
  const snapshot=await api.uploadVaultSnapshot(payload);
  assert.match(snapshot.name,/^finance-vault-/);
  assert.equal(await api.downloadVaultSnapshot(snapshot),payload);
});

test('Graph errors are preserved as a status code without exposing sensitive bodies', async () => {
  const api = new OneDriveTestClient('x', async () => Response.json({error:{code:'accessDenied',message:'SECRET-DO-NOT-EXPOSE'}}, {status:403}));
  await assert.rejects(api.appFolderId(), error => {
    assert.ok(error instanceof GraphError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'accessDenied');
    assert.equal(error.message.includes('SECRET'), false);
    return true;
  });
});

test('Graph blocks non-HTTPS download URL from metadata on real vault read', async () => {
  const api=new OneDriveTestClient('x',async url=>url.endsWith('/me/drive/special/approot')?Response.json({id:'folder'}):Response.json({id:'f1',eTag:'e1','@microsoft.graph.downloadUrl':'http://insecure.test/file'}));
  await assert.rejects(api.readLiveVault(),/安全なダウンロードURL/);
});

test('Default Graph fetch preserves the browser global receiver (Illegal invocation regression)', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  // Mimic the WebIDL receiver check performed by Window.fetch in browsers.
  globalThis.fetch = function(input, init) {
    assert.equal(this, globalThis);
    assert.equal(input, 'https://graph.microsoft.com/v1.0/me/drive/special/approot');
    assert.equal(init.headers.Authorization, 'Bearer TEST_TOKEN');
    called = true;
    return Promise.resolve(Response.json({ id: 'folder-v092' }));
  };
  try {
    const api = new OneDriveTestClient('TEST_TOKEN');
    assert.equal(await api.appFolderId(), 'folder-v092');
    assert.equal(called, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
