/** Read-only projection from encrypted rule metadata and confirmed card rows. */
import {fixedRuleKey, fixedRuleEligible, matchingRule, sortedRules, type MerchantRule, type RuleFixedCost} from '../cloud/merchant-rules.js';
import {fixedCostEvidence,type SubscriptionCandidate} from '../subscriptions/detect.js';
import {fixedCostState,type FixedCostEntry,type CostFrequency} from './contracts.js';
import type {MonthlySource} from '../summary/monthly-summary.js';
import type {AssetsDocument} from '../cloud/assets.js';
export type Charge={usedOn:string;paymentDate:string;period:string;amount:number};
export function latestFixedEvidence(rows:readonly Charge[],frequency:CostFrequency):Charge|null {
  const sorted=[...rows].sort((a,b)=>b.usedOn.localeCompare(a.usedOn)||b.paymentDate.localeCompare(a.paymentDate));
  const latest=sorted[0];if(!latest)return null;
  // An identical issuer merchant may be used for both ordinary and recurring purchases.
  const peers=sorted.filter(r=>frequency==='weekly'?r.usedOn===latest.usedOn:r.period===latest.period);
  return latest.amount>0&&peers.length===1?latest:null;
}
export function ruleFixedCharge(source:MonthlySource,rule:MerchantRule,today:string,evidence=fixedCostEvidence(source,today)):Charge|null {
  const fixed=rule.fixedCost;if(!fixed)return null;
  const current=evidence.get(fixedRuleKey(rule))??[];
  if(current.length)return latestFixedEvidence(current,fixed.frequency);
  for(const previous of [...(fixed.previous??[])].reverse()){
    if(source.rules.some(other=>other.id!==rule.id&&other.fixedCost&&other.fixedCost.state!=='ended'&&fixedRuleKey(other)===previous.key))continue;
    const rows=(evidence.get(previous.key)??[]).filter(r=>r.usedOn<=previous.through);
    if(rows.length)return latestFixedEvidence(rows,fixed.frequency);
  }
  return null;
}
/** Only plain card contracts can be retired into rules without losing dated non-card routes. */
export function migratableCardCost(item:FixedCostEntry):boolean {
  return item.payment==='card'&&!!item.cardId&&(!item.merchantKey||item.merchantKey.startsWith(item.cardId+'|'))&&!item.paymentHistory;
}
export function migratedCardCostIds(source:MonthlySource):Set<string>{
  return new Set([...(source.fixedCostMigrations??[]),...source.rules.flatMap(r=>r.fixedCost?.legacyId?[r.fixedCost.legacyId]:[])]);
}
export function legacyCardCostForRule(source:MonthlySource,rule:MerchantRule):FixedCostEntry|undefined {
  const migrated=migratedCardCostIds(source);
  const matches=(source.assets.fixedCosts??[]).filter(x=>migratableCardCost(x)&&!migrated.has(x.id)&&x.merchantKey===fixedRuleKey(rule));
  return matches.length===1?matches[0]:undefined;
}
export function ruleFixedState(f:RuleFixedCost,today:string){
  return f.state==='active'?fixedCostState({startOn:f.startOn,endOn:f.endOn??null,pauses:f.pauses??[]},today):f.state;
}
export function fixedCostRuleViews(source:MonthlySource,today:string){
  const evidence=fixedCostEvidence(source,today);
  return source.rules.flatMap(rule=>{
    const f=rule.fixedCost;if(!f)return [];
    const charge=ruleFixedCharge(source,rule,today,evidence);
    const categoryId=matchingRule(rule.pattern,rule.cardId,source.rules)?.categoryId??null;
    return [{rule,charge,categoryId,status:ruleFixedState(f,today)}];
  });
}
/** No write, no synthetic actual expense. Only future estimates use the projected price. */
export function fixedCostCalculationAssets(source:MonthlySource,today:string):AssetsDocument {
  const migrated=migratedCardCostIds(source), evidence=fixedCostEvidence(source,today);
  const rulesByKey=new Set(source.rules.filter(r=>r.fixedCost).map(fixedRuleKey));
  const fixedCosts=(source.assets.fixedCosts??[]).flatMap(item=>{
    if(migratableCardCost(item)&&(migrated.has(item.id)||!!item.merchantKey&&rulesByKey.has(item.merchantKey)))return [];
    if(!migratableCardCost(item)||!item.merchantKey)return [item]; // retain unresolved or mixed historical routes
    const charge=latestFixedEvidence(evidence.get(item.merchantKey!)??[],item.frequency);
    if(!charge)return [item]; // preserve the legacy registered price until explicit migration
    return [{...item,amount:charge.amount,pricing:[{effectiveOn:item.startOn,amount:charge.amount}]}];
  });
  for(const {rule,charge,status,categoryId} of fixedCostRuleViews(source,today)){
    if(!charge||rule.fixedCost!.state!=='active'||status==='ended')continue;
    const f=rule.fixedCost!,frequency=f.frequency,day=Number(charge.usedOn.slice(8,10));
    // The existing forecast uses usage-month schedules + the card payment timing.
    const startOn=f.startOn;
    fixedCosts.push({id:f.legacyId??rule.id,name:rule.displayName,payment:'card',cardId:rule.cardId,merchantKey:fixedRuleKey(rule),categoryId,
      frequency,dayOfMonth:frequency==='weekly'?null:day,monthOfYear:frequency==='yearly'?Number(charge.usedOn.slice(5,7)):null,
      weekday:frequency==='weekly'?new Date(charge.usedOn+'T00:00:00Z').getUTCDay():null,startOn,endOn:f.endOn??null,amount:charge.amount,
      priceKind:'fixed',pricing:[{effectiveOn:startOn,amount:charge.amount}],pauses:f.pauses??[],note:'',updatedAt:'1970-01-01T00:00:00.000Z'});
  }
  return {...source.assets,snapshots:source.assets.snapshots??[],fixedCosts} as AssetsDocument;
}
export function legacyRuleFixedCost(item:FixedCostEntry):RuleFixedCost {
  return {frequency:item.frequency,state:'active',startOn:item.startOn,endOn:item.endOn,pauses:item.pauses,legacyId:item.id};
}
/** Draft creation shares the existing exact rule; broader classification is inherited by a dedicated exact rule. */
export function prepareCardFixedRule(source:MonthlySource,today:string,target:{candidate?:SubscriptionCandidate;legacy?:FixedCostEntry}={}){
  const {candidate,legacy}=target,key=candidate?.key??legacy?.merchantKey??undefined;
  const cardId=candidate?.cardId??legacy?.cardId??null,pattern=key?.slice(key.indexOf('|')+1)??'';
  const exact=key?sortedRules(source.rules).find(r=>r.enabled&&fixedRuleEligible(r)&&fixedRuleKey(r)===key)??sortedRules(source.rules).find(r=>r.fixedCost&&fixedRuleKey(r)===key):undefined;
  const existing=exact??(key?matchingRule(pattern,cardId,source.rules):undefined);
  const rule:MerchantRule=exact??{id:'preview-rule',pattern,mode:'exact',displayName:existing?.displayName??candidate?.merchant??legacy?.name??'',cardId,enabled:true,priority:existing?.priority??100,categoryId:existing?.categoryId??null};
  const fixed:RuleFixedCost=exact?.fixedCost??(legacy&&migratableCardCost(legacy)?legacyRuleFixedCost(legacy):{frequency:candidate?.frequency??'monthly',state:'active',startOn:today});
  if(!legacy&&!exact?.fixedCost&&key){const charge=ruleFixedCharge(source,{...rule,fixedCost:fixed},today);if(charge)fixed.startOn=charge.usedOn;}
  return {rule,fixed,key,isNew:!exact};
}
/** A route change uses the prior actual only until the new card has its own observation. */
export function editRuleFixedDraft(rule:MerchantRule,draft:RuleFixedCost|undefined,oldKey:string|undefined,state:RuleFixedCost['state'],frequency:CostFrequency,today:string,source?:MonthlySource|null):RuleFixedCost {
  const key=fixedRuleKey(rule),changed=!!oldKey&&oldKey!==key&&oldKey.indexOf('|')>0&&!!oldKey.slice(oldKey.indexOf('|')+1)&&oldKey.split('|')[0]!=='null';
  const previous=(draft?.previous??[]).filter(x=>x.key!==key&&(!changed||x.key!==oldKey));
  if(changed)previous.push({key:oldKey!,through:today});
  const oldState=draft?ruleFixedState(draft,today):'active';
  const stateChanged=!!draft&&state!==(oldState==='scheduled'?'active':oldState);
  const result:RuleFixedCost={...draft,frequency,state:stateChanged?state:draft?.state??state,startOn:changed?today:draft?.startOn??today,...(previous.length?{previous}:{previous:undefined})};
  if(stateChanged){result.endOn=null;result.pauses=[];}
  if(changed){result.pauses=(result.pauses??[]).filter(p=>p.startOn>=today);if(result.endOn&&result.endOn<today)result.endOn=null;}
  if(!draft&&!changed&&source&&fixedRuleEligible(rule)){
    const evidence=ruleFixedCharge(source,{...rule,fixedCost:result},today);
    if(evidence)result.startOn=evidence.usedOn;
  }
  return result;
}
