import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyAssets} from '../dist/src/cloud/assets.js';
import {emptyRules,validateRules,mergeRules} from '../dist/src/cloud/merchant-rules.js';
import {encryptRules,decryptRules,freshSalt,deriveCloudKey} from '../dist/src/cloud/cloud-crypto.js';
import {fixedCostRuleViews,fixedCostCalculationAssets,prepareCardFixedRule,editRuleFixedDraft,latestFixedEvidence} from '../dist/src/fixed-costs/rule-fixed-costs.js';
import {detectCardSubscriptions,pendingCardSubscriptions} from '../dist/src/subscriptions/detect.js';
import {estimatedCardFixedBills} from '../dist/src/cloud/card-fixed-estimates.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
const today='2026-11-26';
const record=(p,amount=1490,cardId='smbc-nl',confirmation='confirmed',merchant='SERVICE')=>({id:`${p}-${cardId}`,statement:{provider:'smbc',cardId,sourceKind:'paste',sourceName:'synthetic',billingMonth:p,paymentDate:`${p}-27`,statedTotal:amount,confirmation,warnings:[],rows:[{id:`row-${p}-${cardId}`,usedOn:`${p}-01`,merchant,amount}]}});
const rule=(extra={})=>({id:'synthetic-rule',pattern:'SERVICE',mode:'exact',displayName:'Service',cardId:'smbc-nl',enabled:true,priority:100,categoryId:null,fixedCost:{frequency:'monthly',state:'active',startOn:'2026-08-01'},...extra});
const source=(records=[],rules=[],assets=emptyAssets(),fixedCostMigrations=[])=>({records,rules,assets,fixedCostMigrations,categories:[],payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'});
const legacy={id:'synthetic-legacy',name:'Service',payment:'card',cardId:'smbc-nl',merchantKey:'smbc-nl|service',categoryId:null,frequency:'monthly',dayOfMonth:1,monthOfYear:null,weekday:null,startOn:'2026-08-01',endOn:null,amount:1200,priceKind:'fixed',pricing:[{effectiveOn:'2026-08-01',amount:1200}],pauses:[],note:'',updatedAt:'2026-08-01T00:00:00Z'};
test('fixed cost is independent of category and updates from latest confirmed actual without changing accounting',()=>{
  const records=[record('2026-09',1500),record('2026-10',2000),record('2026-11',2500)];
  const base=source(records),withRule=source(records,[rule()]);
  assert.equal(fixedCostRuleViews(withRule,today)[0].charge.amount,2500);
  assert.equal(fixedCostRuleViews(withRule,today)[0].categoryId,null);
  assert.equal(fixedCostRuleViews(source(records,[rule({fixedCost:undefined,categoryId:'fixed'})]),today).length,0);
  assert.equal(fixedCostCalculationAssets(withRule,today).fixedCosts[0].amount,2500);
  assert.equal(withRule.assets.fixedCosts?.length??0,0);
  assert.equal(monthlyReport('2026-10',base).cardOutflow,monthlyReport('2026-10',withRule).cardOutflow);
});
test('provisional, refunds, multiple latest rows and missing evidence never create a new price',()=>{
  assert.equal(fixedCostRuleViews(source([record('2026-10',1500),record('2026-11',2500,'smbc-nl','provisional')],[rule()]),today)[0].charge.amount,1500);
  const refund=record('2026-11',-2500);
  assert.equal(fixedCostRuleViews(source([record('2026-10',1500),refund],[rule()]),today)[0].charge,null);
  const ambiguous=record('2026-11',3000);ambiguous.statement.rows[0].amount=1500;ambiguous.statement.rows.push({...ambiguous.statement.rows[0],id:'second',usedOn:'2026-11-02'});
  assert.equal(fixedCostRuleViews(source([ambiguous],[rule()]),today)[0].charge,null);
  assert.equal(fixedCostCalculationAssets(source([],[rule()]),today).fixedCosts.length,0);
});
test('candidate inherits category and uses same rule; previous card is fallback after route change',()=>{
  const records=['2026-07','2026-08','2026-09','2026-10'].map(p=>record(p));
  const existing=rule({fixedCost:undefined,categoryId:'food'}),s=source(records,[existing]);
  const candidate=detectCardSubscriptions(s,'2026-11')[0];assert.ok(candidate);
  const draft=prepareCardFixedRule(s,today,{candidate});assert.equal(draft.rule.id,existing.id);assert.equal(draft.rule.categoryId,'food');
  const next=rule({cardId:'amazon'});next.fixedCost=editRuleFixedDraft(next,draft.fixed,draft.key,'active','monthly',today,s);
  assert.equal(fixedCostRuleViews(source(records,[next]),today)[0].charge.amount,1490);
  assert.equal(fixedCostRuleViews(source([...records,record('2026-11',2300,'amazon')],[next]),today)[0].charge.amount,2300);
  assert.equal(pendingCardSubscriptions(source(records,[next]),'2026-11').length,0);
});
test('migration receipts preserve original assets but prevent resurrection after removal; manual cash remains',()=>{
  const assets=emptyAssets();assets.fixedCosts=[legacy,{...legacy,id:'synthetic-cash',payment:'cash',cardId:null,merchantKey:null}];
  assert.equal(fixedCostCalculationAssets(source([],[],assets),today).fixedCosts[0].amount,1200);
  const linked=rule({fixedCost:{...rule().fixedCost,legacyId:legacy.id}});
  const doc=validateRules({...emptyRules(),rules:[linked]});assert.equal(doc.format,'finance-merchant-rules-v2');
  assert.deepEqual(doc.fixedCostMigrations,[legacy.id]);
  const next=mergeRules(doc,{...doc,rules:[],deleted:[linked.id]},doc);
  assert.deepEqual(next.fixedCostMigrations,[legacy.id]);
  assert.deepEqual(fixedCostCalculationAssets(source([],[],assets,next.fixedCostMigrations),today).fixedCosts.map(x=>x.id),['synthetic-cash']);
  assert.equal(assets.fixedCosts.length,2);
});
test('future card bill uses the latest actual; imported statement wins; paused and ended do not project',()=>{
  const assets=emptyAssets();assets.cardDebitAccounts={'smbc-nl':'rakuten-bank'};
  const records=[record('2026-10',2000),record('2026-11',2500)];
  const projected=fixedCostCalculationAssets(source(records,[rule()],assets),today);
  assert.equal(estimatedCardFixedBills(projected,records,'2026-11-26','2026-12-31').find(x=>x.paymentDate==='2026-12-28').amount,2500);
  assert.equal(estimatedCardFixedBills(projected,[...records,record('2026-12',3100)],'2026-12-01','2026-12-31').length,0);
  for(const state of ['paused','ended'])assert.equal(fixedCostCalculationAssets(source(records,[rule({fixedCost:{...rule().fixedCost,state}})],assets),today).fixedCosts.length,0);
});
test('v2 encrypted rule round-trip, no amount, duplicate fixed keys rejected',async()=>{
  const r=rule();const doc=validateRules({...emptyRules(),rules:[r]});
  const salt=freshSalt(),key=await deriveCloudKey('synthetic-test-passphrase',salt),cipher=await encryptRules(doc,key,salt);
  assert.deepEqual(await decryptRules(cipher,key,salt),doc);assert.equal('amount' in doc.rules[0].fixedCost,false);
  assert.throws(()=>validateRules({...doc,rules:[r,{...r,id:'synthetic-other'}]}));
  assert.throws(()=>validateRules({...doc,rules:[{...r,cardId:null}]}));
  assert.throws(()=>validateRules({...doc,rules:[{...r,mode:'contains'}]}));
});
test('weekly recurring prices accept separate usage days, not ambiguous same-day charges',()=>{
  const rows=[{usedOn:'2026-11-01',paymentDate:'2026-11-27',period:'2026-11',amount:100},{usedOn:'2026-11-08',paymentDate:'2026-11-27',period:'2026-11',amount:120}];
  assert.equal(latestFixedEvidence(rows,'weekly').amount,120);assert.equal(latestFixedEvidence(rows,'monthly'),null);assert.equal(latestFixedEvidence([...rows,rows[1]],'weekly'),null);
});

test('new blank rule form does not create a fictitious previous card route',()=>{
  const data=source([record('2026-11',1500)]);const draft=prepareCardFixedRule(data,today);
  const r=rule();r.fixedCost=editRuleFixedDraft(r,draft.fixed,'null|','active','monthly',today,data);
  assert.equal(r.fixedCost.previous,undefined);assert.doesNotThrow(()=>validateRules({...emptyRules(),rules:[r]}));
});
