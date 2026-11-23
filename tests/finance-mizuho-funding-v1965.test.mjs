import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyAssets,validateAssets,detectAssetsEditCollisions,mergeAssets} from '../dist/src/cloud/assets.js';
import {mizuhoFundingStatus,mizuhoFundingDescription} from '../dist/src/home/mizuho-funding.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {forecastAccounts} from '../dist/src/home/account-events.js';
const read=p=>readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
const check=(done,updatedAt='2026-11-23T04:00:00.000Z')=>({done,updatedAt});
const assets=()=>({...emptyAssets(),mizuhoTransferPlan:{enabled:true,leadDays:3,extraForSmallBills:true},
  cardDebitAccounts:{'rakuten-mizuho':'mizuho-bank'}});
const source=(a=assets())=>({assets:a});
const report=(entries=[{cardId:'rakuten-mizuho',paymentDate:'2026-11-27',amount:24245,confirmation:'confirmed'}])=>({period:'2026-11',cardLines:entries});

test('legacy vaults omit optional manual transfer checks; malformed or oversized checks are rejected',()=>{
  const old=validateAssets(assets());assert.equal(old.mizuhoFundingChecks,undefined);
  const valid=validateAssets({...assets(),mizuhoFundingChecks:{'2026-11':check(true)}});
  assert.equal(valid.mizuhoFundingChecks['2026-11'].done,true);
  for(const bad of [null,[],{'2026-00':check(true)},{'2026-11':{done:'yes',updatedAt:check(true).updatedAt}},
    {'2026-11':check(true,'bad')},Object.fromEntries(Array.from({length:241},(_,i)=>[`${1900+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,check(true)])),
    JSON.parse('{"__proto__":{"done":true,"updatedAt":"2026-11-23T04:00:00.000Z"}}')])
    assert.throws(()=>validateAssets({...assets(),mizuhoFundingChecks:bad}),/送金確認/);
});

test('separate months merge, same-month opposite edits are detected, and unrelated asset changes persist',()=>{
  const base=validateAssets(assets());
  const a=validateAssets({...base,mizuhoFundingChecks:{'2026-11':check(true)}});
  const b=validateAssets({...base,mizuhoFundingChecks:{'2026-10':check(true)},birthMonth:'2003-01'});
  const merged=mergeAssets(base,a,b);
  assert.deepEqual(Object.keys(merged.mizuhoFundingChecks).sort(),['2026-10','2026-11']);
  assert.equal(merged.birthMonth,'2003-01');
  assert.deepEqual(detectAssetsEditCollisions(base,a,b),[]);
  const old=validateAssets({...base,mizuhoFundingChecks:{'2026-11':check(false,'2026-11-20T00:00:00.000Z')}});
  const local=validateAssets({...old,mizuhoFundingChecks:{'2026-11':check(true,'2026-11-23T00:00:00.000Z')}});
  const remote=validateAssets({...old,mizuhoFundingChecks:{'2026-11':check(true,'2026-11-22T00:00:00.000Z')}});
  assert.deepEqual(detectAssetsEditCollisions(old,local,remote),[{itemId:'mizuho-funding',field:'2026-11'}]);
  assert.equal(mergeAssets(old,local,remote).mizuhoFundingChecks['2026-11'].updatedAt,'2026-11-23T00:00:00.000Z');
});

test('the 12th opens confirmation; the saved payment date and configured lead days determine deadline',()=>{
  const before=mizuhoFundingStatus(source(),report(),'2026-11-11');
  assert.equal(before.periodOpen,false);assert.equal(before.dueDate,'2026-11-24');assert.equal(before.amount,30000);
  const opens=mizuhoFundingStatus(source(),report(),'2026-11-12');
  assert.equal(opens.periodOpen,true);assert.equal(opens.overdue,false);
  assert.equal(mizuhoFundingStatus(source(),report(),'2026-11-24').overdue,false);
  const late=mizuhoFundingStatus(source(),report(),'2026-11-25');
  assert.equal(late.overdue,true);assert.match(mizuhoFundingDescription(late),/期限/);
  const done=mizuhoFundingStatus(source({...assets(),mizuhoFundingChecks:{'2026-11':check(true)}}),report(),'2026-11-25');
  assert.equal(done.completed,true);assert.equal(done.overdue,false);
  assert.equal(mizuhoFundingStatus(source({...assets(),mizuhoFundingChecks:{'2026-10':check(true)}}),report(),'2026-11-25').completed,false);
});

test('unknown and provisional bills never become confirmed bank transfers or invented deadlines',()=>{
  const noBill=mizuhoFundingStatus(source(),report([]),'2026-11-23');
  assert.equal(noBill.dueDate,null);assert.equal(noBill.amount,null);assert.equal(noBill.completed,false);
  const provisional=mizuhoFundingStatus(source(),report([{cardId:'rakuten-mizuho',paymentDate:'2026-11-27',amount:50000,confirmation:'provisional'}]),'2026-11-23');
  assert.equal(provisional.billConfirmed,false);
  assert.equal(mizuhoFundingStatus(source({...assets(),mizuhoTransferPlan:{enabled:false,leadDays:3,extraForSmallBills:true}}),report(),'2026-11-23'),null);
  assert.equal(mizuhoFundingStatus(source({...assets(),cardDebitAccounts:{}}),report(),'2026-11-23'),null);
});

test('confirming a month does not create bank movement, card charge, income or household expense',()=>{
  const base={records:[],rules:[],categories:[],assets:assets(),payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'};
  const marked={...base,assets:{...base.assets,mizuhoFundingChecks:{'2026-11':check(true)}}};
  assert.deepEqual(monthlyReport('2026-11',base),monthlyReport('2026-11',marked));
  assert.deepEqual(forecastAccounts(base,'2026-11-23'),forecastAccounts(marked,'2026-11-23'));
});

test('UI cannot mark confirmation as a balance, expense or card funding entry',()=>{
  const file=read('src/ui/home.ts');
  const vault=read('src/cloud/live-vault.ts');
  const assetsSource=read('src/cloud/assets.ts');
  const css=read('public/styles/home-v171.css');
  const fixed=read('public/styles/fixed-costs-v1960.css');
  assert.match(file,/mizuhoFundingStatus\(source,report,model\.today\)/);
  assert.match(file,/saveMizuhoFunding!\(/);
  assert.match(vault,/next\.mizuhoFundingChecks=/);
  assert.match(vault,/await this\.commitAssets\(next\)/);
  assert.match(assetsSource,/sameEdit\('mizuho-funding'/);
  assert.match(css,/home-funding/);
  assert.match(fixed,/\.fixed-cost-guidance\{/);
  assert.match(read('src/ui/subscriptions.ts'),/subscriptions-muted fixed-cost-guidance/);
});
