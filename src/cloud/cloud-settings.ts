import {requestConfirmation,confirmationPending,type ConfirmationOptions} from '../ui/modal.js';
import { createEncryptedProbe, decryptEncryptedProbe } from './test-envelope.js';
import { OneDriveTestClient, GraphError } from './onedrive-api.js';
import { clearPasswordField } from '../ui/password-fields.js';
import { showActivity, simpleActivity } from '../ui/activity-feedback.js';
import { diagnoseVaultFiles } from './vault-diagnostics.js';
import { classifyMicrosoftAuthError, selectMicrosoftAccount, coalesceSilentToken, type MicrosoftAuthFailure } from './msal-auth.js';
const CLIENT_KEY='finance-onedrive-public-client-id-v1';
const ACCOUNT_KEY='finance-msal-selected-account-v1:';
const SCOPES=['Files.ReadWrite.AppFolder'];
interface MsalAccount {homeAccountId:string;username?:string}
interface MsalResult {account:MsalAccount|null;accessToken:string}
interface MsalInstance {
  initialize():Promise<void>;handleRedirectPromise():Promise<MsalResult|null>;
  getAllAccounts():MsalAccount[];getActiveAccount():MsalAccount|null;setActiveAccount(a:MsalAccount|null):void;
  loginRedirect(r:{scopes:string[];prompt?:string;loginHint?:string}):Promise<void>;
  acquireTokenSilent(r:{scopes:string[];account:MsalAccount;forceRefresh?:boolean}):Promise<MsalResult>;
  acquireTokenRedirect(r:{scopes:string[];account:MsalAccount;prompt?:string}):Promise<void>;
  logoutRedirect(r:{account:MsalAccount;postLogoutRedirectUri:string}):Promise<void>;
}
interface MsalModule {PublicClientApplication:new(config:object)=>MsalInstance}
const $=<T extends HTMLElement>(id:string):T=>{const node=document.getElementById(id);if(!node)throw new Error(`Missing cloud element #${id}`);return node as T;};
// MSAL v5 needs a dedicated static redirect bridge. The app itself must not
// execute inside a silent-auth iframe or popup.
const appUri=()=>window.location.origin+window.location.pathname;
const redirectUri=()=>new URL('auth-bridge.html',new URL('./',window.location.href)).href;
const validId=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
let msal:MsalInstance|null=null;
let selectedAccount:MsalAccount|null=null;
let initializing:Promise<MsalInstance>|null=null;
let activeId='';let busy=false;
type AuthState='checking'|'connected'|'temporary'|'reauth'|'not-connected'|'restore'|'mismatch';
let authState:AuthState='not-connected';
let reauthenticationRequired=false;
export type CloudIssueKind='checking'|'connected'|'not-connected'|'network'|'reauth'|'restore'|'mismatch'|'unknown';
type FailureStage='initialize'|'silent-token'|'graph'|'startup';
let lastAuthIssue:{stage:FailureStage;kind:MicrosoftAuthFailure;code:string;httpStatus:number|null}|null=null;
function safeCode(error:unknown):string {
  if(!error||typeof error!=='object')return 'unavailable';
  const data=error as {errorCode?:unknown;name?:unknown};
  const code=typeof data.errorCode==='string'?data.errorCode:typeof data.name==='string'?data.name:'';
  const known=new Set(['interaction_required','login_required','consent_required','no_tokens_found',
    'no_account_error','invalid_grant','user_login_required','network_error','failed_to_fetch',
    'temporarily_unavailable','service_unavailable','monitor_window_timeout','iframe_bridge_timeout',
    'AuthError','BrowserAuthError','ServerError','InteractionRequiredAuthError','GraphError']);
  return known.has(code)?code:'unavailable';
}
function rememberFailure(error:unknown,stage:FailureStage,kind:MicrosoftAuthFailure=classifyMicrosoftAuthError(error)):void {
  const status=error instanceof GraphError?error.status:null;
  lastAuthIssue={stage,kind,code:safeCode(error),httpStatus:status};
}
/** Redacted diagnostic metadata. No account names, tokens, URLs, request bodies or response text. */
export function cloudAuthDiagnostic():string {
  const v=lastAuthIssue;
  return v?`段階: ${v.stage}\n分類: ${v.kind}\nエラーコード: ${v.code}\nHTTP: ${v.httpStatus??'なし'}`:'診断対象の接続エラーはありません。';
}
export function cloudConnectionNotice():{kind:CloudIssueKind;message:string} {
  if(authState==='restore')return {kind:'restore',message:'保存済みの認証状態を復旧できませんでした'};
  if(authState==='mismatch')return {kind:'mismatch',message:'前回使用したMicrosoftアカウントを確認できません'};
  if(authState==='reauth')return {kind:'reauth',message:'Microsoftの認証が必要です。再接続してください'};
  if(authState==='temporary')return lastAuthIssue?.kind==='network'||lastAuthIssue?.kind==='timeout'||lastAuthIssue?.kind==='server'
    ?{kind:'network',message:'Microsoftに接続できません。通信状態を確認してください'}
    :{kind:'unknown',message:'接続を確認できません。診断情報を表示できます'};
  if(authState==='checking')return {kind:'checking',message:'OneDriveの接続状態を確認しています…'};
  if(authState==='connected')return {kind:'connected',message:'Microsoftアカウントに接続済みです'};
  return {kind:'not-connected',message:'Microsoftアカウントで接続してください'};
}
/** Graph/API failures are separate from MSAL token failures. Never redirect automatically. */
export function recordCloudConnectionFailure(error:unknown):void {
  if(authState==='restore'||authState==='mismatch'||
    (lastAuthIssue?.stage==='silent-token'&&(authState==='temporary'||authState==='reauth')))return;
  const httpStatus=error instanceof GraphError?error.status:null;
  const kind:MicrosoftAuthFailure=httpStatus===401?'interaction':httpStatus===408||httpStatus===429||
    (httpStatus!==null&&httpStatus>=500)?'server':classifyMicrosoftAuthError(error);
  rememberFailure(error,'graph',kind);
  reauthenticationRequired=kind==='interaction';authState=reauthenticationRequired?'reauth':'temporary';updateUi();
}

const tokenJobs=new Map<string,Promise<string>>();
const account=():MsalAccount|null=>selectedAccount;
function priorAccountId(clientId:string):string|null {
  try{return window.localStorage.getItem(ACCOUNT_KEY+clientId);}catch{return null;}
}
function rememberAccount(clientId:string,selected:MsalAccount):void {
  // homeAccountId is an opaque account selector, never a password or token.
  try{window.localStorage.setItem(ACCOUNT_KEY+clientId,selected.homeAccountId);}catch{/* storage denied */}
}
function authStateText():string {return cloudConnectionNotice().message;}

function authErrorMessage(kind:MicrosoftAuthFailure):string {
  switch(kind){
    case 'interaction': return 'Microsoftアカウントの再認証が必要です。「再認証」を押してください。';
    case 'network': return 'ネットワークに接続できません。接続を確認して再試行してください。';
    case 'timeout': return 'Microsoft認証の確認が時間内に完了しませんでした。再試行してください。';
    case 'server': return 'Microsoft認証サービスに一時的な障害があります。再試行してください。';
    default: return 'Microsoft認証を確認できませんでした。接続状態を確認してください。';
  }
}
function status(text:string,kind:'ok'|'error'|'neutral'='neutral') {
  const el=$('cloud-status');
  el.textContent='';
  el.className='cloud-status hidden';
  if(text)simpleActivity(text,kind==='error');
}
function updateUi():void {
  const id=$<HTMLInputElement>('cloud-client-id').value.trim();const connected=!!account()&&activeId===id;
  $('cloud-save-id').toggleAttribute('disabled',busy||!validId(id));
  // A cached MSAL account is not proof of a working token or the intended OneDrive account.
  // Keep explicit reconnect available even if the cached account looks connected.
  $('cloud-login').toggleAttribute('disabled',busy);
  $('cloud-reauth').toggleAttribute('disabled',busy||!validId(id));
  const diagnostic=$('cloud-auth-diagnostic');diagnostic.textContent=cloudAuthDiagnostic();diagnostic.hidden=!lastAuthIssue;
  // Recovery remains available in failure states and through account switching,
  // without competing with the normal vault actions on a healthy connection.
  $('cloud-login').classList.toggle('hidden',connected&&authState==='connected');
  $('cloud-reauth').classList.toggle('hidden',authState==='connected'||authState==='checking'||authState==='not-connected');
  $('cloud-switch-account').toggleAttribute('disabled',busy);
  $('cloud-login').textContent=connected?'通信再試行':'Microsoft接続';
  $('cloud-logout').toggleAttribute('disabled',busy||!connected);
  $('cloud-logout').hidden=!connected;
  $('cloud-folder-check').toggleAttribute('disabled',busy||!connected);
  $('cloud-vault-diagnose').toggleAttribute('disabled',busy||!connected);
  $('cloud-diagnostic-copy').toggleAttribute('disabled',busy||!$('cloud-diagnostic-report').textContent?.trim());
  $('cloud-upload').toggleAttribute('disabled',busy||!connected);
  $('cloud-download').toggleAttribute('disabled',busy||!connected);
  $('cloud-account').textContent=connected?(account()?.username||''):'';
  $('cloud-account').hidden=!$('cloud-account').textContent;
  const state=$('cloud-auth-state');state.textContent=authState==='connected'?'接続済み':authState==='checking'?'確認中':authState==='not-connected'?'未接続':authStateText();
  state.dataset.state=authState;
}
async function ensureMsal():Promise<MsalInstance> {
  const id=$<HTMLInputElement>('cloud-client-id').value.trim();
  if(!validId(id))throw new Error('Microsoft Entraで取得したClient IDを設定してください。');
  if(msal&&activeId===id)return msal;
  if(initializing)return initializing;
  authState='checking';updateUi();
  initializing=(async()=>{
    let lib:MsalModule;
    try {const url=new URL('../../vendor/msal/msal-browser.bundle.js',import.meta.url).href;lib=await import(url) as MsalModule;}
    catch {throw new Error('認証機能を読み込めませんでした。ページを再読み込みしてください。');}
    const instance=new lib.PublicClientApplication({
      auth:{clientId:id,authority:'https://login.microsoftonline.com/consumers',redirectUri:redirectUri(),postLogoutRedirectUri:appUri(),navigateToLoginRequestUrl:false},
      cache:{cacheLocation:'localStorage'},
    });
    await instance.initialize();
    let redirect:MsalResult|null;
    try{redirect=await instance.handleRedirectPromise();}
    catch(error){rememberFailure(error,'initialize');authState='restore';updateUi();throw new Error('保存済みの認証状態を復旧できませんでした');}
    const previous=priorAccountId(id);
    const all=instance.getAllAccounts();
    const active=selectMicrosoftAccount(all,redirect?.account??null,previous,instance.getActiveAccount());
    const mismatched=!!previous&&!active&&!redirect;
    if(mismatched){rememberFailure({name:'AccountMismatch'},'initialize','unknown');}

    instance.setActiveAccount(active);
    selectedAccount=active;
    if(active)rememberAccount(id,active);
    msal=instance;activeId=id;
    authState=active?'checking':mismatched?'mismatch':'not-connected';
    return instance;
  })();
  try{return await initializing;}
  catch(error){if((authState as AuthState)!=='restore'){rememberFailure(error,'initialize');authState='restore';updateUi();}throw error;}
  finally{initializing=null;}

}
/** Coalesce requests for the same account/refresh mode. The MSAL cache handles
 * token lifetime; a Finance Graph client never persists a token string. */
async function silentToken(instance:MsalInstance,user:MsalAccount,forceRefresh=false):Promise<string> {
  if(account()?.homeAccountId!==user.homeAccountId)throw new Error('Microsoftアカウントが切り替わりました。再接続してください。');
  const requestId=`${activeId}:${user.homeAccountId}:${forceRefresh?'refresh':'cached'}`;
  return coalesceSilentToken(tokenJobs,requestId,async()=>{
    let result:MsalResult;
    try{
      result=await instance.acquireTokenSilent({scopes:SCOPES,account:user,...(forceRefresh?{forceRefresh:true}:{})});
    }catch(error){
      const kind=classifyMicrosoftAuthError(error);
      rememberFailure(error,'silent-token',kind);
      reauthenticationRequired=kind==='interaction';
      authState=kind==='interaction'?'reauth':'temporary';
      updateUi();
      throw new Error(authErrorMessage(kind));
    }
    if(account()?.homeAccountId!==user.homeAccountId||
       (result.account&&result.account.homeAccountId!==user.homeAccountId))
      throw new Error('Microsoftアカウントが切り替わりました。再接続してください。');
    reauthenticationRequired=false;lastAuthIssue=null;authState='connected';updateUi();
    return result.accessToken;
  });
}

/** No redirect from data operations, including background startup or writes.
 * Only user-initiated explicit connection actions may start an interactive flow. */
export async function graphClientWithoutRedirect():Promise<OneDriveTestClient> {
  const instance=await ensureMsal();const selected=account();
  if(!selected){authState='not-connected';updateUi();throw new Error('Microsoftアカウントが未接続です。設定の「接続」からログインしてください。');}
  const clientId=activeId;
  const provider=async(forceRefresh=false):Promise<string>=>{
    if(clientId!==activeId||account()?.homeAccountId!==selected.homeAccountId)
      throw new Error('Microsoftアカウントが切り替わりました。データをロックして再接続してください。');
    const token=await silentToken(instance,selected,forceRefresh);
    if(clientId!==activeId||account()?.homeAccountId!==selected.homeAccountId)
      throw new Error('Microsoftアカウントが切り替わりました。データをロックして再接続してください。');
    return token;
  };
  await provider();
  return new OneDriveTestClient(provider,undefined,()=>{
    reauthenticationRequired=true;authState='reauth';updateUi();
  });
}
/** Kept for existing callers. No unattended redirects from financial operations. */
export async function graphClient():Promise<OneDriveTestClient> {
  return graphClientWithoutRedirect();
}
/** Stable MSAL account identity for local key binding; never persist its raw value. */
export function activeMicrosoftAccountId():string|null {
  const id=$<HTMLInputElement>('cloud-client-id').value.trim();
  return msal&&activeId===id?(account()?.homeAccountId??null):null;
}

export type CloudConnectPrompt = 'setup' | 'connect' | 'reconnect' | null;
/** Only offer login after the account state is known; network failures are not sign-out. */
export function cloudConnectPrompt():CloudConnectPrompt {
  const id=$<HTMLInputElement>('cloud-client-id').value.trim();
  if(!validId(id))return 'setup';
  if(!msal||activeId!==id)return null;
  if(reauthenticationRequired||authState==='mismatch'||authState==='restore')return 'reconnect';
  if(!account())return 'connect';
  return null;
}
export interface CloudHandlers {hasUnsavedChanges():boolean;canNavigate?():boolean|Promise<boolean>;confirmationContext():()=>boolean;onRefresh():Promise<void>;onMigration():Promise<void>;onLock():boolean|Promise<boolean>;onChangePassphrase(current:string,next:string,onProgress:(message:string)=>void):Promise<void>;onCleanupPreview():Promise<{generationCount:number;legacyFolderCount:number;unreferencedOriginalCount:number;legacyV1Count:number;snapshots:Array<{id:string;name:string;createdDateTime:string}>}>;onCleanupDelete(which:{oldGenerations:boolean;unreferencedOriginals:boolean;unversionedFolders:boolean;legacyV1:boolean;snapshotIds:string[]},onProgress:(message:string)=>void):Promise<number>}
export function initCloudSettings(handlers:CloudHandlers):void {
  let id='';try{id=localStorage.getItem(CLIENT_KEY)??'';}catch{ /* private browsing */ }
  $<HTMLInputElement>('cloud-client-id').value=id;
  // New installations show the only setup fields automatically; connected users see a tidy overview.
  if(!validId(id)) $<HTMLDetailsElement>('cloud-advanced').open=true;
  $<HTMLInputElement>('cloud-redirect-uri').value=redirectUri();
  $<HTMLInputElement>('cloud-client-id').addEventListener('input',()=>{updateUi();});
  const confirmationOwner={};
  function authContext():()=>boolean {
    const instance=msal,id=activeId,user=account()?.homeAccountId,input=$<HTMLInputElement>('cloud-client-id').value.trim(),stored=localStorage.getItem(CLIENT_KEY);
    return ()=>instance===msal&&id===activeId&&user===account()?.homeAccountId&&input===$<HTMLInputElement>('cloud-client-id').value.trim()&&stored===localStorage.getItem(CLIENT_KEY);
  }
  async function confirmAction(options:Omit<ConfirmationOptions,'owner'>):Promise<boolean> {
    const auth=authContext(),valid=handlers.confirmationContext();
    return await requestConfirmation({...options,owner:confirmationOwner})&&auth()&&valid();
  }
  async function action(fn:()=>Promise<void>):Promise<void> {
    if(busy||confirmationPending())return;busy=true;updateUi();
    try{await fn();}catch(error){const reason=error instanceof Error?error.message:'不明なエラー';status(reason,'error');}
    finally{busy=false;updateUi();}
  }
  $('cloud-save-id').addEventListener('click',()=>{void action(async()=>{
    const value=$<HTMLInputElement>('cloud-client-id').value.trim();
    if(!validId(value))throw new Error('Client IDの形式が不正です。');
    if(account()&&activeId!==value)throw new Error('先に現在のMicrosoftアカウントからサインアウトしてください。');
    localStorage.setItem(CLIENT_KEY,value);
    status('Client IDを保存しました。パスフレーズは保存していません。','ok');
  });});
  $('cloud-login').addEventListener('click',()=>{void action(async()=>{
    const value=$<HTMLInputElement>('cloud-client-id').value.trim();
    if(!validId(value)){
      $<HTMLDetailsElement>('cloud-advanced').open=true;
      $<HTMLInputElement>('cloud-client-id').focus();
      throw new Error('先にMicrosoft EntraのClient IDを入力して保存してください。');
    }
    if(localStorage.getItem(CLIENT_KEY)!==value)throw new Error('先にClient IDを保存してください。');
    const instance=await ensureMsal();
    const current=account();
    // Re-use valid auth without navigating. A network failure never launches login.
    if(current){
      try{
        await graphClientWithoutRedirect();
        await handlers.onRefresh();
        status('OneDriveに接続済みです。','ok');
        return;
      }catch(error){recordCloudConnectionFailure(error);if(!reauthenticationRequired)throw error;}
    }
    const auth=authContext(),valid=handlers.confirmationContext();
    if(handlers.canNavigate){if(!await handlers.canNavigate())return;}
    else if(handlers.hasUnsavedChanges()&&!await confirmAction({title:'認証画面へ移動しますか？',message:'未保存の変更があります。',acceptLabel:'認証へ進む',destructive:true}))return;
    if(!auth()||!valid()||instance!==msal||current?.homeAccountId!==account()?.homeAccountId)return;
    await instance.loginRedirect({scopes:SCOPES,...(current?.username?{loginHint:current.username}:{}),...(!current&&authState==='mismatch'?{prompt:'select_account'}:{})});
  });});
  $('cloud-reauth').addEventListener('click',()=>{void action(async()=>{
    const value=$<HTMLInputElement>('cloud-client-id').value.trim();
    if(!validId(value)||localStorage.getItem(CLIENT_KEY)!==value)
      throw new Error('先にMicrosoft EntraのClient IDを設定・保存してください。');
    const instance=await ensureMsal();
    const auth=authContext(),valid=handlers.confirmationContext();
    if(handlers.canNavigate){if(!await handlers.canNavigate())return;}
    else if(handlers.hasUnsavedChanges()&&!await confirmAction({title:'Microsoft認証をやり直しますか？',message:'未保存の変更があります。',acceptLabel:'再認証する',destructive:true}))return;
    if(!auth()||!valid()||instance!==msal)return;
    const current=account();
    // Explicitly interactive even if cached credentials exist. No sign-out,
    // no clearing another account's cached token, no unattended redirect.
    if(current)await instance.acquireTokenRedirect({scopes:SCOPES,account:current,prompt:'login'});
    else await instance.loginRedirect({scopes:SCOPES,prompt:'select_account'});
  });});
  $('cloud-switch-account').addEventListener('click',()=>{void action(async()=>{
    const instance=await ensureMsal();
    const auth=authContext();
    if(!await confirmAction({title:'Microsoftアカウントを切り替えますか？',message:'現在の保管庫をロックします。',acceptLabel:'切り替える'})||!auth())return;
    if(!await handlers.onLock()||!auth())return;
    // Only an explicit account switch asks Microsoft to show the selector.
    await instance.loginRedirect({scopes:SCOPES,prompt:'select_account'});
  });});
  $('cloud-logout').addEventListener('click',()=>{void action(async()=>{
    const user=account();if(!msal||!user)return;
    const instance=msal,auth=authContext();
    if(!await confirmAction({title:'Microsoftアカウントからサインアウトしますか？',message:'現在の保管庫をロックします。未保存の変更は失われます。',acceptLabel:'サインアウト',destructive:true})||!auth())return;
    if(!await handlers.onLock()||!auth())return;
    await instance.logoutRedirect({account:user,postLogoutRedirectUri:appUri()});
  });});
  $('cloud-folder-check').addEventListener('click',()=>{void action(async()=>{
    const button=$<HTMLButtonElement>('cloud-folder-check');
    button.textContent='確認中…';
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      // A GET to the app folder, not an upload and not a redirect to sign-in.
      const request=(async()=>{await (await graphClientWithoutRedirect()).appFolderId();})();
      await Promise.race([request,new Promise<void>((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('接続確認が時間内に完了しませんでした。ネットワークを確認してください。')),15000);
      })]);
      status('保存先にアクセスできました。','ok');
    }finally {
      if(timer)clearTimeout(timer);
      button.textContent='保存先を確認';
    }
  });});
  $('cloud-vault-diagnose').addEventListener('click',()=>{void action(async()=>{
    const target=$('cloud-diagnostic-report');
    const password=$<HTMLInputElement>('cloud-diagnostic-secret').value;
    target.textContent='診断中…';
    try {
      const result=await diagnoseVaultFiles(await graphClient(),password,message=>{target.textContent=message;});
      target.textContent=result.report;
      status(result.ok?'読み取り専用診断が完了しました。':'診断で確認できないファイルが見つかりました。','neutral');
    } catch(error) {
      // A failed network/authorization operation is not a license to expose its raw response.
      target.textContent='読み取り専用診断を完了できませんでした。\n認証・ネットワーク接続をご確認ください。';
      throw error;
    }finally{clearPasswordField('cloud-diagnostic-secret');}
  });});
  $('cloud-diagnostic-copy').addEventListener('click',()=>{void action(async()=>{
    const value=$('cloud-diagnostic-report').textContent??'';
    if(!value.trim())throw new Error('先に診断を実行してください。');
    await navigator.clipboard.writeText(value);
    status('診断結果をコピーしました。内容にパスフレーズ・暗号文・ファイルIDは含めていません。','ok');
  });});
  $('cloud-upload').addEventListener('click',()=>{void action(async()=>{
    const input=$<HTMLInputElement>('cloud-passphrase');
    try {
    if(input.value.length<12)throw new Error('テスト用パスフレーズは12文字以上で入力してください。');
    const valid=handlers.confirmationContext(),auth=authContext(),password=input.value;
    if(!await confirmAction({title:'暗号化テストファイルを保存しますか？',message:'金融データを含まない暗号化テストファイルをOneDriveに保存します。',acceptLabel:'保存する'})||!valid()||!auth()||input.value!==password)return;
    const {encrypted,probe}=await createEncryptedProbe(password);
    if(!valid()||!auth()||input.value!==password)return;
    const client=await graphClient();
    if(!valid()||!auth()||input.value!==password)return;
    await client.uploadEncryptedProbe(encrypted);
    $('cloud-probe-result').textContent=`アップロード成功：${probe.createdAt} / ID ${probe.nonce}`;
    status('暗号化テストデータをアップロードしました。','ok');
    } finally {clearPasswordField('cloud-passphrase');}
  });});
  $('cloud-download').addEventListener('click',()=>{void action(async()=>{
    const input=$<HTMLInputElement>('cloud-passphrase');
    try {
    const probe=await decryptEncryptedProbe(await (await graphClient()).downloadEncryptedProbe(),input.value);
    $('cloud-probe-result').textContent=`復号成功：${probe.createdAt} / ID ${probe.nonce}`;
    status('OneDriveから暗号化ファイルを取得し、復号できました。','ok');
    } finally {clearPasswordField('cloud-passphrase');}
  });});
  const cleanupScan=$<HTMLButtonElement>('cloud-cleanup-scan');
  const cleanupDelete=$<HTMLButtonElement>('cloud-cleanup-delete');
  const cleanupOptions=$('cloud-cleanup-options');
  const cleanupResult=$('cloud-cleanup-result');
  const oldGenerations=$<HTMLInputElement>('cloud-cleanup-versions');
  const unreferencedOriginals=$<HTMLInputElement>('cloud-cleanup-originals');
  const unversionedFolders=$<HTMLInputElement>('cloud-cleanup-legacy');
  const legacyV1=$<HTMLInputElement>('cloud-cleanup-v1');
  const snapshotList=$('cloud-cleanup-snapshot-list');
  const backupConfirmed=$<HTMLInputElement>('cloud-cleanup-backup');
  let cleanupCounts:{generationCount:number;legacyFolderCount:number;unreferencedOriginalCount:number;legacyV1Count:number;snapshots:Array<{id:string;name:string;createdDateTime:string}>}|null=null;
  let cleanupContext:(()=>boolean)|null=null;
  const selectedSnapshots=()=>Array.from(snapshotList.querySelectorAll<HTMLInputElement>('input[data-snapshot-id]:checked')).map(input=>input.dataset.snapshotId!);
  function invalidateCleanup():void {
    cleanupCounts=null;cleanupContext=null;cleanupOptions.classList.add('hidden');cleanupDelete.disabled=true;
    oldGenerations.checked=false;unreferencedOriginals.checked=false;unversionedFolders.checked=false;legacyV1.checked=false;backupConfirmed.checked=false;
    snapshotList.replaceChildren();
  }
  function updateCleanupDelete():void {
    cleanupDelete.disabled=!cleanupCounts||!backupConfirmed.checked||
      !(oldGenerations.checked&&cleanupCounts.generationCount||unreferencedOriginals.checked&&cleanupCounts.unreferencedOriginalCount||unversionedFolders.checked&&cleanupCounts.legacyFolderCount||legacyV1.checked&&cleanupCounts.legacyV1Count||selectedSnapshots().length);
  }
  for(const checkbox of [oldGenerations,unreferencedOriginals,unversionedFolders,legacyV1,backupConfirmed])
    checkbox.addEventListener('change',updateCleanupDelete);
  snapshotList.addEventListener('change',updateCleanupDelete);
  cleanupScan.addEventListener('click',()=>{void action(async()=>{
    invalidateCleanup();cleanupResult.textContent='暗号化ファイルを確認中…';cleanupScan.disabled=true;
    try {
      const valid=handlers.confirmationContext(),auth=authContext();
      const counts=await handlers.onCleanupPreview();
      if(!valid()||!auth())throw new Error('確認中に保管庫が変更されました。再調査してください。');
      cleanupCounts=counts;cleanupContext=()=>valid()&&auth();
      $('cloud-cleanup-original-count').textContent=`（${counts.unreferencedOriginalCount}件）`;
      $('cloud-cleanup-version-count').textContent=`（${counts.generationCount}世代）`;
      $('cloud-cleanup-legacy-count').textContent=`（${counts.legacyFolderCount}フォルダ）`;
      $('cloud-cleanup-v1-count').textContent=`（${counts.legacyV1Count}件）`;
      for(const item of counts.snapshots){
        const label=document.createElement('label');label.className='rules-check';
        const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.snapshotId=item.id;
        label.append(checkbox,document.createTextNode(` ${item.createdDateTime.slice(0,10)} / ${item.name}`));
        snapshotList.append(label);
      }
      if(!counts.snapshots.length)snapshotList.textContent='スナップショットはありません。';
      unreferencedOriginals.disabled=counts.unreferencedOriginalCount===0;
      oldGenerations.disabled=counts.generationCount===0;
      unversionedFolders.disabled=counts.legacyFolderCount===0;
      legacyV1.disabled=counts.legacyV1Count===0;
      cleanupOptions.classList.remove('hidden');
      cleanupResult.textContent='確認が完了しました。必要な種類だけ選択して削除できます。';
      updateCleanupDelete();
    }catch(error){cleanupResult.textContent=error instanceof Error?error.message:'確認に失敗しました。';throw error;}
    finally{cleanupScan.disabled=false;}
  });});
  cleanupDelete.addEventListener('click',()=>{void action(async()=>{
    if(!cleanupCounts||!cleanupContext?.()||!backupConfirmed.checked)throw new Error('対象を調査し、バックアップを確認してください。');
    const which={oldGenerations:oldGenerations.checked,unreferencedOriginals:unreferencedOriginals.checked,unversionedFolders:unversionedFolders.checked,legacyV1:legacyV1.checked,snapshotIds:selectedSnapshots()};
    const count=(which.oldGenerations?cleanupCounts.generationCount:0)+
      (which.unreferencedOriginals?cleanupCounts.unreferencedOriginalCount:0)+(which.unversionedFolders?cleanupCounts.legacyFolderCount:0)+(which.legacyV1?cleanupCounts.legacyV1Count:0)+which.snapshotIds.length;
    if(!count)return;
    const preview=cleanupCounts;
    if(!await confirmAction({title:'OneDriveの不要データを削除しますか？',message:`${count}件（世代フォルダはフォルダ単位）の暗号化データをOneDriveから削除します。復旧ができなくなる場合があります。すべての端末を最新版に更新し、旧版のタブを閉じてから実行してください。新版索引に切り替わると旧版では解除できません。`,acceptLabel:'削除する',destructive:true,requiredText:'削除'}))return;
    if(cleanupCounts!==preview||!cleanupContext?.()||!backupConfirmed.checked||JSON.stringify(which)!==JSON.stringify({oldGenerations:oldGenerations.checked,unreferencedOriginals:unreferencedOriginals.checked,unversionedFolders:unversionedFolders.checked,legacyV1:legacyV1.checked,snapshotIds:selectedSnapshots()}))throw new Error('削除対象が変更されました。再確認してください。');
    invalidateCleanup();cleanupScan.disabled=true;
    try{
      const removed=await handlers.onCleanupDelete(which,message=>{cleanupResult.textContent=message;});
      cleanupResult.textContent=`${removed}件の削除が完了しました。必要なら再確認してください。`;
    }catch(error){cleanupResult.textContent=error instanceof Error?error.message:'削除結果を確認できません。再度調べてください。';throw error;}
    finally{cleanupScan.disabled=false;}
  });});
  $('cloud-rotate-form').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
    const current=$<HTMLInputElement>('cloud-current-secret').value;
    const next=$<HTMLInputElement>('cloud-next-secret').value;
    const confirm=$<HTMLInputElement>('cloud-next-confirm').value;
    const message=$('cloud-rotate-status');
    if(next.length<12)throw new Error('新しいパスフレーズは12文字以上にしてください。');
    if(next!==confirm)throw new Error('確認用のパスフレーズが一致しません。');
    if(current===next)throw new Error('現在と異なるパスフレーズを指定してください。');
    if(!await confirmAction({title:'暗号化パスフレーズを変更しますか？',message:'OneDrive内の明細・PDF原本・設定を再暗号化します。すべての端末を最新版に更新し、旧版のタブを閉じてください。新版索引に切り替わると旧版では解除できません。',acceptLabel:'再暗号化する',destructive:true}))return;
    if(current!==$<HTMLInputElement>('cloud-current-secret').value||next!==$<HTMLInputElement>('cloud-next-secret').value||confirm!==$<HTMLInputElement>('cloud-next-confirm').value)throw new Error('入力内容が変更されました。再確認してください。');
    const button=$<HTMLButtonElement>('cloud-rotate-submit');
    button.disabled=true;
    message.className='cloud-status';
    try{
      await handlers.onChangePassphrase(current,next,text=>{message.textContent='';showActivity(text,'working');});
      invalidateCleanup();
      for(const id of ['cloud-current-secret','cloud-next-secret','cloud-next-confirm'])clearPasswordField(id);
      message.textContent='';
      message.className='cloud-status ok';
      // The passphrase form stays visible after successful changes. /* finance-v145 */
      status('暗号化パスフレーズを変更しました。','ok');
    }catch(error){
      message.textContent='';
      message.className='cloud-status error';
      throw error;
    }finally{
      for(const id of ['cloud-current-secret','cloud-next-secret','cloud-next-confirm'])clearPasswordField(id);
      button.disabled=false;
    }
  });});
  $('cloud-live-refresh').addEventListener('click',()=>{void action(async()=>{await handlers.onRefresh();status('OneDriveから最新データを読み込みました。','ok');});});
  $('cloud-live-migrate').addEventListener('click',()=>{void action(handlers.onMigration);});
  $('cloud-live-lock').addEventListener('click',()=>{void action(async()=>{await handlers.onLock();});});
  updateUi();
  // Passive startup must not set the global 'busy' flag, otherwise a stalled
  // MSAL initialization disables reconnect/diagnostics in Settings indefinitely.
  if(id&&validId(id))void ensureMsal().then(()=>updateUi()).catch(error=>{
    authState='temporary';
    status(`認証ライブラリの初期化に失敗しました：${error instanceof Error?error.message:'不明なエラー'}`,'error');
    updateUi();
  });
}
