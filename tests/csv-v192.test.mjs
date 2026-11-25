import test from 'node:test';
import assert from 'node:assert/strict';
import {identifyCardCsv,parseCardCsv,decodeCardCsv,csvCells} from '../dist/src/importers/card-csv.js';
import {cardPaymentDate,japaneseBankHoliday} from '../dist/src/importers/payment-date.js';
import {prepareStatementRevision} from '../dist/src/importers/revision-review.js';
import {duplicateStatementMonths} from '../dist/src/cloud/merge.js';
import {validateCardPreferences} from '../dist/src/cloud/assets.js';
import {planStatementImport} from '../dist/src/importers/import-policy.js';
import {importErrors} from '../dist/src/importers/batch-policy.js';

const csv=(name='三井住友カードＶＩＳＡ（ＮＬ）',amount=1200)=>[
  `架空名義,****1234,${name},,,`,
  `2026/10/3,"架空の店, 本店",${amount},1,1,${amount}`,
  `,,,,,${amount}`,'',
].join('\r\n');
const parse=(data=csv(),name='202611.csv',date='2026-11-10')=>parseCardCsv(data,name,date);
test('CSV quoted cell and escaped quotes are read without injection',()=>{
  assert.deepEqual(csvCells('a,"b, c","x""y"\r\n'),[['a','b, c','x"y']]);
  assert.throws(()=>csvCells('a,"unterminated'),/引用符/);
  assert.throws(()=>csvCells('a,"ok"garbage'),/引用符/);
});
test('realistic Vpass CSV formats identify NL, Amazon, Goldpoint even with filename suffix',()=>{
  for(const [header,cardId,name] of [
    ['三井住友カードＶＩＳＡ（ＮＬ）','smbc-nl','202611.csv'],
    ['Ａｍａｚｏｎマスター','amazon','202608a.csv'],
    ['ゴールドポイントカードプラス','goldpoint','202610 (1).csv'],
    ['Ａｍａｚｏｎマスター','amazon','202608a (2).csv'],
  ]){
    const input=csv(header);
    assert.deepEqual(identifyCardCsv(input,name),{cardId,billingMonth:name.slice(0,4)+'-'+name.slice(4,6)});
    const statement=parseCardCsv(input,name,'2026-11-10');
    assert.equal(statement.cardId,cardId);
    assert.equal(statement.sourceKind,'csv');
    assert.equal(statement.confirmation,'confirmed');
    assert.equal(statement.rows[0].merchant,'架空の店, 本店');
    assert.equal(statement.statedTotal,1200);
    assert.deepEqual(importErrors(statement,false),[]);
  }
});
test('strict totals, format and unsupported brand are rejected',()=>{
  assert.throws(()=>parse(csv().replace(',,,,,1200',',,,,,1201')),/一致しません/);
  assert.throws(()=>parse(csv('未知カード')),/対応していない/);
  assert.throws(()=>parse(csv(),'statement.csv'),/ファイル名/);
  assert.throws(()=>parse(csv().replace('2026/10/3','2026/13/3')),/利用日/);
  assert.throws(()=>parse(csv().replace('1200,1,1,1200','1200,1,1,1200,備考,未知の追加列')),/列数/);
  assert.throws(()=>decodeCardCsv(new ArrayBuffer(0)),/サイズ/);
});
test('sixth column is payable amount, even for installment rows',()=>{
  const input='架空,****1234,Ａｍａｚｏｎマスター,,,\n2026/7/21,架空店舗,6000,2,3,2000\n,,,,,2000';
  const s=parse(input,'202608a.csv','2026-08-10');
  assert.equal(s.rows[0].amount,2000);
  assert.match(s.rows[0].description,/6,000/);
  assert.deepEqual(importErrors(s,false),[]);
});
test('payment date follows contract month/day, next bank day incl Japanese holiday',()=>{
  assert.equal(cardPaymentDate('2026-11',{monthOffset:0,day:10}),'2026-11-10');
  assert.equal(cardPaymentDate('2026-09',{monthOffset:0,day:22}),'2026-09-24'); // citizen holiday, then equinox
  assert.equal(cardPaymentDate('2027-05',{monthOffset:0,day:3}),'2027-05-06'); // Golden Week
  assert.equal(cardPaymentDate('2026-12',{monthOffset:1,day:31}),'2027-02-01'); // clamp to Jan31, weekend -> Feb 1
  assert.equal(japaneseBankHoliday('2026-01-02'),true);
  assert.equal(japaneseBankHoliday('2026-11-10'),false);
  assert.throws(()=>cardPaymentDate('2026-11',{monthOffset:0,day:0}),/設定/);
});
test('card preferences validate optional encrypted payment timing',()=>{
  assert.deepEqual(validateCardPreferences({'amazon':{payment:{monthOffset:1,day:26}}}),{'amazon':{payment:{monthOffset:1,day:26}}});
  assert.throws(()=>validateCardPreferences({'amazon':{payment:{monthOffset:1,day:32}}}),/引落日/);
  assert.throws(()=>validateCardPreferences({'rakuten-mizuho':{payment:{monthOffset:0,day:10}}}),/引落日/);
  assert.deepEqual(validateCardPreferences({'amazon':{review:null}}),{'amazon':{review:null}});
});
test('revision retains unique manual display name, not a positional row number',()=>{
  const old=parse('架空,****1234,三井住友カードＶＩＳＡ（ＮＬ）,,,\n2026/10/4,A,100,1,1,100\n2026/10/3,B,200,1,1,200\n,,,,,300');
  old.sourceKind='paste';old.rows[1].merchantOverride='手動の名前';
  const fresh=parse('架空,****1234,三井住友カードＶＩＳＡ（ＮＬ）,,,\n2026/10/3,B,200,1,1,200\n2026/10/4,A,100,1,1,100\n,,,,,300');
  assert.equal(planStatementImport([old],fresh).kind,'revision'); // same content, but CSV promotion is decided by the shared import policy
  const {statement,diff}=prepareStatementRevision(old,fresh);
  assert.equal(statement.rows[0].merchantOverride,'手動の名前');
  assert.equal(statement.rows[1].merchantOverride,undefined);
  assert.equal(diff.transferred,1);
  assert.equal(diff.matched,2);
});
test('unique old notes are preserved when the CSV has no note',()=>{
  const old=parse();old.rows[0].description='手入力のメモ';
  const fresh=parse();
  const {statement,diff}=prepareStatementRevision(old,fresh);
  assert.equal(statement.rows[0].description,'手入力のメモ');
  assert.equal(diff.notesTransferred,1);
  assert.equal(diff.overridesLost.length,0);
});
test('ambiguous repeated merchant amounts do not inherit override by row position',()=>{
  const old=parse('架空,****1234,三井住友カードＶＩＳＡ（ＮＬ）,,,\n2026/10/4,A,100,1,1,100\n2026/10/4,A,100,1,1,100\n,,,,,200');
  old.rows[0].merchantOverride='片方だけ編集';
  const fresh=structuredClone(old);fresh.rows.forEach(r=>delete r.merchantOverride);
  const {statement,diff}=prepareStatementRevision(old,fresh);
  assert.equal(diff.matched,0);
  assert.equal(diff.ambiguous.length,2);
  assert.equal(diff.overridesLost.length,1);
  assert.equal(statement.rows[0].merchantOverride,undefined);
});
test('final OneDrive merge detects same month with different IDs',()=>{
  const a=parse(),b=parse();
  assert.deepEqual(duplicateStatementMonths([{id:'1',statement:a},{id:'2',statement:b}],new Set(['2'])),['smbc-nl|2026-11']);
  assert.deepEqual(duplicateStatementMonths([{id:'1',statement:a}],new Set(['1'])),[]);
  assert.deepEqual(duplicateStatementMonths([{id:'1',statement:a},{id:'2',statement:b}],new Set(['different'])),[]);
});
