import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {importErrors, importDisplayErrors, cardSelectionPending} from '../dist/src/importers/batch-policy.js';
import {parseStatementText} from '../dist/src/importers/statement-parser.js';

const fixture=()=>({
  provider:'rakuten',cardId:null,sourceKind:'paste',sourceName:'架空の明細',
  billingMonth:'2026-10',paymentDate:'2026-10-27',statedTotal:3000,
  confirmation:'confirmed',warnings:[],rows:[{id:'one',usedOn:'2026-09-01',merchant:'架空店舗',amount:3000}],
});
const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/styles/layout-v1911.css',import.meta.url),'utf8');
const parser=readFileSync(new URL('../src/importers/statement-parser.ts',import.meta.url),'utf8');

test('unselected Rakuten is a pending user choice in UI, but still blocks saving',()=>{
  const s=fixture();
  assert.equal(cardSelectionPending(s),true);
  assert.deepEqual(importDisplayErrors(s,false),[]);
  assert.deepEqual(importErrors(s,false),['カード種別が不明です']);
  for(const id of ['rakuten-etc','rakuten-mizuho']){
    s.cardId=id;
    assert.equal(cardSelectionPending(s),false);
    assert.deepEqual(importErrors(s,false),[]);
    assert.deepEqual(importDisplayErrors(s,false),[]);
  }
});
test('true parsing, amount, date and wrong-account errors remain visible and block saving',()=>{
  const s=fixture();s.statedTotal=2800;s.paymentDate='2026-02-31';
  assert.deepEqual(importDisplayErrors(s,false),['支払日が不明または不正です','請求総額と明細合計が一致しません']);
  s.cardId='unrecognized-rakuten-id';
  assert.equal(cardSelectionPending(s),false);
  assert.ok(importDisplayErrors(s,false).includes('カード種別が不明です'));
});
test('import parser does not turn expected Rakuten choice into a warning',()=>{
  const example=`楽天カード株式会社\nお支払日 2026年11月27日\n2026年11月ご請求金額 1,000円\n利用日 利用店名 利用者 支払方法\n2026/10/03 ETCカード売上 ETC* 1回払い 1000 0 1000 1000 1000 0`;
  const s=parseStatementText(example,'paste','架空の楽天明細');
  assert.equal(s.provider,'rakuten');assert.equal(s.cardId,null);
  assert.ok(!s.warnings.some(w=>w.includes('楽天カードの種類')));
  assert.ok(!parser.includes("warnings.push('楽天カードの種類を特定"));
});
test('import summary, list, management and batch bar distinguish choices from red errors',()=>{
  assert.match(main,/const validationIssues=displayIssues\(s\)/);
  assert.match(main,/else if \(cardSelectionPending\(s\)\) setBadgeState\('pill info', 'カード選択待ち'\)/);
  assert.match(main,/const state = collision==='duplicate'\?'duplicate':collision\?'conflict':displayIssues\(statement\)\.length \? 'review' : cardSelectionPending\(statement\) \? 'selection'/);
  assert.match(main,/const selectionOnly = blocked\.filter/);
  assert.match(main, /selectionOnly\.length \? `\$\{selectionOnly\.length\}件のカード選択待ち`/);
  assert.match(main, /\$\('manage-validation'\)\.textContent=errors\.length\?/);
  assert.doesNotMatch(main,/別カードの明細に合算しないための確認です/);
  assert.match(css,/\.statement-flag\.selection/);
});
test('hover only animates reveal and retract; explicit toggle is still immediate',()=>{
  assert.match(css,/@keyframes finance-peek-open/);
  assert.match(css,/@keyframes finance-peek-close/);
  assert.match(css,/\.app-shell\.nav-collapsed\.nav-peeking:not\(\.nav-peek-closing\)/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(main,/function closeDesktopMenuPeek\(\):void/);
  assert.match(main,/addEventListener\('pointerleave',\(\)=>\{closeDesktopMenuPeek\(\);\}\)/);
  assert.match(main,/classList\.remove\('nav-peeking','nav-peek-closing'\)/);
  assert.match(css,/#finance-sidebar \.sidebar-meta\{transition:none!important\}/);
});
