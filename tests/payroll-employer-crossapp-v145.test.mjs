import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptPayrollSource} from '../dist/src/cloud/payroll-bridge.js';
import {validatePayrollIncome,combinePayrollIncome} from '../dist/src/cloud/payroll-income.js';
import {expectedMainSalaries} from '../dist/src/cloud/salary-projection.js';

// Synthetic, non-identifying Payroll v1 records. Never read real OneDrive/PDFs.
const companyA='emp_'+'a'.repeat(32);
const companyB='emp_'+'b'.repeat(32);
const source=(records)=>({format:'payroll-income-v1',year:'2026',records});
const record=(id,paymentDate,job,netPaymentYen,employerId,kind='salary')=>({
  id,paymentDate,targetMonth:paymentDate.slice(0,7),job,kind,netPaymentYen,revision:1,
  ...(employerId===undefined?{}:{employerId}),
});

test('Round4C: Payroll勤務先IDと本業・副業の区分は別々に維持する',()=>{
  const input=source([
    record(101,'2026-09-27','main',180000,companyA),
    record(102,'2026-10-27','main',210000,companyB),
    record(103,'2026-10-30','side',350000,companyB),
  ]);
  const output=adaptPayrollSource(input);
  assert.deepEqual(output.entries.map(item=>item.employerId),[companyA,companyB,companyB]);
  assert.deepEqual(output.entries.map(item=>item.job),['main','main','side']);
  const roundtrip=combinePayrollIncome([validatePayrollIncome(output)]);
  assert.deepEqual(roundtrip.map(item=>[item.id,item.job,item.employerId]),[
    ['pay-101','main',companyA],['pay-102','main',companyB],['pay-103','side',companyB],
  ]);
});

test('Round4C: 勤務先ID未設定の旧Payroll公開データも読み取れる',()=>{
  const output=adaptPayrollSource(source([record(111,'2026-10-27','main',190000,undefined)]));
  assert.equal(output.entries.length,1);
  assert.equal(output.entries[0].employerId,'main');
  assert.equal(Object.hasOwn(output.entries[0],'job'),false);
  assert.equal(output.entries[0].netPay,190000);
  const side=adaptPayrollSource(source([record(112,'2026-10-30','side',350000,undefined)]));
  const combined=combinePayrollIncome([validatePayrollIncome(output),validatePayrollIncome(side)]);
  assert.deepEqual(combined.map(v=>[v.employerId,Object.hasOwn(v,'job'),v.netPay]),[
    ['main',false,190000],['side',false,350000],
  ]);
  assert.deepEqual(expectedMainSalaries(combined,'2026-11-17','2026-12-31').map(v=>[v.date,v.amount,v.sourceMonth]),[
    ['2026-11-27',190000,'2026-10'],['2026-12-27',190000,'2026-10'],
  ]);
  assert.deepEqual(expectedMainSalaries(side.entries,'2026-11-17','2026-12-31'),[]);
});

test('Round4C: 不正な勤務先IDを受け入れない',()=>{
  for(const employerId of ['main','side','emp_abc','emp_'+'F'.repeat(32),'',null]){
    assert.throws(()=>adaptPayrollSource(source([
      record(121,'2026-10-27','main',190000,employerId),
    ])),undefined,String(employerId));
  }
});

test('Round4C: 本業の勤務先が切り替わっても副業実績を給与見込みに流用しない',()=>{
  const output=adaptPayrollSource(source([
    record(131,'2026-09-27','main',180000,companyA),
    record(132,'2026-10-27','main',210000,companyB),
    record(133,'2026-10-30','side',350000,companyB),
  ]));
  const forecast=expectedMainSalaries(output.entries,'2026-11-17','2026-12-31');
  assert.deepEqual(forecast.map(v=>[v.date,v.amount,v.sourceMonth]),[
    ['2026-11-27',210000,'2026-10'],['2026-12-27',210000,'2026-10'],
  ]);
});

test('Round4C: 当月の本業実績を見込みで二重計上しない',()=>{
  const output=adaptPayrollSource(source([
    record(141,'2026-10-27','main',190000,companyA),
    record(142,'2026-11-27','main',210000,companyB),
  ]));
  const forecast=expectedMainSalaries(output.entries,'2026-11-28','2026-12-31');
  assert.deepEqual(forecast.map(v=>[v.date,v.amount]),[['2026-12-27',210000]]);
});
