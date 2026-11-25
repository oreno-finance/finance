import {shippedSheet} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseStatementText} from '../dist/src/importers/statement-parser.js';
import {importErrors,importDisplayErrors,cardSelectionPending} from '../dist/src/importers/batch-policy.js';
import {payrollPassphraseUpdate} from '../dist/src/ui/assets-settings.js';

const source = path => readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const smbc = merchant => `三井住友カード
2026年12月28日お支払い分のご利用明細
2026年12月 支払い予定分のご利用明細合計
**100円**
| ご利用日 | ご利用店名 | カード | 支払区分 | 分割回数 | 支払予定月 | ご利用金額 |
| 26/11/10 | ${merchant} | ご本人 | 1回払い | | 26/12 | 100 |`;

test('Vpass Amazon purchases on NL cannot cause Amazon-card auto-assignment',()=>{
  const statement=parseStatementText(smbc('ＡＭＡＺＯＮ．ＣＯ．ＪＰ'),'paste','架空のNLカード明細');
  assert.equal(statement.provider,'smbc');
  assert.equal(statement.cardId,null);
  assert.equal(statement.rows.length,1);
  assert.equal(statement.rows[0].amount,100);
  assert.ok(!statement.warnings.some(w=>/利用先から推定/.test(w)));
  assert.equal(cardSelectionPending(statement),true);
  assert.deepEqual(importDisplayErrors(statement,false),[]);
  assert.ok(importErrors(statement,false).includes('カード種別が不明です'));
  for(const card of ['smbc-nl','amazon']){
    const chosen={...statement,cardId:card};
    assert.equal(cardSelectionPending(chosen),false);
    assert.deepEqual(importErrors(chosen,false),[]);
  }
});

test('Vpass Amazon-card statement with non-Amazon merchants also requires explicit choice',()=>{
  const statement=parseStatementText(smbc('架空コンビニ'),'pdf','架空のAmazonカード明細');
  assert.equal(statement.cardId,null);
  assert.equal(cardSelectionPending(statement),true);
  // A PDF import must also retain the real check for its original file.
  assert.deepEqual(importDisplayErrors(statement,false),['PDF原本がありません']);
  assert.deepEqual(importDisplayErrors(statement,true),[]);
});

test('unknown provider and invalid cards are real errors, not a pending Vpass choice',()=>{
  const statement=parseStatementText(smbc('テスト店'),'paste','架空の明細');
  assert.equal(cardSelectionPending({...statement,provider:'unknown'}),false);
  assert.ok(importDisplayErrors({...statement,provider:'unknown'},false).includes('カード種別が不明です'));
  assert.ok(importDisplayErrors({...statement,cardId:'wrong-card'},false).includes('カード種別が不明です'));
});

test('Vpass card choice UI matches Rakuten selectable cards and is wired to import draft',()=>{
  const html=source('public/index.html');
  const main=source('src/main.ts');
  const css=source('public/styles/layout-v1911.css');
  assert.match(html,/id="import-smbc-choice"[^>]+class="import-rakuten-choice hidden"/);
  for(const id of ['smbc-nl','amazon'])assert.match(html,new RegExp('name="import-smbc-card" value="'+id+'"'));
  assert.match(main,/smbcChoice\.classList\.toggle\('hidden',s\.provider!=='smbc'\|\|s\.sourceKind==='csv'\)/);
  assert.match(main,/\$\('import-smbc-choice'\)\.addEventListener\('change'/);
  assert.match(main,/s\.cardId=input\.value;\s*markDirty\(s\)/);
  assert.match(css,/\.import-rakuten-choice label\.card-setting-choice:has\(input:checked\)/);
  assert.match(main,/cardSelectionPending\(s\)/);
});

const saved='TEST-ONLY saved payroll password 123456789';
const newSecret='TEST-ONLY new payroll password 987654321';
test('Payroll UI credential actions: saved password reused => no cloud settings write',()=>{
  assert.equal(payrollPassphraseUpdate('',saved),undefined);
  assert.equal(payrollPassphraseUpdate(saved,saved),undefined);
  assert.equal(payrollPassphraseUpdate(newSecret,saved),newSecret);
  assert.equal(payrollPassphraseUpdate(newSecret,null),newSecret);
  assert.equal(payrollPassphraseUpdate('',null),undefined);
});

test('Payroll manual submit uses saved credential and keeps fetched income after settings-write failure',()=>{
  const code=source('src/ui/assets-settings.ts');
  assert.match(code,/\$\<HTMLFormElement\>\('assets-payroll-connect'\)\.addEventListener\('submit',event=>\{event\.preventDefault\(\);void syncPayroll\(\);\}\)/);
  assert.match(code,/const secret=entered\|\|\(\(payrollSession&&payrollOwner===vault\)\?'':saved\?\?''\)/);
  assert.match(code,/const action=payrollPassphraseUpdate\(entered,saved\)/);
  assert.match(code,/if\(action!==undefined\)await vault\.setPayrollAutoPassphrase\(action\)/);
  assert.match(code,/payrollSession=session;payrollOwner=vault;payrollIncome=items;payrollSynced=true;payrollSyncedAt=Date\.now\(\);/);
  assert.match(code,/catch\(error\)\{credentialError=error;\}/);
  assert.match(code,/取得済みの給与情報は維持しています/);
});

test('Gitleaks action pins existing 64-character digest and blocks deployment on security failure',()=>{
  const yml=source('.github/workflows/pages.yml');
  const match=/ghcr\.io\/gitleaks\/gitleaks@sha256:([a-f0-9]+)/.exec(yml);
  assert.ok(match);assert.equal(match[1].length,64);
  assert.equal(match[1],'b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb');
  assert.match(yml,/deploy:\s+needs: security/);
});

test('Settings 720px CSS breakpoint is not preceded by unfinished selector; generated CSS agrees',()=>{
  const original=source('public/styles/settings-v194.css');
  const built=shippedSheet('settings-v194.css');
  assert.equal(built,original);
  assert.doesNotMatch(original,/\.settings-card-picker\s+\.settings-card-picker\s+@media/);
  assert.match(original,/\n@media\(max-width:720px\)\{/);
  assert.equal((original.match(/\{/g)||[]).length,(original.match(/\}/g)||[]).length);
});
