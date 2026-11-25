import test from 'node:test';
import assert from 'node:assert/strict';
import { importErrors, duplicateMonths } from '../dist/src/importers/batch-policy.js';

const makeStatement = (patch = {}) => ({
  provider:'smbc', cardId:'amazon', sourceKind:'paste',sourceName:'架空の明細',
  billingMonth:'2026-12',paymentDate:'2026-12-28',statedTotal:643,
  confirmation:'provisional',warnings:[],
  rows:[{id:'a',usedOn:'2026-11-02',merchant:'架空店舗',amount:643}],
  ...patch,
});

test('batch verification accepts provisional with consistent totals', () => {
  assert.deepEqual(importErrors(makeStatement(), false), []);
});
test('batch verification blocks malformed and mismatched statements', () => {
  const issues=importErrors(makeStatement({statedTotal:644,rows:[{id:'a',usedOn:'2026-15-02',merchant:'',amount:643}]}),false);
  assert.ok(issues.some(x => x.includes('一致')));
  assert.ok(issues.some(x => x.includes('不備')));
});
test('batch verification requires PDF original and valid card', () => {
  assert.ok(importErrors(makeStatement({sourceKind:'pdf',cardId:null}),false).some(x=>x.includes('PDF原本')));
  assert.deepEqual(importErrors(makeStatement({sourceKind:'pdf'}),true),[]);
});
test('batch verification blocks duplicated card and month', () => {
  const conflicts=duplicateMonths([makeStatement(),makeStatement(),makeStatement({cardId:'smbc-nl'})]);
  assert.deepEqual([...conflicts],[0,1]);
});

test('bulk duplicate exclusion retains a saved statement, or the oldest of identical new drafts', async () => {
  const {redundantImportDrafts}=await import('../dist/src/importers/batch-policy.js');
  const old=makeStatement(),a=makeStatement(),b=makeStatement(),other=makeStatement({cardId:'smbc-nl'});
  const select=(list,saved=[])=>redundantImportDrafts(list,s=>!saved.includes(s),()=>true);
  assert.deepEqual(select([a,b,old,other],[old]),[a,b]);
  assert.deepEqual(select([a,b,old,other]),[a,b]);
  assert.deepEqual(select([a,b,old],[b,old]),[]);
  assert.deepEqual(select([other,old]),[]);
});

test('bulk exclusion never chooses among mixed versions, unknown status, source changes or ineligible records',async()=>{
  const {redundantImportDrafts}=await import('../dist/src/importers/batch-policy.js');
  const old=makeStatement(),a=makeStatement();
  const select=(list,eligible=()=>true)=>redundantImportDrafts(list,s=>s!==old,eligible);
  for(const changed of [makeStatement({confirmation:'confirmed'}),makeStatement({confirmation:'unknown'}),makeStatement({sourceKind:'csv'}),makeStatement({statedTotal:645}),makeStatement({paymentDate:'2026-12-29'})]){
    assert.deepEqual(select([a,old,changed]),[]);
  }
  assert.deepEqual(select([a,old],s=>s!==a),[]);
  assert.deepEqual(select([a,old],s=>s!==old),[]);
});

test('import selection saves 99 valid drafts and retains the invalid one',async()=>{
 const {readFileSync}=await import('node:fs');const vm=await import('node:vm');
 const code=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
 const fn=code.slice(code.indexOf('function importBatchPlan()'),code.indexOf('function updateBatchStatus()'));
 const drafts=Array.from({length:100},(_,i)=>makeStatement({billingMonth:`${2020+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`,statedTotal:i===99?644:643}));
 const ctx=vm.createContext({statements:drafts,duplicateMonths,importQueue:()=>drafts,hasUnsavedChanges:()=>true,issues:(s,d)=>[...importErrors(s,false),...(d.has(drafts.indexOf(s))?['duplicate']:[])]});
 vm.runInContext(fn+'\nthis.plan=importBatchPlan;',ctx);
 assert.equal(ctx.plan().eligible.length,99);assert.equal(ctx.plan().blocked[0],drafts[99]);
 drafts.push(makeStatement({billingMonth:drafts[0].billingMonth}));
 assert.equal(ctx.plan().eligible.length,98);assert.equal(ctx.plan().blocked.length,3);
});
