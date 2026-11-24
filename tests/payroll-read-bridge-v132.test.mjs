import test from 'node:test';
import assert from 'node:assert/strict';
import {PayrollReadSession,adaptPayrollSource} from '../dist/src/cloud/payroll-bridge.js';
import {forecastAssets} from '../dist/src/cloud/asset-projection.js';
import {emptyAssets,mergeAssets,validateAssets} from '../dist/src/cloud/assets.js';
const crypto=globalThis.crypto,enc=new TextEncoder();
const passphrase='test-payroll-secret-1234';
const salt=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
const rand=()=>crypto.getRandomValues(new Uint8Array(12));
let key;
async function setup(){
 const base=await crypto.subtle.importKey('raw',enc.encode(passphrase),'PBKDF2',false,['deriveKey']);
 key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:Buffer.from(salt,'base64'),iterations:310000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function encrypted(kind,body){
 const iv=rand(),aad=enc.encode(kind==='index'?'Payroll OneDrive index v1':'Payroll OneDrive income v1');
 const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,enc.encode(JSON.stringify(body)));
 return JSON.stringify({format:'payroll-cloud-envelope-v1',kind,salt,iterations:310000,iv:Buffer.from(iv).toString('base64'),data:Buffer.from(bytes).toString('base64')});
}
const record=(id,date,net,extra={})=>({id,paymentDate:date,targetMonth:date.slice(0,7),job:'main',kind:'salary',netPaymentYen:net,revision:1,...extra});
function fixture(){return {format:'payroll-income-v1',year:'2026',records:[record(101,'2026-11-27',200000),record(102,'2026-12-15',120000,{job:'side',kind:'bonus',grossPaymentYen:140000})]};}
async function client(opts={}){
 await setup();
 const index=await encrypted('index',{format:'payroll-index-v1',years:['2026'],incomeYears:['2026'],...(opts.generation?{generation:opts.generation}:{})});
 const income=await encrypted('income',fixture());
 const calls=[],metadataCalls=[];
 const adapter={calls,metadataCalls,async readPayrollPublishedFile(path,name){calls.push([path,name]);if(name!=='index.enc'&&opts.missing)return null;return {text:name==='index.enc'?index:income,id:name,etag:'etag'};},
  async readPayrollPublishedMetadata(path,name){metadataCalls.push([path,name]);
   if(opts.metadataMissing===name)return null;
   return {id:opts.changedId===name?'replacement':name,etag:opts.changed===name?'updated':'etag'};
  }};
 return adapter;
}
test('Payroll現行の給与ファイルを読める: 手取りと欠損額面を推測しない',async()=>{
 const graph=await client(),session=await PayrollReadSession.connect(graph,passphrase),entries=await session.refresh();
 assert.equal(entries.length,2);assert.deepEqual(entries.map(x=>x.netPay),[200000,120000]);
 assert.equal(entries[0].grossPay,null);assert.equal(entries[1].grossPay,140000);
 assert.deepEqual(graph.calls.map(x=>x[1]),['index.enc','index.enc','2026.enc']);
 assert.deepEqual(graph.metadataCalls.map(x=>x[1]),['2026.enc','index.enc']);
 const assets=emptyAssets();assets.snapshots=[{id:'snapshot-1',accountId:'rakuten-bank',balance:300000,observedAt:'2026-11-01T01:00:00Z'}];
 const none=forecastAssets(assets,'2026-12-31',[],entries,null)['rakuten-bank'];
 const bank=forecastAssets(assets,'2026-12-31',[],entries,'rakuten-bank')['rakuten-bank'];
 assert.equal(none.balance,300000);assert.equal(bank.balance,620000);assert.equal(bank.payrollDelta,320000);
});
test('Payroll新世代のincomeパスを使用',async()=>{
 const generation='11111111-2222-4333-8444-555555555555';const graph=await client({generation});
 const s=await PayrollReadSession.connect(graph,passphrase);await s.refresh();
 assert.deepEqual(graph.calls.at(-1)[0],['versions',generation,'income']);
 assert.deepEqual(graph.metadataCalls,[[['versions',generation,'income'],'2026.enc'],[[],'index.enc']]);
});
test('読めない年度のファイルを0円と誤認せず停止',async()=>{
 const graph=await client({missing:true});const s=await PayrollReadSession.connect(graph,passphrase);
 await assert.rejects(s.refresh(),/見つかりません/);
});
test('誤ったパスフレーズで復号しない',async()=>{
 const graph=await client();await assert.rejects(PayrollReadSession.connect(graph,'invalid-password-789'),/一致しない|破損/);
});
test('過去形式と追加額面の両方を検査・変換',()=>{
 const d=adaptPayrollSource(fixture());
 assert.deepEqual(d.entries.map(x=>x.id),['pay-101','pay-102']);
 assert.deepEqual(d.entries.map(x=>x.grossPay),[null,140000]);
 assert.throws(()=>adaptPayrollSource({...fixture(),records:[record(1,'2026-11-31',3000)]}),/不正/);
 assert.throws(()=>adaptPayrollSource({...fixture(),records:[record(1,'2026-11-27',-4)]}),/不正/);
 assert.throws(()=>adaptPayrollSource({...fixture(),records:[record(1,'2026-11-27',3000),record(1,'2026-12-27',3000)]}),/不正/);
});
test('既存資産設定の復号互換性と給与受取口座の3方向マージ',()=>{
 const old=emptyAssets();delete old.payrollDepositAccount;
 const normalized=validateAssets(old);assert.equal(normalized.payrollDepositAccount,null);
 const local={...normalized,payrollDepositAccount:'rakuten-bank'};
 const remote={...normalized};remote.recurring.push({id:'test-item-123',name:'保険',amount:3000,kind:'expense',fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:27,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true});
 const merged=mergeAssets(normalized,local,remote);assert.equal(merged.payrollDepositAccount,'rakuten-bank');assert.equal(merged.recurring.length,1);
});

test('Payroll同期中の索引・年度更新、ファイル差替え・消失を拒否する',async()=>{
 for(const opts of [{changed:'index.enc'},{changed:'2026.enc'},{changedId:'index.enc'},{changedId:'2026.enc'},{metadataMissing:'index.enc'},{metadataMissing:'2026.enc'}]){
  const graph=await client(opts),session=await PayrollReadSession.connect(graph,passphrase);
  await assert.rejects(session.refresh(),/同期中に更新/);
 }
});

test('複数年度をすべて取得した後で、先に取得した年度の変更も検出する',async()=>{
 await setup();
 const index=await encrypted('index',{format:'payroll-index-v1',years:['2025','2026'],incomeYears:['2025','2026']});
 const first=await encrypted('income',{format:'payroll-income-v1',year:'2025',records:[record(201,'2025-12-27',180000)]});
 const second=await encrypted('income',fixture());
 const calls=[];let secondRead=false;
 const graph={async readPayrollPublishedFile(path,name){calls.push('read:'+name);if(name==='2026.enc')secondRead=true;return {id:name,etag:'old',text:name==='index.enc'?index:name==='2025.enc'?first:second};},
  async readPayrollPublishedMetadata(path,name){calls.push('check:'+name);return {id:name,etag:name==='2025.enc'&&secondRead?'new':'old'};}};
 const session=await PayrollReadSession.connect(graph,passphrase);
 await assert.rejects(session.refresh(),/収入ファイルが同期中に更新/);
 assert.deepEqual(calls,['read:index.enc','read:index.enc','read:2025.enc','read:2026.enc','check:2025.enc']);
});
