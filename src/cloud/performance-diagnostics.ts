/** In-memory, bounded performance diagnostics. No URLs, IDs, tokens or financial data. */
export type FinancePhase =
  | 'graph.request' | 'graph.encrypted-download'
  | 'startup.auth' | 'startup.discover'
  | 'vault.auto-unlock' | 'vault.manual-unlock'
  | 'vault.load-all' | 'vault.years' | 'vault.rules' | 'vault.assets'
  | 'vault.refresh'
  | 'vault.rule-commit' | 'vault.asset-commit' | 'vault.year-commit'
  | 'vault.save-batch' | 'vault.delete-record' | 'vault.encrypted-upload'
  | 'ui.home.overview' | 'ui.analysis.aggregate'
  | 'ui.home.render' | 'ui.home.points'
  | 'ui.analysis.render' | 'ui.analysis.points' | 'ui.analysis.chart';
export type FinanceRequestKind = 'graph.get' | 'graph.write' | 'graph.download' | 'graph.upload-chunk';
interface Samples {count:number; failures:number; totalMs:number; minMs:number; maxMs:number}
const samples = new Map<FinancePhase,Samples>();
const requests:Record<FinanceRequestKind,number> = {'graph.get':0,'graph.write':0,'graph.download':0,'graph.upload-chunk':0};
const origin = typeof performance==='undefined'?0:performance.now();
const ms = () => typeof performance==='undefined'?Date.now():performance.now();
export async function measureFinancePhase<T>(phase:FinancePhase,run:()=>Promise<T>):Promise<T>{
  const started=ms();let ok=false;
  try {const value=await run();ok=true;return value;}
  finally {
    const duration=Math.max(0,ms()-started);
    const prior=samples.get(phase)??{count:0,failures:0,totalMs:0,minMs:Infinity,maxMs:0};
    prior.count++;if(!ok)prior.failures++;
    prior.totalMs+=duration;prior.minMs=Math.min(prior.minMs,duration);prior.maxMs=Math.max(prior.maxMs,duration);
    samples.set(phase,prior);
  }
}
/** Measure synchronous read-only calculations without persisting financial data. */
export function measureFinanceSync<T>(phase:FinancePhase,run:()=>T):T{
  const started=ms();let ok=false;
  try{const result=run();ok=true;return result;}
  finally{
    const duration=Math.max(0,ms()-started);
    const prior=samples.get(phase)??{count:0,failures:0,totalMs:0,minMs:Infinity,maxMs:0};
    prior.count++;if(!ok)prior.failures++;
    prior.totalMs+=duration;prior.minMs=Math.min(prior.minMs,duration);prior.maxMs=Math.max(prior.maxMs,duration);
    samples.set(phase,prior);
  }
}
export function countFinanceRequest(kind:FinanceRequestKind):void {requests[kind]++;}
/** Aggregated totals only, with a fixed vocabulary. Nothing is persisted or transmitted. */
export function financePerformanceReport():{
  elapsedMs:number; requests:Record<FinanceRequestKind,number>;
  phases:Record<string,{count:number;failures:number;totalMs:number;averageMs:number;minMs:number;maxMs:number}>
}{
  const round=(n:number)=>Math.round(n*10)/10;
  const phases:Record<string,{count:number;failures:number;totalMs:number;averageMs:number;minMs:number;maxMs:number}>={};
  for(const [name,s] of samples)phases[name]={count:s.count,failures:s.failures,totalMs:round(s.totalMs),averageMs:round(s.totalMs/s.count),minMs:round(s.minMs),maxMs:round(s.maxMs)};
  return {elapsedMs:round(ms()-origin),requests:{...requests},phases};
}
export function clearFinancePerformance():void {samples.clear();for(const key of Object.keys(requests) as FinanceRequestKind[])requests[key]=0;}
// Local, read-only diagnostics from browser DevTools: financePerformanceReport()
// No data or source identifiers are exposed. The method cannot mutate the vault.
if(typeof window!=='undefined'&&!Object.prototype.hasOwnProperty.call(window,'financePerformanceReport')){
  Object.defineProperty(window,'financePerformanceReport',{value:financePerformanceReport,configurable:false,writable:false});
}
