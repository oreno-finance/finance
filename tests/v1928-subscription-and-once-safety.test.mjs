import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {detectCardSubscriptions,latestRegisteredCardCharge,latestRegisteredCardCharges,subscriptionDecision,pendingCardSubscriptions} from '../dist/src/subscriptions/detect.js';
import {emptyAssets,cardRecurringKey} from '../dist/src/cloud/assets.js';
import {recurringDraftSnapshot} from '../dist/src/ui/assets-settings.js';

const row=(month,merchant='VIDEO STREAM',amount=980,cardId='smbc-nl',confirmation='confirmed',id='one')=>({
  id:`${month}-${cardId}-${id}`,
  statement:{provider:'smbc',cardId,sourceKind:'paste',sourceName:'test',
    billingMonth:month,paymentDate:`${month}-27`,statedTotal:amount,confirmation,warnings:[],
    rows:[{id:`${month}-${id}`,usedOn:`${month}-01`,merchant,amount}]}
});
const source=(records,assets=emptyAssets())=>({records,assets,rules:[],categories:[],currentPeriod:'2026-11',payroll:{ready:false,syncedAt:null,entries:[]}});
const months=['2026-07','2026-08','2026-09','2026-10'];
const earlier=()=>months.map(month=>row(month));

test('registered price is a snapshot; latest confirmed price detects a single new price rise without rewriting decisions',()=>{
  const initial=source(earlier());
  const candidate=detectCardSubscriptions(initial,'2026-11')[0];
  assert.equal(candidate.amount,980);
  const decision=subscriptionDecision(candidate,'registered','2026-10-31T00:00:00Z');
  const assets=emptyAssets();assets.cardRecurringDecisions={[candidate.key]:decision};
  const updated=source([...earlier(),row('2026-11','VIDEO STREAM',1280)],assets);
  assert.deepEqual(latestRegisteredCardCharge(updated,candidate.key,'2026-11'),{month:'2026-11',amount:1280});
  assert.equal(assets.cardRecurringDecisions[candidate.key].amount,980);
  assert.equal(pendingCardSubscriptions(updated,'2026-11').length,0);
  assert.deepEqual(latestRegisteredCardCharges(updated,'2026-11').get(candidate.key),{month:'2026-11',amount:1280});
});

test('latest charge compares the exact merchant/card, uses payment month, and rejects future or unconfirmed statements',()=>{
  const key=cardRecurringKey('smbc-nl','VIDEO STREAM');
  const charges=[...earlier(),row('2026-11','VIDEO STREAM',1280,'amazon'),row('2026-11','OTHER',6500),
    row('2026-11','VIDEO STREAM',1100,'smbc-nl','provisional'),row('2026-12','VIDEO STREAM',2000)];
  assert.deepEqual(latestRegisteredCardCharge(source(charges),key,'2026-11'),{month:'2026-10',amount:980});
});

test('latest month with duplicate merchant charges never invents an amount',()=>{
  const key=cardRecurringKey('smbc-nl','VIDEO STREAM');
  const duplicate=[...earlier(),{...row('2026-11'),statement:{...row('2026-11').statement,
    statedTotal:2560,rows:[{id:'extra-1',usedOn:'2026-11-01',merchant:'VIDEO STREAM',amount:1280},
      {id:'extra-2',usedOn:'2026-11-02',merchant:'VIDEO STREAM',amount:1280}]}}];
  assert.equal(latestRegisteredCardCharge(source(duplicate),key,'2026-11'),null);
});

test('NISA matching is never treated as a registered card subscription latest charge',()=>{
  const assets=emptyAssets();assets.nisaCardRule={enabled:true,cardId:'smbc-nl',merchantContains:'VIDEO STREAM'};
  const key=cardRecurringKey('smbc-nl','VIDEO STREAM');
  assert.equal(latestRegisteredCardCharge(source(earlier(),assets),key,'2026-11'),null);
});

test('one-time draft detects actual edits and reversals, including radios, checkbox, date and amount',()=>{
  const initial=[
    {id:'',type:'radio',value:'expense',checked:false},
    {id:'',type:'radio',value:'transfer',checked:true},
    {id:'assets-once-amount',type:'number',value:'1000'},
    {id:'assets-once-date',type:'date',value:'2026-11-21'},
    {id:'assets-once-funding',type:'checkbox',value:'on',checked:false},
  ];
  const baseline=recurringDraftSnapshot(initial);
  assert.equal(recurringDraftSnapshot(initial.map(x=>({...x}))),baseline);
  for(const [index,change] of [[0,{checked:true}],[1,{checked:false}],[2,{value:'1300'}],
    [3,{value:'2026-11-22'}],[4,{checked:true}]]){
    const draft=initial.map(x=>({...x}));Object.assign(draft[index],change);
    assert.notEqual(recurringDraftSnapshot(draft),baseline);
    draft[index]={...initial[index]};assert.equal(recurringDraftSnapshot(draft),baseline);
  }
});

test('all dismissal paths use the same changed-only guard and successful save bypasses it',()=>{
  const code=readFileSync(new URL('../src/ui/assets-settings.ts',import.meta.url),'utf8');
  assert.match(code,/const onceHasChanges=\(\):boolean=>onceSnapshot\(\)!==onceBaseline/);
  assert.match(code,/onceBaseline=onceSnapshot\(\);\s*onceDialog\.showModal\(\)/);
  assert.match(code,/if\(onceHasChanges\(\)\)\{[\s\S]*?if\(!await requestConfirmation\(\{owner:confirmationOwner,parent:onceDialog,[\s\S]*?destructive:true\}\)\)return/);
  assert.match(code,/\('assets-once-close'\)\.addEventListener\('click',closeOnce\)/);
  assert.match(code,/\('assets-once-cancel'\)\.addEventListener\('click',closeOnce\)/);
  assert.match(code,/bindModalDismiss\(onceDialog,\(\)=>\{void closeOnce\(\);\}\)/);
  assert.match(code,/await requireVault\(\)\.upsertOneTime\(entry,fundingDraft\?\?undefined\);\s*onceDialog\.close\(\);resetOnceForm\(\)/);
  assert.match(code,/isDirty:\(\)=>onceHasChanges\(\)\|\|recurringHasChanges\(\)/);
});

test('registered UI labels current contract amount and latest charge separately without mutating source',()=>{
  const code=readFileSync(new URL('../src/ui/subscriptions.ts',import.meta.url),'utf8');
  assert.match(code,/latestRegisteredCardCharges\(source\)/);
  assert.match(code,/現在の契約額/);
  assert.match(code,/最新の請求実績/);
  assert.match(code,/請求時の契約額/);
  assert.match(code,/priceOnDay\(origin.pricing\?\?\[\],observation.usedOn,origin.amount\)/);
  assert.doesNotMatch(code,/setCardRecurringDecision\(key,\s*latest/);
});

test('registered charge compares usage-day price including boundary, never guesses missing history',async()=>{
  const {runInNewContext}=await import('node:vm');
  const {priceOnDay}=await import('../dist/src/fixed-costs/contracts.js');
  const {latestContractCardCharge}=await import('../dist/src/subscriptions/detect.js');
  const code=readFileSync(new URL('../dist/src/ui/subscriptions.js',import.meta.url),'utf8');
  const body=code.slice(code.indexOf('function latestEvidence('),code.indexOf('function itemsFromSource('));
  assert.ok(body.includes('lastDifference'));
  const compare=runInNewContext(body+'\nlatestEvidence',{priceOnDay,latestContractCardCharge});
  const origin={amount:3000,pricing:[{effectiveOn:'2026-11-01',amount:2000},{effectiveOn:'2026-12-01',amount:3000}]};
  const obs=(usedOn,amount)=>[{usedOn,amount,paymentDate:'2026-12-27',period:'2026-12'}];
  assert.equal(compare(origin,obs('2026-11-10',2000)).lastDifference,0);
  assert.equal(compare(origin,obs('2026-11-30',2200)).lastDifference,200);
  assert.equal(compare(origin,obs('2026-12-01',3000)).lastDifference,0);
  assert.equal(compare(origin,obs('2026-12-01',2000)).lastDifference,-1000);
  assert.equal(compare(origin,obs('2026-10-31',2000)).lastDifference,undefined);
  assert.equal(compare({amount:3000},obs('2026-11-10',2000)).lastDifference,undefined);
  assert.equal(compare({amount:3000,pricing:[]},obs('2026-11-10',2000)).lastDifference,undefined);
  assert.equal(compare(origin,[...obs('2026-12-01',3000),...obs('2026-12-02',3000)]).lastDifference,undefined);
  assert.equal(compare(origin,obs('2026-10-31',2000)).lastAmount,2000);
});
