/** Date-effective payment terms. A contract keeps its original storage ID and its
 * original record; the segments below are transient calculation views only. */
import {CARDS} from '../models/types.js';
import {ASSET_ACCOUNTS,type AssetAccountId,type AssetsDocument,type RecurringEntry} from '../cloud/assets.js';
import {nextFixedCostDate,type CostFrequency,type FixedCostEntry} from './contracts.js';

export interface PaymentTerms {
  payment:'bank'|'card'|'cash';
  cardId:string|null;
  merchantKey:string|null;
  accountId:AssetAccountId|null;
  frequency:CostFrequency;
  dayOfMonth:number|null;
  monthOfYear:number|null;
  weekday:number|null;
}
export interface PaymentChange extends PaymentTerms {effectiveOn:string}
export type ContractOrigin=FixedCostEntry|RecurringEntry;
type ContractSource=Pick<AssetsDocument,'recurring'|'fixedCosts'>;
const validDate=(d:unknown):d is string=>typeof d==='string'&&/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(`${d}T00:00:00Z`))&&new Date(`${d}T00:00:00Z`).toISOString().slice(0,10)===d;
const prevDay=(d:string)=>new Date(Date.parse(`${d}T00:00:00Z`)-86400000).toISOString().slice(0,10);
const fail=():never=>{throw new Error('固定費の支払条件履歴が不正です。');};
export function originalPaymentTerms(item:ContractOrigin):PaymentTerms {
  if('kind' in item&&item.kind!=='expense')return fail();
  return {payment:'kind' in item?'bank':item.payment,cardId:'kind' in item?null:item.cardId,
    merchantKey:'kind' in item?null:item.merchantKey,accountId:'kind' in item?item.fromAccountId:null,
    frequency:item.frequency,dayOfMonth:item.dayOfMonth,monthOfYear:item.monthOfYear,weekday:item.weekday};
}
export function validatePaymentTerms(raw:unknown):PaymentTerms {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();
  const x=raw as PaymentTerms;
  if(!['bank','card','cash'].includes(x.payment)||!['monthly','yearly','weekly'].includes(x.frequency))return fail();
  if(x.payment==='bank'){
    if(!ASSET_ACCOUNTS.some(a=>a.id===x.accountId)||x.cardId!==null||x.merchantKey!==null)return fail();
  }else if(x.payment==='card'){
    if(!CARDS.some(c=>c.id===x.cardId)||x.accountId!==null||
      (x.merchantKey!==null&&(typeof x.merchantKey!=='string'||x.merchantKey.length>250||!x.merchantKey.trim())))return fail();
  }else if(x.accountId!==null||x.cardId!==null||x.merchantKey!==null)return fail();
  if(x.frequency==='weekly'){
    if(x.weekday===null||!Number.isInteger(x.weekday)||x.weekday<0||x.weekday>6||x.dayOfMonth!==null||x.monthOfYear!==null)return fail();
  }else if(x.dayOfMonth===null||!Number.isInteger(x.dayOfMonth)||x.dayOfMonth<0||x.dayOfMonth>31||x.weekday!==null||
    (x.frequency==='monthly'?x.monthOfYear!==null:x.monthOfYear===null||!Number.isInteger(x.monthOfYear)||x.monthOfYear<1||x.monthOfYear>12))return fail();
  return {payment:x.payment,cardId:x.cardId,merchantKey:x.merchantKey,accountId:x.accountId,frequency:x.frequency,dayOfMonth:x.dayOfMonth,monthOfYear:x.monthOfYear,weekday:x.weekday};
}
export function validatePaymentHistory(raw:unknown,item:ContractOrigin):PaymentChange[]|undefined {
  if(raw===undefined)return undefined;
  if(!Array.isArray(raw)||raw.length<2||raw.length>128||('kind' in item&&item.kind!=='expense'))return fail();
  let previous='';
  const entries=raw.map((v:unknown)=>{
    const terms=validatePaymentTerms(v),d=(v as PaymentChange).effectiveOn;
    if(!validDate(d)||d<=previous||(previous!==''&&terms.merchantKey!==null&&!terms.merchantKey.startsWith(`${terms.cardId}|`)))return fail();
    previous=d;
    return {effectiveOn:d,...terms};
  });
  // Original routing remains the baseline. Any attempted rewrite or loss of it fails closed.
  const first=entries[0]!;
  if(first.effectiveOn!==item.startOn||JSON.stringify(validatePaymentTerms(first))!==JSON.stringify(originalPaymentTerms(item)))return fail();
  return entries;
}
/** Prepare a history change without altering the source. No backdating or ambiguous
 * same-day replacement; a future UI must explicitly handle corrections. */
export function appendPaymentChange(item:ContractOrigin,terms:PaymentTerms,effectiveOn:string,today:string):PaymentChange[] {
  const current=validatePaymentHistory(item.paymentHistory,item)??[{effectiveOn:item.startOn,...originalPaymentTerms(item)}];
  if(!validDate(today)||!validDate(effectiveOn)||effectiveOn<today||effectiveOn<=current.at(-1)!.effectiveOn||
    (item.endOn!==null&&effectiveOn>item.endOn))throw new Error('支払条件の適用日は今日以降かつ直近の変更日より後にしてください。');
  const checked=validatePaymentTerms(terms);
  if(checked.merchantKey!==null&&!checked.merchantKey.startsWith(`${checked.cardId}|`))return fail();
  if(JSON.stringify(checked)===JSON.stringify(validatePaymentTerms(current.at(-1))))throw new Error('支払条件に変更がありません。');
  return validatePaymentHistory([...current,{effectiveOn,...checked}],item)!;
}
/** Only the latest, not yet effective change can be withdrawn or corrected.
 * Earlier future entries may depend on later entries and must be unwound from the end. */
export function reviseFuturePaymentChange(item:ContractOrigin,expectedDate:string,today:string,replacement?:{terms:PaymentTerms;effectiveOn:string}):PaymentChange[]|undefined {
  const history=validatePaymentHistory(item.paymentHistory,item);
  if(!history||!validDate(today)||history.at(-1)!.effectiveOn!==expectedDate||expectedDate<=today)throw new Error('適用前の最新の変更予定だけを修正・取り消しできます。');
  const prior=history.slice(0,-1);
  const base={...item,paymentHistory:prior.length>1?prior:undefined};
  if(!replacement)return base.paymentHistory;
  if(replacement.effectiveOn<=today)throw new Error('変更予定の修正日は明日以降にしてください。');
  return appendPaymentChange(base,replacement.terms,replacement.effectiveOn,today);
}
/** Read-only history for UI, including an implicit legacy baseline. */
export function contractPaymentHistory(item:ContractOrigin):readonly PaymentChange[]{
  return item.paymentHistory??[{effectiveOn:item.startOn,...originalPaymentTerms(item)}];
}
export function paymentTermsOn(item:ContractOrigin,day:string):PaymentTerms {
  let result=originalPaymentTerms(item);
  for(const change of item.paymentHistory??[]){if(change.effectiveOn>day)break;result=validatePaymentTerms(change);}
  return result;
}
interface Segment {startOn:string;endOn:string|null;terms:PaymentTerms}
function segments(item:ContractOrigin):Segment[]{
  const history=item.paymentHistory;
  if(!history)return [{startOn:item.startOn,endOn:item.endOn,terms:originalPaymentTerms(item)}];
  if('kind' in item&&!item.enabled)return [];
  const result:Segment[]=[];
  for(let i=0;i<history.length;i++){
    const entry=history[i]!,next=history[i+1];
    const until=next?prevDay(next.effectiveOn):null;
    const endOn=item.endOn===null?until:until===null?item.endOn:item.endOn<until?item.endOn:until;
    if(endOn!==null&&entry.effectiveOn>endOn)continue;
    result.push({startOn:entry.effectiveOn,endOn,terms:entry});
  }
  return result;
}
export function originContracts(doc:ContractSource):ContractOrigin[]{return [...doc.recurring.filter(x=>x.kind==='expense'),...(doc.fixedCosts??[])];}
/** Existing records without history keep their existing identity and behavior. */
export function recurringForCalculation(doc:ContractSource):RecurringEntry[]{
  if(!doc.recurring.some(x=>x.paymentHistory)&&!(doc.fixedCosts??[]).some(x=>x.paymentHistory))return doc.recurring;
  const result=doc.recurring.filter(x=>!x.paymentHistory);
  for(const item of originContracts(doc)){
    if(!item.paymentHistory)continue;
    for(const {startOn,endOn,terms} of segments(item)){
      if(terms.payment!=='bank')continue;
      result.push({id:item.id,name:item.name,amount:item.amount,kind:'expense',fromAccountId:terms.accountId,toAccountId:null,
        frequency:terms.frequency,dayOfMonth:terms.dayOfMonth,monthOfYear:terms.monthOfYear,weekday:terms.weekday,
        startOn,endOn,categoryId:item.categoryId,enabled:true,pricing:item.pricing,pauses:item.pauses,priceKind:item.priceKind,note:item.note});
    }
  }
  return result;
}
export function fixedCostsForCalculation(doc:ContractSource):FixedCostEntry[]{
  if(!doc.recurring.some(x=>x.paymentHistory)&&!(doc.fixedCosts??[]).some(x=>x.paymentHistory))return doc.fixedCosts??[];
  const result=(doc.fixedCosts??[]).filter(x=>!x.paymentHistory);
  for(const item of originContracts(doc)){
    if(!item.paymentHistory)continue;
    for(const {startOn,endOn,terms} of segments(item)){
      if(terms.payment==='bank')continue;
      result.push({id:item.id,name:item.name,amount:item.amount,payment:terms.payment,cardId:terms.cardId,merchantKey:terms.merchantKey,
        frequency:terms.frequency,dayOfMonth:terms.dayOfMonth,monthOfYear:terms.monthOfYear,weekday:terms.weekday,
        startOn,endOn,categoryId:item.categoryId,pricing:item.pricing??[{effectiveOn:item.startOn,amount:item.amount}],pauses:item.pauses??[],
        priceKind:item.priceKind??'fixed',note:item.note??'',updatedAt:'kind' in item?'1970-01-01T00:00:00.000Z':item.updatedAt});
    }
  }
  return result;
}
/** Search each bounded interval using the same recurrence rules as current reports. */
export function nextContractPayment(item:ContractOrigin,fromDay:string):string|null {
  if('kind' in item&&!item.enabled)return null;
  for(const {startOn,endOn,terms} of segments(item)){
    const next=nextFixedCostDate({...terms,startOn,endOn,pauses:item.pauses},fromDay);
    if(next)return next;
  }
  return null;
}

/** A merchant/card pair cannot belong to two overlapping contracts. Adjacent
 * non-overlapping terms (including the same contract's own history) are valid. */
export function contractMerchantKeys(doc:ContractSource):Set<string>{
  return new Set(originContracts(doc).flatMap(item=>contractPaymentHistory(item).flatMap(terms=>terms.merchantKey?[terms.merchantKey]:[])));
}
export function validateHistoricalMerchantRoutes(doc:ContractSource):void {
  const routes=new Map<string,FixedCostEntry[]>();
  for(const item of fixedCostsForCalculation(doc)){
    if(item.payment!=='card'||!item.merchantKey)continue;
    const key=`${item.cardId}|${item.merchantKey}`;
    const entries=routes.get(key)??[];entries.push(item);routes.set(key,entries);
  }
  for(const entries of routes.values()){
    entries.sort((a,b)=>a.startOn.localeCompare(b.startOn));
    let until='';
    for(const entry of entries){
      if(entry.startOn<=until)throw new Error('固定費の支払カードと利用先の有効期間が重複しています。');
      until=entry.endOn??'9999-12-31';
    }
  }
}
