import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {futureProjection} from '../dist/src/cloud/future-projection.js';
import {emptyAssets} from '../dist/src/cloud/assets.js';

const period='2026-11-17';
const record=(accountId,balance)=>({id:accountId+'-snapshot',accountId,balance,observedAt:'2026-11-01T12:00:00+09:00'});
const transfer=(id,toAccountId,amount)=>({id,name:id,amount,kind:'transfer',fromAccountId:'rakuten-bank',toAccountId,
  frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true});
const fixture=()=>{
  const doc=emptyAssets();
  doc.snapshots=[record('cash-savings',50000),record('nisa',100000)];
  doc.recurring=[transfer('cash-transfer-001','cash-savings',10000)];
  return doc;
};
const opts={today:period,targetMonth:'2027-01',changeMonth:'2026-12',savingsRuleId:null,
  savingsAmount:20000,nisaMonthly:20000,nisaAnnualReturn:0};

test('cash-only scenario changes cash savings, not NISA',()=>{
  const r=futureProjection(fixture(),[],{...opts,cashScenarioMonthly:30000,nisaScenarioMonthly:null});
  assert.equal(r.target.cash,80000);
  assert.equal(r.target.cashScenario,120000);
  assert.equal(r.target.nisaScenario,r.target.nisa);
  assert.equal(r.target.combinedScenario,260000);
});
test('NISA-only scenario changes future contributions, not cash savings',()=>{
  const r=futureProjection(fixture(),[],{...opts,cashScenarioMonthly:null,nisaScenarioMonthly:35000});
  assert.equal(r.target.cashScenario,r.target.cash);
  assert.equal(r.target.nisa,140000);
  assert.equal(r.target.nisaScenario,170000);
  assert.equal(r.target.combinedScenario,250000);
});
test('both changes are applied to one combined comparison',()=>{
  const r=futureProjection(fixture(),[],{...opts,cashScenarioMonthly:30000,nisaScenarioMonthly:35000});
  assert.equal(r.target.cashScenario,120000);
  assert.equal(r.target.nisaScenario,170000);
  assert.equal(r.target.combinedScenario,290000);
});
test('NISA recurring bank deposits are replaced, not double-counted',()=>{
  const d=fixture();d.recurring.push(transfer('nisa-transfer-001','nisa',15000));
  const r=futureProjection(d,[],{...opts,nisaMonthly:0,nisaScenarioMonthly:30000});
  assert.equal(r.target.nisa,145000);
  assert.equal(r.target.nisaScenario,175000);
  assert.equal(r.target.combinedScenario,255000);
});
test('scenario never changes actual current-month history',()=>{
  const r=futureProjection(fixture(),[],{...opts,targetMonth:'2026-11',changeMonth:'2026-11',cashScenarioMonthly:50000,nisaScenarioMonthly:50000});
  assert.equal(r.target.cash,60000);assert.equal(r.target.cashScenario,60000);
  assert.equal(r.target.nisa,100000);assert.equal(r.target.nisaScenario,100000);
});
test('invalid comparison money is rejected',()=>{
  assert.throws(()=>futureProjection(fixture(),[],{...opts,nisaScenarioMonthly:-1}),/不正/);
  assert.throws(()=>futureProjection(fixture(),[],{...opts,cashScenarioMonthly:NaN}),/不正/);
});
test('UI uses radio selection, aligned metric colors and no old select',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/styles/ui-v155.css',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../src/ui/future-projection.ts',import.meta.url),'utf8');
  assert.match(html,/id="future-compare-cash" type="checkbox"/);
  assert.match(html,/id="future-compare-nisa" type="checkbox"/);
  assert.doesNotMatch(html,/name="future-compare-type"/);
  assert.doesNotMatch(html,/id="future-savings-rule"/);
  assert.match(ui,/future-totals/);assert.match(ui,/future-breakdown/);
  assert.match(ui,/cashScenarioMonthly:changesCash/);
  assert.match(ui,/nisaScenarioMonthly:changesNisa/);
  assert.match(css,/future-metric-label/);assert.match(css,/future-color-key-base/);
  assert.match(css,/future-path-base\{stroke:var\(--future-total\)/);
});
test('settings fields fill cards and copy button aligns',()=>{
  const css=readFileSync(new URL('../public/styles/ui-v155.css',import.meta.url),'utf8');
  assert.match(css,/cloud-dev-test \.cloud-password-control input/);
  assert.match(css,/cloud-troubleshooting #cloud-diagnostic-secret/);
  assert.match(css,/#cloud-diagnostic-copy\{margin-top:0!important/);
  assert.match(readFileSync(new URL('../public/styles/settings-v194.css',import.meta.url),'utf8'),/settings-payroll-fields>\.rules-field\{margin:0;min-width:0/);
});
