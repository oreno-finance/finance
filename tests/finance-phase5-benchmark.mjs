/** Synthetic-only microbenchmark. No OneDrive access or personal finance data. */
import {performance} from 'node:perf_hooks';
import {LiveVault} from './helpers/coordinated-vault.mjs';

const rows=20,records=1800;
const fake=Array.from({length:records},(_,n)=>({
  id:`synthetic-${n}`,
  statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'synthetic',
    billingMonth:'2026-10',paymentDate:'2026-11-27',statedTotal:rows,confirmation:'confirmed',warnings:[],
    rows:Array.from({length:rows},(_,j)=>({id:`row-${n}-${j}`,merchant:`EXAMPLE-${n}-${j}`,amount:1,usedOn:'2026-10-05'}))},
}));
const vault=new LiveVault({});
vault.key={};
vault.shards=new Map([['2026',{document:{format:'finance-cloud-document-v1',records:fake,deleted:[],conflicts:[]},ref:{id:'dummy',etag:'"1"'}}]]);
const ms=(run,count)=>{const start=performance.now();for(let i=0;i<count;i++)run();return (performance.now()-start)/count;};
const before=ms(()=>vault.records(),8);
const initial=ms(()=>vault.readonlyRecords(),1);
const after=ms(()=>vault.readonlyRecords(),8);
if(vault.readonlyRecords().length!==records)throw new Error('snapshot changed synthetic record count');
console.log(`[Finance phase 5 synthetic] ${records} statements x ${rows} rows; mutable clone ${before.toFixed(2)}ms/call; immutable view first ${initial.toFixed(2)}ms; reused view ${after.toFixed(3)}ms/call`);
console.log('Note: synthetic Node microbenchmark. Not a real browser or OneDrive latency measurement.');
