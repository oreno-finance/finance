import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {deriveCloudKey,freshSalt} from '../dist/src/cloud/cloud-crypto.js';
import {LiveVault} from '../dist/src/cloud/live-vault.js';
const main=readFileSync('src/main.ts','utf8');
const markup=readFileSync('public/index.html','utf8');
const live=readFileSync('src/cloud/live-vault.ts','utf8');
const derived=readFileSync('src/cloud/cloud-crypto.ts','utf8');

test('old 2-hour feature and raw-key exports are absent from all shipped code',()=>{
  assert.equal(existsSync('src/cloud/tab-session.ts'),false);
  assert.equal(existsSync('dist/src/cloud/tab-session.js'),false);
  assert.equal(existsSync('tests/cloud-tab-session.test.mjs'),false);
  for(const data of [main,live,markup,derived,readFileSync('dist/src/main.js','utf8')])
    assert.doesNotMatch(data,/vault-tab-keep|unlockTab|exportTabKey|sessionExportable|keepTab|TAB_SESSION_TTL_MS|saveTabSession|readTabSession|2時間保持/);
  assert.doesNotMatch(derived,/extractable=false|exportKey/);
  assert.match(main,/function purgeLegacyTabKey\(\)/);
  assert.match(main,/store.removeItem\('finance-vault-tab-key-v1'\)/);
  assert.match(main,/function init\(\): void \{\s*purgeLegacyTabKey\(\)/);
  assert.match(main,/await applyBrowserRetentionChoice\(context,false\)/);
});

test('vault derivation never produces an extractable AES key',async()=>{
  const key=await deriveCloudKey('a long and secret finance phrase',freshSalt());
  assert.equal(key.extractable,false);
  assert.equal(typeof LiveVault.prototype.exportTabKey,'undefined');
  assert.equal(typeof LiveVault.prototype.unlockTab,'undefined');
});

test('the every-time default deletes an older browser key or keeps the vault locked on deletion failure',()=>{
  assert.match(markup,/id="vault-retention-every-time"[^>]*checked/);
  assert.match(markup,/毎回パスフレーズを入力する/);
  assert.match(markup,/以前のブラウザ記憶も解除します/);
  assert.match(main,/if\(rememberBrowser\)\{[\s\S]*?else if\(mode!=='create'\)\{\s*\/\/ "毎回入力する" explicitly revokes/);
  assert.match(main,/await applyBrowserRetentionChoice\(context,false\);\s*\}catch\(error\)\{\s*liveVault.lock\(\)/);
  assert.match(main,/if\(mode==='create'&&!rememberBrowser\)[\s\S]*?await applyBrowserRetentionChoice\(newContext,false\)[\s\S]*?await liveVault.create\(pass\)/);
});
