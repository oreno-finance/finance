import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {LiveVault,CloudWriteUncertainError,CloudEditCancelledError} from '../dist/src/cloud/live-vault.js';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';
import {reportSnapshot,snapshotHash,reportRevision,revisedDocument,validateReportDocument} from '../dist/src/reports/monthly-report.js';
import {deriveCloudKey,freshSalt,encryptMonthlyReport,decryptMonthlyReport} from '../dist/src/cloud/cloud-crypto.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const pass='monthly report password 123456';
const nextPass='monthly report next password 234567';
const pay=(period)=>({id:`pay-${period}`,employerId:'main',payPeriod:period,paidOn:`${period}-25`,netPay:200000,grossPay:null,taxablePay:null,currency:'JPY',kind:'salary',revision:1});
const card=(payMonth,amount,confirmation='confirmed')=>({id:`doc-${payMonth}`,statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'demo',billingMonth:payMonth==='2026-11'?'2026-10':'2026-09',paymentDate:`${payMonth}-27`,statedTotal:amount,confirmation,warnings:[],rows:[{id:`row-${payMonth}`,usedOn:'2026-10-01',merchant:'MARKET',amount}]}});
const source=(records=[])=>({records,rules:[{id:'rule1',pattern:'MARKET',displayName:'スーパー',mode:'contains',priority:100,cardId:null,enabled:true,categoryId:'food'}],categories:[{id:'food',name:'食費',color:'orange'}],assets:{nisaCardRule:null,recurring:[],oneTime:[],snapshots:[{id:'snap-before',accountId:'nisa',balance:500000,observedAt:'2026-10-30T00:00:00Z'},{id:'snap-after',accountId:'nisa',balance:600000,observedAt:'2026-12-01T00:00:00Z'}]},payroll:{ready:true,syncedAt:100,entries:[pay('2026-10'),pay('2026-11')]},currentPeriod:'2026-11'});
const base=()=>source([card('2026-10',10000),card('2026-11',15000)]);
class FakeGraph {
  constructor(store={files:new Map(),uncertain:false,noEtag:false,blocked:false,writes:0},generation=null){this.store=store;this.generation=generation;}
  setVaultDataSet(id){this.generation=id;}
  forVaultDataSet(id){return new FakeGraph(this.store,id);}
  key(name){return `${this.generation??'legacy'}:${name}`;}
  read(name){const key=name==='index'?'root:index':this.key(name),item=this.store.files.get(key);return item?{id:key,etag:String(item.version),text:item.text}:null;}
  write(name,text,ref){
    const key=name==='index'?'root:index':this.key(name);const old=this.store.files.get(key);
    if((old&&(!ref||ref.etag!==String(old.version)))||(!old&&ref))throw new GraphError(412,'conflict');
    if(this.store.blocked)throw new GraphError(403,'accessDenied');
    this.store.writes++;
    this.store.files.set(key,{text,version:(old?.version??0)+1});
    if(this.store.uncertain)throw new Error('lost reply');
    return this.store.noEtag?null:this.read(name);
  }
  async readFinanceIndex(){return this.read('index');}
  async writeFinanceIndex(text,ref){return this.write('index',text,ref);}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async listYearFiles(){return [];}
  async readMerchantRules(){return null;}
  async readAssetSettings(){return null;}
  async listMonthlyReports(){return [...this.store.files.entries()].filter(([key])=>key.startsWith(this.key('report:'))).map(([key,file])=>({period:key.split('report:')[1],id:key,etag:String(file.version)}));}
  async readMonthlyReport(period){return this.read(`report:${period}`);}
  async writeMonthlyReport(period,text,ref){return this.write(`report:${period}`,text,ref);}
}
const make=async()=>{const graph=new FakeGraph(),vault=new LiveVault(graph);await vault.create(pass);return {graph,vault};};

test('report uses payment month and separates NISA, missing amounts and as-of balances',()=>{
  const snapshot=reportSnapshot('2026-11',base());
  assert.equal(snapshot.expense,15000);
  assert.equal(snapshot.expenseChange,5000);
  assert.equal(snapshot.balances.find(x=>x.name==='NISA口座').balance,500000);
  const missing=reportSnapshot('2026-11',source([]));
  assert.equal(missing.expense,null);assert.equal(missing.balance,null);
  assert.ok(missing.quality.includes('カード明細未取得'));
  const s=base();s.assets.nisaCardRule={cardId:'smbc-nl',merchantContains:'MARKET',enabled:true};
  const invested=reportSnapshot('2026-11',s);
  assert.equal(invested.nisaOutflow,15000);assert.equal(invested.livingOutflow,0);
  assert.deepEqual(invested.categories,[{name:'NISA積立（資産移動）',amount:15000}]);
});

test('report encryption has a dedicated authenticated domain and rejects ciphertext swapping',async()=>{
  const salt=freshSalt(),key=await deriveCloudKey(pass,salt);
  const snapshot=reportSnapshot('2026-11',base()),hash=await snapshotHash(snapshot);
  const original=revisedDocument(null,reportRevision(snapshot,hash,'今月は少し多い'));
  const ciphertext=await encryptMonthlyReport(original,key,salt);
  assert.equal((await decryptMonthlyReport(ciphertext,key,salt,'2026-11')).current.note,'今月は少し多い');
  await assert.rejects(decryptMonthlyReport(ciphertext,key,salt,'2026-10'));
  const tampered=JSON.parse(ciphertext);tampered.data=tampered.data.slice(0,-2)+'xx';
  await assert.rejects(decryptMonthlyReport(JSON.stringify(tampered),key,salt,'2026-11'));
  assert.throws(()=>validateReportDocument({...original,period:'2026-10'}));
});

test('one report per month, unchanged save is no-op, later edits retain limited history and note',async()=>{
  const {graph,vault}=await make();const snapshot=reportSnapshot('2026-11',base());
  const first=await vault.saveArchivedReport(snapshot,'初回',null);
  const count=graph.store.writes;
  assert.deepEqual(await vault.listArchivedMonths(),['2026-11']);
  const same=await vault.saveArchivedReport(snapshot,'初回',first.current.id);
  assert.equal(same.current.id,first.current.id);assert.equal(graph.store.writes,count);
  const updated=await vault.saveArchivedReport(snapshot,'修正したメモ',first.current.id);
  assert.equal(updated.history.length,1);assert.equal(updated.history[0].note,'初回');
  assert.equal((await vault.loadArchivedReport('2026-11')).current.note,'修正したメモ');
  let last=updated;
  for(let i=0;i<7;i++)last=await vault.saveArchivedReport(snapshot,`版${i}`,last.current.id);
  assert.equal(last.history.length,5);
  assert.equal((await vault.listArchivedMonths()).length,1);
});

test('concurrent report updates never silently overwrite a newer revision',async()=>{
  const {graph,vault}=await make();
  const snapshot=reportSnapshot('2026-11',base());const initial=await vault.saveArchivedReport(snapshot,'old',null);
  const other=new LiveVault(new FakeGraph(graph.store));await other.unlock(pass);
  await other.saveArchivedReport(snapshot,'from other',initial.current.id);
  await assert.rejects(vault.saveArchivedReport(snapshot,'from stale',initial.current.id),CloudEditCancelledError);
  assert.equal((await other.loadArchivedReport('2026-11')).current.note,'from other');
});

test('lost write response blocks blind resend until a successful explicit read',async()=>{
  const {graph,vault}=await make();const snapshot=reportSnapshot('2026-11',base());
  graph.store.uncertain=true;
  await assert.rejects(vault.saveArchivedReport(snapshot,'one',null),CloudWriteUncertainError);
  const count=graph.store.writes;
  await assert.rejects(vault.saveArchivedReport(snapshot,'two',null),CloudWriteUncertainError);
  assert.equal(graph.store.writes,count);
  graph.store.uncertain=false;
  const remote=await vault.loadArchivedReport('2026-11');
  assert.equal(remote.current.note,'one');
  const latest=await vault.saveArchivedReport(snapshot,'two',remote.current.id);
  assert.equal(latest.current.note,'two');
  assert.equal(latest.history.length,1);
});

test('definitive 403 does not quarantine future edits, ETag-less readback confirms success',async()=>{
  const {graph,vault}=await make();const snapshot=reportSnapshot('2026-11',base());
  graph.store.blocked=true;
  await assert.rejects(vault.saveArchivedReport(snapshot,'blocked',null),e=>e instanceof GraphError&&e.status===403);
  graph.store.blocked=false;graph.store.noEtag=true;
  const saved=await vault.saveArchivedReport(snapshot,'saved',null);
  assert.equal(saved.current.note,'saved');
});

test('rotation copies all encrypted report revisions to a new generation and preserves old archive',async()=>{
  const {graph,vault}=await make();const snapshot=reportSnapshot('2026-11',base());
  const first=await vault.saveArchivedReport(snapshot,'first',null);
  await vault.saveArchivedReport(snapshot,'second',first.current.id);
  const before=graph.store.files.get('legacy:report:2026-11').text;
  await vault.changePassphrase(pass,nextPass);
  const newVault=new LiveVault(new FakeGraph(graph.store));await newVault.unlock(nextPass);
  const after=await newVault.loadArchivedReport('2026-11');
  assert.equal(after.current.note,'second');assert.equal(after.history[0].note,'first');
  assert.equal(graph.store.files.get('legacy:report:2026-11').text,before);
  await assert.rejects(new LiveVault(new FakeGraph(graph.store)).unlock(pass),/パスフレーズ/);
});

test('report UI is routed from the monthly summary and remains locked until vault is unlocked',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  const ui=readFileSync(new URL('../src/ui/monthly-reports.ts',import.meta.url),'utf8');
  assert.match(html,/id="nav-reports"/);assert.match(html,/id="reports-view"/);
  assert.match(html,/id="monthly-report-open"/);assert.match(main,/reportsUi\?\.openPeriod\(period\)/);
  assert.match(ui,/if\(!active\(\)\)/);assert.doesNotMatch(ui,/localStorage\.setItem|sessionStorage\.setItem/);
});

test('read-only diagnostics also verify archived report encryption and detect corruption',async()=>{
  const {diagnoseVaultFiles}=await import('../dist/src/cloud/vault-diagnostics.js');
  const {graph,vault}=await make();
  await vault.saveArchivedReport(reportSnapshot('2026-11',base()),'note',null);
  const result=await diagnoseVaultFiles(graph,pass);
  assert.equal(result.ok,true);assert.match(result.report,/2026-11：正常/);
  const file=graph.store.files.get('legacy:report:2026-11');
  const cipher=JSON.parse(file.text);cipher.data=cipher.data.slice(0,-4)+'AAAA';
  graph.store.files.set('legacy:report:2026-11',{...file,text:JSON.stringify(cipher)});
  const damaged=await diagnoseVaultFiles(graph,pass);
  assert.equal(damaged.ok,false);assert.match(damaged.report,/2026-11：失敗/);
});
