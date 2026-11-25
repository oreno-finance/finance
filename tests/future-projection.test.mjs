import test from 'node:test';
import assert from 'node:assert/strict';
import {currentSavingMonthly,futureProjection,suggestedNisaMonthly,targetMonthForAge} from '../dist/src/cloud/future-projection.js';
import {canonicalStatementFilename} from '../dist/src/ui/statement-filename.js';
import {emptyAssets,withUpdatedNisaCardRule} from '../dist/src/cloud/assets.js';
import {matchingNisaRows,forecastAssets} from '../dist/src/cloud/asset-projection.js';

const clone=o=>structuredClone(o);
const now='2026-11-17';
const saved=(id,amount)=>({id:id+'-snap001',accountId:id,balance:amount,observedAt:'2026-11-01T12:00:00+09:00'});
const deposit=(name='現金貯金への振替',amount=10000)=>({id:'cash-transfer-001',name,amount,kind:'transfer',fromAccountId:'rakuten-bank',toAccountId:'cash-savings',frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true});
const base=()=>{
  const doc=emptyAssets();
  doc.snapshots=[saved('cash-savings',50000),saved('nisa',100000)];
  doc.recurring=[deposit()];
  return doc;
};
const options={today:now,targetMonth:'2027-01',changeMonth:'2026-12',savingsRuleId:'cash-transfer-001',savingsAmount:20000,nisaMonthly:20000,nisaAnnualReturn:0};

test('future scheduled savings are included in current month and future months',()=>{
  const r=futureProjection(base(),[],options);
  assert.equal(r.target.cash,80000);
  assert.equal(r.target.cashScenario,100000);
  assert.equal(r.target.nisa,140000);
  assert.equal(r.target.combined,220000);
  assert.equal(r.target.combinedScenario,240000);
});
test('scenario changes only after chosen month',()=>{
  const r=futureProjection(base(),[],{...options,changeMonth:'2027-01'});
  assert.equal(r.target.cash,80000);assert.equal(r.target.cashScenario,90000);
});
test('no selected rule makes scenario identical to baseline',()=>{
  const r=futureProjection(base(),[],{...options,savingsRuleId:null});
  assert.equal(r.target.cash,r.target.cashScenario);
});
test('year boundary and target month are inclusive',()=>{
  const r=futureProjection(base(),[],{...options,targetMonth:'2026-12'});
  assert.deepEqual(r.points.map(p=>p.month),['2026-11','2026-12']);
  assert.equal(r.target.cash,70000);
});
test('disabled and expired scheduled transfers do not apply',()=>{
  const d=base();d.recurring[0].endOn='2026-11-18';
  const r=futureProjection(d,[],{...options,savingsRuleId:null});
  assert.equal(r.target.cash,50000);
});
test('NISA annual return is compounded monthly and changes neither cash variant',()=>{
  const zero=futureProjection(base(),[],options);
  const withReturn=futureProjection(base(),[],{...options,nisaAnnualReturn:0.05});
  assert.equal(withReturn.target.cash,zero.target.cash);
  assert.equal(withReturn.target.cashScenario,zero.target.cashScenario);
  assert.ok(withReturn.target.nisa>zero.target.nisa);
});
test('zero growth and no future NISA cards keep the registered valuation',()=>{
  const r=futureProjection(base(),[],{...options,nisaMonthly:0});
  assert.equal(r.target.nisa,100000);
});
test('recurring NISA transfers exclude additional inferred card deposits',()=>{
  const d=base();d.recurring.push({...deposit('NISA積立',15000),id:'nisa-transfer-001',toAccountId:'nisa'});
  const r=futureProjection(d,[],{...options,nisaMonthly:0});
  assert.equal(r.hasNisaSchedule,true);
  assert.equal(r.target.nisa,145000);
  const both=futureProjection(d,[],options);
  assert.equal(both.target.nisa,r.target.nisa);
  assert.equal(both.conflictingNisaSources,true);
});
test('missing confirmed snapshots stay missing, not zero',()=>{
  const d=base();d.snapshots=d.snapshots.filter(v=>v.accountId!=='nisa');
  const r=futureProjection(d,[],options);
  assert.equal(r.target.nisa,null);assert.equal(r.target.combined,null);
  assert.equal(r.target.cashScenario,100000);
});
test('cash savings expenses and withdrawals reduce expected balance',()=>{
  const d=base();d.recurring.push({...deposit('貯金から支払',5000),id:'cash-expense-001',kind:'expense',fromAccountId:'cash-savings',toAccountId:null});
  const r=futureProjection(d,[],{...options,savingsRuleId:null});
  assert.equal(r.target.cash,65000);
});
test('age target uses actual birth month and never guesses day',()=>{
  assert.equal(targetMonthForAge('2003-05',40),'2043-05');
  assert.equal(targetMonthForAge('2003-05',0),null);
  assert.equal(targetMonthForAge('2003-13',40),null);
});
test('bad target dates and negative amounts fail closed',()=>{
  assert.throws(()=>futureProjection(base(),[],{...options,targetMonth:'2026-10'}),/不正/);
  assert.throws(()=>futureProjection(base(),[],{...options,savingsAmount:-1}),/不正/);
  assert.throws(()=>futureProjection(base(),[],{...options,nisaAnnualReturn:0.4}),/不正/);
});
test('name is standardized independently of issuer-provided sourceName',()=>{
  const statement={cardId:'rakuten-mizuho',billingMonth:'2026-11',paymentDate:'2026-11-27',sourceName:'download (3).pdf'};
  assert.equal(canonicalStatementFilename(statement),'202611_みずほ楽天カード_明細.pdf');
  assert.equal(canonicalStatementFilename(statement,'12345678-1234-1234-1234-123456789abc'),'202611_みずほ楽天カード_明細.pdf');
});
test('unknown cards generate safe filename and valid date fallback',()=>{
  const statement={cardId:null,billingMonth:null,paymentDate:'2026-12-10',sourceName:'../../secret'};
  assert.equal(canonicalStatementFilename(statement),'202612_カード種別未設定_明細.pdf');
});
test('latest matching NISA card month can seed an editable assumption',()=>{
  const d=base();d.nisaCardRule={cardId:'rakuten-mizuho',merchantContains:'楽天証券',enabled:true};
  const records=[{id:'card-1',statement:{cardId:'rakuten-mizuho',rows:[{id:'row-1',usedOn:'2026-10-20',merchant:'楽天証券',amount:20000}]}}];
  const suggested=suggestedNisaMonthly(d,records,now);
  assert.equal(suggested.amount,20000);
});
test('old card samples are not projected forever',()=>{
  const d=base();d.nisaCardRule={cardId:'rakuten-mizuho',merchantContains:'楽天証券',enabled:true};
  const records=[{id:'card-1',statement:{cardId:'rakuten-mizuho',rows:[{id:'row-1',usedOn:'2025-01-20',merchant:'楽天証券',amount:20000}]}}];
  assert.equal(suggestedNisaMonthly(d,records,now).amount,0);
});

const cardRule={cardId:'rakuten-mizuho',merchantContains:'Synthetic investment',enabled:true};
const cardSample=(date,amount=20000,id='row-1')=>({id,statement:{cardId:cardRule.cardId,rows:[{id:'sample',usedOn:date,merchant:cardRule.merchantContains,amount}]}});
const nisaDeposit=(overrides={})=>({...deposit('Synthetic recurring NISA',15000),id:'nisa-transfer-001',toAccountId:'nisa',...overrides});

test('expired bank NISA schedule does not suppress current card contributions or hint',()=>{
  const d=base();d.nisaCardRule=cardRule;d.recurring.push(nisaDeposit({endOn:'2026-10-31'}));
  const records=[cardSample('2026-10-20')];
  const amount=suggestedNisaMonthly(d,records,now).amount;
  assert.equal(amount,20000);
  const r=futureProjection(d,records,{...options,nisaMonthly:amount});
  assert.equal(r.hasNisaSchedule,false);assert.equal(r.conflictingNisaSources,false);
  assert.equal(r.target.nisa,140000);assert.equal(r.target.nisaScenario,r.target.nisa);
  assert.deepEqual(currentSavingMonthly(d,now,amount),{cash:10000,nisa:20000});
});
test('bank schedule only takes precedence in overlapping months; scenario replaces principal once',()=>{
  const d=base();d.nisaCardRule=cardRule;d.recurring.push(nisaDeposit({startOn:'2027-01-01',endOn:'2027-02-28'}));
  const r=futureProjection(d,[],{...options,targetMonth:'2027-03',nisaScenarioMonthly:30000,changeMonth:'2027-02'});
  assert.deepEqual(r.points.map(p=>p.nisa),[100000,120000,135000,150000,170000]);
  assert.deepEqual(r.points.map(p=>p.nisaScenario),[100000,120000,135000,165000,195000]);
  assert.equal(r.conflictingNisaSources,true);
  assert.equal(currentSavingMonthly(d,now,20000).nisa,20000);
  assert.equal(currentSavingMonthly(d,'2027-01-01',20000).nisa,15000);
  assert.equal(currentSavingMonthly(d,'2027-02-28',20000).nisa,15000);
  assert.equal(currentSavingMonthly(d,'2027-03-01',20000).nisa,20000);
});
test('non-payment and paused months of an active bank schedule do not start card deposits',()=>{
  const d=base();d.recurring.push(nisaDeposit({frequency:'yearly',monthOfYear:1,pauses:[{startOn:'2026-12-01',endOn:'2026-12-31'}]}));
  const r=futureProjection(d,[],{...options,targetMonth:'2027-02'});
  assert.deepEqual(r.points.map(p=>p.nisa),[100000,100000,115000,115000]);
  assert.equal(currentSavingMonthly(d,'2026-12-15',20000).nisa,0);
  assert.equal(currentSavingMonthly(d,'2027-01-01',20000).nisa,1250);
});
test('monthly pace excludes disabled, future, expired and paused entries and uses effective pricing',()=>{
  const d=base();d.recurring=[
    {...deposit(),amount:24000,pricing:[{effectiveOn:'2026-01-01',amount:12000},{effectiveOn:'2026-12-01',amount:24000}]},
    {...deposit(),id:'future',startOn:'2027-01-01'},
    {...deposit(),id:'ended',endOn:'2026-11-16'},
    {...deposit(),id:'disabled',enabled:false},
    {...deposit(),id:'paused',pauses:[{startOn:'2026-11-17',endOn:null}]},
    nisaDeposit({amount:30000,pricing:[{effectiveOn:'2026-01-01',amount:15000},{effectiveOn:'2026-12-01',amount:30000}]})];
  assert.deepEqual(currentSavingMonthly(d,now,20000),{cash:12000,nisa:15000});
  assert.deepEqual(currentSavingMonthly(d,'2026-12-01',20000),{cash:24000,nisa:30000});
});
test('disabled or removed card rule preserves historical contributions but stops future inference',()=>{
  const d=base();d.nisaCardRule=cardRule;
  const records=[cardSample('2026-11-10')];
  const history=matchingNisaRows(d,records);assert.equal(history.length,1);
  for(const rule of [null,{...cardRule,enabled:false}]){
    const changed=withUpdatedNisaCardRule(d,rule,now);
    const matched=matchingNisaRows(changed,records);
    assert.deepEqual(matched,history);
    assert.equal(forecastAssets(changed,now,records,[],null,matched).nisa.balance,120000);
    assert.equal(suggestedNisaMonthly(changed,records,now,matched).amount,0);
    assert.equal(suggestedNisaMonthly(changed,records,'2026-11-18').amount,0);
    assert.equal(futureProjection(changed,records,{...options,nisaMonthly:suggestedNisaMonthly(changed,records,now,matched).amount},matched).target.nisa,120000);
  }
});
test('changed or re-enabled card rule only infers from its current effective period',()=>{
  const d=base();d.nisaCardRule=cardRule;
  const records=[cardSample('2026-11-10'),cardSample('2026-11-18',30000,'row-2')];
  const removed=withUpdatedNisaCardRule(d,null,'2026-11-12');
  const enabled=withUpdatedNisaCardRule(removed,cardRule,'2026-11-17');
  assert.equal(suggestedNisaMonthly(enabled,records,'2026-11-17').amount,0);
  const matches=matchingNisaRows(enabled,records);assert.equal(matches.length,2);
  assert.equal(suggestedNisaMonthly(enabled,records,'2026-11-18',matches).amount,30000);
  const other=withUpdatedNisaCardRule(d,{...cardRule,merchantContains:'Other investment'},now);
  assert.equal(suggestedNisaMonthly(other,records,'2026-11-18').amount,0);
});
