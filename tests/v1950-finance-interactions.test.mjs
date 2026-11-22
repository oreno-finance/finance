import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyAssets} from '../dist/src/cloud/assets.js';
import {reconcileBalance} from '../dist/src/cloud/balance-reconciliation.js';
import {nearestProjectionIndex} from '../dist/src/ui/future-projection.js';

const saved=(id,balance,date)=>({id,accountId:'rakuten-bank',balance,observedAt:`${date}T12:00:00Z`});
const fixture=()=>{const d=emptyAssets();d.snapshots=[saved('prev-snapshot',50000,'2026-11-01'),saved('now-snapshot',43000,'2026-11-10')];return d;};
const recon=(d=fixture(),ready=true)=>reconcileBalance(d,'rakuten-bank',[],[],null,ready,'2026-11-22');
test('reconciliation uses the PREVIOUS snapshot and never the new balance as its own baseline',()=>{
  const d=fixture(), before=structuredClone(d);
  const r=recon(d);
  assert.ok(r);assert.equal(r.predicted,50000);assert.equal(r.actual,43000);assert.equal(r.difference,-7000);
  assert.equal(r.previous.id,'prev-snapshot');assert.equal(r.latest.id,'now-snapshot');
  assert.deepEqual(d,before,'calculation never changes the OneDrive document');
});
test('recurring bank expense changes expected balance but does not manufacture a missing entry',()=>{
  const d=fixture();
  d.recurring.push({id:'rent-001',name:'口座引落',kind:'expense',amount:5000,fromAccountId:'rakuten-bank',toAccountId:null,
    frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true});
  const r=recon(d);
  assert.equal(r.predicted,45000);
  assert.equal(r.difference,-2000);
});
test('planned one-off movement is flagged as a possible cause of an apparent mismatch',()=>{
  const d=fixture();
  d.oneTime=[{id:'once-001',date:'2026-11-06',name:'予定の引落',kind:'expense',amount:3000,
    status:'planned',fromAccountId:'rakuten-bank',toAccountId:null}];
  const r=recon(d);
  assert.equal(r.predicted,47000);assert.equal(r.difference,-4000);
  assert.equal(r.provisionalEntries,1);
});
test('a confirmed change may match the expected value exactly',()=>{
  const d=fixture();d.snapshots[1].balance=50000;
  const r=recon(d);
  assert.equal(r.difference,0);
});
test('same-day corrections and future-dated confirmations do not produce false comparisons',()=>{
  const d=fixture();d.snapshots[0].observedAt='2026-11-10T10:00:00Z';
  assert.equal(recon(d),null);
  d.snapshots[0].observedAt='2026-11-01T12:00:00Z';
  d.snapshots[1].observedAt='2026-12-10T12:00:00Z';
  assert.equal(recon(d),null);
});
test('investment market-value difference is explicitly distinct from an unrecorded expense',()=>{
  const d=emptyAssets();d.snapshots=[{...saved('old-investment',100000,'2026-11-01'),accountId:'nisa'},
    {...saved('new-investment',107000,'2026-11-10'),accountId:'nisa'}];
  const r=reconcileBalance(d,'nisa',[],[],null,true,'2026-11-22');
  assert.equal(r.difference,7000);assert.equal(r.valuationMayChange,true);
});
test('graph pointer position is clamped and consistently resolves monthly values',()=>{
  assert.equal(nearestProjectionIndex(10,10,840,13),0);
  assert.equal(nearestProjectionIndex(60,10,840,13),0);
  assert.equal(nearestProjectionIndex(824,10,840,13),12);
  assert.equal(nearestProjectionIndex(60+387,10,840,13),6);
  assert.equal(nearestProjectionIndex(900,10,840,13),12);
  assert.equal(nearestProjectionIndex(200,10,0,13),0);
  assert.equal(nearestProjectionIndex(Number.NaN,10,840,13),0);
});
test('interactive graph has filter, drag and keyboard support without touching saved assets',()=>{
  const ui=readFileSync(new URL('../src/ui/future-projection.ts',import.meta.url),'utf8');
  assert.match(ui,/future-chart-filters/);assert.match(ui,/aria-pressed/);
  assert.match(ui,/pointerdown/);assert.match(ui,/pointermove/);assert.match(ui,/ArrowRight/);
  assert.match(ui,/role:'slider'/);assert.match(ui,/chosenMonth/);
});
test('startup notification buttons shrink to their content and separator is absent',()=>{
  const css=readFileSync(new URL('../public/styles/startup-recovery.css',import.meta.url),'utf8');
  assert.match(css,/display:flex;flex-wrap:wrap;justify-content:flex-start/);
  assert.match(css,/border-top:0/);
  assert.doesNotMatch(css,/grid-column:1\/-1/);
});
