import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCardCsv} from '../dist/src/importers/card-csv.js';
import {importErrors} from '../dist/src/importers/batch-policy.js';
import {planStatementImport} from '../dist/src/importers/import-policy.js';

// All fixtures are synthetic. Never include imported customer statements in public tests.
const amazon='架空名義,****0000,Ａｍａｚｏｎマスター';
const nl='架空名義,****0000,三井住友カードＶＩＳＡ（ＮＬ）';
const parse=(header,lines,filename='202601.csv')=>parseCardCsv([header,...lines].join('\r\n'),filename,'2026-01-10');

test('Vpass optional seventh column keeps a genuine refund negative and its remark',()=>{
  const s=parse(amazon,[
    '2025/12/15,架空オンライン店舗,1320,１,１,1320,',
    '2025/12/20,架空オンライン店舗,-1320,１,１,-1320,返品',
    ',,,,,0,',
  ]);
  assert.deepEqual(s.rows.map(r=>r.amount),[1320,-1320]);
  assert.equal(s.rows[1].description,'返品');
  assert.equal(s.statedTotal,0);
  assert.deepEqual(s.warnings,[]);
  assert.deepEqual(importErrors(s,false),[]);
});

test('store-specific descriptions do not generate false installment warnings',()=>{
  const s=parse(nl,[
    '2025/12/21,架空コンビニ,860,１,１,860,架空支店',
    '2025/12/22,架空コンビニ,140,１,１,140,',
    ',,,,,1000,',
  ]);
  assert.equal(s.rows[0].description,'架空支店');
  assert.equal(s.rows[1].description,undefined);
  assert.deepEqual(s.warnings,[]);
});

test('cashback with exchange-rate notes is kept as a credit, not another charge',()=>{
  const s=parse(nl,[
    '2025/12/20,架空店舗,1000,1,1,1000,',
    '2025/12/21,CASHBACK EXAMPLE,-300,1,1,-300,-300.00 JPY 1.0000',
    ',,,,,700,',
  ]);
  assert.deepEqual(s.rows.map(r=>r.amount),[1000,-300]);
  assert.equal(s.rows[1].description,'-300.00 JPY 1.0000');
  assert.equal(s.statedTotal,700);
  assert.deepEqual(s.warnings,[]);
});

test('installment original purchase remains metadata, monthly billed amount remains the sum',()=>{
  const s=parse(amazon,[
    '2026/2/25,架空オンライン店舗,28980,３,１,9660,28980 0',
    '2026/2/28,架空会費,300,１,１,300,',
    ',,,,,9960,',
  ],'202603 (1).csv');
  assert.equal(s.rows[0].amount,9660);
  assert.match(s.rows[0].description,/28,980円/);
  assert.match(s.rows[0].description,/28980 0/);
  assert.equal(s.statedTotal,9960);
  assert.equal(s.warnings.length,1);
});

test('same installment purchase on separate billing months is not a duplicate',()=>{
  const m1=parse(amazon,['2026/2/25,架空店舗,28980,３,１,9660,',',,,,,9660,'],'202603 (1).csv');
  const m2=parse(amazon,['2026/2/25,架空店舗,28980,３,２,9660,',',,,,,9660,'],'202604 (1).csv');
  assert.equal(planStatementImport([m1],m2).kind,'add');
});

test('nonempty eighth column, invoice mismatch and excessive notes remain invalid',()=>{
  const template=['2025/12/20,架空店舗,700,1,1,700,備考'];
  assert.throws(()=>parse(nl,[template[0]+',隠し請求',',,,,,700,']),/列数/);
  assert.throws(()=>parse(nl,[...template,',,,,,699,']),/一致しません/);
  assert.throws(()=>parse(nl,[template[0]+'x'.repeat(510),',,,,,700,']),/備考が長すぎ/);
});
