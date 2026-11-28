import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyAssets, validateAssets, validateNisaRuleHistory, withUpdatedNisaCardRule,
  nisaRuleOnDay, mergeAssets, detectAssetsEditCollisions,
} from '../dist/src/cloud/assets.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {matchingNisaRows,forecastAssets} from '../dist/src/cloud/asset-projection.js';
import {detectCardSubscriptions} from '../dist/src/subscriptions/detect.js';
import {webcrypto} from 'node:crypto';
import {encryptAssets,decryptAssets,deriveCloudKey,freshSalt} from '../dist/src/cloud/cloud-crypto.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

const oldRule={cardId:'smbc-nl',merchantContains:'RAKUTEN SECURITIES',enabled:true};
const nextRule={cardId:'amazon',merchantContains:'INVEST',enabled:true};
const row=(id,usedOn,merchant,amount)=>({id,usedOn,merchant,amount});
const statement=(id,cardId,billingMonth,paymentDate,rows)=>({id,statement:{
  provider:'smbc',cardId,sourceKind:'paste',sourceName:'nisa-fixture',billingMonth,paymentDate,
  statedTotal:rows.reduce((sum,r)=>sum+r.amount,0),confirmation:'confirmed',warnings:[],rows,
}});
const records=[
  statement('old','smbc-nl','2026-10','2026-11-27',[
    row('a','2026-10-09','RAKUTEN SECURITIES',10000),
    row('b','2026-10-10','REGULAR SHOP',1000),
  ]),
  statement('other','amazon','2026-09','2026-10-27',[row('other-old','2026-09-15','INVEST',2000)]),
  statement('new','amazon','2026-11','2026-12-27',[row('new-row','2026-11-23','INVEST',20000)]),
];
const source=(assets,items=records)=>({records:items,rules:[],categories:[],assets,
  payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'});

test('changing NISA card and merchant keeps past transactions classified with the old rule',()=>{
  const initial={...emptyAssets(),nisaCardRule:oldRule};
  const before=monthlyReport('2026-11',source(initial));
  assert.equal(before.nisaOutflow,10000);
  const updated=withUpdatedNisaCardRule(initial,nextRule,'2026-11-21');
  assert.deepEqual(updated.nisaCardRuleHistory,[{effectiveOn:'2026-11-22',previous:oldRule}]);
  assert.equal(monthlyReport('2026-11',source(updated)).nisaOutflow,10000);
  assert.equal(monthlyReport('2026-12',source(updated)).nisaOutflow,20000);
  assert.equal(monthlyReport('2026-10',source(updated)).nisaOutflow,0,'past Amazon purchase is not retroactively NISA');
  assert.equal(monthlyReport('2026-11',source(updated)).cardOutflow,before.cardOutflow);
  assert.equal(monthlyReport('2026-11',source(updated)).livingOutflow,before.livingOutflow);
  assert.equal(initial.nisaCardRuleHistory,undefined,'read-only update does not mutate existing assets');
});

test('unlinking NISA preserves historical contributions, while future purchases stop matching',()=>{
  const initial={...emptyAssets(),nisaCardRule:oldRule};
  const unlinked=withUpdatedNisaCardRule(initial,null,'2026-11-21');
  assert.equal(unlinked.nisaCardRule,null);
  assert.equal(nisaRuleOnDay(unlinked,'2026-11-21')?.cardId,'smbc-nl');
  assert.equal(nisaRuleOnDay(unlinked,'2026-11-22'),null);
  assert.equal(monthlyReport('2026-11',source(unlinked)).nisaOutflow,10000);
  assert.equal(matchingNisaRows(unlinked,records).length,1);
});

test('multiple changes on same day cannot rewrite the frozen past, later changes create another period',()=>{
  const initial={...emptyAssets(),nisaCardRule:oldRule};
  const interim=withUpdatedNisaCardRule(initial,nextRule,'2026-11-21');
  const thirdRule={...nextRule,merchantContains:'FUND'};
  const sameDay=withUpdatedNisaCardRule(interim,thirdRule,'2026-11-21');
  assert.equal(sameDay.nisaCardRuleHistory.length,1);
  assert.deepEqual(nisaRuleOnDay(sameDay,'2026-11-21'),oldRule);
  assert.deepEqual(nisaRuleOnDay(sameDay,'2026-11-22'),thirdRule);
  const nextDay=withUpdatedNisaCardRule(sameDay,nextRule,'2026-11-22');
  assert.deepEqual(nextDay.nisaCardRuleHistory.map(x=>x.effectiveOn),['2026-11-22','2026-11-23']);
  assert.deepEqual(nisaRuleOnDay(nextDay,'2026-11-22'),thirdRule);
  assert.deepEqual(nisaRuleOnDay(nextDay,'2026-11-23'),nextRule);
  assert.throws(()=>withUpdatedNisaCardRule(nextDay,oldRule,'2026-11-20'),/日付/);
});

test('legacy first-time NISA registration backfills old imported records',()=>{
  const doc=emptyAssets();
  const first=withUpdatedNisaCardRule(doc,oldRule,'2026-11-21');
  assert.equal(first.nisaCardRuleHistory,undefined);
  assert.equal(monthlyReport('2026-11',source(first)).nisaOutflow,10000);
  assert.deepEqual(validateAssets(first).nisaCardRule,oldRule);
  assert.equal(nisaRuleOnDay(doc,'2026-10-01'),null);
});

test('NISA asset forecast and historical principal retain contributions after unlink or card switch',()=>{
  const assets=withUpdatedNisaCardRule({...emptyAssets(),nisaCardRule:oldRule},nextRule,'2026-11-21');
  assets.snapshots=[{id:'nisa-balance-one',accountId:'nisa',balance:500000,observedAt:'2026-09-01T00:00:00Z'}];
  assert.deepEqual(matchingNisaRows(assets,records).map(r=>r.amount),[10000,20000]);
  const projected=forecastAssets(assets,'2026-12-30',records);
  assert.equal(projected.nisa.cardNisaDelta,30000);
  assert.equal(projected.nisa.balance,530000);
  const unlinked=withUpdatedNisaCardRule(assets,null,'2026-12-31');
  assert.equal(forecastAssets(unlinked,'2026-12-30',records).nisa.balance,530000);
});

test('subscription suggestions honor historical NISA classification after merchant changes',()=>{
  const assets=withUpdatedNisaCardRule({...emptyAssets(),nisaCardRule:oldRule},nextRule,'2026-11-21');
  const charges=['2026-07','2026-08','2026-09','2026-10'].map((month,i)=>
    statement(`sub-${i}`,'smbc-nl',month,`${month}-27`,[row(`subrow-${i}`,`${month}-09`,'RAKUTEN SECURITIES',10000)]));
  assert.deepEqual(detectCardSubscriptions(source(assets,charges),'2026-11'),[]);
});

test('NISA rule/history are one atomic merge field, independent asset changes preserve both',()=>{
  const base={...emptyAssets(),nisaCardRule:oldRule};
  const left=withUpdatedNisaCardRule(base,nextRule,'2026-11-21');
  const right=structuredClone(base);
  right.snapshots=[{id:'nisa-balance-one',accountId:'nisa',balance:10000,observedAt:'2026-11-01T00:00:00Z'}];
  assert.deepEqual(detectAssetsEditCollisions(base,left,right),[]);
  const merged=mergeAssets(base,left,right);
  assert.deepEqual(merged.nisaCardRule,nextRule);
  assert.equal(merged.nisaCardRuleHistory.length,1);
  assert.equal(merged.snapshots.length,1);
  const collision=withUpdatedNisaCardRule(base,null,'2026-11-21');
  assert.deepEqual(detectAssetsEditCollisions(base,left,collision),[{itemId:'nisa-card-rule',field:'nisaCardRule'}]);
  const preferred=mergeAssets(base,left,collision);
  assert.deepEqual(preferred.nisaCardRuleHistory,left.nisaCardRuleHistory);
});

test('NISA timeline validates dates, order and size without silently dropping records',()=>{
  const good=[{effectiveOn:'2026-11-22',previous:oldRule}];
  assert.deepEqual(validateNisaRuleHistory(good),good);
  for(const invalid of [null,{},[{effectiveOn:'2026-11-99',previous:oldRule}],
    [...good,...good],[{effectiveOn:'2026-11-22',previous:{...oldRule,merchantContains:''}}],
    Array.from({length:513},(_,i)=>({effectiveOn:'2026-11-22',previous:null}))]){
    assert.throws(()=>validateAssets({...emptyAssets(),nisaCardRuleHistory:invalid}));
  }
});

test('history remains encrypted at rest and survives decrypt/revalidate',async()=>{
  const doc=withUpdatedNisaCardRule({...emptyAssets(),nisaCardRule:oldRule},nextRule,'2026-11-21');
  const salt=freshSalt(),key=await deriveCloudKey('long and private NISA test secret',salt);
  const encrypted=await encryptAssets(doc,key,salt);
  assert.equal(encrypted.includes('RAKUTEN SECURITIES'),false);
  assert.equal(encrypted.includes('INVEST'),false);
  assert.deepEqual(await decryptAssets(encrypted,key,salt),doc);
});

test('H02: duplicate IDs, duplicate bills and invalid or provisional records never contribute to NISA assets',()=>{
 const assets={...emptyAssets(),nisaCardRule:oldRule};
 const original=statement('normal','smbc-nl','2026-10','2026-11-27',[row('x','2026-10-09','RAKUTEN SECURITIES',30000)]);
 assert.equal(matchingNisaRows(assets,[original])[0].amount,30000);
 const other={...structuredClone(original),id:'duplicate'};
 assert.deepEqual(matchingNisaRows(assets,[original,other]),[]);
 assert.equal(monthlyReport('2026-11',source(assets,[original,other])).cardOutflow,null);
 assert.equal(matchingNisaRows(assets,[original]).length,1);
 const across=structuredClone(original);across.statement.billingMonth='2026-11';across.statement.paymentDate='2026-12-27';
 assert.deepEqual(matchingNisaRows(assets,[original,across]),[]);
 for(const mutate of [s=>s.confirmation='provisional',s=>s.confirmation='unknown',s=>s.statedTotal++,s=>s.paymentDate='2026-02-30',s=>s.sourceKind='pdf',s=>{s.rows.push({...s.rows[0]});s.statedTotal*=2;},s=>s.provider='rakuten']){
  const bad=structuredClone(original);mutate(bad.statement);assert.deepEqual(matchingNisaRows(assets,[bad]),[]);
 }
});
