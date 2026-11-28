/** In-memory, bounded performance diagnostics. No URLs, IDs, tokens or financial data. */
export type FinancePhase =
  | 'graph.request' | 'graph.encrypted-download' | 'graph.upload-chunk'
  | 'vault.lock-acquire' | 'vault.lock-release' | 'vault.lock-inspect' | 'vault.lock-revalidate'
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
const httpStatuses:Record<string,number> = {};
let retries=0;
export function countFinanceStatus(status:number):void {
  if(Number.isInteger(status)&&status>=100&&status<=599)httpStatuses[status]=(httpStatuses[status]??0)+1;
}
export function countFinanceRetry():void {retries++;}
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
  elapsedMs:number; requests:Record<FinanceRequestKind,number>; httpStatuses:Record<string,number>; retries:number;
  phases:Record<string,{count:number;failures:number;totalMs:number;averageMs:number;minMs:number;maxMs:number}>
}{
  const round=(n:number)=>Math.round(n*10)/10;
  const phases:Record<string,{count:number;failures:number;totalMs:number;averageMs:number;minMs:number;maxMs:number}>={};
  for(const [name,s] of samples)phases[name]={count:s.count,failures:s.failures,totalMs:round(s.totalMs),averageMs:round(s.totalMs/s.count),minMs:round(s.minMs),maxMs:round(s.maxMs)};
  return {elapsedMs:round(ms()-origin),requests:{...requests},httpStatuses:{...httpStatuses},retries,phases};
}
export function clearFinancePerformance():void {activeTrace=null;samples.clear();retries=0;for(const key of Object.keys(httpStatuses))delete httpStatuses[key];for(const key of Object.keys(requests) as FinanceRequestKind[])requests[key]=0;}
// Local, read-only diagnostics from browser DevTools: financePerformanceReport()
// No data or source identifiers are exposed. The method cannot mutate the vault.
if(typeof window!=='undefined'&&!Object.prototype.hasOwnProperty.call(window,'financePerformanceReport')){
  Object.defineProperty(window,'financePerformanceReport',{value:financePerformanceReport,configurable:false,writable:false});
}

// Console-only tracing. Fixed labels and numeric aggregates; never log arguments,
// results, errors, paths, request headers, or financial data.
const operationLabels = {
  onedrive:'OneDrive通信', startup:'起動・接続', discover:'保管庫確認', connection:'接続操作',
  unlock:'保管庫解除', create:'保管庫作成', refresh:'最新取得', migration:'旧データ移行',
  'statement-save':'明細保存', 'statement-delete':'明細削除', 'settings-save':'設定保存',
  'rule-save':'ルール保存', 'original-read':'PDF原本取得', 'report-read':'月次レポート取得',
  'report-save':'月次レポート保存', 'payroll-sync':'Payroll同期', 'payroll-credential':'Payroll連携確認',
  'year-conflict':'年度競合確認', 'pending-check':'保存結果確認', 'pending-resume':'保存再開',
  'lock-recovery':'保存ロック復旧', 'passphrase-change':'パスフレーズ変更',
  'cleanup-preview':'整理対象確認', 'cleanup-delete':'保管庫整理',
} as const;
type Operation = keyof typeof operationLabels;
type PerformanceReport = ReturnType<typeof financePerformanceReport>;
interface Trace {start:number; before:PerformanceReport; pending:number; labels:Set<Operation>; rejected:number}
let autoTrace=false;
let activeTrace:Trace|null=null;
/** Enable for this page only. Turning off discards an unfinished measurement. */
export function financePerformanceAuto(enabled?:boolean):boolean {
  if(typeof enabled!=='boolean')return autoTrace;
  if(autoTrace!==enabled){autoTrace=enabled;activeTrace=null;}
  return autoTrace;
}
/** Group nested/overlapping async work. Global counters cannot attribute concurrent
 * network traffic to separate actions, so overlapping actions are explicitly grouped.
 * Raw Graph scopes are a fallback for operations without a higher-level scope. */
export function traceFinanceOperation<T>(operation:Operation,run:()=>Promise<T>):Promise<T>{
  if(!autoTrace)return run();
  const trace=activeTrace??{start:ms(),before:financePerformanceReport(),pending:0,labels:new Set<Operation>(),rejected:0};
  activeTrace=trace;trace.pending++;
  if(operation!=='onedrive'||trace.labels.size===0)trace.labels.add(operation);
  const finish=(rejected:boolean)=>{
    if(rejected)trace.rejected++;
    if(--trace.pending!==0||activeTrace!==trace)return;
    activeTrace=null;
    const after=financePerformanceReport(),before=trace.before;
    const requests={...after.requests};
    for(const key of Object.keys(requests) as FinanceRequestKind[])requests[key]-=before.requests[key];
    if(!Object.values(requests).some(n=>n>0))return;
    const phases:Record<string,{count:number;failures:number;totalMs:number}>={};
    for(const [key,value] of Object.entries(after.phases)){
      const prior=before.phases[key],count=value.count-(prior?.count??0);
      if(count>0)phases[key]={count,failures:value.failures-(prior?.failures??0),totalMs:Math.round(value.totalMs-(prior?.totalMs??0))};
    }
    const statuses:Record<string,number>={};
    for(const [key,value] of Object.entries(after.httpStatuses)){
      const count=value-(before.httpStatuses[key]??0);if(count>0)statuses[key]=count;
    }
    const labels=[...trace.labels].map(label=>operationLabels[label]);
    const elapsedMs=Math.round(ms()-trace.start);
    const totalRequests=Object.values(requests).reduce((sum,n)=>sum+n,0);
    // A diagnostic must never alter an application's success or failure.
    try{console.info(`[Finance性能] ${labels[0]} | ${(elapsedMs/1000).toFixed(2)}秒 | 通信カウンター ${totalRequests}回\n${JSON.stringify({
      operations:labels,elapsedMs,totalRequests,requests,httpStatuses:statuses,retries:after.retries-before.retries,phases,rejectedScopes:trace.rejected,
      measurement:'operationsは主操作と関連・同時処理。phasesの時間は重複あり。HTTPステータスは観測した応答のみ。',
    },null,2)}`);}catch{/* Console may be unavailable. */}
  };
  try{return run().then(value=>{finish(false);return value;},error=>{finish(true);throw error;});}
  catch(error){finish(true);throw error;}
}
if(typeof window!=='undefined'&&!Object.prototype.hasOwnProperty.call(window,'financePerformanceAuto')){
  Object.defineProperty(window,'financePerformanceAuto',{value:financePerformanceAuto,configurable:false,writable:false});
}
