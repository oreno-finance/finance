/** Finance Round 4-C: explicit role and opaque employer ID in legacy v1 income. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptPayrollSource} from '../dist/src/cloud/payroll-bridge.js';
import {validatePayrollIncome} from '../dist/src/cloud/payroll-income.js';
import {expectedMainSalaries} from '../dist/src/cloud/salary-projection.js';
const empA='emp_'+'a'.repeat(32), empB='emp_'+'b'.repeat(32);
const rec=(id,paidOn,net,extra={})=>({id,paymentDate:paidOn,targetMonth:paidOn.slice(0,7),
 job:'main',kind:'salary',netPaymentYen:net,grossPaymentYen:net+30000,taxablePaymentYen:net+25000,revision:1,...extra});
const source=(rows)=>({format:'payroll-income-v1',year:'2026',records:rows});
test('旧v1の勤務区分は変更せず、勝手に勤務先IDを補完しない',()=>{
 const data=adaptPayrollSource(source([rec(1,'2026-10-27',100000)]));
 assert.equal(data.entries[0].employerId,'main');
 assert.equal(Object.hasOwn(data.entries[0],'job'),false);
 assert.equal(data.entries[0].netPay,100000);
});
test('新しいv1任意フィールドでは恒久勤務先IDと勤務区分を分離する',()=>{
 const data=adaptPayrollSource(source([
  rec(1,'2026-09-27',120000,{employerId:empA}),
  rec(2,'2026-10-27',210000,{employerId:empB}),
 ]));
 assert.deepEqual(data.entries.map(item=>item.employerId),[empA,empB]);
 assert.deepEqual(data.entries.map(item=>item.job),['main','main']);
 const validated=validatePayrollIncome(data);
 assert.equal(validated.entries[1].job,'main');
 const estimates=expectedMainSalaries(data.entries,'2026-11-17','2026-12-31');
 assert.deepEqual(estimates.map(item=>[item.date,item.amount]),[
  ['2026-11-27',205000],['2026-12-27',205000],
 ]);
});
test('不正な勤務先IDや勤務区分は受け取らない',()=>{
 for(const employerId of ['main','emp_123','同じ会社',empA.toUpperCase()])
  assert.throws(()=>adaptPayrollSource(source([rec(1,'2026-10-27',200000,{employerId})])),/不正/);
 const valid=adaptPayrollSource(source([rec(1,'2026-10-27',200000,{employerId:empA})]));
 valid.entries[0].job='unknown';
 assert.throws(()=>validatePayrollIncome(valid),/不正/);
});
test('別勤務区分と賞与は通常給与見込みの元にしない',()=>{
 const data=adaptPayrollSource(source([
  rec(1,'2026-10-27',220000,{employerId:empA}),
  rec(2,'2026-11-01',500000,{job:'side',employerId:empB}),
  rec(3,'2026-11-10',350000,{kind:'bonus',employerId:empA}),
 ]));
 assert.deepEqual(expectedMainSalaries(data.entries,'2026-11-17','2026-11-30').map(x=>x.amount),[215000]);
});
