/**
 * Opt-in device/browser key. Only a non-extractable Web Crypto AES-GCM CryptoKey
 * and minimum vault metadata live in IndexedDB. Financial records, passwords,
 * tokens and plaintext are never placed in this database.
 *
 * This is separate from the one-time legacy IndexedDB data import.
 */
import { validDataSetId } from './cloud-crypto.js';

const DATABASE = 'finance-remembered-browser-key-v1';
const STORE = 'keys';
const VERSION = 1;
const LOCK_FLAG = 'finance-browser-vault-manually-locked-v1';
export const CROSS_TAB_LOCK_KEY = 'finance-vault-lock-event-v1';
/** Every event is unique so repeated locks also notify already-open tabs. */
export function notifyOtherFinanceTabs(storage:Pick<Storage,'setItem'>):void {
  storage.setItem(CROSS_TAB_LOCK_KEY,crypto.randomUUID());
}

const encoder = new TextEncoder();
const clientIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const saltPattern = /^[A-Za-z0-9+/]{22}==$/;

export interface BrowserKeyContext { clientId:string; homeAccountId:string }
export interface RememberedBrowserKey { key:CryptoKey; salt:string; dataSetId:string|null }
interface StoredBrowserKey extends RememberedBrowserKey {
  id:string;
  version:1;
}

export class InvalidRememberedBrowserKeyError extends Error {
  constructor(){super('このブラウザの保存鍵が破損しています。パスフレーズで解除し、再登録してください。');this.name='InvalidRememberedBrowserKeyError';}
}

/** Opaque, account-specific store identifier. Never persist MSAL account IDs. */
async function keyId(context:BrowserKeyContext):Promise<string> {
  if(!clientIdPattern.test(context.clientId)||!context.homeAccountId||context.homeAccountId.length>512)
    throw new Error('Microsoftアカウントの確認後に操作してください。');
  const bytes=encoder.encode(`Finance remembered browser v1\0${context.clientId.toLowerCase()}\0${context.homeAccountId}`);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
}

function openDatabase():Promise<IDBDatabase> {
  if(typeof indexedDB==='undefined')return Promise.reject(new Error('このブラウザでは鍵の永続保存を利用できません。'));
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DATABASE,VERSION);
    let blocked=false;
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE,{keyPath:'id'});
    };
    request.onsuccess=()=>{if(blocked)request.result.close();else resolve(request.result);};
    request.onerror=()=>reject(request.error??new Error('ブラウザの鍵保存領域を開けません。'));
    request.onblocked=()=>{blocked=true;reject(new Error('別のタブが鍵保存領域を使用中です。'));};
  });
}

/** Resolve after transaction commit, not merely when the request succeeds. */
async function transaction<T>(mode:IDBTransactionMode,run:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db=await openDatabase();
  try {
    return await new Promise<T>((resolve,reject)=>{
      let tx:IDBTransaction;
      try{tx=db.transaction(STORE,mode);}catch(error){reject(error);return;}
      let output:T;
      const request=run(tx.objectStore(STORE));
      request.onsuccess=()=>{output=request.result;};
      tx.oncomplete=()=>resolve(output);
      tx.onerror=()=>reject(tx.error??new Error('鍵保存処理に失敗しました。'));
      tx.onabort=()=>reject(tx.error??new Error('鍵保存が中断されました。'));
    });
  }finally{db.close();}
}

export function validRememberedCryptoKey(key:unknown):key is CryptoKey {
  return typeof CryptoKey!=='undefined'&&key instanceof CryptoKey&&
    key.type==='secret'&&!key.extractable&&key.algorithm.name==='AES-GCM'&&
    (key.algorithm as AesKeyAlgorithm).length===256&&
    key.usages.includes('encrypt')&&key.usages.includes('decrypt');
}

export async function readBrowserKey(context:BrowserKeyContext):Promise<RememberedBrowserKey|null> {
  const id=await keyId(context);
  const entry=await transaction<StoredBrowserKey|undefined>('readonly',store=>store.get(id));
  if(!entry)return null;
  if(entry.version!==VERSION||entry.id!==id||!validRememberedCryptoKey(entry.key)||
      !saltPattern.test(entry.salt)||(entry.dataSetId!==null&&!validDataSetId(entry.dataSetId)))
    throw new InvalidRememberedBrowserKeyError();
  return {key:entry.key,salt:entry.salt,dataSetId:entry.dataSetId};
}
export async function isBrowserRemembered(context:BrowserKeyContext):Promise<boolean> {
  return (await readBrowserKey(context))!==null;
}
export async function rememberBrowserKey(context:BrowserKeyContext,record:RememberedBrowserKey):Promise<void> {
  const id=await keyId(context);
  if(!validRememberedCryptoKey(record.key)||!saltPattern.test(record.salt)||
      (record.dataSetId!==null&&!validDataSetId(record.dataSetId)))throw new Error('保存できない復号鍵です。');
  const entry:StoredBrowserKey={id,version:VERSION,key:record.key,salt:record.salt,dataSetId:record.dataSetId};
  await transaction<IDBValidKey>('readwrite',store=>store.put(entry));
}
export async function forgetBrowserKey(context:BrowserKeyContext):Promise<void> {
  const id=await keyId(context);
  await transaction<undefined>('readwrite',store=>store.delete(id));
}

/** Exactly one policy for unlock: save a non-extractable browser key, or revoke any earlier one. */
export async function applyBrowserRetentionChoice(context:BrowserKeyContext,remember:boolean,record?:RememberedBrowserKey):Promise<void> {
  if(remember){
    if(!record)throw new Error('記憶する鍵がありません。');
    await rememberBrowserKey(context,record);
  }else{
    await forgetBrowserKey(context);
  }
}

/** Manual lock survives reload/browser restart without storing any sensitive data. */
export function isManuallyLocked(storage:Pick<Storage,'getItem'>):boolean {
  try{return storage.getItem(LOCK_FLAG)==='1';}catch{return true;}
}
export function setManualLock(storage:Pick<Storage,'setItem'>):void { storage.setItem(LOCK_FLAG,'1'); }
export function clearManualLock(storage:Pick<Storage,'removeItem'>):void { storage.removeItem(LOCK_FLAG); }
