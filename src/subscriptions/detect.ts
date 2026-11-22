/** P1-C: read-only detection of card-paid recurring charges.
 * Payment month is the ONLY period axis. A suggestion never changes household cashflow. */
import { CARDS } from '../models/types.js';
import { displayMerchant, normalizeMerchant } from '../cloud/merchant-rules.js';
import { cardRecurringKey, nisaRuleOnDay, type CardRecurringDecision } from '../cloud/assets.js';
import type { MonthlySource } from '../summary/monthly-summary.js';
import { importErrors } from '../importers/batch-policy.js';

export interface SubscriptionCandidate {
  key:string;cardId:string;cardName:string;merchant:string;
  frequency:'monthly'|'yearly';amount:number;minAmount:number;maxAmount:number;
  months:string[];confidence:'high'|'medium';
}
const periodNumber=(p:string)=>Number(p.slice(0,4))*12+Number(p.slice(5,7))-1;
const validDate=(d:string|null)=>!!d&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(`${d}T00:00:00Z`))&&new Date(`${d}T00:00:00Z`).toISOString().slice(0,10)===d;
const close=(a:number,b:number)=>Math.abs(a-b)<=Math.max(100,Math.round(Math.min(a,b)*0.08));
const median=(items:number[])=>[...items].sort((a,b)=>a-b)[Math.floor(items.length/2)]!;
const todayPeriod=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;};
interface Observation {period:string; amount:number}
interface Group {cardId:string;merchant:string;values:Observation[]}
/** A single evidence pipeline for suggestions and registered charge comparisons.
 * This never edits a saved decision and excludes unsafe/ambiguous source records. */
function eligibleCardChargeGroups(source:MonthlySource,asOf:string):Map<string,Group> {
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(asOf))throw new Error('検出対象の年月が不正です。');
  const permittedCards=new Set(CARDS.map(item=>item.id));
  const duplicate=new Map<string,number>();
  for(const {statement:s} of source.records){
    if(!s.cardId||!s.billingMonth)continue;
    const id=`${s.cardId}|${s.billingMonth}`;
    duplicate.set(id,(duplicate.get(id)??0)+1);
  }
  const groups=new Map<string,Group>();
  for(const record of source.records){
    const s=record.statement;
    if(!s.cardId||!permittedCards.has(s.cardId)||s.confirmation!=='confirmed'||!validDate(s.paymentDate)||
       !s.billingMonth||duplicate.get(`${s.cardId}|${s.billingMonth}`)!==1||
       importErrors(s,s.sourceKind!=='pdf'||!!record.originalId).length)continue;
    const period=s.paymentDate!.slice(0,7);
    if(period>asOf||periodNumber(asOf)-periodNumber(period)>37)continue;
    for(const row of s.rows){
      if(!Number.isSafeInteger(row.amount)||row.amount<=0||!validDate(row.usedOn))continue;
      const nisa=nisaRuleOnDay(source.assets,row.usedOn);
      if(nisa?.enabled&&nisa.cardId===s.cardId&&normalizeMerchant(row.merchant).includes(normalizeMerchant(nisa.merchantContains)))continue;
      const merchant=displayMerchant(row.merchant,s.cardId,source.rules,row.merchantOverride).trim();
      if(!merchant||merchant.length>100||normalizeMerchant(row.merchant).length>160||cardRecurringKey(s.cardId,row.merchant).length>240)continue;
      // The issuer's original merchant survives display-rule renames.
      const key=cardRecurringKey(s.cardId,row.merchant);
      const group=groups.get(key)??{cardId:s.cardId,merchant,values:[]};
      group.values.push({period,amount:row.amount});groups.set(key,group);
    }
  }
  return groups;
}

/** Most recent *confirmed, uniquely identified* card charge for a registered merchant.
 * A new price needs no repeated pattern; a single new confirmed bill is sufficient.
 * When the latest month contains multiple matching charges, no price is guessed. */
export type LatestRegisteredCharge={month:string;amount:number};
export function latestRegisteredCardCharges(source:MonthlySource,asOf=todayPeriod()):Map<string,LatestRegisteredCharge|null> {
  const result=new Map<string,LatestRegisteredCharge|null>();
  for(const [key,group] of eligibleCardChargeGroups(source,asOf)){
    const month=group.values.reduce((latest,item)=>item.period>latest?item.period:latest,'');
    const latest=group.values.filter(item=>item.period===month);
    result.set(key,latest.length===1?{month,amount:latest[0]!.amount}:null);
  }
  return result;
}
export function latestRegisteredCardCharge(source:MonthlySource,key:string,asOf=todayPeriod()):LatestRegisteredCharge|null {
  return latestRegisteredCardCharges(source,asOf).get(key)??null;
}

/** Detection accepts only valid, confirmed, uniquely-billed statements. */
export function detectCardSubscriptions(source:MonthlySource,asOf=todayPeriod()):SubscriptionCandidate[]{
  const groups=eligibleCardChargeGroups(source,asOf);
  const results:SubscriptionCandidate[]=[];
  for(const [key,group] of groups){
    // Multiple charges on the same card / merchant / payment month are ambiguous.
    const byMonth=new Map<string,Observation[]>();
    for(const item of group.values){const values=byMonth.get(item.period)??[];values.push(item);byMonth.set(item.period,values);}
    const distinct=[...byMonth.values()].filter(items=>items.length===1).map(items=>items[0]!).sort((a,b)=>a.period.localeCompare(b.period));
    if(distinct.length<2)continue;
    let winner:{frequency:'monthly'|'yearly';values:Observation[]}|null=null;
    // Treat each observed amount as a possible price tier, then pick the most recent substantial pattern.
    for(const anchor of distinct){
      const closeRows=distinct.filter(o=>close(o.amount,anchor.amount));
      const run:Observation[][]=[];let running:Observation[]=[];
      for(const obs of closeRows){
        if(running.length&&periodNumber(obs.period)-periodNumber(running.at(-1)!.period)>1){run.push(running);running=[];}
        running.push(obs);
      }
      if(running.length)run.push(running);
      for(const values of run){
        const recency=periodNumber(asOf)-periodNumber(values.at(-1)!.period);
        if(values.length>=3&&recency<=3&&(!winner||winner.frequency==='yearly'||values.length>winner.values.length||
          (values.length===winner.values.length&&values.at(-1)!.period>winner.values.at(-1)!.period)))
          winner={frequency:'monthly',values};
      }
      // Yearly: two different years, roughly twelve months apart, never inferred from one charge.
      if(!winner){
        for(let i=1;i<closeRows.length;i++){
          const a=closeRows[i-1]!,b=closeRows[i]!;
          if(periodNumber(b.period)-periodNumber(a.period)!==12||periodNumber(asOf)-periodNumber(b.period)>14)continue;
          winner={frequency:'yearly',values:[a,b]};
        }
      }
    }
    if(!winner)continue;
    const {frequency,values}=winner;
    // An already registered bank-side recurring expense is not proposed as a new card charge.
    if(source.assets.recurring.some(item=>item.enabled&&item.kind==='expense'&&item.frequency===frequency&&
      normalizeMerchant(item.name)===normalizeMerchant(group.merchant)&&close(item.amount,median(values.map(v=>v.amount)))))continue;
    const amount=median(values.map(v=>v.amount));
    results.push({key,cardId:group.cardId,cardName:source.assets.cardPreferences?.[group.cardId]?.name??CARDS.find(c=>c.id===group.cardId)?.name??'カード',
      merchant:group.merchant,frequency,amount,minAmount:Math.min(...values.map(v=>v.amount)),maxAmount:Math.max(...values.map(v=>v.amount)),
      months:values.map(v=>v.period),confidence:frequency==='monthly'&&values.length>=4?'high':'medium'});
  }
  return results.sort((a,b)=>b.months.at(-1)!.localeCompare(a.months.at(-1)!)||b.months.length-a.months.length||a.merchant.localeCompare(b.merchant,'ja'));
}
export function pendingCardSubscriptions(source:MonthlySource,asOf?:string):SubscriptionCandidate[]{
  const decisions=source.assets.cardRecurringDecisions??{};
  return detectCardSubscriptions(source,asOf).filter(candidate=>!matchedCardRecurringDecision(decisions,candidate));
}
export function subscriptionDecision(candidate:SubscriptionCandidate,state:CardRecurringDecision['state'],now=new Date().toISOString()):CardRecurringDecision {
  return {cardId:candidate.cardId,merchant:candidate.key.slice(candidate.cardId.length+1),label:candidate.merchant,amount:candidate.amount,
    frequency:candidate.frequency,state,updatedAt:now};
}

/** Read old display-name-keyed decisions without changing encrypted storage.
 * A renamed legacy alias cannot be mapped reliably without user confirmation. */
export function matchedCardRecurringDecision(decisions:Record<string,CardRecurringDecision>,candidate:SubscriptionCandidate):string|null {
  if(decisions[candidate.key])return candidate.key;
  const legacy=cardRecurringKey(candidate.cardId,candidate.merchant);
  return decisions[legacy]?legacy:null;
}
/** Offer *manual* migration only when the old decision and new candidate form
 * an unambiguous one-to-one pair for the same card and recurrence frequency. */
export function legacyDecisionMigrationCandidate(
  decisions:Record<string,CardRecurringDecision>,candidates:SubscriptionCandidate[],candidate:SubscriptionCandidate
):string|null {
  if(matchedCardRecurringDecision(decisions,candidate))return null;
  const unlinked=candidates.filter(c=>!matchedCardRecurringDecision(decisions,c)&&c.cardId===candidate.cardId);
  const linked=new Set(candidates.flatMap(c=>{
    const key=matchedCardRecurringDecision(decisions,c);return key?[key]:[];
  }));
  const orphaned=Object.entries(decisions).filter(([key,item])=>!linked.has(key)&&item.cardId===candidate.cardId&&item.frequency===candidate.frequency);
  const peers=unlinked.filter(c=>c.frequency===candidate.frequency);
  return orphaned.length===1&&peers.length===1?orphaned[0]![0]:null;
}
