import { matchingRule, normalizeMerchant, type MerchantRule } from '../cloud/merchant-rules.js';
import type { ParsedStatement } from '../models/types.js';
export interface RecentMerchant {merchant:string;cardId:string;lastDate:string;count:number;amount:number|null;partiallyRegistered:boolean;}
/** Raw issuer names, grouped across cards after excluding registered predicates in their own card scope. */
export function recentMerchants(statements:readonly ParsedStatement[],options:{cardId?:string;rules?:readonly MerchantRule[];merchant?:string}={}):RecentMerchant[] {
  const names=new Map<string,RecentMerchant>();
  const covered=new Map<string,boolean>(),coveredNames=new Set<string>();
  // Disabled rules are also registered; they can be edited in the existing list.
  const rules=(options.rules??[]).map(rule=>rule.enabled?rule:{...rule,enabled:true});
  for(const statement of statements){
    if(options.cardId&&statement.cardId!==options.cardId)continue;
    for(const row of statement.rows){
      const merchant=row.merchant.trim(),key=normalizeMerchant(merchant);
      if(!key||(options.merchant&&key!==options.merchant))continue;
      const scope=`${statement.cardId??'unknown'}\u0000${key}`;
      if(!covered.has(scope))covered.set(scope,!!matchingRule(merchant,statement.cardId,rules));
      if(covered.get(scope)){coveredNames.add(key);continue;}
      const date=/^\d{4}-\d{2}-\d{2}$/.test(row.usedOn)?row.usedOn:'';
      const amount=Number.isSafeInteger(row.amount)?row.amount:null;
      const previous=names.get(key);
      if(previous){
        previous.count++;
        if(date>previous.lastDate){previous.merchant=merchant;previous.lastDate=date;previous.cardId=statement.cardId??'unknown';previous.amount=amount;}
        else if(date===previous.lastDate&&amount!==previous.amount)previous.amount=null;
      }else names.set(key,{merchant,cardId:statement.cardId??'unknown',lastDate:date,count:1,amount,partiallyRegistered:false});
    }
  }
  for(const [key,item] of names)item.partiallyRegistered=coveredNames.has(key);
  return [...names.values()].sort((a,b)=>b.lastDate.localeCompare(a.lastDate)||b.count-a.count||a.merchant.localeCompare(b.merchant,'ja'));
}
