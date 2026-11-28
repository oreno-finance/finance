import {fixedCostsForCalculation} from '../fixed-costs/payment-history.js';
/** Conservative, read-only card debit estimates built from actual fixed-cost contracts.
 * Never creates a statement or persists a bill. An imported payment-month statement
 * takes precedence for the WHOLE card to prevent duplicate bank debits. */
import {cardDebitAccountOnDay,DEFAULT_MIZUHO_PLAN,cardRecurringKey,type AssetsDocument} from './assets.js';
import {mizuhoTransferForBill,type MizuhoPlannedTransfer} from './mizuho-transfer.js';
import {confirmedRecords} from '../importers/batch-policy.js';
import type {CloudRecord} from './merge.js';
import {cardForecastPriceOnDay,fixedCostOccurrences,type CostFrequency} from '../fixed-costs/contracts.js';
import {cardPaymentDate, type CardPaymentTiming} from '../importers/payment-date.js';
import {CARDS,statementPeriod} from '../models/types.js';

export interface EstimatedCardFixedBill {id:string;cardId:string;name:string;paymentDate:string;amount:number;contractIds:string[];estimated:true}
const month=(day:string)=>day.slice(0,7);
const index=(m:string)=>Number(m.slice(0,4))*12+Number(m.slice(5,7))-1;
const fromIndex=(i:number)=>`${Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`;
function paymentTiming(cardId:string,doc:AssetsDocument,verified:readonly CloudRecord[]):CardPaymentTiming|null {
  const explicit=doc.cardPreferences?.[cardId]?.payment;
  if(explicit)return explicit;
  const latest=verified.filter(r=>r.statement.cardId===cardId&&r.statement.paymentDate&&r.statement.billingMonth)
    .sort((a,b)=>b.statement.paymentDate!.localeCompare(a.statement.paymentDate!))[0];
  if(!latest)return null;
  const payment=latest.statement.paymentDate!,billing=latest.statement.billingMonth!;
  const offset=index(month(payment))-index(billing);
  if(offset!==0&&offset!==1)return null;
  return {monthOffset:offset,day:Number(payment.slice(8,10))};
}
const usageCycle=(day:string,frequency:CostFrequency)=>frequency==='weekly'?day:frequency==='yearly'?day.slice(0,4):month(day);
/** Future estimate needs a configured/observed payment-day rule and a source contract. */
export function estimatedCardFixedBills(doc:AssetsDocument,records:readonly CloudRecord[],fromDay:string,toDay:string):EstimatedCardFixedBill[]{
  if(toDay<fromDay||!/^20\d\d-\d\d-\d\d$/.test(fromDay)||!/^20\d\d-\d\d-\d\d$/.test(toDay))return [];
  const months=new Set<string>();
  for(let i=index(month(fromDay))-2;i<=index(month(toDay))&&months.size<=7;i++)months.add(fromIndex(i));
  const seen=new Set(records.filter(r=>r.statement.cardId&&statementPeriod(r.statement))
    .map(r=>`${r.statement.cardId}|${statementPeriod(r.statement)}`));
  const observedMonths=new Set(records.flatMap(r=>{const p=statementPeriod(r.statement);return p?[p]:[];}));
  const contracts=fixedCostsForCalculation(doc).filter(c=>c.payment==='card'&&c.cardId);
  if(!contracts.length)return [];
  const watched=new Map<string,Set<CostFrequency>>();
  for(const contract of contracts){
    if(!contract.merchantKey)continue;
    const frequencies=watched.get(contract.merchantKey)??new Set<CostFrequency>();
    frequencies.add(contract.frequency);watched.set(contract.merchantKey,frequencies);
  }
  const verified=confirmedRecords(records);
  const observedCycles=new Map<string,Set<string>>();
  for(const {statement} of verified){
    if(!statement.cardId)continue;
    for(const row of statement.rows){
      if(row.amount===0)continue;
      const key=cardRecurringKey(statement.cardId,row.merchant);
      for(const frequency of watched.get(key)??[]){
        const cycleKey=`${key}|${frequency}|${usageCycle(row.usedOn,frequency)}`;
        const days=observedCycles.get(cycleKey)??new Set<string>();
        days.add(row.usedOn);observedCycles.set(cycleKey,days);
      }
    }
  }
  const buckets=new Map<string,EstimatedCardFixedBill>();
  for(const contract of contracts){
    if(!contract.cardId)continue;
    const timing=paymentTiming(contract.cardId,doc,verified);
    if(!timing)continue; // Never invent a payment date.
    for(const m of months){
      for(const occurrence of fixedCostOccurrences(m,[contract])){
        // A known usage cycle already appears in a verified statement. A changed
        // payment schedule must not create another estimated debit for that cycle.
        const known=contract.merchantKey?observedCycles.get(`${contract.merchantKey}|${contract.frequency}|${usageCycle(occurrence.date,contract.frequency)}`):undefined;
        if(known&&[...known].some(day=>day>=contract.startOn&&(!contract.endOn||day<=contract.endOn)))continue;
        let due:string;
        try{due=cardPaymentDate(m,timing);}catch{continue;}
        if(!cardDebitAccountOnDay(doc,contract.cardId,due)||due<fromDay||due>toDay||seen.has(`${contract.cardId}|${month(due)}`)||
          (doc.cardNoUseMonths?.includes(month(due))&&!observedMonths.has(month(due))))continue;
        const key=`${contract.cardId}|${due}`;
        const previous=buckets.get(key);
        const amount=cardForecastPriceOnDay(contract,occurrence.date);
        if(amount===null)continue;
        const next=(previous?.amount??0)+amount;
        if(!Number.isSafeInteger(next))throw new Error('カード固定費の請求見込みが大きすぎます。');
        const name=doc.cardPreferences?.[contract.cardId]?.name??CARDS.find(c=>c.id===contract.cardId)?.name??'カード';
        buckets.set(key,{id:`estimate:${key}`,cardId:contract.cardId,name:`${name}（固定費から推定）`,paymentDate:due,
          amount:next,contractIds:[...(previous?.contractIds??[]),contract.id],estimated:true});
      }
    }
  }
  return [...buckets.values()].sort((a,b)=>a.paymentDate.localeCompare(b.paymentDate)||a.cardId.localeCompare(b.cardId));
}

export interface EstimatedMizuhoFunding extends MizuhoPlannedTransfer {id:string;estimated:true}
/** Only future funding of an estimated bill; actual statements and manual transfers
 * take precedence through the same funding rules as confirmed bills. */
export function estimatedMizuhoFunding(doc:AssetsDocument,records:readonly CloudRecord[],today:string,until:string):EstimatedMizuhoFunding[]{
  const plan=doc.mizuhoTransferPlan??DEFAULT_MIZUHO_PLAN;
  if(!plan.enabled||until<today)return [];
  const last=new Date(`${until}T00:00:00Z`);
  if(!Number.isFinite(last.getTime()))return [];
  last.setUTCDate(last.getUTCDate()+plan.leadDays);
  const results:EstimatedMizuhoFunding[]=[];
  for(const bill of estimatedCardFixedBills(doc,records,today,last.toISOString().slice(0,10))){
    const transfer=mizuhoTransferForBill(bill,doc);
    if(transfer&&transfer.date>=today&&transfer.date<=until)results.push({...transfer,id:`fund:${bill.id}`,estimated:true});
  }
  return results;
}
