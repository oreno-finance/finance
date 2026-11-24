import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
import {cloudConnectionNotice,cloudAuthDiagnostic,recordCloudConnectionFailure} from '../dist/src/cloud/cloud-settings.js';
import {showActivity,finishActivity} from '../dist/src/ui/activity-feedback.js';
const file=p=>readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
const IDs=['home-view','import-view','manage-view','rules-view','assets-page','future-view','summary-view',
  'analysis-view','reports-view','subscriptions-view'];

function fakeCloudDom(){
  const objects=new Map();
  return {getElementById(id){
    if(!objects.has(id))objects.set(id,{value:id==='cloud-client-id'?'12345678-1234-1234-1234-123456789abc':'',
      dataset:{},textContent:'',toggleAttribute(){},className:'',setAttribute(){}});
    return objects.get(id);
  }};
}

test('network and reauthentication failures are separate, with redacted diagnostics',()=>{
  const old=globalThis.document;globalThis.document=fakeCloudDom();
  try{
    recordCloudConnectionFailure(new GraphError(503,'private-user@example.com'));
    assert.equal(cloudConnectionNotice().kind,'network');
    assert.match(cloudConnectionNotice().message,/通信状態を確認/);
    assert.match(cloudAuthDiagnostic(),/HTTP: 503/);
    assert.doesNotMatch(cloudAuthDiagnostic(),/private|domain|@|Bearer|token/i);
    recordCloudConnectionFailure({name:'BrowserAuthError',errorCode:'interaction_required',message:'secret access token'});
    assert.equal(cloudConnectionNotice().kind,'reauth');
    assert.match(cloudConnectionNotice().message,/認証が必要/);
    assert.match(cloudAuthDiagnostic(),/interaction_required/);
    assert.doesNotMatch(cloudAuthDiagnostic(),/secret|access token/);
    recordCloudConnectionFailure({errorCode:'PRIVATE_ALPHA',message:'secret'});
    assert.equal(cloudConnectionNotice().kind,'unknown');
    assert.match(cloudAuthDiagnostic(),/unavailable/);
    assert.doesNotMatch(cloudAuthDiagnostic(),/PRIVATE_ALPHA|secret/);
  }finally{globalThis.document=old;}
});

test('every data menu delegates to a shared connection gate while settings stays available',()=>{
  const source=file('src/main.ts'),gate=file('src/ui/cloud-gate.ts');
  const css=file('public/styles/cloud-gate-v1980.css');
  for(const id of IDs)assert.match(gate,new RegExp(`id:'${id}'`));
  assert.match(source,/syncFinanceCloudGates\(\{/);
  assert.match(source,/const notice=cloudConnectionNotice\(\)/);
  assert.match(gate,/view\.classList\.toggle\('finance-cloud-gated',state\.blocked\)/);
  assert.match(gate,/appendAction\(actions,'設定を開く',state\.onSettings\)/);
  assert.match(gate,/appendAction\(actions,'保管庫を解除',state\.onUnlock,true\)/);
  assert.match(gate,/appendAction\(actions,'Microsoft認証をやり直す',state\.onReauthenticate\)/);
  assert.match(css,/max-width:none!important/);
  assert.match(css,/#assets-page/);
  assert.doesNotMatch(gate,/id:'settings-view'/);
});

test('explicit interactive Microsoft reauth uses the chosen account without sign-out',()=>{
  const cloud=file('src/cloud/cloud-settings.ts'),html=file('public/index.html');
  const start=cloud.indexOf("$('cloud-reauth').addEventListener('click'");
  const end=cloud.indexOf("$('cloud-switch-account').addEventListener('click'",start);
  assert.ok(start>0&&end>start);
  const block=cloud.slice(start,end);
  assert.match(block,/handlers\.canNavigate/);
  assert.match(block,/instance\.acquireTokenRedirect\(\{scopes:SCOPES,account:current,prompt:'login'\}\)/);
  assert.match(block,/loginRedirect\(\{scopes:SCOPES,prompt:'select_account'\}\)/);
  assert.doesNotMatch(block,/logout|localStorage\.removeItem|localStorage\.clear/);
  assert.match(html,/id="cloud-reauth"/);
  assert.match(html,/id="cloud-auth-diagnostic"/);
});

test('auth state distinguishes all five user-facing errors without raw exception text',()=>{
  const cloud=file('src/cloud/cloud-settings.ts');
  for(const text of ['Microsoftに接続できません。通信状態を確認してください',
    'Microsoftの認証が必要です。再接続してください','保存済みの認証状態を復旧できませんでした',
    '前回使用したMicrosoftアカウントを確認できません','接続を確認できません。診断情報を表示できます'])
    assert.ok(cloud.includes(text),text);
  assert.match(cloud,/errorCode/);
  assert.match(cloud,/const known=new Set/);
  assert.doesNotMatch(cloud,/localStorage\.setItem\([^,]*,\s*(?:.*accessToken|.*passphrase)/);
});

test('notification close control dismisses the notice without cancelling background tasks',()=>{
  let close;
  const classes=new Set();
  const label={textContent:''};
  const button={disabled:false,addEventListener(kind,handler){if(kind==='click')close=handler;}};
  const panel={dataset:{},classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k)},
    querySelector(sel){return sel==='.activity-message'?label:sel==='.activity-dismiss'?button:null},setAttribute(){}};
  const old=globalThis.document;globalThis.document={getElementById:id=>id==='toast'?panel:null};
  try{
    showActivity('同期中…','working');
    assert.equal(classes.has('visible'),true);
    assert.equal(typeof close,'function');
    close();
    assert.equal(classes.has('visible'),false);
    finishActivity('同期中');
    showActivity('保存完了','good');
    assert.equal(classes.has('visible'),true);
    close();
    assert.equal(classes.has('visible'),false);
  }finally{globalThis.document=old;}
});

test('toast has an accessible dismiss button and leaves bottom-right actions unobstructed',()=>{
  const html=file('public/index.html'),css=file('public/styles/activity-v199.css');
  assert.match(html,/class="activity-dismiss" aria-label="通知を閉じる"/);
  assert.match(css,/bottom:86px!important/);
  assert.match(css,/pointer-events:none/);
  assert.match(css,/activity-toast \.activity-dismiss\{pointer-events:auto/);
  assert.match(css,/\.toast\.activity-toast\{bottom:76px!important/);
});
