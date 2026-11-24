import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { LiveVault, CloudWriteUncertainError } from './helpers/coordinated-vault.mjs';
import { GraphError } from '../dist/src/cloud/onedrive-api.js';
if (!globalThis.crypto) globalThis.crypto=webcrypto;
const password='fake words for a test vault only';

class Graph {
  constructor(){this.items=new Map();this.failRead=null;this.failReadAfterWrite=null;this.failWriteAfterCommit=null;this.returnNoEtag=null;this.counts={rules:0,assets:0};}
  read(name){
    if(this.failRead===name)throw new Error(`${name} readback failed`);
    const f=this.items.get(name);
    return f?{id:name,etag:`"${f.rev}"`,text:f.text}:null;
  }
  write(name,text,ref){
    this.counts[name]++;
    const old=this.items.get(name);
    if(old && (!ref||ref.etag!==`"${old.rev}"`))throw new GraphError(412,'ETag conflict');
    if(!old && ref)throw new GraphError(412,'ETag conflict');
    this.items.set(name,{text,rev:(old?.rev??0)+1});
    if(this.failReadAfterWrite===name)this.failRead=name;
    if(this.failWriteAfterCommit===name)throw new Error(`${name} response lost`);
    return this.returnNoEtag===name?null:this.read(name);
  }
  async readFinanceIndex(){return this.read('index');}
  async writeFinanceIndex(t,r){return this.write('index',t,r);}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async listYearFiles(){return [];}
  async readMerchantRules(){return this.read('rules');}
  async writeMerchantRules(t,r){return this.write('rules',t,r);}
  async readAssetSettings(){return this.read('assets');}
  async writeAssetSettings(t,r){return this.write('assets',t,r);}
}
const rule=(name='Name')=>({id:'test-rule',pattern:'TEST',displayName:name,mode:'contains',cardId:null,enabled:true,priority:100});

async function vault(){const graph=new Graph(),v=new LiveVault(graph);await v.create(password);return {graph,v};}

test('rules: accepted Graph upload with missing ETag and readback failure is uncertain, never retried blindly',async()=>{
  const {graph,v}=await vault();
  graph.returnNoEtag='rules';graph.failReadAfterWrite='rules';
  await assert.rejects(v.upsertMerchantRule(rule()),error=>error instanceof CloudWriteUncertainError&&/保存済みの可能性/.test(error.message));
  assert.equal(graph.items.has('rules'),true,'OneDrive already has the encrypted file');
  assert.equal(v.merchantRules().length,0,'local state must not assume an unverified commit');
  await assert.rejects(v.upsertMerchantRule(rule('Again')),CloudWriteUncertainError);
  assert.equal(graph.counts.rules,1,'no second write until a verified refresh');
  await assert.rejects(v.refresh(),/readback failed/);
  await assert.rejects(v.upsertMerchantRule(rule('Again')),CloudWriteUncertainError);
  assert.equal(graph.counts.rules,1,'a failed refresh cannot clear the guard');
  graph.failRead=null;graph.failReadAfterWrite=null;graph.returnNoEtag=null;
  await v.refresh();
  assert.equal(v.merchantRules()[0].displayName,'Name');
  await v.upsertMerchantRule(rule('After refresh'));
  assert.equal(v.merchantRules()[0].displayName,'After refresh');
  assert.equal(graph.counts.rules,2);
});

test('assets: accepted upload with no ETag and failed readback retains old state, blocks duplicates until refresh',async()=>{
  const {graph,v}=await vault();
  graph.returnNoEtag='assets';graph.failReadAfterWrite='assets';
  await assert.rejects(v.setCardDebitAccounts({'rakuten-mizuho':'mizuho-bank'}),CloudWriteUncertainError);
  assert.equal(graph.items.has('assets'),true);
  assert.equal(v.assetSettings().cardDebitAccounts?.['rakuten-mizuho'],undefined);
  await assert.rejects(v.setCardDebitAccounts({'rakuten-mizuho':'rakuten-bank'}),CloudWriteUncertainError);
  assert.equal(graph.counts.assets,1);
  graph.failRead=null;graph.failReadAfterWrite=null;graph.returnNoEtag=null;
  await v.refresh();
  assert.equal(v.assetSettings().cardDebitAccounts['rakuten-mizuho'],'mizuho-bank');
  await v.setCardDebitAccounts({'rakuten-mizuho':'rakuten-bank'});
  assert.equal(graph.counts.assets,2);
});

test('ambiguous lost upload response also blocks blind rule and asset resubmission',async()=>{
  for(const kind of ['rules','assets']){
    const {graph,v}=await vault();graph.failWriteAfterCommit=kind;
    const write=()=>kind==='rules'?v.upsertMerchantRule(rule()):v.setCardDebitAccounts({'rakuten-mizuho':'mizuho-bank'});
    await assert.rejects(write(),CloudWriteUncertainError);
    assert.equal(graph.items.has(kind),true);
    await assert.rejects(write(),CloudWriteUncertainError);
    assert.equal(graph.counts[kind],1);
    graph.failWriteAfterCommit=null;
    await v.refresh();
    assert.equal(graph.counts[kind],1);
  }
});

test('a rejected Graph 403 write is definite; it does not quarantine a later permitted write',async()=>{
  const {graph,v}=await vault();
  const original=graph.writeMerchantRules.bind(graph);
  graph.writeMerchantRules=async()=>{throw new GraphError(403,'accessDenied');};
  await assert.rejects(v.upsertMerchantRule(rule()),error=>error instanceof GraphError&&error.status===403);
  graph.writeMerchantRules=original;
  await v.upsertMerchantRule(rule());
  assert.equal(v.merchantRules()[0].displayName,'Name');
});

test('ETag-less response with verified readback remains a confirmed successful save',async()=>{
  const {graph,v}=await vault();
  graph.returnNoEtag='rules';await v.upsertMerchantRule(rule());
  graph.returnNoEtag='assets';await v.setCardDebitAccounts({'rakuten-mizuho':'mizuho-bank'});
  assert.equal(v.merchantRules()[0].displayName,'Name');
  assert.equal(v.assetSettings().cardDebitAccounts['rakuten-mizuho'],'mizuho-bank');
  await v.upsertMerchantRule(rule('Next'));
  assert.equal(v.merchantRules()[0].displayName,'Next');
});

test('HTML references transparent F-dot favicon assets and clear uncertain-state language',async()=>{
  const [html,svg,css]=await Promise.all([
    readFile(new URL('../dist/index.html',import.meta.url),'utf8'),
    readFile(new URL('../dist/favicon.svg',import.meta.url),'utf8'),
    readFile(new URL('../dist/styles/style.css',import.meta.url),'utf8'),
  ]);
  assert.match(html,/rel="icon" href="\.\/favicon\.svg"/);
  assert.match(html,/rel="alternate icon" href="\.\/favicon\.ico"/);
  assert.match(svg,/<text[^>]*fill="#101b30"/);
  assert.match(svg,/<tspan fill="#4eb79d">\.<\/tspan>/);
  assert.doesNotMatch(svg,/<rect|<image/,'favicon has no background');
  assert.match(css,/\.brand-mark span\{color:#4eb79d\}/);
  const ico=await readFile(new URL('../dist/favicon.ico',import.meta.url));
  assert.deepEqual([...ico.subarray(0,4)],[0,0,1,0]);
});
