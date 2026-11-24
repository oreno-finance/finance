/** Finance read-only bridge to Payroll v1.1 encrypted income exports.
 * Payroll writes payroll/index.enc and payroll/(versions/ID/)?income/YYYY.enc.
 * No source PDF, identity, token, passphrase or derived key is persisted by Finance.
 */
import type {OneDriveTestClient} from './onedrive-api.js';
import {combinePayrollIncome,validatePayrollIncome,type PayrollIncomeEntry,type PayrollIncomeDocument} from './payroll-income.js';
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const indexAAD=encoder.encode('Payroll OneDrive index v1');
const incomeAAD=encoder.encode('Payroll OneDrive income v1');
const maxYears=300;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const year=/^(19|20|21)\d{2}$/;
interface Envelope{format:'payroll-cloud-envelope-v1';kind:'index'|'income';salt?:string;iterations?:number;iv:string;data:string}
interface PayrollIndex{format:'payroll-index-v1';years:string[];incomeYears:string[];generation?:string;rotation?:unknown}
interface SourceIncome {format:'payroll-income-v1';year:string;records:Array<{id:number;paymentDate:string;targetMonth:string;job:string;kind:string;employerId?:string;netPaymentYen:number;grossPaymentYen?:number;taxablePaymentYen?:number;revision:number}>}
function obj(raw:unknown):raw is Record<string,unknown>{return raw!==null&&typeof raw==='object'&&!Array.isArray(raw);}
function b64(value:unknown,limit=30_000_000):Uint8Array<ArrayBuffer>{
 if(typeof value!=='string'||value.length>Math.ceil(limit*4/3)+8||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw Error('Payroll暗号データの形式が不正です。');
 const plain=atob(value);if(plain.length>limit)throw Error('Payroll暗号データが容量上限を超えています。');
 return Uint8Array.from(plain,c=>c.charCodeAt(0));
}
function envelope(text:string,kind:Envelope['kind']):Envelope{
 let raw:unknown;
 try{raw=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw Error('Payrollの暗号ファイルがJSONではありません。');}
 if(!obj(raw)||raw.format!=='payroll-cloud-envelope-v1'||raw.kind!==kind||typeof raw.data!=='string'||
    b64(raw.iv,32).length!==12||(raw.salt!==undefined&&(raw.iterations!==310000||b64(raw.salt,32).length!==16)))
    throw Error('Payrollの暗号ファイルの形式が一致しません。');
 return raw as unknown as Envelope;
}
async function keyFrom(passphrase:string,salt:string):Promise<CryptoKey>{
 if([...passphrase].length<12)throw Error('Payrollのパスフレーズは12文字以上が必要です。');
 const raw=await crypto.subtle.importKey('raw',encoder.encode(passphrase),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',salt:b64(salt,32),iterations:310000,hash:'SHA-256'},raw,{name:'AES-GCM',length:256},false,['decrypt']);
}
async function decoded<T>(e:Envelope,key:CryptoKey,aad:Uint8Array):Promise<T>{
 let bytes:ArrayBuffer;
 try{bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64(e.iv,32),additionalData:new Uint8Array(aad)},key,b64(e.data));}
 catch{throw Error('Payrollのパスフレーズが一致しないか、暗号ファイルが破損しています。');}
 try{return JSON.parse(decoder.decode(bytes)) as T;}
 catch{throw Error('Payrollの復号内容がJSONとして読み取れません。');}
}
function indexCheck(raw:PayrollIndex):PayrollIndex{
 if(!raw||raw.format!=='payroll-index-v1'||!Array.isArray(raw.years)||!Array.isArray(raw.incomeYears)||
    raw.incomeYears.length>maxYears||raw.years.length>maxYears||raw.incomeYears.some(y=>typeof y!=='string'||!year.test(y))||
    (raw.generation!==undefined&&!uuid.test(raw.generation))||raw.rotation)
    throw Error('Payrollの索引が不正またはパスフレーズ変更中です。');
 return raw;
}
export function adaptPayrollSource(doc:unknown):PayrollIncomeDocument{
 if(!obj(doc)||doc.format!=='payroll-income-v1'||typeof doc.year!=='string'||!year.test(doc.year)||
    !Array.isArray(doc.records)||doc.records.length>5000)throw Error('Payrollの収入ファイル形式が不正です。');
 const seen=new Set<number>();
 const entries=doc.records.map((item:unknown)=>{
  if(!obj(item)||!Number.isSafeInteger(item.id)||(item.id as number)<=0||seen.has(item.id as number)||
     typeof item.paymentDate!=='string'||typeof item.targetMonth!=='string'||
     !(['main','side'].includes(String(item.job)))||!(['salary','bonus'].includes(String(item.kind)))||
     (item.employerId!==undefined&&(typeof item.employerId!=='string'||!/^emp_[0-9a-f]{32}$/.test(item.employerId)))||
     !Number.isSafeInteger(item.netPaymentYen)||(item.netPaymentYen as number)<0||
     (item.grossPaymentYen!==undefined&&(!Number.isSafeInteger(item.grossPaymentYen)||(item.grossPaymentYen as number)<0))||
     (item.taxablePaymentYen!==undefined&&(!Number.isSafeInteger(item.taxablePaymentYen)||(item.taxablePaymentYen as number)<0))||
     !Number.isSafeInteger(item.revision)||(item.revision as number)<1)
     throw Error('Payrollの給与レコードに不正なデータがあります。');
  const id=item.id as number;seen.add(id);
  return {id:`pay-${id}`,employerId:(item.employerId??item.job) as string,
   ...(item.employerId?{job:item.job as 'main'|'side'}:{}),payPeriod:item.targetMonth as string,paidOn:item.paymentDate as string,
   grossPay:item.grossPaymentYen===undefined?null:item.grossPaymentYen as number,
   netPay:item.netPaymentYen as number,taxablePay:item.taxablePaymentYen===undefined?null:item.taxablePaymentYen as number,
   currency:'JPY',kind:item.kind as 'salary'|'bonus',revision:item.revision as number};
 });
 return validatePayrollIncome({format:'payroll-income-v1',year:Number(doc.year),updatedAt:new Date(0).toISOString(),entries,deletedIds:[]});
}
/** Key is non-extractable and lives in memory until Finance is locked/closed. */
export class PayrollReadSession {
 private constructor(private readonly client:OneDriveTestClient,private readonly key:CryptoKey,private readonly salt:string){}
 static async connect(client:OneDriveTestClient,passphrase:string):Promise<PayrollReadSession>{
  const file=await client.readPayrollPublishedFile([],'index.enc',1_000_000);
  if(!file)throw Error('Payrollの暗号保管庫がOneDriveにありません。Payrollで同期してください。');
  const head=envelope(file.text,'index');if(!head.salt||head.iterations!==310000)throw Error('Payrollの暗号索引のソルトが不正です。');
  const key=await keyFrom(passphrase,head.salt);
  indexCheck(await decoded<PayrollIndex>(head,key,indexAAD));
  return new PayrollReadSession(client,key,head.salt);
 }
 async refresh():Promise<PayrollIncomeEntry[]>{
  const file=await this.client.readPayrollPublishedFile([],'index.enc',1_000_000);
  if(!file)throw Error('Payrollの索引が見つかりません。');
  const head=envelope(file.text,'index');
  if(head.salt!==this.salt)throw Error('Payroll側でパスフレーズが変更されました。再接続してください。');
  const ix=indexCheck(await decoded<PayrollIndex>(head,this.key,indexAAD));
  const paths=ix.generation?['versions',ix.generation,'income']:['income'];
  const docs:PayrollIncomeDocument[]=[];
  // Index is authoritative. Never silently skip missing years.
  for(const y of [...new Set(ix.incomeYears)].sort()){
   const encrypted=await this.client.readPayrollPublishedFile(paths,`${y}.enc`,30_000_000);
   if(!encrypted)throw Error(`Payrollの${y}年の収入ファイルが見つかりません。`);
   const env=envelope(encrypted.text,'income');
   if(env.salt!==this.salt||env.iterations!==310000)throw Error(`Payrollの${y}年の収入ファイルの鍵情報が一致しません。`);
   const doc=adaptPayrollSource(await decoded<SourceIncome>(env,this.key,incomeAAD));
   if(doc.year!==Number(y))throw Error('Payrollの収入ファイルの年度が一致しません。');
   docs.push(doc);
  }
  return combinePayrollIncome(docs);
 }
}
