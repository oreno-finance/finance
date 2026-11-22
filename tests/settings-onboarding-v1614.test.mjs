import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync('public/index.html','utf8');
const main=readFileSync('src/main.ts','utf8');
const cloud=readFileSync('src/cloud/cloud-settings.ts','utf8');
const css=readFileSync('public/styles/settings-cleanup.css','utf8');

test('settings shows OneDrive above Payroll without duplicating the sections',()=>{
  const settings=html.slice(html.indexOf('id="settings-view"'),html.indexOf('<footer>'));
  assert.ok(settings.indexOf('id="cloud-view"')<settings.indexOf('id="settings-payroll-disclosure"'));
  assert.equal(settings.match(/id="cloud-view"/g)?.length,1);
  assert.equal(settings.match(/id="settings-payroll-disclosure"/g)?.length,1);
});

test('startup sign-in invitation is a dismissible native dialog with two clear actions',()=>{
  assert.match(html,/<dialog id="cloud-connect-dialog"[^>]*aria-labelledby="cloud-connect-title"/);
  assert.match(html,/id="cloud-connect-later"[^>]*>あとで<\/button>/);
  assert.match(html,/id="cloud-connect-continue"[^>]*>Microsoftアカウントで接続<\/button>/);
  assert.match(main,/dialog\.showModal\(\)/);
  assert.match(main,/cloudConnectDismissed=true;/);
  assert.match(main,/cloud-connect-later'\)\.addEventListener\('click'/);
  assert.match(main,/connectionDialog\.addEventListener\('cancel'/);
});

test('connect invitation follows account status, not a generic network error',()=>{
  assert.match(cloud,/if\(!validId\(id\)\)return 'setup'/);
  assert.match(cloud,/if\(!msal\|\|activeId!==id\)return null/);
  assert.match(cloud,/if\(!account\(\)\)return 'connect'/);
  assert.match(cloud,/return reauthenticationRequired\?'reconnect':null/);
  assert.match(main,/showCloudConnectDialog\(cloudConnectPrompt\(\)\)/);
  assert.ok(main.indexOf('showCloudConnectDialog(cloudConnectPrompt())')>main.indexOf('async function startCloud()'));
  assert.ok(main.indexOf('showCloudConnectDialog(cloudConnectPrompt())')<main.indexOf('async function refreshCloud()'));
  assert.match(main,/if\(!mode\|\|cloudConnectDismissed\)return/);
  assert.match(main,/\$<HTMLButtonElement>\('cloud-login'\)\.click\(\)/);
});

test('manual sign-in does not ask a redundant confirmation unless there are unsaved edits',()=>{
  assert.match(cloud,/handlers\.hasUnsavedChanges\(\) && !window\.confirm/);
  assert.doesNotMatch(cloud,/Microsoftログインへ移動します。未保存の編集がある場合は破棄されます/);
  assert.match(main,/hasUnsavedChanges:\(\)=>\{const state=interruptionState\(\)/);
  assert.match(main,/canNavigate:\(\)=>confirmInterruption/);
});

test('modal has mobile-sized button layout',()=>{
  assert.match(css,/\.cloud-connect-dialog \.vault-form-actions/);
  assert.match(css,/@media\(max-width:480px\)/);
});
