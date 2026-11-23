/** Synthetic-data benchmark: no private Finance records or network access. */
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {monthlyReport,prepareMonthlyReports} from '../dist/src/summary/monthly-summary.js';

const periods=Array.from({length:12},(_,i)=>`2026-${String(i+1).padStart(2,'0')}`);
const records=Array.from({length:1800},(_,i)=>{
  const month=periods[i%12];
  return {id:`synthetic-${i}`,statement:{provider:'rakuten',cardId:'rakuten-mizuho',
    sourceKind:'paste',sourceName:'synthetic',billingMonth:month,paymentDate:`${month}-15`,
    statedTotal:100,confirmation:'confirmed',warnings:[],rows:[{id:`r-${i}`,usedOn:`${month}-02`,merchant:'synthetic',amount:100}]}};
});
const source={records,rules:[],categories:[],assets:{recurring:[]},payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-12'};
const plain=()=>periods.map(period=>monthlyReport(period,source));
const indexed=()=>{const prepared=prepareMonthlyReports(source.records);return periods.map(period=>monthlyReport(period,source,prepared));};
assert.deepEqual(indexed(),plain());
function sample(run){const times=[];for(let i=0;i<5;i++){
  const t=performance.now();run();times.push(performance.now()-t);
}return times.slice(1).sort((a,b)=>a-b)[1];}
// Both methods run against the same synthetic snapshot and identical result.
const baseline=sample(plain),optimized=sample(indexed);
console.log(`[Phase 3 synthetic] 1800 records x 12 months; original scan path ${baseline.toFixed(1)}ms; prepared-index path ${optimized.toFixed(1)}ms; ${(baseline/Math.max(optimized,0.001)).toFixed(2)}x`);
console.log('Note: this is a local synthetic microbenchmark, not actual OneDrive or browser UI timing.');
