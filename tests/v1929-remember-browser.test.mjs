import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {LiveVault, BrowserKeyGenerationChangedError} from './helpers/coordinated-vault.mjs';
import {encryptIndex, freshSalt, deriveCloudKey} from '../dist/src/cloud/cloud-crypto.js';
import {readBrowserKey, rememberBrowserKey, forgetBrowserKey, applyBrowserRetentionChoice, isBrowserRemembered, InvalidRememberedBrowserKeyError,
  setManualLock, clearManualLock, isManuallyLocked} from '../dist/src/cloud/remembered-browser.js';

const clientId='78a9834b-ab02-4123-ad31-37ad28ee2050';
const alpha={clientId,homeAccountId:'msal.account-ALPHA'};
const beta={clientId,homeAccountId:'msal.account-BETA'};
const salt=btoa(String.fromCharCode(...new Uint8Array(16).fill(6)));
const previousIndexedDb=globalThis.indexedDB;
const database=new Map();
const fauxDb={
  objectStoreNames:{contains:name=>name==='keys'},
  createObjectStore:()=>{},close:()=>{},
  transaction:()=>{
    const tx={};
    const issue=(op)=>{
      const request={};
      queueMicrotask(()=>{
        try {request.result=op();request.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());}
        catch(error){request.error=error;tx.onerror?.();}
      });
      return request;
    };
    tx.objectStore=()=>({
      get:id=>issue(()=>database.get(id)),
      put:entry=>issue(()=>{database.set(entry.id,structuredClone(entry));return entry.id;}),
      delete:id=>issue(()=>{database.delete(id);return undefined;}),
    });
    return tx;
  },
};
globalThis.indexedDB={open:()=>{
  const request={result:fauxDb};
  queueMicrotask(()=>request.onsuccess?.());
  return request;
}};
after(()=>{if(previousIndexedDb===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=previousIndexedDb;});
const secret=()=>crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
const storage=()=>{
  const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};
};
const mockClient=()=>{
  const files=new Map();
  const read=key=>files.get(key)??null;
  const put=(key,text)=>{files.set(key,{id:key,etag:'"1"',text});};
  return {files,readFinanceIndex:async()=>read('index'),readLiveVault:async()=>null,
    writeFinanceIndex:async text=>put('index',text),listYearFiles:async()=>[],ensurePayrollNamespace:async()=>{},
    setVaultDataSet:()=>{}};
};

test('non-extractable key survives IndexedDB serialization and simulated browser restart without expiry',async()=>{
  const key=await secret();
  assert.equal(key.extractable,false);
  await rememberBrowserKey(alpha,{key,salt,dataSetId:null});
  const reread=await readBrowserKey(alpha);
  assert.equal(reread.key.extractable,false);
  assert.equal(await isBrowserRemembered(alpha),true);
  const plain=new TextEncoder().encode('Financial data stays in OneDrive');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},reread.key,plain);
  const afterRestart=await readBrowserKey(alpha);
  assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv},afterRestart.key,encrypted)),plain);
  assert.equal(database.size,1,'only the wrapped key metadata is persisted; no password, statements or tokens');
  const entry=[...database.values()][0];
  assert.equal(entry.key.extractable,false);
  assert.ok(!('passphrase'in entry)&&!('accessToken'in entry)&&!('statements'in entry));
  assert.ok(!JSON.stringify(entry).includes('account-ALPHA'),'raw account IDs are not persisted');
});

test('another Microsoft account or Client ID cannot read the first account key',async()=>{
  assert.equal(await readBrowserKey(beta),null);
  assert.equal(await readBrowserKey({...alpha,clientId:'4e0a683d-f1cd-4e02-92cd-5bb6e66f762b'}),null);
  assert.equal(await isBrowserRemembered(alpha),true);
});

test('manual lock persists across a simulated reload and does not delete the key; explicit unlock can clear it',async()=>{
  const s=storage();
  assert.equal(isManuallyLocked(s),false);
  setManualLock(s);
  assert.equal(isManuallyLocked(s),true);
  assert.ok(await readBrowserKey(alpha));
  clearManualLock(s);
  assert.equal(isManuallyLocked(s),false);
  await forgetBrowserKey(alpha);
  assert.equal(await readBrowserKey(alpha),null);
});

test('corrupt records fail closed and can be removed, rejected extractable keys never persist',async()=>{
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  await assert.rejects(rememberBrowserKey(alpha,{key,salt,dataSetId:null}),/保存できない/);
  const id=(await (async()=>{await rememberBrowserKey(alpha,{key:await secret(),salt,dataSetId:null});return [...database.keys()][0];})());
  database.set(id,{...database.get(id),salt:'tampered'});
  await assert.rejects(readBrowserKey(alpha),InvalidRememberedBrowserKeyError);
  await forgetBrowserKey(alpha);
  assert.equal(await readBrowserKey(alpha),null);
});

test('saved browser key unlocks the real cloud crypto without any OneDrive writes',async()=>{
  const api=mockClient();
  const original=new LiveVault(api);
  await original.create('long correct 1Password phrase 2026');
  const record=original.verifiedBrowserKey();
  assert.equal(record.key.extractable,false);
  await rememberBrowserKey(alpha,record);
  const before=api.files.size;
  const clone=new LiveVault(api);
  await clone.unlockBrowserKey(await readBrowserKey(alpha));
  assert.equal(clone.unlocked,true);
  assert.deepEqual(clone.records(),[]);
  assert.equal(api.files.size,before,'restore must not upload or reencrypt anything');
  assert.equal((await api.readFinanceIndex()).text.includes('long correct 1Password'),false);
  // The same key cannot unlock a changed generation.
  const rotatedSalt=freshSalt();
  const rotatedKey=await deriveCloudKey('another very long passphrase 2027',rotatedSalt);
  await api.writeFinanceIndex(await encryptIndex({format:'finance-cloud-index-v1',years:[]},rotatedKey,rotatedSalt,crypto.randomUUID()));
  await assert.rejects(new LiveVault(api).unlockBrowserKey(await readBrowserKey(alpha)),BrowserKeyGenerationChangedError);
  await forgetBrowserKey(alpha);
});

test('UI maintains both opt-in choices, account status controls, and fail-safe handlers',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const main=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  const settings=await readFile(new URL('../src/cloud/cloud-settings.ts',import.meta.url),'utf8');
  for(const name of ['vault-browser-keep','vault-retention-every-time','cloud-remember-register','cloud-remember-forget','cloud-remember-status'])
    assert.ok(html.includes(`id="${name}"`),name);
  assert.match(html,/id="vault-browser-keep" type="radio" name="vault-retention"/);
  assert.doesNotMatch(html,/id="vault-browser-keep"[^>]*checked/);
  assert.match(main,/if\(allowAutomatic&&browserContext\)/);
  assert.match(main,/setManualLock\(local\)/);
  assert.match(main,/await forgetBrowserKey\(rememberedContext\)/);
  assert.match(main,/if\(rememberBrowser\)/);
  assert.match(main,/保管庫は解除できましたが、このブラウザを記憶できませんでした/);
  assert.match(settings,/export function activeMicrosoftAccountId/);
  assert.match(settings,/cacheLocation:'localStorage'/,'MSAL now owns the persistent auth cache; vault keys remain separate');
});

test('switch from remembered browser to every-time input revokes the old key, including after manual lock',async()=>{
  const key=await secret();
  await applyBrowserRetentionChoice(alpha,true,{key,salt,dataSetId:null});
  assert.ok(await readBrowserKey(alpha));
  const flag=storage();
  setManualLock(flag);
  // Entering a passphrase does not imply permission to retain the earlier key.
  await applyBrowserRetentionChoice(alpha,false);
  clearManualLock(flag);
  assert.equal(isManuallyLocked(flag),false);
  assert.equal(await readBrowserKey(alpha),null,'next startup must not silently unlock');
  assert.equal(database.size,0,'stored key must actually be removed');
});

test('failed key deletion must reject every-time choice rather than claiming success',async()=>{
  const key=await secret();
  await applyBrowserRetentionChoice(alpha,true,{key,salt,dataSetId:null});
  const prior=globalThis.indexedDB;
  try {
    globalThis.indexedDB={open:()=>{throw new Error('blocked IndexedDB');}};
    await assert.rejects(applyBrowserRetentionChoice(alpha,false),/blocked IndexedDB/);
  } finally {globalThis.indexedDB=prior;}
  assert.ok(await readBrowserKey(alpha),'failed revocation must not be reported as completed');
  await forgetBrowserKey(alpha);
});
