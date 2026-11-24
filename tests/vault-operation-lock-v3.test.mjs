import test from 'node:test';
import assert from 'node:assert/strict';
import {OneDriveTestClient,VaultOperationBusyError} from '../dist/src/cloud/onedrive-api.js';
const name='finance-operation-lock';
const err=(status,code)=>Response.json({error:{code}},{status});
const state=()=>({marker:null,requests:[],serial:0,mode:'normal',onSession:null});
function driver(shared,token='synthetic-graph-token'){
 const fetch=async(url,init)=>{
  shared.requests.push({url,method:init.method,headers:init.headers,body:typeof init.body==='string'?init.body:null});
  if(url.endsWith('/children')&&init.method==='POST'){
   const body=JSON.parse(init.body);assert.equal(body.name,name);assert.deepEqual(body.folder,{});assert.equal(body['@microsoft.graph.conflictBehavior'],'fail');
   if(shared.marker)return err(409,'nameAlreadyExists');
   shared.marker={id:`marker-${++shared.serial}`,name,eTag:`"${shared.serial}"`,folder:{}};
   if(shared.mode==='lost-create')throw new Error('lost creation response');
   return Response.json(shared.marker,{status:201});
  }
  if(init.method==='DELETE'){
   assert.ok(shared.marker);assert.ok(url.endsWith('/'+shared.marker.id));assert.equal(init.headers['If-Match'],shared.marker.eTag);
   if(shared.mode==='replaced')return err(412,'preconditionFailed');
   shared.marker=null;return new Response(null,{status:204});
  }
  if(url.endsWith('/createUploadSession')){
   shared.onSession?.();return Response.json({uploadUrl:'https://upload.invalid/session'});
  }
  if(url==='https://upload.invalid/session'){
   if(shared.mode==='lost-write')throw new Error('lost upload response');
   return Response.json({id:'cipher',eTag:'"9"'},{status:201});
  }
  throw new Error('Unexpected fixture request');
 };
 const client=new OneDriveTestClient(token,fetch);client.folderPath=async()=> 'finance-root';return client;
}
const valid=()=>{};
test('Phase 6E: 実Graphクライアントは固定名の新規作成のみを所有権として認め、競合中は解除しない',async()=>{
 const shared=state(),a=driver(shared),b=driver(shared);
 const release=await a.acquireVaultMutation(valid);const first=shared.marker.id;
 await assert.rejects(b.acquireVaultMutation(valid),VaultOperationBusyError);
 assert.equal(shared.marker.id,first);assert.equal(shared.requests.filter(r=>r.method==='DELETE').length,0);
 await release();assert.equal(shared.marker,null);
 const next=await b.acquireVaultMutation(valid);assert.notEqual(shared.marker.id,first);await next();assert.equal(shared.marker,null);
});
test('Phase 6E: 操作ロックの作成応答を失った場合は既存フォルダーを横取りしない',async()=>{
 const shared=state(),a=driver(shared),b=driver(shared);shared.mode='lost-create';
 await assert.rejects(a.acquireVaultMutation(valid),/操作権を確認できません/);
 const first=shared.marker.id;shared.mode='normal';await assert.rejects(b.acquireVaultMutation(valid),VaultOperationBusyError);
 assert.equal(shared.marker.id,first);assert.equal(shared.requests.filter(r=>r.method==='DELETE').length,0);
});
test('Phase 6E: 書込み応答不明では操作ロックを維持し、別端末の管理操作を拒否する',async()=>{
 const shared=state(),a=driver(shared),b=driver(shared),release=await a.acquireVaultMutation(valid);
 shared.mode='lost-write';await assert.rejects(a.writeAssetSettings('synthetic-ciphertext',null),/lost upload/);
 await assert.rejects(release(),/操作ロックを保持/);assert.ok(shared.marker);assert.equal(shared.requests.filter(r=>r.method==='DELETE').length,0);
 shared.mode='normal';await assert.rejects(b.acquireVaultMutation(valid),VaultOperationBusyError);
});
test('Phase 6E: upload session取得中にロックされれば暗号ファイルのチャンクを一件も送らない',async()=>{
 const shared=state(),a=driver(shared);let locked=false;
 const guard=()=>{if(locked)throw new Error('locked');};
 const release=await a.acquireVaultMutation(guard);shared.onSession=()=>{locked=true;};
 await assert.rejects(a.writeAssetSettings('synthetic-ciphertext',null),/locked/);
 assert.equal(shared.requests.filter(r=>r.url==='https://upload.invalid/session').length,0);
 await release();assert.equal(shared.marker,null,'未送信のチャンクは不明な保存と区別する');
});
test('Phase 6E: ロックの解除は作成時のIDとETagに限定し412を成功扱いしない',async()=>{
 const shared=state(),a=driver(shared),b=driver(shared),release=await a.acquireVaultMutation(valid);shared.mode='replaced';
 await assert.rejects(release(),/412/);assert.ok(shared.marker);await assert.rejects(b.acquireVaultMutation(valid),VaultOperationBusyError);
});
