import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const main = readFileSync('src/main.ts','utf8');
const fallback = readFileSync('public/scripts/startup-recovery.js','utf8');
const html = readFileSync('public/index.html','utf8');

test('OneDrive connecting status is concise and does not explain that navigation works',()=>{
  assert.match(main, /showActivity\('OneDriveに接続中…','working'\)/);
  assert.match(main, /\$\('cloud-live-status'\)\.textContent='接続中';/);
  assert.doesNotMatch(main, /設定画面は操作できます|接続確認中…|設定で認証状態・保存先を確認できます/);
  assert.match(main, /OneDriveの接続に時間がかかっています/);
});

test('Settings shows only the state under the OneDrive heading',()=>{
  assert.match(main, /const cloudIssue=cloudConnectionNotice\(\)/);
  assert.match(main, /\?cloudIssue\.message:connectionIssue\?\?state;/);
  assert.doesNotMatch(main, /label\.textContent=`OneDrive：\$\{state\}`/);
  assert.match(html, /id="cloud-live-status"/);
});

test('startup failure keeps recovery buttons without an explanatory paragraph',()=>{
  assert.match(fallback,/heading\.textContent='Financeを起動できませんでした'/);
  assert.match(fallback,/note\.textContent='';/);
  assert.doesNotMatch(fallback,/OneDriveの接続待ちではなく|設定画面を表示しました/);
  assert.match(fallback,/settings\.textContent='設定を表示'/);
  assert.match(fallback,/copy\.textContent='起動診断をコピー'/);
});
