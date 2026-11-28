import test from 'node:test';
import assert from 'node:assert/strict';
import {financePerformanceAuto,traceFinanceOperation,countFinanceRequest,measureFinancePhase,financePerformanceReport,clearFinancePerformance} from '../dist/src/cloud/performance-diagnostics.js';
import {OneDriveTestClient} from '../dist/src/cloud/onedrive-api.js';

const capture=async run=>{
  const original=console.info,logs=[];
  console.info=(message)=>{const newline=message.indexOf("\n");logs.push([message.slice(0,newline),JSON.parse(message.slice(newline+1))]);};
  clearFinancePerformance();financePerformanceAuto(false);
  try{await run(logs);}finally{financePerformanceAuto(false);clearFinancePerformance();console.info=original;}
};
const request=()=>traceFinanceOperation('onedrive',async()=>{
  countFinanceRequest('graph.get');
  await measureFinancePhase('graph.request',async()=>{});
});
test('automatic diagnostics are opt-in; local-only actions do not log',()=>capture(async logs=>{
  await traceFinanceOperation('refresh',request);
  assert.equal(logs.length,0);
  assert.equal(financePerformanceAuto(true),true);
  await traceFinanceOperation('statement-save',async()=>{});
  assert.equal(logs.length,0);
  await traceFinanceOperation('statement-delete',async()=>{await request();await request();});
  assert.equal(logs.length,1);
  assert.deepEqual(logs[0][1].operations,['明細削除']);
  assert.equal(logs[0][1].requests['graph.get'],2);
  assert.equal(logs[0][1].totalRequests,2);
  assert.equal(logs[0][1].phases['graph.request'].count,2);
  assert.equal(financePerformanceReport().requests['graph.get'],3);
  financePerformanceAuto(false);await request();assert.equal(logs.length,1);
}));
test('overlapping scopes wait for both and explicitly group their counts',()=>capture(async logs=>{
  financePerformanceAuto(true);
  let release;const held=new Promise(resolve=>{release=resolve;});
  const a=traceFinanceOperation('refresh',async()=>{await request();await held;});
  await traceFinanceOperation('payroll-sync',request);
  assert.equal(logs.length,0);release();await a;
  assert.equal(logs.length,1);
  assert.deepEqual(logs[0][1].operations,['最新取得','Payroll同期']);
  assert.equal(logs[0][1].requests['graph.get'],2);
}));
test('failure logs numeric diagnostics only, then propagates the exact error',()=>capture(async logs=>{
  financePerformanceAuto(true);
  const error=new Error('synthetic-sensitive-marker');
  await assert.rejects(traceFinanceOperation('report-read',async()=>{
    countFinanceRequest('graph.get');
    await measureFinancePhase('graph.request',async()=>{throw error;});
  }),e=>e===error);
  assert.equal(logs.length,1);assert.equal(logs[0][1].rejectedScopes,1);
  assert.equal(logs[0][1].phases['graph.request'].failures,1);
  assert.doesNotMatch(JSON.stringify(logs),/synthetic-sensitive-marker/);
  await request();assert.equal(logs.length,2);
}));
test('disabling discards pending output and can be enabled again',()=>capture(async logs=>{
  financePerformanceAuto(true);let release;
  const held=new Promise(resolve=>{release=resolve;});
  const a=traceFinanceOperation('refresh',async()=>{await request();await held;});
  financePerformanceAuto(false);release();await a;assert.equal(logs.length,0);
  financePerformanceAuto(true);await request();assert.equal(logs.length,1);
  assert.equal(logs[0][1].requests['graph.get'],1);
}));
test('a real client request without an outer operation emits a safe fallback',()=>capture(async logs=>{
  financePerformanceAuto(true);
  const client=new OneDriveTestClient('synthetic-test-only',async()=>new Response(JSON.stringify({id:'synthetic-private-id'}),{status:200,headers:{'Content-Type':'application/json'}}));
  await client.appFolderId();
  assert.equal(logs.length,1);assert.equal(logs[0][1].requests['graph.get'],1);
  assert.doesNotMatch(JSON.stringify(logs),/synthetic-(?:test-only|private-id)/);
}));

test('HTTP status and retry diagnostics are numeric, scoped and copyable',()=>capture(async logs=>{
  financePerformanceAuto(true);let calls=0;
  const client=new OneDriveTestClient('synthetic-secret',async()=>++calls===1
    ?new Response('{}',{status:429,headers:{'Retry-After':'0'}})
    :Response.json({id:'synthetic-id'}));
  await client.appFolderId();
  assert.equal(logs.length,1);const result=logs[0][1];
  assert.equal(result.totalRequests,2);assert.deepEqual(result.httpStatuses,{'200':1,'429':1});assert.equal(result.retries,1);
  assert.doesNotMatch(JSON.stringify(logs),/synthetic-(?:secret|id)/);
}));
test('412 lock recovery remains conditional and records separate acquire/release/revalidation timings',()=>capture(async logs=>{
  financePerformanceAuto(true);
  const marker={id:'synthetic-marker',name:'finance-operation-lock',eTag:'"before"',folder:{childCount:0}};
  const deletes=[];
  const client=new OneDriveTestClient('synthetic-token',async(url,init={})=>{
    if(init.method==='POST')return Response.json(marker,{status:201});
    if(init.method==='DELETE'){
      deletes.push(init.headers['If-Match']);
      return deletes.length===1?Response.json({error:{code:'resourceModified'}},{status:412}):new Response(null,{status:204});
    }
    if(url.includes('/children?'))return Response.json({value:[]});
    return Response.json({...marker,eTag:'"after"'});
  });
  client.folderPath=async()=> 'synthetic-parent';
  await traceFinanceOperation('statement-delete',async()=>{const release=await client.acquireVaultMutation(()=>{});await release();});
  assert.deepEqual(deletes,['"before"','"after"']);
  assert.equal(logs.length,1);const result=logs[0][1];
  assert.deepEqual(result.httpStatuses,{'200':2,'201':1,'204':1,'412':1});
  assert.equal(result.totalRequests,5);assert.equal(result.retries,1);
  for(const phase of ['vault.lock-acquire','vault.lock-release','vault.lock-revalidate'])assert.equal(result.phases[phase].count,1);
  assert.equal(result.phases['vault.lock-release'].failures,0);
  assert.doesNotMatch(JSON.stringify(logs),/synthetic-|resourceModified/);
}));
