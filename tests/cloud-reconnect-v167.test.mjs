import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const cloud=readFileSync(new URL('src/cloud/cloud-settings.ts',root),'utf8');
const main=readFileSync(new URL('src/main.ts',root),'utf8');
const html=readFileSync(new URL('public/index.html',root),'utf8');
const css=readFileSync(new URL('public/styles/ui-v167.css',root),'utf8');

test('reconnect button remains available with a cached account and allows account selection',()=>{
  assert.match(cloud,/cloud-login'\)\.toggleAttribute\('disabled',busy\)/);
  assert.match(cloud,/通信を再試行/);
  assert.match(html,/id="cloud-reauth"[^>]*>Microsoft認証をやり直す/);
  const handler=cloud.split("$('cloud-login').addEventListener('click'")[1]?.split("$('cloud-reauth').addEventListener('click'")[0]??'';
  assert.match(handler,/await graphClientWithoutRedirect\(\)/);
  assert.match(handler,/loginRedirect\(\{scopes:SCOPES,\.\.\./);
  assert.match(cloud,/await instance.acquireTokenRedirect\(\{scopes:SCOPES,account:current,prompt:'login'\}\)/);
  assert.match(cloud,/await instance.loginRedirect\(\{scopes:SCOPES,prompt:'select_account'\}\)/);
  assert.doesNotMatch(handler,/if\(!reauthenticationRequired\)return/);
});

test('refresh never offers new vault creation when remote data is missing',()=>{
  const refresh=main.split('async function refreshCloud()')[1]?.split('async function migrateLegacy()')[0]??'';
  assert.match(refresh,/if\(!liveVault\.exists\)throw new Error/);
  assert.match(refresh,/askVault\('unlock'\)/);
  assert.doesNotMatch(refresh,/askVault\('create'\)/);
  const startup=main.split('async function startCloud()')[1]?.split('async function refreshCloud()')[0]??'';
  assert.doesNotMatch(startup,/askVault\('create'\)/);
});

test('new vault creation is a separate guarded explicit action',()=>{
  assert.match(html,/id="cloud-new-vault"[^>]*class="secondary-action hidden"/);
  assert.match(main,/cloud-new-vault'\)\.classList\.toggle\('hidden',/);
  assert.match(main,/const nowExists=await liveVault\.discover\(\)/);
  assert.match(main,/if\(answer\)await askVault\('create'\)/);
});

test('desktop manager fills full available horizontal width while mobile remains untouched',()=>{
  assert.match(styleOrder,/styles\/ui-v167\.css/);
  assert.match(css,/@media \(min-width: 981px\)/);
  assert.match(css,/\.workspace > \.content:has\(#manage-view:not\(\.hidden\)\)/);
  assert.match(css,/#manage-view\.manage-view\s*\{[^}]*max-width:\s*none/s);
  assert.doesNotMatch(css,/@media.*max-width/);
});
