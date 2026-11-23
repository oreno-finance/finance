/** Shared date matcher for asset forecasts and monthly cashflow summaries.
 * It does not imply that a bank has completed any transfer. */
import type { RecurringEntry } from './assets.js';
import {pausedOnDay,priceOnDay} from '../fixed-costs/contracts.js';

export function recurringOccursOn(entry:RecurringEntry,day:string):boolean {
  if(!entry.enabled||day<entry.startOn||(entry.endOn!==null&&day>entry.endOn)||pausedOnDay(entry.pauses??[],day))return false;
  const yy=Number(day.slice(0,4)),mm=Number(day.slice(5,7)),dd=Number(day.slice(8,10));
  if(entry.frequency==='weekly')return new Date(`${day}T00:00:00Z`).getUTCDay()===entry.weekday;
  if(entry.frequency==='yearly'&&mm!==entry.monthOfYear)return false;
  const last=new Date(Date.UTC(yy,mm,0)).getUTCDate();
  return dd===(entry.dayOfMonth===0?last:Math.min(entry.dayOfMonth!,last));
}
export function recurringEffectiveAmount(entry:RecurringEntry,day:string):number {
  return priceOnDay(entry.pricing??[],day,entry.amount);
}
export interface RecurringOccurrence { id:string; entry:RecurringEntry; date:string }
/** Enumerate all occurrences, including future and not-yet-executed dates. */
export function recurringInMonth(period:string,entries:readonly RecurringEntry[]):RecurringOccurrence[] {
  if(!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(period))throw new Error('定期入出金の集計年月が不正です。');
  const yy=Number(period.slice(0,4)),mm=Number(period.slice(5,7));
  const last=new Date(Date.UTC(yy,mm,0)).getUTCDate();
  const results:RecurringOccurrence[]=[];
  for(const entry of entries){
    if(!entry.enabled)continue;
    for(let i=1;i<=last;i++){
      const day=`${period}-${String(i).padStart(2,'0')}`;
      if(recurringOccursOn(entry,day))results.push({id:`${entry.id}:${day}`,entry:{...entry,amount:recurringEffectiveAmount(entry,day)},date:day});
    }
  }
  return results.sort((a,b)=>a.date.localeCompare(b.date)||a.entry.name.localeCompare(b.entry.name,'ja')||a.id.localeCompare(b.id));
}
