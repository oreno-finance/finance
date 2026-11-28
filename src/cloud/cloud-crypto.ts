import { emptyDocument, validateCloudDocument, type CloudDocument } from './merge.js';
import { validateRules, type MerchantRulesDocument } from './merchant-rules.js';
import { validateIndex, type FinanceIndex } from './layout.js';
import { validateAssets, type AssetsDocument } from './assets.js';
const enc=new TextEncoder();
const dec=new TextDecoder('utf-8',{fatal:true});
const DOMAIN=enc.encode('Finance OneDrive cloud vault v1');
const ORIGINAL_DOMAIN=enc.encode('Finance OneDrive PDF original v1');
const INDEX_DOMAIN=enc.encode('Finance OneDrive index v1');
const RULES_DOMAIN=enc.encode('Finance OneDrive merchant rules v1');
const ASSETS_DOMAIN=enc.encode('Finance OneDrive assets settings v1');
const ITERATIONS=310000;
export interface CloudEnvelope {format:'finance-cloud-envelope-v1';salt:string;iterations:number;iv:string;data:string}
export interface OriginalEnvelope {format:'finance-cloud-original-v1';iv:string;data:string}
export type IndexEnvelope = {format:'finance-cloud-index-envelope-v1'|'finance-cloud-index-envelope-v2'|'finance-cloud-index-envelope-v3'|'finance-cloud-index-envelope-v4';salt:string;iterations:number;iv:string;data:string;dataSetId?:string};
export const validDataSetId=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
function b64(bytes:Uint8Array):string {let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);}
function un64(text:string):Uint8Array<ArrayBuffer> {if(typeof text!=='string'||text.length>220_000_000)throw new Error('暗号データが不正です。');return new Uint8Array(Uint8Array.from(atob(text),c=>c.charCodeAt(0)));}
export function freshSalt():string{return b64(crypto.getRandomValues(new Uint8Array(16)));}
export async function deriveCloudKey(passphrase:string,salt:string):Promise<CryptoKey> {
  if(!passphrase)throw new Error('パスフレーズを入力してください。');
  const bytes=un64(salt);if(bytes.length!==16)throw new Error('暗号化ソルトが不正です。');
  const base=await crypto.subtle.importKey('raw',enc.encode(passphrase),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:bytes,iterations:ITERATIONS,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptDocument(document:CloudDocument,key:CryptoKey,salt:string):Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:DOMAIN},key,enc.encode(JSON.stringify(document)));
  return JSON.stringify({format:'finance-cloud-envelope-v1',salt,iterations:ITERATIONS,iv:b64(iv),data:b64(new Uint8Array(data))} satisfies CloudEnvelope);
}
export async function encryptIndex(index:FinanceIndex,key:CryptoKey,salt:string,dataSetId:string|null=null,coordinated:boolean|'v4'=false):Promise<string> {
  if(dataSetId!==null&&!validDataSetId(dataSetId))throw new Error('保管庫世代IDが不正です。');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:coordinated?enc.encode(`Finance OneDrive index ${coordinated==='v4'?'v4':'v3'}:${dataSetId??'root'}`):INDEX_DOMAIN},key,enc.encode(JSON.stringify(validateIndex(index))));
  return JSON.stringify({format:coordinated==='v4'?'finance-cloud-index-envelope-v4':coordinated?'finance-cloud-index-envelope-v3':dataSetId?'finance-cloud-index-envelope-v2':'finance-cloud-index-envelope-v1',salt,iterations:ITERATIONS,iv:b64(iv),data:b64(new Uint8Array(data)),...(dataSetId?{dataSetId}:{})} satisfies IndexEnvelope);
}
export function parseIndexEnvelope(text:string):IndexEnvelope {
  if (text.length>1_000_000)throw new Error('クラウド索引がサイズ上限を超えています。');
  const result=JSON.parse(text) as IndexEnvelope;
  if((result?.format!=='finance-cloud-index-envelope-v1'&&result?.format!=='finance-cloud-index-envelope-v2'&&result?.format!=='finance-cloud-index-envelope-v3'&&result?.format!=='finance-cloud-index-envelope-v4')||result.iterations!==ITERATIONS||un64(result.salt).length!==16||un64(result.iv).length!==12||(result.format==='finance-cloud-index-envelope-v2'?!validDataSetId(result.dataSetId):(result.format==='finance-cloud-index-envelope-v3'||result.format==='finance-cloud-index-envelope-v4')?(result.dataSetId!==undefined&&!validDataSetId(result.dataSetId)):result.dataSetId!==undefined))throw new Error('対応していないクラウド索引形式です。');
  return result;
}
export async function decryptIndex(env:IndexEnvelope,key:CryptoKey):Promise<FinanceIndex> {
  try {
    const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(env.iv),additionalData:(env.format==='finance-cloud-index-envelope-v3'||env.format==='finance-cloud-index-envelope-v4')?enc.encode(`Finance OneDrive index ${env.format.endsWith('v4')?'v4':'v3'}:${env.dataSetId??'root'}`):INDEX_DOMAIN},key,un64(env.data));
    return validateIndex(JSON.parse(dec.decode(data)));
  }catch{throw new Error('パスフレーズが違うか、クラウド索引が破損しています。');}
}
export function parseEnvelope(text:string):CloudEnvelope {
  if(text.length>25_000_000)throw new Error('暗号化明細がサイズ上限を超えています。');
  const result=JSON.parse(text) as CloudEnvelope;
  if(result?.format!=='finance-cloud-envelope-v1'||result.iterations!==ITERATIONS||un64(result.salt).length!==16||un64(result.iv).length!==12)throw new Error('対応していない暗号化明細形式です。');
  return result;
}
export async function decryptDocument(env:CloudEnvelope,key:CryptoKey):Promise<CloudDocument> {
  try {
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(env.iv),additionalData:DOMAIN},key,un64(env.data));
    return validateCloudDocument(JSON.parse(dec.decode(clear)));
  } catch {throw new Error('パスフレーズが違うか、暗号化明細が破損しています。');}
}
export async function encryptOriginal(bytes:Uint8Array,key:CryptoKey):Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:ORIGINAL_DOMAIN},key,new Uint8Array(bytes));
  return JSON.stringify({format:'finance-cloud-original-v1',iv:b64(iv),data:b64(new Uint8Array(data))} satisfies OriginalEnvelope);
}
export async function decryptOriginal(text:string,key:CryptoKey):Promise<Uint8Array> {
  const env=JSON.parse(text) as OriginalEnvelope;
  if(env.format!=='finance-cloud-original-v1')throw new Error('PDF原本の暗号形式が不正です。');
  const result=await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(env.iv),additionalData:ORIGINAL_DOMAIN},key,un64(env.data));
  return new Uint8Array(result);
}
/** Plain PDF identity is stored only inside the encrypted statement. */
export async function originalDigest(bytes:Uint8Array):Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function verifyOriginalDigest(bytes:Uint8Array,expected?:string):Promise<void> {
  if(expected!==undefined&&await originalDigest(bytes)!==expected)throw new Error('PDF原本が明細の登録内容と一致しません。OneDriveの原本を確認してください。');
}
export {emptyDocument};

/** Rules have independent authenticated context. Old Finance ciphertext stays untouched. */
export async function encryptRules(doc:MerchantRulesDocument,key:CryptoKey,salt:string):Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:RULES_DOMAIN},key,enc.encode(JSON.stringify(validateRules(doc))));
  return JSON.stringify({format:'finance-cloud-rules-envelope-v1',salt,iterations:ITERATIONS,iv:b64(iv),data:b64(new Uint8Array(data))});
}
export async function decryptRules(text:string,key:CryptoKey,expectedSalt:string):Promise<MerchantRulesDocument> {
  if(text.length>2_000_000)throw new Error('利用先ルールの暗号ファイルが大きすぎます。');
  const env=JSON.parse(text) as {format:string;salt:string;iterations:number;iv:string;data:string};
  if(env?.format!=='finance-cloud-rules-envelope-v1'||env.salt!==expectedSalt||env.iterations!==ITERATIONS||un64(env.iv).length!==12)
    throw new Error('利用先ルールの暗号形式またはソルトが不正です。');
  try {
    const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(env.iv),additionalData:RULES_DOMAIN},key,un64(env.data));
    return validateRules(JSON.parse(dec.decode(bytes)));
  }catch {throw new Error('利用先ルールの復号または整合性確認に失敗しました。');}
}

/** Assets settings have their own authenticated domain, independent from rules and statements. */
export async function encryptAssets(doc:AssetsDocument,key:CryptoKey,salt:string):Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const bytes=enc.encode(JSON.stringify(validateAssets(doc)));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:ASSETS_DOMAIN},key,bytes);
  return JSON.stringify({format:'finance-cloud-assets-envelope-v1',salt,iterations:ITERATIONS,iv:b64(iv),data:b64(new Uint8Array(data))});
}
export async function decryptAssets(text:string,key:CryptoKey,expectedSalt:string):Promise<AssetsDocument> {
  if(text.length>2_000_000)throw new Error('資産設定の暗号ファイルが大きすぎます。');
  let env:{format:string;salt:string;iterations:number;iv:string;data:string};
  try{env=JSON.parse(text);}catch{throw new Error('資産設定の暗号形式が不正です。');}
  if(env?.format!=='finance-cloud-assets-envelope-v1'||env.salt!==expectedSalt||env.iterations!==ITERATIONS||un64(env.iv).length!==12)
    throw new Error('資産設定の暗号形式またはソルトが不正です。');
  try {
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(env.iv),additionalData:ASSETS_DOMAIN},key,un64(env.data));
    return validateAssets(JSON.parse(dec.decode(clear)));
  }catch {throw new Error('資産設定の復号または整合性確認に失敗しました。');}
}

/** A separate AES-GCM authentication domain per archived reporting month. */
export async function encryptMonthlyReport(doc:import('../reports/monthly-report.js').MonthlyReportDocument,key:CryptoKey,salt:string):Promise<string> {
  const valid=(await import('../reports/monthly-report.js')).validateReportDocument(doc);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const domain=enc.encode(`Finance monthly report v1:${valid.period}`);
  const payload=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:domain},key,enc.encode(JSON.stringify(valid)));
  return JSON.stringify({format:'finance-monthly-report-envelope-v1',period:valid.period,salt,iterations:ITERATIONS,iv:b64(iv),data:b64(new Uint8Array(payload))});
}
export async function decryptMonthlyReport(text:string,key:CryptoKey,salt:string,period:string):Promise<import('../reports/monthly-report.js').MonthlyReportDocument> {
  if(text.length>2_000_000)throw new Error('月次レポートの容量が大きすぎます。');
  let env:{format:string;period:string;salt:string;iterations:number;iv:string;data:string};
  try{env=JSON.parse(text);}catch{throw new Error('月次レポートの暗号形式が不正です。');}
  if(env?.format!=='finance-monthly-report-envelope-v1'||env.period!==period||env.salt!==salt||env.iterations!==ITERATIONS||un64(env.iv).length!==12)
    throw new Error('月次レポートの暗号形式が不正です。');
  try{
    const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(env.iv),additionalData:enc.encode(`Finance monthly report v1:${period}`)},key,un64(env.data));
    const {validateReportDocument}=await import('../reports/monthly-report.js');
    return validateReportDocument(JSON.parse(dec.decode(data)),period);
  }catch{throw new Error('月次レポートを復号できませんでした。');}
}
