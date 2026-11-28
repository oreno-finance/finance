import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyAssets} from '../dist/src/cloud/assets.js';
import {emptyRules,validateRules,mergeRules} from '../dist/src/cloud/merchant-rules.js';
import {encryptRules,decryptRules,freshSalt,deriveCloudKey} from '../dist/src/cloud/cloud-crypto.js';
import {fixedCostRuleViews,fixedCostCalculationAssets,prepareCardFixedRule,editRuleFixedDraft,latestFixedEvidence,legacyRuleFixedCost} from '../dist/src/fixed-costs/rule-fixed-costs.js';
import {detectCardSubscriptions,pendingCardSubscriptions} from '../dist/src/subscriptions/detect.js';
import {estimatedCardFixedBills,estimatedMizuhoFunding} from '../dist/src/cloud/card-fixed-estimates.js';
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
  const newCard=record('2026-11',2300,'amazon');
  assert.equal(fixedCostRuleViews(source([...records,newCard],[next]),today)[0].charge.amount,1490);
  newCard.statement.rows[0].usedOn=today;
  assert.equal(fixedCostRuleViews(source([...records,newCard],[next]),today)[0].charge.amount,2300);
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

test('M04: monthly and annual evidence follows usage cycles and rejects refunds in the latest cycle',()=>{
 const a={usedOn:'2026-10-31',paymentDate:'2026-11-27',period:'2026-11',amount:100};
 const b={...a,usedOn:'2026-11-01',amount:200};
 assert.equal(latestFixedEvidence([a,b],'monthly').amount,200);
 assert.equal(latestFixedEvidence([b,{...b,paymentDate:'2026-12-27',period:'2026-12'}],'monthly'),null);
 assert.equal(latestFixedEvidence([a,b],'yearly'),null);
 assert.equal(latestFixedEvidence([b,{...b,usedOn:'2026-11-02',amount:-200}],'monthly'),null);
 assert.equal(latestFixedEvidence([a,{...b,usedOn:'2027-11-01'}],'yearly').amount,200);
});

test('M01: changing A to B and back to A does not treat the former A period as new evidence',()=>{
 const a=rule(),b=rule({cardId:'amazon'}),back=rule();
 b.fixedCost=editRuleFixedDraft(b,a.fixedCost,'smbc-nl|service','active','monthly','2026-10-10');
 back.fixedCost=editRuleFixedDraft(back,b.fixedCost,'amazon|service','active','monthly','2026-11-10');
 const records=[record('2026-09',1000),record('2026-10',2000,'amazon')];records[1].statement.rows[0].usedOn='2026-10-10';
 assert.equal(fixedCostRuleViews(source(records,[back]),today)[0].charge.amount,2000);
 const next=record('2026-11',3000);next.statement.rows[0].usedOn='2026-11-10';
 assert.equal(fixedCostRuleViews(source([...records,next],[back]),today)[0].charge.amount,3000);
 assert.equal(back.fixedCost.previous.length,2);
 assert.doesNotThrow(()=>validateRules({...emptyRules(),rules:[back]}));
});

test('M02: inferred card price never replaces registered history or explicit future price',()=>{
 const assets=emptyAssets();assets.cardDebitAccounts={'smbc-nl':'rakuten-bank'};
 assets.cardPreferences={'smbc-nl':{payment:{monthOffset:1,day:27}}};
 const pricing=[{effectiveOn:'2026-08-01',amount:1000},{effectiveOn:'2026-10-01',amount:1500},{effectiveOn:'2027-01-01',amount:3000}];
 const contract={...legacy,amount:3000,pricing};Object.freeze(pricing);pricing.forEach(Object.freeze);Object.freeze(contract);
 assets.fixedCosts=Object.freeze([contract]);Object.freeze(assets);
 const records=[record('2026-11',2000)];const view=fixedCostCalculationAssets(source(records,[],assets),today);
 assert.deepEqual(view.fixedCosts[0].pricing,pricing);assert.equal(view.fixedCosts[0].amount,3000);
 assert.equal(estimatedCardFixedBills(view,records,'2027-01-01','2027-01-31')[0].amount,2000);
 assert.equal(estimatedCardFixedBills(view,records,'2027-02-01','2027-03-02')[0].amount,3000);
 const linked=rule({fixedCost:{...rule().fixedCost,legacyId:legacy.id}});
 const migrated=fixedCostCalculationAssets(source(records,[linked],assets),today);
 assert.deepEqual(migrated.fixedCosts[0].pricing,pricing);
 assert.equal(estimatedCardFixedBills(migrated,records,'2027-02-01','2027-03-02')[0].amount,3000);
 assert.deepEqual(fixedCostCalculationAssets(source(records,[rule()]),today).fixedCosts[0].pricing,[]);
});

test('M03: ended rule retains only pending charges within its known active interval',()=>{
 const assets=emptyAssets();assets.cardDebitAccounts={'smbc-nl':'rakuten-bank'};
 assets.cardPreferences={'smbc-nl':{payment:{monthOffset:1,day:27}}};
 const r=rule();const records=[record('2026-10',1500)];records[0].statement.rows[0].usedOn='2026-10-10';
 r.fixedCost=editRuleFixedDraft(r,r.fixedCost,'smbc-nl|service','ended','monthly',today);
 assert.equal(r.fixedCost.endOn,today);
 const view=fixedCostCalculationAssets(source(records,[r],assets),today);
 assert.equal(fixedCostRuleViews(source(records,[r],assets),today)[0].status,'ended');
 const bills=estimatedCardFixedBills(view,records,'2026-12-01','2027-01-31');
 assert.deepEqual(bills.map(b=>[b.paymentDate,b.amount]),[['2026-12-28',1500]]);
 assert.equal(estimatedCardFixedBills(view,[...records,record('2026-12',2000)],'2026-12-01','2027-01-31').length,0);
 const afterEnd=record('2026-11',9000);afterEnd.statement.rows[0].usedOn='2026-11-27';
 assert.equal(fixedCostRuleViews(source([...records,afterEnd],[r],assets),'2026-11-30')[0].charge.amount,1500);
});

test('M03: pause retains earlier unpaid charges, same-day resume and repeated pauses preserve valid intervals',()=>{
 const r=rule(),key='smbc-nl|service',edit=(state,day)=>{r.fixedCost=editRuleFixedDraft(r,r.fixedCost,key,state,'monthly',day);assert.doesNotThrow(()=>validateRules({...emptyRules(),rules:[r]}));};
 edit('paused',today);assert.deepEqual(r.fixedCost.pauses,[{startOn:'2026-11-27',endOn:null}]);
 const assets=emptyAssets();assets.cardDebitAccounts={'smbc-nl':'rakuten-bank'};assets.cardPreferences={'smbc-nl':{payment:{monthOffset:1,day:27}}};
 const view=fixedCostCalculationAssets(source([record('2026-10',1500)],[r],assets),today);
 assert.equal(estimatedCardFixedBills(view,[],'2026-12-01','2027-01-31').length,1);
 edit('active',today);assert.deepEqual(r.fixedCost.pauses,[]);
 edit('paused',today);edit('active','2026-12-05');edit('paused','2026-12-20');
 assert.deepEqual(r.fixedCost.pauses,[{startOn:'2026-11-27',endOn:'2026-12-04'},{startOn:'2026-12-21',endOn:null}]);
 edit('ended','2026-12-23');assert.equal(r.fixedCost.endOn,'2026-12-23');
 assert.deepEqual(r.fixedCost.pauses,[{startOn:'2026-11-27',endOn:'2026-12-04'},{startOn:'2026-12-21',endOn:'2026-12-23'}]);
 const scheduled=rule({fixedCost:{...rule().fixedCost,startOn:'2027-01-01'}});
 scheduled.fixedCost=editRuleFixedDraft(scheduled,scheduled.fixedCost,key,'ended','monthly',today);
 assert.doesNotThrow(()=>validateRules({...emptyRules(),rules:[scheduled]}));
 assert.equal(fixedCostCalculationAssets(source([record('2026-10')],[scheduled],assets),today).fixedCosts.length,0);
});


test('M03: pending ended charge reaches bank forecast and Mizuho funding only until replaced',async()=>{
 const {forecastBankBalances}=await import('../dist/src/cloud/salary-projection.js');
 const {forecastAccounts}=await import('../dist/src/home/account-events.js');
 const {bankTimeline}=await import('../dist/src/summary/bank-timeline.js');
 const card='rakuten-mizuho',key=card+'|service';
 const assets=emptyAssets();assets.cardDebitAccounts={[card]:'mizuho-bank'};
 assets.cardPreferences={[card]:{payment:{monthOffset:1,day:27}}};
 assets.mizuhoTransferPlan={enabled:true,leadDays:3,extraForSmallBills:false};
 assets.snapshots=[{id:'snapshot-r',accountId:'rakuten-bank',balance:100000,observedAt:'2026-11-26T00:00:00Z'},{id:'snapshot-m',accountId:'mizuho-bank',balance:5000,observedAt:'2026-11-26T00:00:00Z'}];
 const observation=record('2026-10',1500,card);observation.statement.provider='rakuten';observation.statement.rows[0].usedOn='2026-10-10';
 const r=rule({cardId:card});r.fixedCost=editRuleFixedDraft(r,r.fixedCost,key,'ended','monthly',today);
 const s=source([observation],[r],assets),view=fixedCostCalculationAssets(s,today);
 assert.equal(estimatedCardFixedBills(view,s.records,'2026-12-01','2026-12-31')[0].amount,1500);
 const funding=estimatedMizuhoFunding(view,s.records,today,'2026-12-31');assert.equal(funding.length,1);assert.equal(funding[0].amount,5000);
 const projected=forecastBankBalances(view,'2026-12-31',s.records,[],null,today);
 assert.equal(projected.fixedCostCardEstimatesByAccount['mizuho-bank'],1500);
 assert.equal(projected.estimatedTransferByAccount['rakuten-bank'],-5000);
 assert.equal(forecastAccounts(s,today).debits.find(d=>d.estimated).amount,1500);
 assert.ok(bankTimeline('2026-12',s,today).days.some(d=>d.date===funding[0].date&&d.items.some(x=>x.kind==='transfer'&&x.amount===-5000)));
 assert.equal(estimatedMizuhoFunding({...view,oneTime:[{id:'manual-funding',date:funding[0].date,kind:'transfer',status:'done',amount:5000,fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',cardFunding:true}]},s.records,today,'2026-12-31').length,0);
 assert.equal(estimatedCardFixedBills({...view,cardNoUseMonths:['2026-12']},s.records,'2026-12-01','2026-12-31').length,0);
 assert.equal(estimatedCardFixedBills({...view,cardPreferences:undefined},[],'2026-12-01','2026-12-31').length,0);
});


test('M03: a previous non-overlapping contract usage is not treated as the new contract debit',()=>{
 const assets=emptyAssets();assets.cardDebitAccounts={'smbc-nl':'rakuten-bank'};assets.cardPreferences={'smbc-nl':{payment:{monthOffset:1,day:27}}};
 assets.fixedCosts=[{...legacy,startOn:'2026-11-15',dayOfMonth:20,pricing:[{effectiveOn:'2026-11-15',amount:1200}]}];
 const records=[record('2026-11',1000)];
 const view=fixedCostCalculationAssets(source(records,[],assets),today);
 assert.equal(estimatedCardFixedBills(view,records,'2026-12-01','2026-12-31')[0].amount,1200);
});

test('INT-03: card change keeps the old route unpaid usage, original cadence and past suspension',async()=>{
 const assets=emptyAssets();assets.cardDebitAccounts={'smbc-nl':'rakuten-bank',amazon:'mizuho-bank'};
 assets.cardPreferences={'smbc-nl':{payment:{monthOffset:1,day:27}},amazon:{payment:{monthOffset:1,day:27}}};
 const old=rule({fixedCost:{...rule().fixedCost,pauses:[{startOn:'2026-09-01',endOn:'2026-09-30'}]}});
 const next=rule({cardId:'amazon'});
 next.fixedCost=editRuleFixedDraft(next,old.fixedCost,'smbc-nl|service','active','monthly',today);
 assert.deepEqual(next.fixedCost.previous,[{key:'smbc-nl|service',through:today,startOn:'2026-08-01',frequency:'monthly',pauses:old.fixedCost.pauses}]);
 const doc=validateRules({...emptyRules(),rules:[next]});
 const salt=freshSalt(),key=await deriveCloudKey('synthetic-test-passphrase',salt);
 assert.deepEqual(await decryptRules(await encryptRules(doc,key,salt),key,salt),doc);
 const observation=record('2026-10',1500);observation.statement.rows[0].usedOn='2026-10-10';
 const s=source([observation],[next],assets);
 const view=fixedCostCalculationAssets(s,today);
 assert.deepEqual(estimatedCardFixedBills(view,s.records,'2026-12-01','2027-01-31').map(b=>[b.cardId,b.paymentDate,b.amount]),[['smbc-nl','2026-12-28',1500],['amazon','2027-01-27',1500]]);
 const actual=record('2026-12',1500);actual.statement.rows[0].usedOn='2026-11-10';
 assert.deepEqual(estimatedCardFixedBills(view,[observation,actual],'2026-12-01','2027-01-31').map(b=>b.cardId),['amazon']);
 // A later contract on the old card must not disqualify earlier observations.
 const later=rule({id:'synthetic-later',fixedCost:{...rule().fixedCost,startOn:'2026-12-01'}});
 assert.equal(fixedCostRuleViews(source([observation],[next,later],assets),today)[0].charge.amount,1500);
});

test('INT-03: changing card while paused preserves the open pause and prevents old paused usage',()=>{
 const assets=emptyAssets();assets.cardDebitAccounts={'smbc-nl':'rakuten-bank',amazon:'mizuho-bank'};
 assets.cardPreferences={'smbc-nl':{payment:{monthOffset:1,day:27}},amazon:{payment:{monthOffset:1,day:27}}};
 const old=rule({fixedCost:{...rule().fixedCost,state:'paused',pauses:[{startOn:'2026-11-01',endOn:null}]}});
 const next=rule({cardId:'amazon'});
 next.fixedCost=editRuleFixedDraft(next,old.fixedCost,'smbc-nl|service','paused','monthly',today);
 assert.deepEqual(next.fixedCost.pauses,[{startOn:today,endOn:null}]);
 assert.deepEqual(next.fixedCost.previous[0].pauses,[{startOn:'2026-11-01',endOn:'2026-11-25'}]);
 assert.doesNotThrow(()=>validateRules({...emptyRules(),rules:[next]}));
 const observation=record('2026-10',1500);observation.statement.rows[0].usedOn='2026-10-10';
 assert.equal(estimatedCardFixedBills(fixedCostCalculationAssets(source([observation],[next],assets),today),[observation],'2026-12-01','2027-01-31').length,0);
});


test('M03: ended legacy rule and ended route change preserve a known final valid day',()=>{
 const cancelled={...legacy,startOn:'2026-12-01',endOn:'2026-11-26',pricing:[{effectiveOn:'2026-12-01',amount:legacy.amount}]};
 const fixed=legacyRuleFixedCost(cancelled);
 assert.equal(fixed.state,'ended');
 const cancelledRule=rule({fixedCost:fixed});
 assert.doesNotThrow(()=>validateRules({...emptyRules(),rules:[cancelledRule]}));
 assert.equal(fixedCostRuleViews(source([record('2026-10')],[cancelledRule]),today)[0].charge,null);
 const old=rule({fixedCost:{...rule().fixedCost,state:'ended',endOn:'2026-11-10'}});
 const next=rule({cardId:'amazon'});
 next.fixedCost=editRuleFixedDraft(next,old.fixedCost,'smbc-nl|service','ended','monthly',today);
 assert.equal(next.fixedCost.endOn,'2026-11-10');
 assert.equal(next.fixedCost.state,'ended');
 assert.deepEqual(next.fixedCost.previous,[{key:'smbc-nl|service',through:'2026-11-11',startOn:'2026-08-01',frequency:'monthly',pauses:[]}]);
 assert.doesNotThrow(()=>validateRules({...emptyRules(),rules:[next]}));
 const assets=emptyAssets();assets.cardDebitAccounts={'smbc-nl':'rakuten-bank',amazon:'mizuho-bank'};
 assets.cardPreferences={'smbc-nl':{payment:{monthOffset:1,day:27}},amazon:{payment:{monthOffset:1,day:27}}};
 const observation=record('2026-10',1500);observation.statement.rows[0].usedOn='2026-10-10';
 const s=source([observation],[next],assets);
 assert.deepEqual(estimatedCardFixedBills(fixedCostCalculationAssets(s,today),s.records,'2026-12-01','2027-01-31').map(b=>[b.cardId,b.paymentDate,b.amount]),[['smbc-nl','2026-12-28',1500]]);
});
