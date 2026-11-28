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

test('M304: date-effective routes preserve legacy values, null baseline, same-day final value and independent device edits',async()=>{
 const {updateCardDebitRoutes,updatePayrollDepositRoute,cardDebitAccountOnDay,payrollDepositAccountOnDay,detectAssetsEditCollisions,assertAccountRouteContinuity}=await import('../dist/src/cloud/assets.js');
 const legacy={...emptyAssets(),cardDebitAccounts:{'smbc-nl':'rakuten-bank'},payrollDepositAccount:'rakuten-bank'};
 const left=structuredClone(legacy),right=structuredClone(legacy);
 updateCardDebitRoutes(left,{'smbc-nl':'mizuho-bank'},'2026-11-20');
 updateCardDebitRoutes(left,{'smbc-nl':'cash-savings'},'2026-11-20');
 updateCardDebitRoutes(left,{'smbc-nl':'cash-savings'},'2026-11-21');
 updateCardDebitRoutes(left,{},'2026-12-01');
 updateCardDebitRoutes(right,{'smbc-nl':'rakuten-bank',amazon:'mizuho-bank'},'2026-11-20');
 updatePayrollDepositRoute(right,'cash-savings','2026-11-25');
 assert.equal(left.cardDebitAccountHistory['smbc-nl'].length,3);
 assert.equal(left.format,'finance-assets-v3');
 assert.equal(detectAssetsEditCollisions(legacy,left,right).length,0);
 const both=mergeAssets(legacy,left,right);
 assert.equal(cardDebitAccountOnDay(both,'smbc-nl','2026-11-19'),'rakuten-bank');
 assert.equal(cardDebitAccountOnDay(both,'smbc-nl','2026-11-20'),'cash-savings');
 assert.equal(cardDebitAccountOnDay(both,'smbc-nl','2026-12-01'),null);
 assert.equal(cardDebitAccountOnDay(both,'amazon','2026-11-19'),null);
 assert.equal(cardDebitAccountOnDay(both,'amazon','2026-11-20'),'mizuho-bank');
 assert.equal(payrollDepositAccountOnDay(both,'2026-11-24'),'rakuten-bank');
 assert.equal(payrollDepositAccountOnDay(both,'2026-11-25'),'cash-savings');
 assert.deepEqual(validateAssets(both),both);
 assert.throws(()=>validateAssets({...both,format:'finance-assets-v2'}),/履歴/);
 assert.throws(()=>validateAssets({...both,payrollDepositAccount:'rakuten-bank'}),/履歴/);
 assert.throws(()=>assertAccountRouteContinuity(both,legacy),/旧形式/);
 const concurrent=structuredClone(legacy);
 updateCardDebitRoutes(concurrent,{'smbc-nl':'mizuho-bank'},'2026-11-21');
 assert.equal(detectAssetsEditCollisions(legacy,left,concurrent).length,1);
 assert.throws(()=>mergeAssets(legacy,left,concurrent),/履歴/);
 const independent={...legacy,birthMonth:'2000-01'};
 assert.deepEqual(mergeAssets(legacy,independent,both).cardDebitAccountHistory,both.cardDebitAccountHistory);
});

test('M304: payment date and paidOn agree across bank forecasts, timeline, home and encrypted round-trip',async()=>{
 const {updateCardDebitRoutes,updatePayrollDepositRoute}=await import('../dist/src/cloud/assets.js');
 const {forecastBankBalances}=await import('../dist/src/cloud/salary-projection.js');
 const {forecastAccounts}=await import('../dist/src/home/account-events.js');
 const {monthlyReport}=await import('../dist/src/summary/monthly-summary.js');
 const {mizuhoTransferForBill}=await import('../dist/src/cloud/mizuho-transfer.js');
 const {freshSalt,deriveCloudKey,encryptAssets,decryptAssets}=await import('../dist/src/cloud/cloud-crypto.js');
 const assets={...emptyAssets(),cardDebitAccounts:{'smbc-nl':'rakuten-bank','rakuten-mizuho':'rakuten-bank'},payrollDepositAccount:'rakuten-bank',
  snapshots:['rakuten-bank','mizuho-bank','cash-savings'].map((accountId,i)=>({id:`snap-routes-${i}`,accountId,balance:100000,observedAt:'2026-11-01T00:00:00Z'}))};
 updateCardDebitRoutes(assets,{'smbc-nl':'mizuho-bank','rakuten-mizuho':'mizuho-bank'},'2026-11-20');
 updatePayrollDepositRoute(assets,'cash-savings','2026-11-20');
 const records=[{id:'bill-before',statement:{...record.statement,billingMonth:'2026-10',paymentDate:'2026-11-10',confirmation:'confirmed',statedTotal:1000,rows:[{id:'row-one',usedOn:'2026-10-05',merchant:'SHOP',amount:1000}]}},
  {id:'bill-after',statement:{...record.statement,billingMonth:'2026-11',paymentDate:'2026-11-27',confirmation:'confirmed',statedTotal:2000,rows:[{id:'row-two',usedOn:'2026-11-05',merchant:'SHOP',amount:2000}]}}];
 const entries=[salary('pay-before','2026-11-10',10000),{...salary('pay-after','2026-11-27',20000),payPeriod:'2026-10'}];
 const source={assets,records,rules:[],categories:[],payroll:{ready:true,syncedAt:Date.parse('2026-11-28T00:00:00Z'),entries},currentPeriod:'2026-11',currentDay:'2026-11-28'};
 const report=forecastBankBalances(assets,'2026-11-30',records,entries,'cash-savings','2026-11-28');
 assert.equal(report.accounts['rakuten-bank'].balance,109000);
 assert.equal(report.accounts['mizuho-bank'].balance,98000);
 assert.equal(report.accounts['cash-savings'].balance,120000);
 assert.equal(bankTimeline('2026-11',source,'2026-11-28').endBalance,109000);
 const home=forecastAccounts(source,'2026-11-28');
 for(const id of ['rakuten-bank','mizuho-bank','cash-savings']){
  const account=home.accounts.find(a=>a.accountId===id);
  assert.equal(account.days.filter(d=>d.date<='2026-11-30').at(-1).balance,report.accounts[id].balance);
 }
 assert.equal(monthlyReport('2026-11',source).actualIncome,30000);
 assets.mizuhoTransferPlan={enabled:true,leadDays:3,extraForSmallBills:false};
 assert.equal(mizuhoTransferForBill({cardId:'rakuten-mizuho',paymentDate:'2026-11-19',amount:1000},assets),null);
 assert.equal(mizuhoTransferForBill({cardId:'rakuten-mizuho',paymentDate:'2026-11-20',amount:1000},assets)?.date,'2026-11-17');
 const salt=freshSalt(),key=await deriveCloudKey('synthetic route history test passphrase',salt);
 const cipher=await encryptAssets(assets,key,salt);
 assert.equal(cipher.includes('cardDebitAccountHistory'),false);
 assert.deepEqual(await decryptAssets(cipher,key,salt),validateAssets(assets));
});
