import test from 'node:test';
import assert from 'node:assert/strict';
import {OneDriveTestClient,GraphError,VaultOperationBusyError,VaultMutationUncertainError} from '../dist/src/cloud/onedrive-api.js';
import {LiveVault,CloudWriteUncertainError,CloudEditCancelledError} from '../dist/src/cloud/live-vault.js';
import {readFileSync} from 'node:fs';

// Exercise the actual HTTP client with deterministic synthetic data and a
// separate upload endpoint. No Microsoft account, real data, or network.
function fixture(){
 const s={marker:null,serial:0,files:new Map(),sessions:new Map(),requests:[],chunkCalls:0,deleteCalls:0,throttleAt:new Set(),mode:'normal',children:[],createThrottle:false,createFail:false,onDelete:null};
 const name='finance-operation-lock';
 const err=(status,code='fixture')=>Response.json({error:{code}},{status,headers:{'Retry-After':'0'}});
 const api=new OneDriveTestClient('synthetic-token',async(url,init={})=>{
  const method=init.method??'GET';s.requests.push({url,method,headers:init.headers});
  if(url.startsWith('https://upload.invalid/')){
   assert.equal(init.headers.Authorization,undefined);assert.equal(init.credentials,'omit');
   const target=s.sessions.get(url);assert.ok(target);s.chunkCalls++;
   if(s.throttleAt.delete(s.chunkCalls)||s.mode==='throttle-all')return err(429);
   if(s.mode==='lost-uncommitted')throw new Error('synthetic lost final response');
   const file={id:target,eTag:`"file-${++s.serial}"`,text:new TextDecoder().decode(init.body)};s.files.set(target,file);
   if(s.mode==='lost-committed')throw new Error('synthetic lost final response');
   return Response.json({id:file.id,eTag:file.eTag},{status:201});
  }
  if(url.startsWith('https://download.invalid/')){
   const file=s.files.get(decodeURIComponent(url.slice('https://download.invalid/'.length)));assert.ok(file);return new Response(file.text);
  }
  if(method==='POST'&&url.endsWith('/children')){
   if(s.marker)return err(409,'nameAlreadyExists');
   s.marker={id:`marker-${++s.serial}`,name,eTag:`"marker-${s.serial}"`,folder:{childCount:0},createdDateTime:'2026-01-01T00:00:00Z'};return Response.json(s.marker,{status:201});
  }
  if(method==='POST'&&url.endsWith('/createUploadSession')){
   if(s.createFail)throw new Error('synthetic lost session allocation');
   if(s.createThrottle){s.createThrottle=false;return err(429);}
   const named=url.indexOf(':/',8);
   const target=decodeURIComponent(named>=0?url.slice(named+2,-':/createUploadSession'.length):url.match(/\/items\/([^/]+)\/createUploadSession$/)[1]);
   if(named<0&&(!s.files.has(target)||init.headers['If-Match']!==s.files.get(target).eTag))return err(412,'resourceModified');
   const session=`https://upload.invalid/${++s.serial}`;s.sessions.set(session,target);return Response.json({uploadUrl:session});
  }
  if(method==='DELETE'){
   s.deleteCalls++;s.onDelete?.();
   if(!s.marker||!url.endsWith('/'+s.marker.id))return err(404,'itemNotFound');
   if(init.headers['If-Match']!==s.marker.eTag)return err(412,'resourceModified');
   if(s.mode==='delete-throttle'){s.mode='normal';return err(429);}
   if(s.mode==='delete-rejected')return err(403);
   s.marker=null;
   if(s.mode==='delete-lost'){s.mode='normal';throw new Error('synthetic lost DELETE response');}
   return new Response(null,{status:204});
  }
  if(method==='GET'&&url.includes(`:/${name}?`))return s.marker?Response.json(s.marker):err(404);
  if(method==='GET'&&url.includes('/children?')&&url.includes('/marker-'))return Response.json({value:s.children});
  if(method==='GET'&&url.indexOf(':/',8)>=0){
   const target=decodeURIComponent(url.slice(url.indexOf(':/',8)+2).split('?')[0]);const file=s.files.get(target);
   return file?Response.json({id:file.id,eTag:file.eTag,'@microsoft.graph.downloadUrl':`https://download.invalid/${encodeURIComponent(target)}`}):err(404);
  }
  throw new Error('Unexpected fixture request');
 });
 api.folderPath=async()=> 'root';return {s,api};
}
const guard=()=>{};
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('45件の原本送信中に明示的な429が発生しても待機再試行し、最後にロックを解除する',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.createThrottle=true;s.throttleAt=new Set([12,28,44]);
 for(let i=1;i<=45;i++)await api.uploadDatedOriginal(id(i),`encrypted-sample-${i}`,'2026-01');
 s.mode='delete-throttle';await release();assert.equal(s.files.size,45);assert.equal(s.chunkCalls,48);assert.equal(s.deleteCalls,2);assert.equal(s.marker,null);
 const next=await api.acquireVaultMutation(guard);await next();assert.equal(s.marker,null);
});
test('429の再試行上限を超えても書込み不明のロックを作らない',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.mode='throttle-all';
 await assert.rejects(api.uploadDatedOriginal(id(1),'synthetic-cipher','2026-01'),e=>e instanceof GraphError&&e.status===429);
 assert.equal(s.chunkCalls,4);assert.equal(s.files.size,0);await release();assert.equal(s.marker,null);
});
test('セッション作成の応答消失では原本の送信を開始していないのでロック解除できる',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.createFail=true;
 await assert.rejects(api.uploadDatedOriginal(id(1),'synthetic-cipher','2026-01'),/lost session/);
 assert.equal(s.chunkCalls,0);await release();assert.equal(s.marker,null);
});
test('最終送信応答が消失しても暗号文の完全一致で確認できれば再送せず解除できる',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.mode='lost-committed';
 await api.uploadDatedOriginal(id(1),'synthetic-cipher','2026-01');assert.equal(s.chunkCalls,1);assert.equal(s.files.size,1);
 await release();assert.equal(s.marker,null);
});
test('最終送信の結果を証明できなければ再送も自動解除もしない',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.mode='lost-uncommitted';
 await assert.rejects(api.uploadDatedOriginal(id(1),'synthetic-cipher','2026-01'),/lost final/);assert.equal(s.chunkCalls,1);
 await assert.rejects(release(),/操作ロックを保持/);assert.ok(s.marker);assert.equal(s.deleteCalls,0);
});
test('解除応答が消失しても同じIDの再確認で復旧し、新しいロックを削除しない',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.mode='delete-lost';await release();assert.equal(s.marker,null);assert.equal(s.deleteCalls,2);
 const next=await api.acquireVaultMutation(guard);await next();
});
test('残留ロック復旧は明示承認・保管庫検証・同一空フォルダーの再確認がすべて必要',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.mode='delete-rejected';await assert.rejects(release(),/403/);s.mode='normal';
 const initial=s.marker.id;let verified=0;const verify=async()=>{verified++;};
 assert.equal(await api.recoverVaultMutationLock(guard,verify,async()=>false),'cancelled');assert.equal(verified,0);assert.equal(s.marker.id,initial);
 await assert.rejects(api.recoverVaultMutationLock(guard,async()=>{throw new Error('invalid vault');},async()=>true),/invalid vault/);assert.equal(s.marker.id,initial);
 s.children=[{id:'unexpected-child'}];await assert.rejects(api.recoverVaultMutationLock(guard,verify,async()=>true),/空ではない/);s.children=[];
 assert.equal(await api.recoverVaultMutationLock(guard,verify,async()=>true),'released');assert.equal(s.marker,null);assert.equal(verified,1);
});
test('復旧確認中に対象の変更・ローカル操作・アカウント変更があれば解除しない',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);
 await assert.rejects(api.recoverVaultMutationLock(guard,async()=>{},async()=>true),VaultOperationBusyError);
 s.mode='delete-rejected';await assert.rejects(release(),/403/);s.mode='normal';const deletes=s.deleteCalls;
 await assert.rejects(api.recoverVaultMutationLock(guard,async()=>{s.marker={...s.marker,id:'marker-successor',eTag:'"new"'};},async()=>true),/変化しました/);assert.equal(s.deleteCalls,deletes);assert.equal(s.marker.id,'marker-successor');
 let current=true;await assert.rejects(api.recoverVaultMutationLock(()=>{if(!current)throw new Error('context changed');},async()=>{},async()=>{current=false;return true;}),/context changed/);assert.equal(s.deleteCalls,deletes);
});
test('作成後に同じ空ロックのETagが変わっても所有者だけが最新ETagで解除し次の保存へ進める',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);
 const old=s.marker.eTag,markerId=s.marker.id;s.marker.eTag='"updated-marker"';
 await release();assert.equal(s.marker,null);
 const deletes=s.requests.filter(r=>r.method==='DELETE');assert.equal(deletes.length,2);
 assert.deepEqual(deletes.map(r=>r.headers['If-Match']),[old,'"updated-marker"']);
 assert.ok(deletes.every(r=>r.url.endsWith('/'+markerId)));
 assert.ok(s.requests.some(r=>r.url.includes('/'+markerId+'/children?')));
 const next=await api.acquireVaultMutation(guard);await next();assert.equal(s.marker,null);
});
test('412再照合で別IDのロックを発見した場合は後続ロックを削除しない',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.marker.eTag='"changed"';
 const request=api.http;api.http=async(url,init)=>{
   if((init?.method??'GET')==='GET'&&url.includes(':/finance-operation-lock?'))s.marker={...s.marker,id:'marker-successor',eTag:'"successor"'};
   return request(url,init);
 };
 await assert.rejects(release(),/IDが変化/);assert.equal(s.deleteCalls,1);assert.equal(s.marker.id,'marker-successor');
});
test('412再照合で空でないロックや再変更されたETagは解除せず停止する',async()=>{
 for(const mode of ['nonempty','changing','same-etag']){
   const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);const old=s.marker.eTag;
   s.marker.eTag='"changed"';
   if(mode==='nonempty')s.children=[{id:'synthetic-child'}];
   if(mode==='changing')s.onDelete=()=>{if(s.deleteCalls===2)s.marker.eTag='"changed-again"';};
   if(mode==='same-etag'){
     const request=api.http;api.http=async(url,init)=>{
       if((init?.method??'GET')==='GET'&&url.includes(':/finance-operation-lock?'))return Response.json({...s.marker,eTag:old});
       return request(url,init);
     };
   }
   await assert.rejects(release(),mode==='nonempty'?/空ではない/:/412/);
   assert.equal(s.deleteCalls,mode==='changing'?2:1);assert.ok(s.marker);
 }
});
test('書込み結果が不明ならETagが変化してもロックの再照合・解除を行わない',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.mode='lost-uncommitted';
 await assert.rejects(api.uploadDatedOriginal(id(1),'synthetic-cipher','2026-01'),/lost final/);
 s.marker.eTag='"changed"';await assert.rejects(release(),/操作ロックを保持/);assert.equal(s.deleteCalls,0);assert.ok(s.marker);
});
test('保存確定後の解除失敗は保存済みの結果を維持し、失敗時は元の原因も表示する',async()=>{
 const client={acquireVaultMutation:async()=>async()=>{throw new Error('synthetic release failure');}};const vault=new LiveVault(client);
 const result=await vault.withMutation(guard,async()=>['saved-id'],undefined,false);assert.deepEqual(result,['saved-id']);assert.match(vault.takeMutationWarning(),/保存は確認済み.*synthetic release failure/);
 await assert.rejects(vault.withMutation(guard,async()=>{throw new Error('synthetic upload failure');},undefined,false),e=>e instanceof CloudWriteUncertainError&&/synthetic upload failure.*synthetic release failure/.test(e.message));
});
test('復旧UIは入力による確認を要求し、下書きや再開計画を消去しない',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');const ui=readFileSync(new URL('../src/cloud/cloud-settings.ts',import.meta.url),'utf8');const source=readFileSync(new URL('../src/cloud/live-vault.ts',import.meta.url),'utf8');
 assert.match(html,/id="cloud-lock-recover"/);assert.match(ui,/requiredText:'解除'/);assert.match(ui,/他のすべてのFinanceタブを閉じ/);
 const recover=source.slice(source.indexOf('async recoverSaveLock('),source.indexOf('  /** Old releases'));
 assert.match(recover,/this\.readCurrent/);assert.doesNotMatch(recover,/this\.refresh\(|pendingYearBatch\s*=/);
});

// Full batch orchestration and encryption with the real upload/lock client.
// Year/index storage here is a conditional encrypted in-memory implementation.
test('LiveVaultの45件一括保存は429を挟んでも全件登録され、次の保存を妨げない',async()=>{
 const {s,api}=fixture();const files=new Map();let version=0;
 const read=key=>files.get(key)??null;
 const write=(key,text,ref)=>{const old=read(key);if(ref?old?.etag!==ref.etag:!!old)throw new GraphError(412,'conflict');const file={id:key,etag:`"rev-${++version}"`,text};files.set(key,file);return file;};
 api.readFinanceMetadata=async kind=>read(kind);api.readFinanceIndex=async()=>read('index');api.writeFinanceIndex=async(text,ref)=>{write('index',text,ref);};
 api.readLiveVault=async()=>null;api.ensurePayrollNamespace=async()=>{};api.readMerchantRules=async()=>null;api.readAssetSettings=async()=>null;
 api.listYearFiles=async()=>[...files].filter(([k])=>k.startsWith('year:')).map(([k,v])=>({year:k.slice(5),id:v.id,etag:v.etag}));
 api.readYearVault=async year=>read('year:'+year);api.readListedYearVault=async file=>read('year:'+file.year);
 api.readYearVaultForSave=async year=>({kind:'remote',file:read('year:'+year)});
 api.writeYearVault=async(year,text,ref)=>write('year:'+year,text,ref);
 const vault=new LiveVault(api);await vault.create('synthetic-password-for-test');
 s.throttleAt=new Set([10,23,44]);const candidates=[];
 for(let i=0;i<45;i++){
   const year=2023+Math.floor(i/12),month=String(i%12+1).padStart(2,'0'),billingMonth=`${year}-${month}`;
   candidates.push({id:`fixture-record-${i}`,statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'pdf',sourceName:'synthetic.pdf',billingMonth,paymentDate:`${billingMonth}-27`,statedTotal:100,confirmation:'confirmed',warnings:[],rows:[{id:`row-${i}`,usedOn:`${billingMonth}-01`,merchant:'SAMPLE',amount:100}]},source:{bytes:new Uint8Array([37,80,68,70,i]),mime:'application/pdf'}});
 }
 s.onDelete=()=>{if(s.deleteCalls===1)s.marker.eTag='"updated-during-save"';};
 const ids=await vault.saveBatch(candidates);assert.equal(ids.length,45);assert.equal(vault.records().length,45);assert.equal(s.files.size,45);assert.equal(s.marker,null);
 assert.equal(s.chunkCalls,48);assert.equal(s.deleteCalls,2);assert.equal(vault.takeMutationWarning(),null);await vault.refresh();assert.equal(vault.records().length,45);
 const next={...candidates[0].statement,statedTotal:101,rows:[{...candidates[0].statement.rows[0],amount:101}]};await vault.saveBatch([{id:ids[0],statement:next}]);assert.equal(s.marker,null);assert.equal(vault.records().find(r=>r.id===ids[0]).statement.statedTotal,101);
});

test('完了済みの自分の残留ロックは次の共通操作取得時に同一IDと最新ETagでのみ解除',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);const original=s.marker.id;
 s.mode='delete-rejected';await assert.rejects(release(),/403/);s.mode='normal';s.marker.eTag='"new-etag"';
 const next=await api.acquireVaultMutation(guard);assert.notEqual(s.marker.id,original);await next();assert.equal(s.marker,null);
});
test('完了済みマーカーが別IDに置換されていれば取得を拒否し削除しない',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.mode='delete-rejected';await assert.rejects(release(),/403/);s.mode='normal';
 s.marker={...s.marker,id:'marker-successor',eTag:'"successor"'};const deletes=s.deleteCalls;
 await assert.rejects(api.acquireVaultMutation(guard),VaultOperationBusyError);assert.equal(s.deleteCalls,deletes);assert.equal(s.marker.id,'marker-successor');
});
test('書込み結果不明の自分のロックは次の操作でも解除しない',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);s.mode='lost-uncommitted';await assert.rejects(api.uploadDatedOriginal(id(1),'synthetic-cipher','2026-01'),/lost final/);
 await assert.rejects(release(),/操作ロックを保持/);s.mode='normal';await assert.rejects(api.acquireVaultMutation(guard),VaultOperationBusyError);assert.equal(s.deleteCalls,0);
});

// Phase 2B: the common result contract covers all save entrances, not just PDF batches.
test('書込み未確認の解除拒否は成功通知に変換しない',async()=>{
 const client={acquireVaultMutation:async()=>async()=>{throw new VaultMutationUncertainError();}};const messages=[];const vault=new LiveVault(client,message=>messages.push(message));
 await assert.rejects(vault.withMutation(guard,async()=>42,undefined,false),CloudWriteUncertainError);
 assert.deepEqual(messages,[]);assert.equal(vault.takeMutationWarning(),null);assert.equal(vault.activeMutation,null);
});
test('取得失敗では金融書込みを開始せず、明確な中止として扱う',async()=>{
 const client={acquireVaultMutation:async()=>{throw new Error('synthetic connection failure');}};const vault=new LiveVault(client);let writes=0;
 await assert.rejects(vault.withMutation(guard,async()=>{writes++;},undefined,false),CloudEditCancelledError);assert.equal(writes,0);
});
test('既知の書込み拒否と解除障害は結果不明に変換せず、競合再試行もさせない',async()=>{
 const client={acquireVaultMutation:async()=>async()=>{throw new Error('synthetic release failure');}};const vault=new LiveVault(client);
 await assert.rejects(vault.withMutation(guard,async()=>{throw new GraphError(412,'fixture');},undefined,false),e=>e instanceof CloudEditCancelledError&&/412.*synthetic release failure/.test(e.message));
 assert.equal(vault.takeMutationWarning(),null);
});
test('自己ロック解除失敗後の資産・ルール・レポート保存は成功を維持し、次の操作で復帰する',async()=>{
 const {s,api}=fixture();const files=new Map();let serial=0;
 const read=k=>files.get(k)??null;
 const write=(k,text,ref)=>{const old=read(k);if(ref?old?.etag!==ref.etag:!!old)throw new GraphError(412,'conflict');const result={id:k,etag:`rev-${++serial}`,text};files.set(k,result);return result;};
 api.readFinanceMetadata=async kind=>read(kind);api.readFinanceIndex=async()=>read('index');api.writeFinanceIndex=async(text,ref)=>write('index',text,ref);
 api.readLiveVault=async()=>null;api.ensurePayrollNamespace=async()=>{};api.listYearFiles=async()=>[];
 api.readAssetSettings=async()=>read('assets');api.writeAssetSettings=async(text,ref)=>write('assets',text,ref);
 api.readMerchantRules=async()=>read('rules');api.writeMerchantRules=async(text,ref)=>write('rules',text,ref);
 api.readMonthlyReport=async period=>read(period);api.writeMonthlyReport=async(period,text,ref)=>write(period,text,ref);
 const messages=[];const vault=new LiveVault(api,message=>messages.push(message));await vault.create('synthetic-password-for-test');
 const rule={id:'rule-a',pattern:'SHOP',displayName:'Sample',mode:'contains',cardId:null,enabled:true,priority:100};
 s.mode='delete-rejected';await vault.setBirthMonth('2000-01');assert.ok(s.marker);assert.equal(vault.assetSettings().birthMonth,'2000-01');
 assert.match(messages.at(-1),/保存は確認済み/);const asset=read('assets');
 // Even a failed automatic cleanup on the next save must not mark settings uncertain.
 await assert.rejects(vault.setBirthMonth('2000-02'),CloudEditCancelledError);assert.equal(read('assets'),asset);
 s.mode='normal';await vault.setBirthMonth('2000-02');assert.equal(s.marker,null);assert.equal(vault.assetSettings().birthMonth,'2000-02');
 s.mode='delete-rejected';await vault.upsertMerchantRule(rule);assert.ok(s.marker);assert.equal(vault.merchantRules()[0].displayName,'Sample');
 s.mode='normal';await vault.upsertMerchantRule({...rule,displayName:'Edited'});assert.equal(s.marker,null);assert.equal(vault.merchantRules()[0].displayName,'Edited');
 const {reportSnapshot}=await import('../dist/src/reports/monthly-report.js');
 const snapshot=reportSnapshot('2026-01',{records:[],rules:[],categories:[],assets:vault.assetSettings(),payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-01'});
 s.mode='delete-rejected';const report=await vault.saveArchivedReport(snapshot,'sample',null);assert.ok(s.marker);
 s.mode='normal';const next=await vault.saveArchivedReport(snapshot,'edited',report.current.id);assert.equal(s.marker,null);assert.equal(next.current.note,'edited');
 assert.equal(messages.length,3);assert.equal(vault.takeMutationWarning(),null);
 // A competing marker must not disable read-only access or mutate the draft.
 s.marker={id:'marker-other',name:'finance-operation-lock',eTag:'other',folder:{childCount:0}};const deletes=s.deleteCalls;const before=read('assets');
 await assert.rejects(vault.refresh(),/保存操作が進行中/);assert.equal(vault.assetSettings().birthMonth,'2000-02');assert.equal((await vault.loadArchivedReport('2026-01')).current.note,'edited');
 await assert.rejects(vault.setBirthMonth('2000-03'),CloudEditCancelledError);assert.equal(read('assets'),before);assert.equal(s.deleteCalls,deletes);
 s.marker=null;await vault.setBirthMonth('2000-03');assert.equal(vault.assetSettings().birthMonth,'2000-03');
});

test('H202: malformed final success body is an uncertain write, not a safe rejection',async()=>{
 for(const body of ['{','null','[]','{}','{"id":7}','{"id":""}']){
  const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);
  const request=api.http;api.http=async(url,init)=>url.startsWith('https://upload.invalid/')?(s.chunkCalls++,new Response(body,{status:201})):request(url,init);
  await assert.rejects(api.uploadDatedOriginal(id(1),'synthetic-cipher','2026-01'));
  assert.equal(s.chunkCalls,1);await assert.rejects(release(),/操作ロックを保持/);assert.ok(s.marker);assert.equal(s.deleteCalls,0);
 }
});
test('H202: malformed final body after committing can recover only by exact read-back',async()=>{
 const {s,api}=fixture();const release=await api.acquireVaultMutation(guard);
 const request=api.http;api.http=async(url,init)=>{const response=await request(url,init);return url.startsWith('https://upload.invalid/')?new Response('{',{status:201}):response;};
 const receipt=await api.uploadDatedOriginal(id(1),'synthetic-cipher','2026-01');assert.ok(receipt.etag);
 assert.equal(s.chunkCalls,1);await release();assert.equal(s.marker,null);
});

// Real HTTP client for the index and asset writer, with only unrelated
// namespace enumeration isolated. No real account or financial data.
async function writerUpgradeFixture(){
 const {s,api}=fixture();api.ensurePayrollNamespace=async()=>{};api.listYearFiles=async()=>[];api.readLiveVault=async()=>null;
 const vault=new LiveVault(api);await vault.create('synthetic-password-for-test');
 const initial=await api.readFinanceIndex(true);assert.equal(JSON.parse(initial.text).format,'finance-cloud-index-envelope-v3');
 return {s,api,vault,initial};
}
function failNextIndexResponse(s,api,mode){
 const original=api.http;let fired=false;
 api.http=async(url,init)=>{
  if(!fired&&url.startsWith('https://upload.invalid/')&&s.sessions.get(url)==='index.enc'){
   fired=true;s.mode=mode;try{return await original(url,init);}finally{s.mode='normal';}
  }
  return original(url,init);
 };
 return ()=>fired;
}
test('INT3-19: first v4 index write with lost committed response verifies exact ciphertext and proceeds without replay',async()=>{
 const {s,api,vault,initial}=await writerUpgradeFixture();const fired=failNextIndexResponse(s,api,'lost-committed');const chunks=s.chunkCalls;
 await vault.setCardDebitAccounts({'rakuten-mizuho':'mizuho-bank'});assert.equal(fired(),true);
 const index=await api.readFinanceIndex(true);assert.equal(index.id,initial.id);assert.notEqual(index.etag,initial.etag);
 assert.equal(JSON.parse(index.text).format,'finance-cloud-index-envelope-v4');assert.equal(s.chunkCalls-chunks,2);
 assert.equal(s.marker,null);assert.equal(vault.assetSettings().cardDebitAccounts['rakuten-mizuho'],'mizuho-bank');
 const restarted=new LiveVault(api);await restarted.unlock('synthetic-password-for-test');assert.equal(restarted.assetSettings().format,'finance-assets-v3');
});
test('INT3-19: unconfirmed v4 upgrade fences the write; recovery verifies old data before an explicit retry',async()=>{
 const {s,api,vault,initial}=await writerUpgradeFixture();const fired=failNextIndexResponse(s,api,'lost-uncommitted');const chunks=s.chunkCalls;
 await assert.rejects(vault.setCardDebitAccounts({'rakuten-mizuho':'mizuho-bank'}),CloudWriteUncertainError);
 assert.equal(fired(),true);assert.equal(s.chunkCalls-chunks,1);assert.ok(s.marker);assert.equal(await api.readAssetSettings(true),null);
 assert.deepEqual(await api.readFinanceIndex(true),initial);
 await assert.rejects(vault.setCardDebitAccounts({'rakuten-mizuho':'mizuho-bank'}),CloudWriteUncertainError);assert.equal(s.chunkCalls-chunks,1);
 assert.equal(await vault.recoverSaveLock(async()=>true,()=>true),'released');await vault.refresh();
 await vault.setCardDebitAccounts({'rakuten-mizuho':'mizuho-bank'});assert.equal(s.marker,null);
 assert.equal(JSON.parse((await api.readFinanceIndex(true)).text).format,'finance-cloud-index-envelope-v4');
 assert.equal(vault.assetSettings().cardDebitAccounts['rakuten-mizuho'],'mizuho-bank');
});
