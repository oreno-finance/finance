import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {homeIncomeBreakdown} from '../dist/src/home/income-breakdown.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {emptyAssets} from '../dist/src/cloud/assets.js';

test('Home income uses the reconciled monthly report, not a second income calculation',()=>{
  const period='2026-11',assets=emptyAssets();
  assets.recurring=[{id:'other',kind:'income',name:'その他の収入',amount:1000,toAccountId:'rakuten-bank',fromAccountId:null,frequency:'monthly',dayOfMonth:1,monthOfYear:null,weekday:null,startOn:period+'-01',endOn:null,enabled:true,categoryId:null}];
  const source={records:[],rules:[],categories:[],assets,payroll:{ready:true,syncedAt:1,entries:[{id:'main',employerId:'id-main',job:'main',kind:'salary',paidOn:period+'-25',netPay:190000},{id:'side',employerId:'id-side',job:'side',kind:'salary',paidOn:period+'-27',netPay:25000}]},currentPeriod:period,currentDay:period+'-28'};
  const report=monthlyReport(period,source),parts=homeIncomeBreakdown(report);
  assert.deepEqual(parts,{main:190000,side:25000,other:1000});
  assert.equal(parts.main+parts.side+parts.other,report.income);
  source.payroll.ready=false;
  assert.deepEqual(homeIncomeBreakdown(monthlyReport(period,source)),{main:null,side:null,other:null});
});

test('Home income keeps estimates and confirmed one-time income, never counts unfinished plans',()=>{
  const report={payrollReady:true,income:215000,incomeMissingRegular:false,incomeLines:[{job:'side',amount:15000}],incomeEstimates:[{job:'main',amount:180000}],recurringLines:[{kind:'income',name:'副業給与',amount:5000}],oneTimeLines:[{kind:'income',status:'done',name:'その他',amount:15000},{kind:'income',status:'planned',name:'給与',amount:10000}]};
  assert.deepEqual(homeIncomeBreakdown(report),{main:180000,side:20000,other:15000});
  assert.equal(homeIncomeBreakdown({...report,incomeMissingRegular:true}).main,null);
});

function harness(){
  const code=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
  const fn=code.slice(code.indexOf('async function completeVaultOpening('),code.indexOf('function updateCloudStatus(',code.indexOf('async function completeVaultOpening(')));
  const events=[],vault={unlocked:true,recoveryOnly:false};let settle,fail;
  const promise=new Promise((resolve,reject)=>{settle=resolve;fail=reject;});
  const ctx=vm.createContext({liveVault:vault,initialPayrollVault:null,lockSequence:1,lastCloudCheckAt:0,$:id=>({classList:{contains:()=>id!=='home-view'}}),
    syncCloudGate:()=>events.push('gate'),appendCloudRecordsKeepingDrafts:(_records,redraw)=>events.push(`records:${redraw}`),
    assetsUi:{refreshPayroll:()=>{events.push('payroll');return promise;}},cardSettingsUi:null,reportsUi:null,render:()=>events.push('render'),updateCloudStatus:()=>events.push('status'),operationResult:()=>events.push('warning')});
  vm.runInContext(fn+'\nthis.open=completeVaultOpening;',ctx);
  return {ctx,vault,events,settle,fail};
}

test('Initial Finance view waits for Payroll then paints exactly once',async()=>{
  const {ctx,vault,events,settle}=harness();const opening=ctx.open(vault,[]);
  assert.equal(ctx.initialPayrollVault,vault);assert.deepEqual(events,['gate','records:false','payroll']);
  settle();assert.equal(await opening,true);assert.equal(ctx.initialPayrollVault,null);
  assert.deepEqual(events,['gate','records:false','payroll','render','status']);
});
test('Initial Payroll failure does not leave the Finance loading gate stuck',async()=>{
  const {ctx,vault,events,fail}=harness();const opening=ctx.open(vault,[]);fail(Error('synthetic failure'));
  assert.equal(await opening,true);assert.equal(ctx.initialPayrollVault,null);assert.deepEqual(events,['gate','records:false','payroll','warning','render','status']);
});
test('A lock while Payroll is loading must not reveal a late result',async()=>{
  const {ctx,vault,events,settle}=harness();const opening=ctx.open(vault,[]);
  ctx.lockSequence++;ctx.initialPayrollVault=null;vault.unlocked=false;settle();
  assert.equal(await opening,false);assert.deepEqual(events,['gate','records:false','payroll']);
});
