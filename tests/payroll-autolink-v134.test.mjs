import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {emptyAssets,validateAssets,mergeAssets,validatePayrollAutoPassphrase} from '../dist/src/cloud/assets.js';
import {encryptAssets,decryptAssets,deriveCloudKey,freshSalt} from '../dist/src/cloud/cloud-crypto.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const payrollSecret='TEST ONLY payroll passphrase 2026';
const financeSecret='TEST ONLY finance passphrase 2026';
const changedSecret='TEST ONLY rotated finance passphrase 2027';
class FakeGraph{
  constructor(store,gen=null){this.store=store;this.gen=gen;}
  setVaultDataSet(v){this.gen=v;}
  forVaultDataSet(v){return new FakeGraph(this.store,v);}
  name(p){return `${this.gen??'main'}:${p}`;}
  read(p){const x=this.store.get(this.name(p));return x?{id:this.name(p),etag:String(x.rev),text:x.text}:null;}
  write(p,body,ref){const key=this.name(p),v=this.store.get(key);
    if(ref?(!v||String(v.rev)!==ref.etag):!!v)throw new GraphError(412,'etag conflict');
    const rev=(v?.rev??0)+1;this.store.set(key,{text:body,rev});return {id:key,etag:String(rev)};
  }
  async readFinanceIndex(){return new FakeGraph(this.store).read('index');}
  async writeFinanceIndex(text,ref){return new FakeGraph(this.store).write('index',text,ref);}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async listYearFiles(){return [];}
  async readMerchantRules(){return this.read('rules');}
  async writeMerchantRules(body,ref){return this.write('rules',body,ref);}
  async readAssetSettings(){return this.read('assets');}
  async writeAssetSettings(body,ref){return this.write('assets',body,ref);}
}

test('existing assets without Payroll link are still accepted; invalid credentials rejected',()=>{
  const old=emptyAssets();delete old.payrollAutoPassphrase;
  assert.equal(validateAssets(old).payrollAutoPassphrase,null);
  assert.equal(validatePayrollAutoPassphrase(payrollSecret),payrollSecret);
  assert.throws(()=>validatePayrollAutoPassphrase('short'),/不正/);
  assert.throws(()=>validatePayrollAutoPassphrase({password:'x'}),/不正/);
  assert.throws(()=>validatePayrollAutoPassphrase('x'.repeat(1025)),/不正/);
});

test('auto Payroll password is encrypted at rest; Finance key is required to unlock it',async()=>{
  const salt=freshSalt(),key=await deriveCloudKey(financeSecret,salt);
  const source={...emptyAssets(),payrollAutoPassphrase:payrollSecret};
  const encrypted=await encryptAssets(source,key,salt);
  assert.ok(!encrypted.includes(payrollSecret),'plain credential must not be exposed to OneDrive');
  assert.equal((await decryptAssets(encrypted,key,salt)).payrollAutoPassphrase,payrollSecret);
  const wrong=await deriveCloudKey(changedSecret,salt);
  await assert.rejects(decryptAssets(encrypted,wrong,salt),/復号/);
});

test('concurrent asset changes preserve the saved link and never record a competing credential in conflict audit',()=>{
  const base=emptyAssets(),remote=structuredClone(base),local=structuredClone(base);
  local.payrollAutoPassphrase=payrollSecret;
  remote.payrollDepositAccount='rakuten-bank';
  const merged=mergeAssets(base,local,remote);
  assert.equal(merged.payrollAutoPassphrase,payrollSecret);
  assert.equal(merged.payrollDepositAccount,'rakuten-bank');
  const theirs='TEST ONLY another payroll passphrase 2026';
  const conflict=mergeAssets(base,{...base,payrollAutoPassphrase:payrollSecret},{...base,payrollAutoPassphrase:theirs});
  assert.equal(conflict.payrollAutoPassphrase,payrollSecret);
  assert.equal(JSON.stringify(conflict.conflicts).includes(payrollSecret),false);
  assert.equal(JSON.stringify(conflict.conflicts).includes(theirs),false);
});

test('auto Payroll credential survives reopening and Finance key rotation; disconnect clears active encrypted settings',async()=>{
  const store=new Map(),vault=new LiveVault(new FakeGraph(store));
  await vault.create(financeSecret);
  await vault.setPayrollAutoPassphrase(payrollSecret);
  const active=store.get('main:assets').text;
  assert.ok(!active.includes(payrollSecret));
  const reopened=new LiveVault(new FakeGraph(store));await reopened.unlock(financeSecret);
  assert.equal(reopened.assetSettings().payrollAutoPassphrase,payrollSecret);
  await reopened.changePassphrase(financeSecret,changedSecret);
  const newReader=new LiveVault(new FakeGraph(store));await newReader.unlock(changedSecret);
  assert.equal(newReader.assetSettings().payrollAutoPassphrase,payrollSecret);
  await newReader.setPayrollAutoPassphrase(null);
  const deleted=new LiveVault(new FakeGraph(store));await deleted.unlock(changedSecret);
  assert.equal(deleted.assetSettings().payrollAutoPassphrase,null);
  assert.ok(![...store].some(([key,value])=>key.includes('assets')&&value.text.includes(payrollSecret)));
});

test('Payroll controls live in app settings and auto refresh is initiated after Finance unlock',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const main=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  const code=await readFile(new URL('../src/ui/assets-settings.ts',import.meta.url),'utf8');
  const accountsAt=html.indexOf('id="assets-page"'),settingsAt=html.indexOf('id="settings-view"'),payrollAt=html.indexOf('id="assets-payroll-connect"');
  assert.ok(accountsAt>=0&&settingsAt>accountsAt&&payrollAt>settingsAt);
  for(const id of ['assets-payroll-forget','assets-payroll-deposit-form']){
    assert.ok(html.slice(settingsAt).includes(`id="${id}"`),id);
  }
  assert.ok(!html.slice(accountsAt,settingsAt).includes('id="assets-payroll-sync"'));
  assert.ok(!html.includes('id="assets-payroll-remember"'));
  assert.ok(!html.includes('id="assets-payroll-auto-status"'));
  assert.ok(!html.includes('id="assets-payroll-months"'));
  assert.match(main,/await liveVault\.unlock\(pass\)[\s\S]*?void assetsUi\?\.refreshPayroll\(\)/);
  assert.match(code,/window\.setInterval\(\(\)=>\{if\(!document\.hidden\)void refreshPayroll\(\);\},10\*60\*1000\)/);
  assert.match(code,/if\(action!==undefined\)await vault\.setPayrollAutoPassphrase\(action\)/);
});
