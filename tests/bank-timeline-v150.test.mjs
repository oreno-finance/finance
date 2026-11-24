import test from 'node:test';
import assert from 'node:assert/strict';
import {bankTimeline} from '../dist/src/summary/bank-timeline.js';
import {emptyAssets, validateAssets, mergeAssets, validateBirthMonth, validateCardDebitAccounts} from '../dist/src/cloud/assets.js';
const salary=(id,paidOn,amount=188149)=>({id,employerId:'main',payPeriod:paidOn.slice(0,7),paidOn,netPay:amount,grossPay:null,taxablePay:null,kind:'salary',revision:1});
const snap=(balance=100000)=>({id:'snap-16112026',accountId:'rakuten-bank',balance,observedAt:'2026-11-16T12:00:00.000Z'});
const recurring=(name,amount,day,extra={})=>({id:`rec-${day}-${name}`,name,amount,kind:'expense',fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:day,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true,...extra});
const record={id:'card-test',statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'テスト',billingMonth:'2026-10',paymentDate:'2026-11-20',statedTotal:150000,confirmation:'provisional',warnings:[],rows:[{id:'tx-1',usedOn:'2026-10-20',merchant:'SHOP',amount:150000}]}};
const make=(accounts={'smbc-nl':'rakuten-bank'},entries=[salary('old','2026-10-27')])=>({records:[record],rules:[],categories:[],assets:{...emptyAssets(),cardDebitAccounts:accounts,payrollDepositAccount:'rakuten-bank',snapshots:[snap()],recurring:[recurring('保険料',10000,30)]},payroll:{ready:true,syncedAt:1000,entries},currentPeriod:'2026-11'});
test('bank cash timeline includes card debit before estimated payday and scheduled debit after it',()=>{
 const result=bankTimeline('2026-11',make(),'2026-11-17');
 assert.equal(result.startBalance,100000);
 assert.equal(result.minimum,-50000);
 assert.equal(result.endBalance,128149);
 assert.deepEqual(result.days.map(x=>[x.date,x.balance]),[['2026-11-20',-50000],['2026-11-27',138149],['2026-11-30',128149]]);
 assert.equal(result.days[0].items[0].provisional,true);
});
test('unmapped card payments never get guessed as Rakuten bank debits',()=>{
 const result=bankTimeline('2026-11',make({}),'2026-11-17');
 assert.deepEqual(result.missingCardAccounts,['三井住友カード NL']);
 assert.equal(result.minimum,100000);
 assert.equal(result.endBalance,278149);
});
test('confirmed salary overrides estimation and salary-like recurring income does not duplicate payroll',()=>{
 const source=make({'smbc-nl':'rakuten-bank'},[salary('old','2026-10-27'),salary('now','2026-11-27',205000)]);
 source.assets.recurring.push(recurring('本業給与',205000,27,{kind:'income',fromAccountId:null,toAccountId:'rakuten-bank'}));
 const result=bankTimeline('2026-11',source,'2026-11-17');
 assert.equal(result.endBalance,145000);
 assert.equal(result.days.filter(d=>d.date==='2026-11-27').length,1);
 assert.equal(result.days.find(d=>d.date==='2026-11-27').delta,205000);
});
test('birth month and card debit accounts validate and merge without breaking legacy assets',()=>{
 const original=emptyAssets();assert.deepEqual(validateAssets(original),original);
 assert.equal(validateBirthMonth('2003-07'),'2003-07');
 assert.throws(()=>validateBirthMonth('2003-13'),/確認/);
 assert.deepEqual(validateCardDebitAccounts({'amazon':'cash-savings'}),{'amazon':'cash-savings'});
 assert.throws(()=>validateCardDebitAccounts({'amazon':'nisa'}),/不正/);
 const left={...original,birthMonth:'2003-07'};
 const right={...original,cardDebitAccounts:{amazon:'rakuten-bank'}};
 const combined=mergeAssets(original,left,right);
 assert.equal(combined.birthMonth,'2003-07');
 assert.equal(combined.cardDebitAccounts.amazon,'rakuten-bank');
});
test('account-card bank forecast also applies mapped card debits, without changing unrelated accounts',async()=>{
 const {forecastBankBalances}=await import('../dist/src/cloud/salary-projection.js');
 const source=make();
 const result=forecastBankBalances(source.assets,'2026-11-30',source.records,source.payroll.entries,'rakuten-bank','2026-11-17');
 assert.equal(result.cardDebitByAccount['rakuten-bank'],150000);
 assert.equal(result.accounts['rakuten-bank'].balance,128149);
 assert.equal(result.accounts['cash-savings'].balance,null);
});
test('encrypted vault persists birth month and debit settings without leaking names or values',async()=>{
 const {LiveVault}=await import('./helpers/coordinated-vault.mjs');
 const {GraphError}=await import('../dist/src/cloud/onedrive-api.js');
 class Storage {
  constructor(){this.rows=new Map();}
  read(key){const x=this.rows.get(key);return x?{text:x.text,id:key,etag:`"${x.version}"`}:null;}
  write(key,text,ref){const old=this.rows.get(key);
   if((old&&(!ref||ref.etag!==`"${old.version}"`))||(!old&&ref))throw new GraphError(412,'conflict');
   const version=(old?.version??0)+1;this.rows.set(key,{text,version});return {id:key,etag:`"${version}"`};}
  async readFinanceIndex(){return this.read('index');}
  async writeFinanceIndex(s,ref){return this.write('index',s,ref);}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async listYearFiles(){return [];}
  async readMerchantRules(){return null;}
  async readAssetSettings(){return this.read('assets');}
  async writeAssetSettings(s,ref){return this.write('assets',s,ref);}
 }
 const g=new Storage(),vault=new LiveVault(g);await vault.create('safe test passphrase 2026!');
 await vault.setBirthMonth('2003-07');
 await vault.setCardDebitAccounts({amazon:'rakuten-bank'});
 assert.equal(g.rows.get('assets').text.includes('2003-07'),false);
 assert.equal(g.rows.get('assets').text.includes('rakuten-bank'),false);
 const mirror=new LiveVault(g);await mirror.unlock('safe test passphrase 2026!');
 assert.equal(mirror.assetSettings().birthMonth,'2003-07');
 assert.equal(mirror.assetSettings().cardDebitAccounts.amazon,'rakuten-bank');
});
