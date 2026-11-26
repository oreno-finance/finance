import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {emptyAssets,validateAssets,validateOneTime,mergeAssets,recurringCoveredByOneTime} from '../dist/src/cloud/assets.js';
import {forecastAssets} from '../dist/src/cloud/asset-projection.js';
import {forecastBankBalances} from '../dist/src/cloud/salary-projection.js';
import {bankTimeline} from '../dist/src/summary/bank-timeline.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {mizuhoTransferForBill} from '../dist/src/cloud/mizuho-transfer.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
import {encryptAssets,decryptAssets,freshSalt,deriveCloudKey} from '../dist/src/cloud/cloud-crypto.js';
import {readFileSync} from 'node:fs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const secret='secure test passphrase for one-off cloud records';
const once=(id='once-1',extra={})=>({id,date:'2026-11-20',name:'現金で支払った',amount:5000,kind:'expense',status:'done',fromAccountId:'rakuten-bank',toAccountId:null,...extra});
const snap=(id,account,balance,date='2026-11-16T10:00:00+09:00')=>({id,accountId:account,balance,observedAt:date});
const entry=(id='rec-1')=>({id,name:'定期保険',amount:6000,kind:'expense',fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true});
const doc=()=>({...emptyAssets(),snapshots:[snap('bank-r','rakuten-bank',100000),snap('bank-m','mizuho-bank',0),snap('bank-n','nisa',10000)]});
const source=(assets,records=[])=>({assets:records.length?assets:{...assets,cardNoUseMonths:['2026-11']},records,rules:[],categories:[],payroll:{ready:true,syncedAt:1,entries:[{id:'pay-1',employerId:'main',kind:'salary',paidOn:'2026-11-27',payPeriod:'2026-11',netPay:200000,grossPay:null,taxablePay:null,currency:'JPY',revision:1}]},currentPeriod:'2026-11'});
class Graph {
  constructor(data){this.data=data;this.fail=false;}
  read(k){const x=this.data.get(k);return x?{text:x.text,id:k,etag:`"${x.rev}"`}:null;}
  write(k,text,ref){if(this.fail)throw new Error('simulated save failure');const before=this.data.get(k);if(before&&(!ref||ref.etag!==`"${before.rev}"`))throw new GraphError(412,'conflict');if(!before&&ref)throw new GraphError(412,'conflict');const rev=(before?.rev??0)+1;this.data.set(k,{text,rev});return {id:k,etag:`"${rev}"`};}
  async readFinanceIndex(){return this.read('index');}
  async writeFinanceIndex(text,ref){return this.write('index',text,ref);}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async listYearFiles(){return [];}
  async readMerchantRules(){return this.read('rules');}
  async writeMerchantRules(text,ref){return this.write('rules',text,ref);}
  async readAssetSettings(){return this.read('assets');}
  async writeAssetSettings(text,ref){return this.write('assets',text,ref);}
}

test('legacy assets remain backward-compatible without adding optional fields',()=>{
  const legacy=emptyAssets();assert.deepEqual(validateAssets(legacy),legacy);
  assert.deepEqual(mergeAssets(legacy,legacy,legacy),legacy);
});
test('one-off validation rejects unsafe amount, invalid date, same-account transfers and false funding routes',()=>{
  assert.deepEqual(validateOneTime(once()),once());
  for(const patch of [{amount:0},{amount:1.5},{date:'2026-02-30'},{name:' '},{kind:'deposit'},{status:'paid'},{id:10000000},{fromAccountId:'nonsense'},{cardFunding:true}])
    assert.throws(()=>validateOneTime(once('once-1',patch)));
  const transfer=once('once-t',{kind:'transfer',fromAccountId:'rakuten-bank',toAccountId:'rakuten-bank'});
  assert.throws(()=>validateOneTime(transfer),/別々/);
  assert.equal(validateOneTime(once('once-t',{kind:'transfer',fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',cardFunding:true})).cardFunding,true);
});
test('one-off planned expense and done income appear after the baseline, without changing stored snapshots',()=>{
  const assets=doc();assets.oneTime=[once('once-exp',{status:'planned',date:'2026-11-18',amount:12000}),once('once-inc',{kind:'income',name:'臨時入金',status:'done',date:'2026-11-19',fromAccountId:null,toAccountId:'rakuten-bank',amount:4000})];
  const report=forecastAssets(assets,'2026-11-19');
  assert.equal(report['rakuten-bank'].balance,92000);
  assert.equal(assets.snapshots[0].balance,100000);
  assets.snapshots.push(snap('new-bank','rakuten-bank',85000,'2026-11-19T13:00:00+09:00'));
  assert.equal(forecastAssets(assets,'2026-11-19')['rakuten-bank'].balance,85000);
  assert.equal(forecastAssets(assets,'2026-11-21')['rakuten-bank'].balance,85000);
});
test('bank-to-bank transfers change account forecasts and bank timeline, never household balance',()=>{
  const assets=doc();assets.oneTime=[once('once-t',{kind:'transfer',name:'貯金へ',amount:20000,fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',date:'2026-11-20'})];
  const forecast=forecastBankBalances(assets,'2026-11-30',[],[],null,'2026-11-17');
  assert.equal(forecast.accounts['rakuten-bank'].balance,80000);
  assert.equal(forecast.accounts['mizuho-bank'].balance,20000);
  const timeline=bankTimeline('2026-11',source(assets,[]),'2026-11-17');
  assert.equal(timeline.endBalance,80000);
  assert.equal(timeline.days[0].delta,-20000);
  const month=monthlyReport('2026-11',source(assets));
  assert.equal(month.oneTimeExpense,0);
  assert.equal(month.monthlyBalance,200000);
});
test('cash withdrawal does not count as household consumption, explicit expense does',()=>{
  const assets=doc();assets.oneTime=[once('once-w',{kind:'withdrawal',name:'ATM引出',amount:10000}),once('once-e',{kind:'expense',name:'現金を使った',amount:3000,date:'2026-11-21'})];
  const month=monthlyReport('2026-11',source(assets));
  assert.equal(month.oneTimeExpense,3000);
  assert.equal(month.monthlyBalance,197000);
  assert.equal(forecastAssets(assets,'2026-11-30')['rakuten-bank'].balance,87000);
});
test('one-time income adds to monthly income, while transfer and withdrawal remain neutral',()=>{
  const assets=doc();assets.oneTime=[once('once-i',{kind:'income',fromAccountId:null,toAccountId:'rakuten-bank',amount:7000,name:'返金'})];
  const month=monthlyReport('2026-11',source(assets));
  assert.equal(month.oneTimeIncome,7000);
  assert.equal(month.monthlyBalance,207000);
});
test('manual matching recurrence replaces the schedule for forecasts and monthly totals',()=>{
  const assets=doc();assets.recurring=[entry()];assets.oneTime=[once('done-rec',{date:'2026-11-20',name:'定期保険',amount:6000})];
  assert.equal(recurringCoveredByOneTime(assets.recurring[0],'2026-11-20',assets.oneTime),true);
  assert.equal(forecastAssets(assets,'2026-11-25')['rakuten-bank'].balance,94000);
  const report=monthlyReport('2026-11',source(assets));
  assert.equal(report.recurringExpense,0);
  assert.equal(report.oneTimeExpense,6000);
  assert.equal(report.monthlyBalance,194000);
  assert.deepEqual(bankTimeline('2026-11',source(assets),'2026-11-17').days.map(d=>d.delta),[-6000]);
});
test('explicit Mizuho card-funding transfer prevents predicted duplicate, including later manual dates',()=>{
  const assets=doc();assets.mizuhoTransferPlan={enabled:true,leadDays:3,extraForSmallBills:true};assets.cardDebitAccounts={'rakuten-mizuho':'mizuho-bank'};
  const bill={cardId:'rakuten-mizuho',amount:24245,paymentDate:'2026-11-27'};
  assert.equal(mizuhoTransferForBill(bill,assets)?.amount,30000);
  assets.oneTime=[once('fund-1',{kind:'transfer',name:'カード代送金',date:'2026-11-25',amount:30000,fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',cardFunding:true})];
  assert.equal(mizuhoTransferForBill(bill,assets),null);
});
test('one-time entries are encrypted, with no plaintext payee or amount visible',async()=>{
  const assets={...doc(),oneTime:[once('secret-entry',{name:'PERSONAL BANK TRANSFER',amount:76321})]};
  const salt=freshSalt(),key=await deriveCloudKey(secret,salt);
  const cipher=await encryptAssets(assets,key,salt);
  assert.equal(cipher.includes('PERSONAL BANK TRANSFER'),false);
  assert.equal(cipher.includes('76321'),false);
  assert.deepEqual(await decryptAssets(cipher,key,salt),validateAssets(assets));
});
test('concurrent devices merge independent one-time records and persist tombstones',()=>{
  const base=emptyAssets();const a={...base,oneTime:[once('left-1')]},b={...base,oneTime:[once('right-2',{amount:7000})]};
  const merged=mergeAssets(base,a,b);
  assert.deepEqual(merged.oneTime.map(x=>x.id).sort(),['left-1','right-2']);
  const removed={...merged,oneTime:merged.oneTime.filter(x=>x.id!=='left-1'),deletedOneTime:['left-1']};
  const result=mergeAssets(merged,removed,merged);
  assert.deepEqual(result.oneTime.map(x=>x.id),['right-2']);
  assert.deepEqual(result.deletedOneTime,['left-1']);
});
test('LiveVault persists, updates and deletes one-time records through encrypted assets with no statement changes',async()=>{
  const store=new Map(),graph=new Graph(store),vault=new LiveVault(graph);await vault.create(secret);
  await vault.upsertOneTime(once('once-a',{name:'SECRET WIRE TRANSFER'}));
  assert.equal(store.get('assets').text.includes('SECRET WIRE TRANSFER'),false);
  assert.equal(store.has('rules'),false);
  const b=new LiveVault(new Graph(store));await b.unlock(secret);
  assert.equal(b.assetSettings().oneTime[0].name,'SECRET WIRE TRANSFER');
  await b.upsertOneTime(once('once-a',{name:'UPDATED',status:'planned'}));
  await vault.refresh();assert.equal(vault.assetSettings().oneTime[0].name,'UPDATED');
  await vault.deleteOneTime('once-a');
  await b.refresh();assert.deepEqual(b.assetSettings().oneTime,[]);
  assert.deepEqual(b.assetSettings().deletedOneTime,['once-a']);
});
test('failed OneDrive write cannot mutate local recorded one-time entries',async()=>{
  const store=new Map(),graph=new Graph(store),vault=new LiveVault(graph);await vault.create(secret);
  graph.fail=true;
  await assert.rejects(vault.upsertOneTime(once('failed')),/failure/);
  assert.equal(vault.assetSettings().oneTime,undefined);
});
test('UI registers the modal and fixes history counter as a unit, without showing a full-sized form',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles/ui-v158.css',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../src/ui/assets-settings.ts',import.meta.url),'utf8');
  assert.match(html,/id="assets-once-add"/);
  assert.match(html,/<dialog id="assets-once-dialog"/);
  assert.match(html,/id="assets-once-list"/);
  assert.match(ui,/assets-history-counter/);
  assert.match(ui,/`（\$\{items.length\}件）`/);
  assert.match(css,/assets-history-counter\{[^}]*white-space:nowrap/);
});

test('future savings and NISA projection include a single planned transfer exactly once',async()=>{
  const {futureProjection}=await import('../dist/src/cloud/future-projection.js');
  const assets=doc();assets.snapshots.push(snap('bank-c','cash-savings',50000));
  assets.oneTime=[once('once-saving',{kind:'transfer',name:'臨時貯金',date:'2026-11-22',amount:10000,fromAccountId:'rakuten-bank',toAccountId:'cash-savings'}),
    once('once-nisa',{kind:'transfer',name:'NISAに臨時入金',date:'2026-12-03',amount:5000,fromAccountId:'rakuten-bank',toAccountId:'nisa'})];
  const options={today:'2026-11-17',targetMonth:'2026-12',changeMonth:'2026-12',savingsRuleId:null,savingsAmount:0,nisaMonthly:0,nisaAnnualReturn:0};
  const result=futureProjection(assets,[],options);
  assert.deepEqual(result.points.map(p=>[p.month,p.cash,p.nisa]),[['2026-11',60000,10000],['2026-12',60000,15000]]);
});

test('dedicated actual funding save refuses a stale second-device duplicate, preserves the first transfer and remains usable',async()=>{
 const store=new Map(),vault=new LiveVault(new Graph(store));await vault.create(secret);
 await vault.setMizuhoTransferPlan({enabled:true,leadDays:3,extraForSmallBills:true});
 const second=new LiveVault(new Graph(store));await second.unlock(secret);
 const snapshot={billId:'invoice-demo',paymentDate:'2025-11-27',billAmount:24245,transferAmount:30000};
 const movement=once('actual-funding-a',{date:'2025-11-26',kind:'transfer',name:'送金',amount:28000,fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',cardFunding:true});
 await vault.upsertOneTime(movement,snapshot);
 const encrypted=store.get('assets').text;
 await assert.rejects(second.upsertOneTime({...movement,id:'actual-funding-b',amount:31000},snapshot),/振替が登録/);
 assert.equal(store.get('assets').text,encrypted);
 await second.refresh();assert.deepEqual(second.assetSettings().oneTime.map(e=>[e.id,e.amount]),[['actual-funding-a',28000]]);
 assert.equal(second.assetSettings().mizuhoFundingChecks,undefined);
 await second.upsertOneTime(once('independent-entry'));assert.equal(second.assetSettings().oneTime.length,2);
});
