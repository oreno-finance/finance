/** Cumulative *estimated* earned points from encrypted Finance statement records.
 * This is not a card provider balance and is not the number of currently redeemable points. */
import {pointsForAmount,safePointSum} from './point-benefits.js';
import type { ParsedStatement } from '../models/types.js';
export interface PointInput {statement:Pick<ParsedStatement,'cardId'|'rows'|'confirmation'>}
export interface PointEstimate {sumYen:number; rows:number; statements:number; points:number|null; provisional:number}
export function estimateCardPoints(records:readonly PointInput[],cardId:string,ratePercent:number|undefined):PointEstimate {
  let sumYen=0,rows=0,statements=0,provisional=0;
  for(const {statement} of records){
    if(statement.cardId!==cardId)continue;
    statements++;
    if(statement.confirmation==='provisional')provisional++;
    for(const row of statement.rows){
      sumYen=safePointSum(sumYen,row.amount);rows++;
    }
  }
  // Round only the final estimate; real provider point rules can differ per transaction.
  const points=ratePercent===undefined?null:pointsForAmount(sumYen,ratePercent);
  return {sumYen,rows,statements,points,provisional};
}
