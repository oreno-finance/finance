/** Conservative, read-only card debit estimates built from actual fixed-cost contracts.
 * Never creates a statement or persists a bill. An imported payment-month statement
 * takes precedence for the WHOLE card to prevent duplicate bank debits. */
import type {AssetsDocument} from './assets.js';
import type {CloudRecord} from './merge.js';
import {fixedCostOccurrences} from '../fixed-costs/contracts.js';
import {cardPaymentDate, type CardPaymentTiming} from '../importers/payment-date.js';
import {CARDS} from '../models/types.js';

export interface EstimatedCardFixedBill {id:string;cardId:string;name:string;paymentDate:string;amount:number;contractIds:string[];estimated:true}
const month=(day:string)=>day.slice(0,7);
const index=(m:string)=>Number(m.slice(0,4))*12+Number(m.slice(5,7))-1;
const fromIndex=(i:number)=>`${Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`;
function paymentTiming(cardId:string,doc:AssetsDocument,records:readonly CloudRecord[]):CardPaymentTiming|null {
  const explicit=doc.cardPreferences?.[cardId]?.payment;
  if(explicit)return explicit;
  const latest=records.filter(r=>r.statement.cardId===cardId&&r.statement.paymentDate&&r.statement.billingMonth)
    .sort((a,b)=>b.statement.paymentDate!.localeCompare(a.statement.paymentDate!))[0];
  if(!latest)return null;
  const payment=latest.statement.paymentDate!,billing=latest.statement.billingMonth!;
  const offset=index(month(payment))-index(billing);
  if(offset!==0&&offset!==1)return null;
  return {monthOffset:offset,day:Number(payment.slice(8,10))};
}
/** Future estimate needs a configured/observed payment-day rule and a source contract. */
export function estimatedCardFixedBills(doc:AssetsDocument,records:readonly CloudRecord[],fromDay:string,toDay:string):EstimatedCardFixedBill[]{
  if(toDay<fromDay||!/^20\d\d-\d\d-\d\d$/.test(fromDay)||!/^20\d\d-\d\d-\d\d$/.test(toDay))return [];
  const months=new Set<string>();
  for(let i=index(month(fromDay))-2;i<=index(month(toDay))&&months.size<=7;i++)months.add(fromIndex(i));
  const seen=new Set(records.filter(r=>r.statement.cardId&&r.statement.paymentDate)
    .map(r=>`${r.statement.cardId}|${month(r.statement.paymentDate!)}`));
  const buckets=new Map<string,EstimatedCardFixedBill>();
  for(const contract of doc.fixedCosts??[]){
    if(contract.payment!=='card'||!contract.cardId)continue;
    if(!doc.cardDebitAccounts?.[contract.cardId])continue;
    const timing=paymentTiming(contract.cardId,doc,records);
    if(!timing)continue; // Never invent a payment date.
    for(const m of months){
      for(const occurrence of fixedCostOccurrences(m,[contract])){
        let due:string;
        try{due=cardPaymentDate(m,timing);}catch{continue;}
        if(due<fromDay||due>toDay||seen.has(`${contract.cardId}|${month(due)}`)||
          doc.cardNoUseMonths?.includes(month(due)))continue;
        const key=`${contract.cardId}|${due}`;
        const previous=buckets.get(key);
        const next=(previous?.amount??0)+occurrence.amount;
        if(!Number.isSafeInteger(next))throw new Error('カード固定費の請求見込みが大きすぎます。');
        const name=doc.cardPreferences?.[contract.cardId]?.name??CARDS.find(c=>c.id===contract.cardId)?.name??'カード';
        buckets.set(key,{id:`estimate:${key}`,cardId:contract.cardId,name:`${name}（固定費から推定）`,paymentDate:due,
          amount:next,contractIds:[...(previous?.contractIds??[]),contract.id],estimated:true});
      }
    }
  }
  return [...buckets.values()].sort((a,b)=>a.paymentDate.localeCompare(b.paymentDate)||a.cardId.localeCompare(b.cardId));
}
