/** Read-only reconciliation of card contributions and manually scheduled NISA movements.
 * Only an explicit relationship plus a unique matching occurrence can suppress a
 * schedule. A real bank movement is never silently cancelled. */
import {nisaRuleOnDay,recurringOneTimeMatch,type AssetsDocument,type NisaRuleSettings,type AssetAccountId,type RecurringEntry,type OneTimeEntry} from './assets.js';
import {recurringInMonth} from './recurring-schedule.js';
import {recurringForCalculation} from '../fixed-costs/payment-history.js';

export interface NisaCardContribution {date:string;amount:number;recordId:string;rowId:string}
export interface NisaMovementCandidate {date:string;amount:number;fromAccountId:AssetAccountId|null;toAccountId:AssetAccountId|null;sourceId:string;kind:'recurring'|'one-time';status:'planned'|'done'}
export function nisaBankFundingIndependent(doc:NisaRuleSettings,day:string):boolean {
  const rule=nisaRuleOnDay(doc,day);return !!rule?.enabled&&rule.bankFunding?.kind==='independent';
}
const incoming=(entry:Pick<RecurringEntry,'toAccountId'|'fromAccountId'>)=>entry.toAccountId==='nisa'&&entry.fromAccountId!=='nisa';
const occurrenceKey=(id:string,day:string)=>`${id}:${day}`;
export function reconcileNisaMovements(doc:NisaRuleSettings & Pick<AssetsDocument,'recurring'|'oneTime'|'fixedCosts'>,rows:readonly NisaCardContribution[],actualThrough:string,recurring=recurringForCalculation(doc)){
  const suppressedRecurring=new Set<string>(),suppressedOneTime=new Set<string>();
  const ambiguous:NisaMovementCandidate[]=[];
  const incomingRecurring=recurring.filter(incoming);
  const months=new Map<string,NisaCardContribution[]>();
  for(const row of rows){if(row.date>actualThrough||!/^(19|20|21)\d{2}-/.test(row.date))continue;const month=row.date.slice(0,7);const list=months.get(month)??[];list.push(row);months.set(month,list);}
  const oneTimeByMonth=new Map<string,OneTimeEntry[]>();
  for(const item of doc.oneTime??[]){if(!incoming(item))continue;const month=item.date.slice(0,7);const list=oneTimeByMonth.get(month)??[];list.push(item);oneTimeByMonth.set(month,list);}
  const collectCandidates=(month:string)=>{
    const oneTime=oneTimeByMonth.get(month)??[];
    const occurrences=recurringInMonth(month,incomingRecurring);
    // A unique scheduled/one-off pair is one movement, even if still planned.
    const paired=new Set<string>();
    const candidates:Array<{event:NisaMovementCandidate;recurringId?:string;oneTimeId?:string;uncertain?:boolean}> = [];
    for(const {entry,date} of occurrences){
      const match=recurringOneTimeMatch(entry,date,oneTime,undefined,recurring);
      const once=match==='unique'?oneTime.find(x=>x.date===date&&x.amount===entry.amount&&x.kind===entry.kind&&x.fromAccountId===entry.fromAccountId&&x.toAccountId===entry.toAccountId&&x.name.normalize('NFKC').trim().toLocaleLowerCase()===entry.name.normalize('NFKC').trim().toLocaleLowerCase()):undefined;
      if(once)paired.add(once.id);
      candidates.push({event:{date,amount:entry.amount,fromAccountId:entry.fromAccountId,toAccountId:entry.toAccountId,sourceId:once?.id??entry.id,kind:once?'one-time':'recurring',status:once?.status??'planned'},recurringId:entry.id,oneTimeId:once?.id,uncertain:match==='ambiguous'});
    }
    for(const once of oneTime)if(!paired.has(once.id))candidates.push({event:{date:once.date,amount:once.amount,fromAccountId:once.fromAccountId,toAccountId:once.toAccountId,sourceId:once.id,kind:'one-time',status:once.status},oneTimeId:once.id});
    return candidates;
  };
  // A relationship is valid on both dates, not inferred from equal amounts or the current rule.
  const linkKey=(date:string,amount:number,id?:string):string|null=>{
      const rule=nisaRuleOnDay(doc,date);
      return rule?.enabled&&rule.bankFunding?.kind==='same'&&(id===undefined||rule.bankFunding.recurringId===id)?
        JSON.stringify([rule.cardId,rule.merchantContains,rule.bankFunding.recurringId,amount]):null;
    };
  const adjacentMonth=(month:string,offset:number)=>{const d=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-1+offset,1));return d.toISOString().slice(0,7);};
  const cache=new Map<string,ReturnType<typeof collectCandidates>>();
  const candidatesFor=(month:string)=>{let result=cache.get(month);if(!result){result=collectCandidates(month);cache.set(month,result);}return result;};
  const ambiguousIds=new Set<string>();
  const note=(event:NisaMovementCandidate)=>{const k=JSON.stringify([event.kind,event.sourceId,event.date]);if(!ambiguousIds.has(k)){ambiguousIds.add(k);ambiguous.push(event);}};
  for(const [month,cards] of months){
    const candidates=candidatesFor(month);
    const cardCounts=new Map<string,number>(),candidateCounts=new Map<string,number>();
    const count=(map:Map<string,number>,key:string|null)=>{if(key!==null)map.set(key,(map.get(key)??0)+1);};
    for(const row of cards)count(cardCounts,linkKey(row.date,row.amount));
    for(const c of candidates)if(c.recurringId)count(candidateCounts,linkKey(c.event.date,c.event.amount,c.recurringId));
    const independentCards=cards.every(row=>nisaBankFundingIndependent(doc,row.date));
    for(const candidate of candidates){
      const event=candidate.event;
      if(independentCards&&nisaBankFundingIndependent(doc,event.date))continue;
      const key=candidate.recurringId&&event.fromAccountId!==null?linkKey(event.date,event.amount,candidate.recurringId):null;
      if(event.status==='planned'&&!candidate.uncertain&&key!==null&&cardCounts.get(key)===1&&candidateCounts.get(key)===1){
        if(candidate.recurringId)suppressedRecurring.add(occurrenceKey(candidate.recurringId,event.date));
        if(candidate.oneTimeId)suppressedOneTime.add(candidate.oneTimeId);
      }else note(event);
    }
    // A month boundary alone cannot prove the same occurrence. If an explicit
    // relationship has no same-month candidate, flag a matching adjacent-month
    // occurrence that has already come due, without suppressing either source.
    for(const [key] of cardCounts){
      if(candidateCounts.has(key))continue;
      for(const offset of [-1,1]){
        const adjacent=adjacentMonth(month,offset);
        if(months.get(adjacent)?.some(row=>linkKey(row.date,row.amount)===key))continue;
        for(const c of candidatesFor(adjacent)){
          if(c.recurringId&&c.event.date<=actualThrough&&linkKey(c.event.date,c.event.amount,c.recurringId)===key)note(c.event);
        }
      }
    }
  }
  return {
    excludesRecurring:(id:string,day:string)=>suppressedRecurring.has(occurrenceKey(id,day)),
    excludesOneTime:(id:string)=>suppressedOneTime.has(id),
    ambiguousFor:(account:AssetAccountId,start:string,end:string)=>ambiguous.filter(e=>e.date>start&&e.date<=end&&(e.fromAccountId===account||e.toAccountId===account)),
    ambiguous,
  };
}
