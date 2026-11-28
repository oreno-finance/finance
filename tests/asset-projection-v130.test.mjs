import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {emptyAssets, validateAssets, mergeAssets} from '../dist/src/cloud/assets.js';
import {forecastAssets, matchingNisaRows, lastDayOfNextMonth} from '../dist/src/cloud/asset-projection.js';
import {LiveVault} from '../dist/src/cloud/live-vault.js';
import {deriveCloudKey, decryptAssets} from '../dist/src/cloud/cloud-crypto.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const observedAt='2026-11-16T12:00:00.000Z';
const snap=(id,accountId,balance,at=observedAt)=>({id,accountId,balance,observedAt:at});
const transfer=(id,patch={})=>({id,name:'貯蓄口座への定期送金',amount:10000,kind:'transfer',fromAccountId:'rakuten-bank',toAccountId:'cash-savings',frequency:'monthly',dayOfMonth:27,monthOfYear:null,weekday:null,startOn:'2026-11-01',endOn:null,categoryId:null,enabled:true,...patch});
const record=(id,rows,cardId='rakuten-mizuho')=>({id,statement:{cardId,provider:cardId==='smbc-nl'?'smbc':'rakuten',sourceKind:'paste',sourceName:'synthetic',billingMonth:'2026-11',paymentDate:'2026-11-27',confirmation:'confirmed',warnings:[],statedTotal:rows.reduce((sum,r)=>sum+r.amount,0),rows:rows.map((row,i)=>({id:`row-${i}`,merchant:row.merchant,usedOn:row.date,amount:row.amount}))}});
function doc(){return {...emptyAssets(),snapshots:[snap('snap-main','rakuten-bank',200000),snap('snap-cash','cash-savings',100000),snap('snap-nisa','nisa',500000)],recurring:[transfer('transfer-one')]};}
test('recurring transfers affect both balances from day AFTER snapshot without changing aggregate assets',()=>{
 const before=forecastAssets(doc(),'2026-11-16');
 assert.equal(before['rakuten-bank'].balance,200000);
 const after=forecastAssets(doc(),'2026-11-27');
 assert.equal(after['rakuten-bank'].balance,190000);
 assert.equal(after['cash-savings'].balance,110000);
 assert.equal(after.nisa.balance,500000);
 assert.equal(after['rakuten-bank'].balance+after['cash-savings'].balance,300000);
 const second=forecastAssets(doc(),'2026-12-31');
 assert.equal(second['rakuten-bank'].balance,180000);
 assert.equal(second['cash-savings'].balance,120000);
 assert.equal(second['rakuten-bank'].forecastEvents,2);
});
test('nonexistent 31st clamps to end of month, yearly and weekly honor start/end/disabled',()=>{
 const data={...doc(),recurring:[
   transfer('monthly-31',{dayOfMonth:31}),
   transfer('year-end',{kind:'expense',toAccountId:null,amount:2000,frequency:'yearly',monthOfYear:12,dayOfMonth:0,startOn:'2026-12-01'}),
   transfer('weekly',{kind:'income',fromAccountId:null,toAccountId:'rakuten-bank',amount:500,frequency:'weekly',dayOfMonth:null,weekday:3,startOn:'2026-11-18',endOn:'2026-11-25'}),
   transfer('disabled',{enabled:false})
 ]};
 const november=forecastAssets(data,'2026-11-30');
 assert.equal(november['rakuten-bank'].balance,191000); // -10000 + 2*500
 assert.equal(november['cash-savings'].balance,110000);
 const december=forecastAssets(data,'2026-12-31');
 assert.equal(december['rakuten-bank'].balance,179000); // second -10000 and year-end -2000
});
test('a snapshot on the 27th excludes all events of that day; newer snapshot becomes the only baseline',()=>{
 const data={...doc(),snapshots:[...doc().snapshots,snap('snapshot-latest','rakuten-bank',180000,'2026-11-27T12:00:00Z')]};
 assert.equal(forecastAssets(data,'2026-11-27')['rakuten-bank'].balance,180000);
 assert.equal(forecastAssets(data,'2026-12-27')['rakuten-bank'].balance,170000);
 assert.equal(forecastAssets(data,'2026-11-16')['rakuten-bank'].balance,200000);
});
test('NISA auto contributions require explicit merchant AND card; refunds and malformed dates are excluded',()=>{
 const data={...doc(),nisaCardRule:{cardId:'rakuten-mizuho',merchantContains:'楽天証券',enabled:true}};
 const records=[record('a',[
  {merchant:'ラクテンショウケン',date:'2026-11-23',amount:1000},
  {merchant:'楽天証券 投信積立',date:'2026-11-24',amount:20000},
  {merchant:'楽天証券',date:'2026-11-16',amount:3000},
  {merchant:'楽天証券',date:'2026-11-25',amount:-2000},
 ]),record('b',[{merchant:'楽天証券',date:'2026-11-28',amount:30000}],'smbc-nl')];
 const invalid=structuredClone(records[0]);invalid.statement.rows.push({id:'invalid',usedOn:'2026-13-99',merchant:'楽天証券',amount:2000});invalid.statement.statedTotal+=2000;
 assert.equal(matchingNisaRows(data,[invalid]).length,0,'malformed row excludes the entire statement');
 assert.equal(matchingNisaRows(data,records).length,2);
 assert.equal(forecastAssets(data,'2026-11-30',records).nisa.balance,520000);
 assert.equal(forecastAssets(data,'2026-11-30',records)['rakuten-bank'].balance,190000,'card charge does not debit unmapped bank');
 data.nisaCardRule=null;
 assert.equal(forecastAssets(data,'2026-11-30',records).nisa.balance,500000);
});
test('legacy assets file without investment linkage reads as unlinked and does not guess savings',()=>{
 const legacy=doc();delete legacy.nisaCardRule;
 assert.equal(validateAssets(legacy).nisaCardRule,null);
 assert.equal(forecastAssets({...emptyAssets()},'2026-11-30').nisa.balance,null);
 assert.equal(lastDayOfNextMonth(new Date(2026,11,15)),'2027-01-31');
});
test('three-way merge combines new link with independent snapshots and tracks same-field conflict',()=>{
 const base=doc(),left=structuredClone(base),right=structuredClone(base);
 left.nisaCardRule={cardId:'rakuten-mizuho',merchantContains:'楽天証券',enabled:true};
 right.snapshots.push(snap('other-bank','nisa',555000,'2026-11-20T00:00:00Z'));
 const merged=mergeAssets(base,left,right);
 assert.equal(merged.nisaCardRule.merchantContains,'楽天証券');
 assert.equal(merged.snapshots.length,4);
 const other=structuredClone(right);other.nisaCardRule={cardId:'smbc-nl',merchantContains:'楽天証券',enabled:true};
 const collision=mergeAssets(base,left,other);
 assert.equal(collision.nisaCardRule.cardId,'rakuten-mizuho');
 assert.ok(collision.conflicts.some(c=>c.field==='nisaCardRule'));
});
test('account workspace separated from app settings; Microsoft controls are not duplicated',async()=>{
 const fs=await import('node:fs/promises');
 const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
 const main=await fs.readFile(new URL('../src/main.ts',import.meta.url),'utf8');
 assert.match(html,/id="settings-view"/);
 assert.match(html,/id="nav-settings"/);
 assert.doesNotMatch(html,/id="nav-cloud"/);
 assert.match(html,/id="nav-assets"/);
 assert.match(html,/id="assets-page"/);
 assert.ok(html.indexOf('id="assets-view"')<html.indexOf('id="settings-view"'));
 assert.ok(html.indexOf('id="assets-page"')<html.indexOf('id="assets-view"'));
 assert.ok(html.indexOf('id="settings-view"')<html.indexOf('id="cloud-view"'));
 assert.match(main,/view === 'assets'/);
 assert.match(main,/view === 'settings'/);
 for(const id of ['cloud-rotate-form','cloud-client-id','cloud-login','assets-nisa-link-form','assets-balances-form']){
  assert.equal(html.match(new RegExp(`id="${id}"`,'g'))?.length,1);
 }
});

// H301: verified card contributions and an explicitly linked bank schedule
// represent one movement. The card bill itself is never removed.
const nisaTransfer=transfer('nisa-bank-plan',{name:'Synthetic NISA transfer',toAccountId:'nisa',amount:20000,dayOfMonth:25});
const nisaRule={cardId:'rakuten-mizuho',merchantContains:'Synthetic investment',enabled:true};
const nisaRecord=()=>record('nisa-card-bill',[{merchant:nisaRule.merchantContains,date:'2026-11-24',amount:20000}]);
const nisaData=(bankFunding)=>({...doc(),recurring:[nisaTransfer],cardDebitAccounts:{'rakuten-mizuho':'rakuten-bank'},nisaCardRule:{...nisaRule,...(bankFunding?{bankFunding}:{})},...(bankFunding?{format:'finance-assets-v3'}:{})});
const sameFunding={kind:'same',recurringId:nisaTransfer.id};
const independentFunding={kind:'independent'};
const sourceFor=(data,records)=>({assets:data,records,rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null},currentPeriod:'2026-11',currentDay:'2026-11-30'});
test('H301: explicit one-to-one link removes the duplicate schedule on both sides, while preserving card outflow across screens',async()=>{
 const {forecastBankBalances}=await import('../dist/src/cloud/salary-projection.js');
 const {forecastAccounts}=await import('../dist/src/home/account-events.js');
 const {bankTimeline}=await import('../dist/src/summary/bank-timeline.js');
 const {monthlyReport}=await import('../dist/src/summary/monthly-summary.js');
 const {futureProjection}=await import('../dist/src/cloud/future-projection.js');
 const assets=nisaData(sameFunding),records=[nisaRecord()],source=sourceFor(assets,records),today='2026-11-30';
 const before=JSON.stringify(assets);
 const forecasts=forecastBankBalances(assets,today,records,[],null,today);
 assert.equal(forecasts.accounts.nisa.balance,520000);
 assert.equal(forecasts.accounts['rakuten-bank'].balance,180000);
 assert.equal(forecasts.accounts.nisa.nisaOverlap,undefined);
 assert.equal(forecastAccounts(source,today,1).accounts.find(a=>a.accountId==='rakuten-bank').projected,180000);
 assert.equal(bankTimeline('2026-11',source,today).endBalance,180000);
 const monthly=monthlyReport('2026-11',source);
 assert.equal(monthly.cardOutflow,20000);assert.equal(monthly.nisaOutflow,20000);
 const projection=futureProjection(assets,records,{today,targetMonth:'2026-12',changeMonth:'2026-12',savingsRuleId:null,savingsAmount:0,nisaMonthly:20000,nisaAnnualReturn:0});
 assert.equal(projection.nisaStart,520000);assert.equal(projection.target.nisa,540000);
 assert.equal(JSON.stringify(assets),before);
});
test('H301: unspecified overlap is explicitly reference-only; independent funding keeps both contributions',async()=>{
 const {futureProjection,currentSavingMonthly}=await import('../dist/src/cloud/future-projection.js');
 const records=[nisaRecord()],today='2026-11-30';
 const ambiguous=forecastAssets(nisaData(),today,records);
 assert.equal(ambiguous.nisa.balance,540000);assert.equal(ambiguous.nisa.nisaOverlap.scheduledDelta,20000);
 assert.equal(ambiguous['rakuten-bank'].nisaOverlap.scheduledDelta,-20000);assert.match(ambiguous.nisa.warning,/参考値/);
 const independent=nisaData(independentFunding),result=forecastAssets(independent,today,records);
 assert.equal(result.nisa.balance,540000);assert.equal(result.nisa.nisaOverlap,undefined);
 assert.equal(result['rakuten-bank'].balance,180000);
 assert.equal(currentSavingMonthly(independent,today,20000).nisa,40000);
 const options={today,targetMonth:'2026-12',changeMonth:'2026-12',savingsRuleId:null,savingsAmount:0,nisaMonthly:20000,nisaAnnualReturn:0};
 assert.equal(futureProjection(independent,records,options).target.nisa,580000);
 assert.equal(futureProjection(independent,records,options).conflictingNisaSources,false);
 assert.equal(futureProjection(nisaData(),records,options).conflictingNisaSources,true);
});
test('H301: explicit link never cancels an executed transfer, ambiguous matches or different amounts',()=>{
 const data=nisaData(sameFunding),records=[nisaRecord()],today='2026-11-30';
 const once={id:'nisa-once-test',name:nisaTransfer.name,amount:20000,kind:'transfer',date:'2026-11-25',fromAccountId:'rakuten-bank',toAccountId:'nisa',status:'planned'};
 data.oneTime=[once];
 let r=forecastAssets(data,today,records);
 assert.equal(r.nisa.balance,520000);assert.equal(r['rakuten-bank'].balance,200000);assert.equal(r.nisa.overdue,undefined);
 data.oneTime=[{...once,status:'done'}];
 r=forecastAssets(data,today,records);assert.equal(r.nisa.balance,540000);assert.equal(r.nisa.nisaOverlap.count,1);
 assert.equal(r['rakuten-bank'].balance,180000);
 data.oneTime=[];data.recurring=[{...nisaTransfer,amount:15000}];
 r=forecastAssets(data,today,records);assert.equal(r.nisa.balance,535000);assert.equal(r.nisa.nisaOverlap.count,1);
 data.recurring=[nisaTransfer];
 const two=record('two-rows',[{merchant:nisaRule.merchantContains,date:'2026-11-23',amount:20000},{merchant:nisaRule.merchantContains,date:'2026-11-24',amount:20000}]);
 r=forecastAssets(data,today,[two]);assert.equal(r.nisa.balance,560000);assert.equal(r.nisa.nisaOverlap.count,1);
 const provisional=nisaRecord();provisional.statement.confirmation='provisional';
 r=forecastAssets(data,today,[provisional]);assert.equal(r.nisa.balance,520000);assert.equal(r.nisa.cardNisaDelta,0);
});
test('H301: history, snapshot dates, old formats and encrypted setting round-trip',async()=>{
 const {withUpdatedNisaCardRule,nisaRuleOnDay}=await import('../dist/src/cloud/assets.js');
 const {encryptAssets,decryptAssets,deriveCloudKey}=await import('../dist/src/cloud/cloud-crypto.js');
 const original=nisaData(),next=withUpdatedNisaCardRule(original,{...nisaRule,bankFunding:sameFunding},'2026-11-22');
 assert.equal(next.format,'finance-assets-v3');assert.equal(nisaRuleOnDay(next,'2026-11-22').bankFunding,undefined);
 assert.deepEqual(nisaRuleOnDay(next,'2026-11-23').bankFunding,sameFunding);
 assert.equal(forecastAssets(next,'2026-11-30',[nisaRecord()]).nisa.balance,520000);
 assert.equal(validateAssets(original).format,'finance-assets-v1');
 assert.throws(()=>validateAssets({...next,format:'finance-assets-v1'}),/保存形式/);
 const salt='AAAAAAAAAAAAAAAAAAAAAA==',key=await deriveCloudKey('synthetic integration passphrase',salt);
 const encrypted=await encryptAssets(next,key,salt);assert.ok(!encrypted.includes(nisaTransfer.id));
 assert.deepEqual((await decryptAssets(encrypted,key,salt)).nisaCardRule.bankFunding,sameFunding);
 const later={...next,snapshots:[...next.snapshots,snap('new-nisa-snapshot','nisa',520000,'2026-11-24T12:00:00Z')]};
 assert.equal(forecastAssets(later,'2026-11-30',[nisaRecord()]).nisa.balance,520000);
});
test('H301: an ambiguous recurring/one-off match cannot suppress a bank movement; NISA withdrawal stays intact',()=>{
 const data=nisaData(sameFunding),records=[nisaRecord()];
 const once={id:'nisa-once-test',name:nisaTransfer.name,amount:20000,kind:'transfer',date:'2026-11-25',fromAccountId:'rakuten-bank',toAccountId:'nisa',status:'done'};
 data.oneTime=[once,{...once,id:'nisa-once-other'},{...once,id:'nisa-withdrawal',fromAccountId:'nisa',toAccountId:'rakuten-bank',amount:5000,date:'2026-11-26'}];
 const r=forecastAssets(data,'2026-11-30',records);
 assert.equal(r.nisa.cardNisaDelta,20000);assert.equal(r.nisa.recurringDelta,20000);assert.equal(r.nisa.oneTimeDelta,35000);
 assert.ok(r.nisa.nisaOverlap.count>=2);assert.equal(r['rakuten-bank'].oneTimeDelta,-35000);
});
test('H301: a future-use card row cannot suppress a prior scheduled movement in a historical forecast',()=>{
 const data=nisaData(sameFunding);data.recurring=[{...nisaTransfer,dayOfMonth:20}];
 const r=forecastAssets(data,'2026-11-22',[nisaRecord()],[],null,undefined,'2026-11-30');
 assert.equal(r.nisa.balance,520000);assert.equal(r.nisa.cardNisaDelta,0);assert.equal(r.nisa.recurringDelta,20000);
});
test('H301: relationship-only edits do not erase the card contribution sample for long-term estimates',async()=>{
 const {withUpdatedNisaCardRule}=await import('../dist/src/cloud/assets.js');
 const {suggestedNisaMonthly}=await import('../dist/src/cloud/future-projection.js');
 const data=nisaData(),changed=withUpdatedNisaCardRule(data,{...nisaRule,bankFunding:independentFunding},'2026-11-29');
 assert.equal(suggestedNisaMonthly(changed,[nisaRecord()],'2026-11-30').amount,20000);
});

test('INT3-02: summary and historical reconciliation share the NISA matching result',async()=>{
 const {monthlyReport,prepareMonthlyReports}=await import('../dist/src/summary/monthly-summary.js');
 const {reportSnapshot}=await import('../dist/src/reports/monthly-report.js');
 const {reconcileBalance}=await import('../dist/src/cloud/balance-reconciliation.js');
 const assets=nisaData(sameFunding),records=[nisaRecord()];
 const once={id:'nisa-once-test',name:nisaTransfer.name,amount:20000,kind:'transfer',date:'2026-11-25',fromAccountId:'rakuten-bank',toAccountId:'nisa',status:'planned'};
 assets.oneTime=[once];assets.snapshots.push(snap('next-bank','rakuten-bank',180000,'2026-11-30T12:00:00Z'));
 const source=sourceFor(assets,records),prepared=prepareMonthlyReports(records),before=JSON.stringify(assets);
 const report=monthlyReport('2026-11',source,prepared);
 assert.equal(report.cardOutflow,20000);assert.equal(report.nisaOutflow,20000);assert.equal(report.recurringTransfers,0);assert.equal(report.oneTimeLines.length,0);assert.equal(report.pastUnconfirmedOneTime,0);
 assert.equal(reconcileBalance(assets,'rakuten-bank',records,[],null,false,'2026-11-30').provisionalEntries,0);
 const unknown={...assets,nisaCardRule:nisaRule};
 const ambiguous=monthlyReport('2026-11',sourceFor(unknown,records),prepared);
 assert.equal(ambiguous.nisaOverlapCount,1);assert.equal(ambiguous.cardOutflow,20000);assert.ok(reportSnapshot('2026-11',sourceFor(unknown,records)).quality.some(x=>x.includes('NISA積立と銀行振替')));
 const done={...assets,oneTime:[{...once,status:'done'}]};
 const actual=monthlyReport('2026-11',sourceFor(done,records),prepared);
 assert.equal(actual.oneTimeLines.length,1);assert.equal(actual.oneTimeLines[0].status,'done');assert.equal(actual.nisaOverlapCount,1);
 assert.equal(JSON.stringify(assets),before);
});

test('H301: linked NISA occurrences across month boundary remain visible as candidates, not automatic matches',async()=>{
 const {reconcileNisaMovements}=await import('../dist/src/cloud/nisa-movements.js');
 const data=nisaData(sameFunding);data.recurring=[{...nisaTransfer,startOn:'2026-12-01',dayOfMonth:1}];
 const rows=[{date:'2026-11-30',amount:20000,recordId:'card-nov',rowId:'row-nov'}];
 const future=reconcileNisaMovements(data,rows,'2026-11-30');assert.equal(future.ambiguous.length,0);
 const due=reconcileNisaMovements(data,rows,'2026-12-02');assert.equal(due.ambiguous.length,1);assert.equal(due.ambiguous[0].date,'2026-12-01');assert.equal(due.excludesRecurring(nisaTransfer.id,'2026-12-01'),false);
 const nextRows=[...rows,{date:'2026-12-02',amount:20000,recordId:'card-dec',rowId:'row-dec'}];
 const matched=reconcileNisaMovements(data,nextRows,'2026-12-02');assert.equal(matched.ambiguous.length,0);assert.equal(matched.excludesRecurring(nisaTransfer.id,'2026-12-01'),true);
});
