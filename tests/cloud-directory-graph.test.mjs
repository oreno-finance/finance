import test from 'node:test';
import assert from 'node:assert/strict';
import { OneDriveTestClient } from '../dist/src/cloud/onedrive-api.js';
import { GraphError } from '../dist/src/cloud/onedrive-api.js';

const root='https://graph.microsoft.com/v1.0';
const uuid='12345678-1234-1234-1234-123456789abc';
const response=(obj,status=200)=>Response.json(obj,{status});

/** A small fake Microsoft Graph tree to assert real request paths, metadata, ETags and token scope. */
function drive() {
  const entries=new Map([['approot',{id:'approot',name:'Apps',folder:true,children:new Map()}]]);
  const uploads=new Map();const calls=[];
  let count=0;
  function child(parent,name){return entries.get(parent)?.children?.get(name)??null;}
  function create(parent,name,folder,text=''){
    const id=`node-${++count}`;
    const node={id,name,folder,children:folder?new Map():undefined,text,revision:1};
    entries.set(id,node);entries.get(parent).children.set(name,id);return node;
  }
  const http=async (url,init={})=>{
    calls.push({url,init});
    if(url.startsWith('https://upload.test/')) {
      assert.equal(init.headers?.Authorization,undefined,'bearer must NOT be sent to upload URL');
      assert.equal(init.credentials,'omit');
      const id=url.split('/').at(-1);const upload=uploads.get(id);
      if(!upload)return response({},404);
      if(upload.etag&&upload.existing.revision!==Number(upload.etag.replaceAll('"','')))return response({},412);
      const content=new TextDecoder().decode(init.body);
      if(upload.existing){upload.existing.text=content;upload.existing.revision++;return response({id:upload.existing.id,eTag:`"${upload.existing.revision}"`});}
      const item=create(upload.parent,upload.name,false,content);return response({id:item.id,eTag:'"1"'});
    }
    if(url.startsWith('https://download.test/')) {
      assert.equal(init.headers?.Authorization,undefined);
      const id=url.split('/').at(-1);return new Response(entries.get(id)?.text??'',{status:entries.has(id)?200:404});
    }
    assert.ok(url.startsWith(root));
    assert.equal(init.headers?.Authorization,'Bearer token');
    const path=url.slice(root.length);
    if(path==='/me/drive/special/approot')return response({id:'approot'});
    const match=path.match(/^\/me\/drive\/items\/([^/?]+)(?::\/([^?:]+))?(?::)?(\/createUploadSession|\/children)?(?:\?.*)?$/);
    if(!match)throw Error('unexpected graph path '+path);
    const [,id,name,suffix]=match;
    const parent=entries.get(decodeURIComponent(id));
    if(!parent)return response({error:{code:'itemNotFound'}},404);
    if(suffix==='/children'&&init.method==='POST'){
      const body=JSON.parse(init.body);
      if(child(parent.id,body.name))return response({error:{code:'nameAlreadyExists'}},409);
      return response(create(parent.id,body.name,true),201);
    }
    if(suffix==='/children')return response({value:[...parent.children.values()].map(childId=>({id:childId,name:entries.get(childId).name,folder:entries.get(childId).folder?{}:undefined,eTag:`\"${entries.get(childId).revision}\"`}))});
    if(suffix==='/createUploadSession'){
      const target=name? (child(parent.id,decodeURIComponent(name))?entries.get(child(parent.id,decodeURIComponent(name))):null):parent;
      if(name&&target)return response({error:{code:'nameAlreadyExists'}},409);
      if(!name&&init.headers?.['If-Match']!==`"${target.revision}"`)return response({error:{code:'preconditionFailed'}},412);
      const key=`upload-${++count}`;
      uploads.set(key,{parent:parent.id,name:name?decodeURIComponent(name):null,existing:name?null:target,etag:init.headers?.['If-Match']});
      return response({uploadUrl:`https://upload.test/${key}`});
    }
    if(name){const target=child(parent.id,decodeURIComponent(name));return target?response({id:target,eTag:`"${entries.get(target).revision}"`}):response({error:{code:'itemNotFound'}},404);}
    if(init.headers?.['If-None-Match']===`"${parent.revision}"`)return new Response(null,{status:304});
    return response({id:parent.id,size:parent.text?.length??0,eTag:`"${parent.revision}"`,'@microsoft.graph.downloadUrl':`https://download.test/${parent.id}`});
  };
  return {client:new OneDriveTestClient('token',http),calls,entries,http};
}

test('Finance index lives at Apps/Finance/finance/index.enc, not app root',async()=>{
  const {client,calls}=drive();
  assert.equal(await client.readFinanceIndex(),null);
  await client.writeFinanceIndex('cipher-index',null);
  const file=await client.readFinanceIndex();
  assert.equal(file.text,'cipher-index');
  assert.ok(calls.some(c=>c.url===root+'/me/drive/items/approot:/finance'));
  assert.ok(calls.some(c=>c.url.includes(':/index.enc:/createUploadSession')));
  assert.equal(calls.some(c=>c.url.includes('finance-v1-vault.enc')),false);
});

test('Finance year shards are independent resources with If-Match on update',async()=>{
  const {client,calls}=drive();
  await client.writeYearVault('2025','encrypted-year-2025',null);
  await client.writeYearVault('2026','encrypted-year-2026',null);
  const year=await client.readYearVault('2026');
  assert.equal(year.text,'encrypted-year-2026');
  await client.writeYearVault('2026','edited-year-2026',{id:year.id,etag:year.etag});
  assert.equal((await client.readYearVault('2025')).text,'encrypted-year-2025');
  assert.equal((await client.readYearVault('2026')).text,'edited-year-2026');
  assert.deepEqual(await client.listYearBuckets(),['2025','2026']);
  assert.ok(calls.some(c=>c.url===root+`/me/drive/items/${year.id}/createUploadSession`&&c.init.headers['If-Match']===year.etag));
});

test('PDF original goes to originals/YYYY/MM/UUID.enc and its payload remains private',async()=>{
  const {client,calls}=drive();
  const receipt=await client.uploadDatedOriginal(uuid,'encrypted pdf bytes','2026-11');
  assert.ok(receipt.id);assert.equal(receipt.etag,'"1"');
  assert.equal(await client.downloadDatedOriginal(uuid,'2026-11'),'encrypted pdf bytes');
  assert.ok(calls.some(c=>c.url.includes(':/2026')));
  assert.ok(calls.some(c=>c.url.includes(':/11')));
  assert.ok(calls.some(c=>c.url.includes(`:/${uuid}.enc:/createUploadSession`)));
  await assert.rejects(client.uploadDatedOriginal(uuid,'second blob','2026-11'),error=>error instanceof GraphError&&error.status===409);
});

test('the future Payroll namespace is separate and never stores card records',async()=>{
  const {client,calls}=drive();
  await client.ensurePayrollNamespace();
  assert.ok(calls.some(c=>c.url.includes(':/payroll')));
  assert.equal(await client.readFinanceIndex(),null);
});

test('directory cache removes repeated app-root and ancestor lookups',async()=>{
  const {client,calls}=drive();
  await client.writeYearVault('2026','cipher-1',null);
  calls.length=0;
  assert.equal((await client.readYearVault('2026')).text,'cipher-1');
  assert.equal((await client.readYearVault('2026')).text,'cipher-1');
  assert.equal(calls.filter(c=>c.url.endsWith('/me/drive/special/approot')).length,0);
  assert.equal(calls.filter(c=>c.url.endsWith(':/finance')||c.url.endsWith(':/statements')).length,0);
  assert.equal(calls.filter(c=>c.url.includes(':/2026.enc')).length,2);
});

test('concurrent PDF saves share ancestor creation and preserve immutable originals',async()=>{
  const {client,calls}=drive();
  const other='87654321-4321-4321-4321-cba987654321';
  await Promise.all([
    client.uploadDatedOriginal(uuid,'cipher-a','2026-11'),
    client.uploadDatedOriginal(other,'cipher-b','2026-11'),
  ]);
  assert.equal(await client.downloadDatedOriginal(uuid,'2026-11'),'cipher-a');
  assert.equal(await client.downloadDatedOriginal(other,'2026-11'),'cipher-b');
  assert.equal(calls.filter(c=>c.init.method==='POST'&&c.url.endsWith('/children')&&c.init.body?.includes('"name":"11"')).length,1);
  assert.equal(calls.filter(c=>c.url.endsWith('/me/drive/special/approot')).length,1);
});

test('listed-year read avoids named-path lookup and uses newest metadata ETag',async()=>{
  const {client,calls}=drive();
  await client.writeYearVault('2026','encrypted-one',null);
  const [file]=await client.listYearFiles();
  calls.length=0;
  const result=await client.readListedYearVault(file);
  assert.equal(result.text,'encrypted-one');
  assert.equal(result.etag,'"1"');
  assert.equal(calls.filter(c=>c.url.startsWith(root)).length,1,'single item metadata request');
  assert.equal(calls.filter(c=>c.url.startsWith('https://download.test/')).length,1);
});

test('Graph completion returns the committed ETag, including on update',async()=>{
  const {client}=drive();
  const initial=await client.writeYearVault('2026','cipher-1',null);
  assert.deepEqual(initial&&{id:initial.id,etag:initial.etag},{id:initial?.id,etag:'"1"'});
  const updated=await client.writeYearVault('2026','cipher-2',initial);
  assert.equal(updated?.etag,'"2"');
  await assert.rejects(client.writeYearVault('2026','outdated',initial),error=>error instanceof GraphError&&error.status===412);
  assert.equal((await client.readYearVault('2026')).text,'cipher-2');
});

test('conditional year check issues If-None-Match and skips ciphertext for HTTP 304',async()=>{
  const {client,calls}=drive();
  const original=await client.writeYearVault('2026','cipher-one',null);
  calls.length=0;
  assert.deepEqual(await client.readYearVaultForSave('2026',original),{kind:'unchanged'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].init.headers['If-None-Match'],original.etag);
  assert.equal(calls.filter(c=>c.url.startsWith('https://download.test/')).length,0);
  await client.writeYearVault('2026','cipher-two',original);
  calls.length=0;
  const changed=await client.readYearVaultForSave('2026',original);
  assert.equal(changed.kind,'remote');
  assert.equal(changed.file?.text,'cipher-two');
  assert.equal(changed.file?.etag,'"2"');
  assert.equal(calls.filter(c=>c.url.startsWith('https://download.test/')).length,1);
  assert.equal(calls.filter(c=>c.url.startsWith(root)).length,1);
});

test('merchant rules use isolated finance/rules/merchants.enc and conditional ETag updates',async()=>{
  const {client,calls}=drive();
  assert.equal(await client.readMerchantRules(),null);
  const initial=await client.writeMerchantRules('encrypted-merchant-rules-v1',null);
  assert.ok(initial?.id&&initial?.etag);
  const actual=await client.readMerchantRules();
  assert.equal(actual.text,'encrypted-merchant-rules-v1');
  assert.ok(calls.some(call=>call.url.includes(':/rules')));
  assert.ok(calls.some(call=>call.url.includes(':/merchants.enc:/createUploadSession')));
  assert.equal(calls.some(call=>call.url.includes(':/statements/')),false);
  const updated=await client.writeMerchantRules('encrypted-merchant-rules-v2',initial);
  assert.notEqual(updated.etag,initial.etag);
  await assert.rejects(client.writeMerchantRules('bad-stale-version',initial),error=>error instanceof GraphError&&error.status===412);
  assert.equal((await client.readMerchantRules()).text,'encrypted-merchant-rules-v2');
});


test('asset settings live in a separate encrypted Finance settings directory with ETag writes',async()=>{
  const {client,calls}=drive();
  assert.equal(await client.readAssetSettings(),null);
  await client.writeAssetSettings('encrypted-account-data',null);
  const file=await client.readAssetSettings();
  assert.equal(file.text,'encrypted-account-data');
  assert.ok(calls.some(c=>c.url.includes(':/settings')));
  assert.ok(calls.some(c=>c.url.includes(':/assets.enc:/createUploadSession')));
  await client.writeAssetSettings('encrypted-account-data-v2',{id:file.id,etag:file.etag});
  assert.equal((await client.readAssetSettings()).text,'encrypted-account-data-v2');
  await assert.rejects(client.writeAssetSettings('stale',{id:file.id,etag:file.etag}),error=>error instanceof GraphError&&error.status===412);
  assert.equal(await client.readMerchantRules(),null);
  assert.equal(await client.readFinanceIndex(),null);
});

test('rotated generation routes all mutable files to isolated version paths while root index remains stable',async()=>{
  const {client,calls}=drive();
  await client.writeFinanceIndex('initial-index',null);
  await client.writeYearVault('2026','old-ciphertext',null);
  await client.writeMerchantRules('old-rules',null);
  await client.writeAssetSettings('old-assets',null);
  await client.uploadDatedOriginal(uuid,'old-original','2026-11');
  const next=client.forVaultDataSet(uuid);
  await next.writeYearVault('2026','new-ciphertext',null);
  await next.writeMerchantRules('new-rules',null);
  await next.writeAssetSettings('new-assets',null);
  await next.uploadDatedOriginal(uuid,'new-original','2026-11');
  assert.equal((await next.readFinanceIndex()).text,'initial-index','the index is always at the root');
  assert.equal((await next.readYearVault('2026')).text,'new-ciphertext');
  assert.equal((await next.readMerchantRules()).text,'new-rules');
  assert.equal((await next.readAssetSettings()).text,'new-assets');
  assert.equal(await next.downloadDatedOriginal(uuid,'2026-11'),'new-original');
  assert.equal((await client.readYearVault('2026')).text,'old-ciphertext','old generation not rewritten');
  assert.equal(await client.downloadDatedOriginal(uuid,'2026-11'),'old-original');
  assert.deepEqual(await next.listYearBuckets(),['2026']);
  assert.ok(calls.some(c=>c.url.includes(`:/${uuid}`)), 'generation has its own folder');
  client.setVaultDataSet(uuid);
  assert.equal((await client.readYearVault('2026')).text,'new-ciphertext');
  assert.throws(()=>client.setVaultDataSet('../finance'),/世代ID/);
});


test('reserved versions folder is resolved by children listing without calling Graph version-history route',async()=>{
  const {client,http}=drive();
  const versioned=client.forVaultDataSet(uuid);
  await versioned.writeYearVault('2026','cipher-2026',null);
  const paths=[];
  const recovered=new OneDriveTestClient('token',async(url,init={})=>{
    paths.push({url,method:init.method??'GET'});
    if(url.endsWith(':/versions'))return new Response('{"value":[1 2]}',{status:200,headers:{'Content-Type':'application/json'}});
    return http(url,init);
  });
  recovered.setVaultDataSet(uuid);
  assert.deepEqual((await recovered.listYearFiles()).map(item=>item.year),['2026']);
  assert.equal(paths.filter(x=>x.url.endsWith(':/versions')).length,0, 'reserved route must never be requested');
  assert.ok(paths.some(x=>x.url.includes('/children?$select=id,name,folder&$top=200')));
  assert.ok(paths.every(x=>x.method==='GET'),'fallback must not write to OneDrive');
});

test('corrupted metadata and collection JSON fail safely without creating folders',async()=>{
  const {client,http}=drive();
  const versioned=client.forVaultDataSet(uuid);
  await versioned.writeYearVault('2026','cipher-2026',null);
  const paths=[];
  const unreadable=new OneDriveTestClient('token',async(url,init={})=>{
    paths.push({url,method:init.method??'GET'});
    if(url.endsWith(':/versions'))return new Response('{"id":"bad",]',{status:200,headers:{'Content-Type':'application/json'}});
    if(url.includes('/children?$select=id,name,folder&$top=200'))return new Response('[broken', {status:200,headers:{'Content-Type':'application/json'}});
    return http(url,init);
  });
  unreadable.setVaultDataSet(uuid);
  await assert.rejects(unreadable.listYearFiles(),/両方の方法で解析できません/);
  assert.ok(!paths.some(x=>x.url.endsWith(':/versions')));
  assert.ok(paths.every(x=>x.method==='GET'),'diagnosis must not mutate on failed fallback');
});

test('Payroll new generation income uses listed versions folder and never calls the reserved route',async()=>{
  const generation='11111111-2222-4333-8444-555555555555';
  const calls=[];
  const api=new OneDriveTestClient('token',async(url,init={})=>{
    calls.push({url,method:init.method??'GET',cache:init.cache});
    if(url.endsWith('/me/drive/special/approot'))return Response.json({id:'app'});
    if(url.endsWith('/app:/payroll'))return Response.json({id:'payroll-id',folder:{}});
    if(url.endsWith('/payroll-id/children?$select=id,name,folder&$top=200'))
      return Response.json({value:[{id:'versions-id',name:'versions',folder:{}}]});
    if(url.endsWith(':/versions'))return Response.json({error:{code:'BadRequest'}},{status:400});
    if(url.endsWith(`/versions-id:/${generation}`))return Response.json({id:'gen-id',folder:{}});
    if(url.endsWith('/gen-id:/income'))return Response.json({id:'income-id',folder:{}});
    if(url.endsWith('/income-id:/2026.enc'))
      return Response.json({id:'income-file',eTag:'etag-income','@microsoft.graph.downloadUrl':'https://example.test/payroll-income'});
    if(url.endsWith('https://example.test/payroll-income'))return new Response('test-encrypted-file',{status:200});
    throw Error('Unexpected graph request '+url);
  });
  const file=await api.readPayrollPublishedFile(['versions',generation,'income'],'2026.enc',1024);
  assert.equal(file?.text,'test-encrypted-file');
  const before=calls.length;
  assert.deepEqual(await api.readPayrollPublishedMetadata(['versions',generation,'income'],'2026.enc'),{id:'income-file',etag:'etag-income'});
  assert.equal(calls.length,before+1,'metadata check must not download ciphertext');
  assert.equal(calls.at(-1).cache,'no-store');
  await assert.rejects(api.readPayrollPublishedMetadata(['statements'],'2026.enc'),/限定/);
  await assert.rejects(api.readPayrollPublishedMetadata(['income'],'index.enc'),/不正/);
  assert.ok(!calls.some(c=>c.url.endsWith(':/versions')));
  assert.ok(calls.some(c=>c.url.includes('/payroll-id/children?$select=id,name,folder&$top=200')));
  assert.ok(calls.every(c=>c.method==='GET'));
});
