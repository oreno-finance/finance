import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OneDriveTestClient, GraphError } from '../dist/src/cloud/onedrive-api.js';
import { selectMicrosoftAccount, classifyMicrosoftAuthError, coalesceSilentToken } from '../dist/src/cloud/msal-auth.js';

const one={homeAccountId:'user-one',username:'first@example.com'};
const two={homeAccountId:'user-two',username:'second@example.com'};
const graph='https://graph.microsoft.com/v1.0';

test('account selection pins explicit previous identity, never picks arbitrary first user',()=>{
  assert.equal(selectMicrosoftAccount([one,two],null,'user-two',one),two);
  assert.equal(selectMicrosoftAccount([one,two],null,'deleted-account',one),null);
  assert.equal(selectMicrosoftAccount([one,two],null,null,null),null);
  assert.equal(selectMicrosoftAccount([one,two],two,'user-one',one),two);
  assert.equal(selectMicrosoftAccount([one],null,null,null),one);
  assert.equal(selectMicrosoftAccount([one,two],null,null,two),two);
});

test('silent errors distinguish user interaction from offline, timeout and service outage',()=>{
  assert.equal(classifyMicrosoftAuthError({name:'InteractionRequiredAuthError',errorCode:'interaction_required'}),'interaction');
  assert.equal(classifyMicrosoftAuthError({errorCode:'no_account_error'}),'interaction');
  assert.equal(classifyMicrosoftAuthError({errorCode:'network_error'}),'network');
  assert.equal(classifyMicrosoftAuthError(new Error('Failed to fetch')),'network');
  assert.equal(classifyMicrosoftAuthError({errorCode:'monitor_window_timeout'}),'timeout');
  assert.equal(classifyMicrosoftAuthError({errorCode:'temporarily_unavailable'}),'server');
  assert.equal(classifyMicrosoftAuthError({errorCode:'unexpected'}),'unknown');
});

test('concurrent silent renewals share one pending request and release it afterward',async()=>{
  const jobs=new Map();let count=0;let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const get=()=>coalesceSilentToken(jobs,'account:scope:cached',async()=>{count++;return pending;});
  const calls=Array.from({length:5},()=>get());
  assert.equal(count,0,'async acquisition is queued as a microtask');
  release('fresh-access-token');
  assert.deepEqual(await Promise.all(calls),Array(5).fill('fresh-access-token'));
  assert.equal(count,1);
  assert.equal(jobs.size,0);
  await get();
  assert.equal(count,2);
});

test('failed concurrent token refresh clears the pending slot for the next attempt',async()=>{
  const jobs=new Map();let count=0;
  const refresh=()=>coalesceSilentToken(jobs,'account:scope:refresh',async()=>{
    count++;
    if(count===1)throw new Error('temporary');
    return 'recovered';
  });
  await assert.rejects(Promise.all([refresh(),refresh(),refresh()]),/temporary/);
  assert.equal(jobs.size,0);
  assert.equal(await refresh(),'recovered');
  assert.equal(count,2);
});

test('a long-lived Graph client asks MSAL for a token for each API request',async()=>{
  const tokens=['first','renewed','latest'];
  const seen=[];let n=0;
  const api=new OneDriveTestClient(async()=>tokens[n++],async(url,init)=>{
    seen.push({url,token:init.headers.Authorization});
    if(url.endsWith('/me/drive/special/approot'))return Response.json({id:'folder1'});
    if(url.includes('/children?'))return Response.json({value:[]});
    throw new Error(`unexpected ${url}`);
  });
  assert.equal(await api.appFolderId(),'folder1');
  assert.deepEqual(await api.listVaultSnapshots(),[]);
  const clone=api.forVaultDataSet('12345678-1234-1234-1234-123456789012');
  assert.equal(await clone.appFolderId(),'folder1');
  assert.deepEqual(seen.map(x=>x.token),['Bearer first','Bearer renewed','Bearer latest']);
});

test('Graph GET 401 renews and retries once, never looping',async()=>{
  const forced=[];const calls=[];
  const api=new OneDriveTestClient(async(refresh=false)=>{forced.push(refresh);return refresh?'renewed':'expired';},async(url,init)=>{
    calls.push(init.headers.Authorization);
    return init.headers.Authorization==='Bearer expired'
      ? Response.json({error:{code:'InvalidAuthenticationToken'}},{status:401})
      : Response.json({id:'safe-folder'});
  });
  assert.equal(await api.appFolderId(),'safe-folder');
  assert.deepEqual(forced,[false,true]);
  assert.deepEqual(calls,['Bearer expired','Bearer renewed']);
});

test('Graph GET remains bounded to one retry even if refreshed credentials are denied',async()=>{
  const forced=[];let attempts=0,unauthorized=0;
  const api=new OneDriveTestClient(async(forceRefresh=false)=>{
    forced.push(forceRefresh);return forceRefresh?'refreshed':'cached';
  },async()=>{
    attempts++;
    return Response.json({error:{code:'InvalidAuthenticationToken'}},{status:401});
  },()=>unauthorized++);
  await assert.rejects(api.appFolderId(),error=>error instanceof GraphError&&error.status===401);
  assert.deepEqual(forced,[false,true]);
  assert.equal(attempts,2);
  assert.equal(unauthorized,1);
});

test('Graph POST/PUT 401 is not retried even with a renewable token; callback signals reauth',async()=>{
  const forced=[];let writes=0,unauthorized=0;
  const api=new OneDriveTestClient(async(refresh=false)=>{forced.push(refresh);return 'token';},async(url,init)=>{
    if(url.endsWith('/me/drive/special/approot'))return Response.json({id:'folder'});
    if(init.method==='PUT'){
      writes++;
      return Response.json({error:{code:'InvalidAuthenticationToken'}},{status:401});
    }
    throw new Error('unanticipated request');
  },()=>unauthorized++);
  await assert.rejects(api.uploadEncryptedProbe('test-encrypted-file'),error=>{
    assert.ok(error instanceof GraphError);
    assert.equal(error.status,401);return true;
  });
  assert.equal(writes,1);
  assert.deepEqual(forced,[false,false]);
  assert.equal(unauthorized,1);
});

test('Graph 403 remains a permission error, not a forced token renewal',async()=>{
  let requested=0,unauthorized=0;
  const api=new OneDriveTestClient(async()=>{requested++;return 'token';},async()=>
    Response.json({error:{code:'accessDenied'}},{status:403}),()=>unauthorized++);
  await assert.rejects(api.appFolderId(),error=>{
    assert.ok(error instanceof GraphError);
    assert.equal(error.status,403);
    assert.equal(error.code,'accessDenied');
    return true;
  });
  assert.equal(requested,1);
  assert.equal(unauthorized,0);
});

test('signed content URL uses neither bearer token nor MSAL token callback',async()=>{
  let requested=0, signed=0;
  const read=new OneDriveTestClient(async()=>{requested++;return 'secret-token';},async(url,init)=>{
    if(url.endsWith('/me/drive/special/approot'))return Response.json({id:'folder'});
    if(url.includes('/finance-v09-connectivity.enc.json'))return Response.json({id:'file',eTag:'e1','@microsoft.graph.downloadUrl':'https://blob.example.test/signed'});
    if(url==='https://blob.example.test/signed'){
      signed++;
      assert.equal(init.credentials,'omit');
      assert.equal(init.headers?.Authorization,undefined);
      return new Response('encrypted',{status:200});
    }
    throw new Error(`unexpected ${url}`);
  });
  assert.equal(await read.downloadEncryptedProbe(),'encrypted');
  assert.equal(signed,1);
  assert.equal(requested,2,'only the two Graph metadata GETs require MSAL');
});

test('GitHub Pages ships an isolated MSAL v5 bridge, no login redirects on passive startup',()=>{
  const cloud=readFileSync('src/cloud/cloud-settings.ts','utf8');
  const html=readFileSync('public/index.html','utf8');
  const bridge=readFileSync('public/auth-bridge.html','utf8');
  const build=readFileSync('scripts/build-msal.mjs','utf8');
  const entry=readFileSync('public/auth-bridge.js','utf8');
  const main=readFileSync('src/main.ts','utf8');
  assert.match(cloud,/cacheLocation:'localStorage'/);
  assert.match(cloud,/redirectUri:redirectUri\(\)/);
  assert.match(cloud,/selectMicrosoftAccount\(instance\.getAllAccounts\(\)/);
  assert.doesNotMatch(cloud,/getAllAccounts\(\)\[0\]/);
  assert.match(cloud,/await graphClientWithoutRedirect\(\)/);
  const switchHandler=cloud.split("$('cloud-switch-account').addEventListener('click'")[1]?.split("$('cloud-logout').addEventListener('click'")[0]??'';
  assert.match(switchHandler,/handlers\.onLock\(\)/);
  assert.match(switchHandler,/prompt:'select_account'/);
  assert.match(html,/id="cloud-auth-state"/);
  assert.match(html,/id="cloud-switch-account"/);
  assert.match(bridge,/auth-bridge\.js/);
  assert.doesNotMatch(bridge,/main\.js|msal-browser\.bundle\.js/);
  assert.match(entry,/msalRedirectBridge\.broadcastResponseToMainFrame/);
  assert.match(build,/msal-redirect-bridge\.min\.js/);
  // Check the passive-startup behavior rather than requiring the original
  // uninstrumented expression: performance diagnostics may time the same call.
  const startup=main.split('async function startCloud():Promise<void> {')[1]?.split('async function refreshCloud():Promise<void> {')[0]??'';
  assert.match(startup,/graphClientWithoutRedirect\(\)/);
  assert.doesNotMatch(startup,/\b(?:loginRedirect|loginPopup|acquireTokenRedirect|acquireTokenPopup)\s*\(/);
  assert.match(main,/readBrowserKey\(browserContext\)/);
});
