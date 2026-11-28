/** Microsoft Graph API client for the encrypted Finance vault and connectivity checks. */
import { traceFinanceOperation, countFinanceRequest, countFinanceStatus, countFinanceRetry, measureFinancePhase } from './performance-diagnostics.js';
import { FINANCE_DIR, PAYROLL_DIR, checkBucket, checkOriginalMonth, originalParts } from './layout.js';
import { asSnapshots, isSnapshotName, MAX_SNAPSHOT_BYTES, snapshotName, validateBackupText, type VaultSnapshot } from './vault-snapshots.js';
const GRAPH = 'https://graph.microsoft.com/v1.0';
/** MSAL owns token caching and refreshing. Only Graph requests may ask for tokens. */
export type GraphTokenSource = string | ((forceRefresh?:boolean)=>Promise<string>);

interface DriveItem { id: string; name?: string; size?: number; eTag?: string; folder?: {childCount?:number}; createdDateTime?: string; '@microsoft.graph.downloadUrl'?: string }
export interface CleanupFile { id:string; name:string; etag:string }
export interface DatedOriginalFile extends CleanupFile { year:string; month:string }
export interface CleanupSnapshot extends CleanupFile { size:number; createdDateTime:string }
export interface RetiredRootData { legacyV1:CleanupFile[]; snapshots:CleanupSnapshot[] }
const GENERATION_NAME=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export class GraphError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(`OneDrive APIエラー (${status}${code ? ` / ${code}` : ''})。権限・接続・アカウントを確認してください。`);
  }
}

/** This is an empty coordination folder, never a data file. Folder creation
 * uses conflictBehavior=fail, not an upload session or a read-then-write lock.
 * No lease expiry: a suspended tab must never regain permission after expiry. */
const MUTATION_LOCK_NAME='finance-operation-lock';
/** Honor an explicit throttling response, without replaying an ambiguous write. */
function throttlingDelay(response:Response,attempt:number):number|null {
  const value=response.headers.get('Retry-After');
  const delay=value===null?1000*2**attempt:/^\d+$/.test(value)?Number(value)*1000:Date.parse(value)-Date.now();
  if(!Number.isFinite(delay)||delay>60000)return null;
  return Math.max(0,delay);
}
const wait=(ms:number)=>ms>0?new Promise<void>(resolve=>setTimeout(resolve,ms)):Promise.resolve();
type MutationMarker={id:string;etag:string;createdAt:string|null};
export class VaultOperationBusyError extends Error {
  constructor(message='別の端末で保存中か、前回の通信中断で保存ロックが残っています。時間を置いて再試行してください。続く場合は設定の「保存ロックを確認」を利用してください。'){super(message);this.name='VaultOperationBusyError';}
}
/** A data write is still unconfirmed, not merely a failed lock DELETE. */
export class VaultMutationUncertainError extends Error {
  constructor(){super('OneDriveの書込み結果が不明なため操作ロックを保持しました。設定の保存ロック復旧で保存結果を確認してください。');this.name='VaultMutationUncertainError';}
}
export class OneDriveTestClient {
  private mutationLease:{uncertain:boolean;guard:()=>void;released:boolean}|null=null;
  private mutationAcquiring=false;
  // This connection has observed a server-side marker ETag change. Reuse the
  // existing ownership revalidation before DELETE only in that case.
  private preferFreshMutationMarker=false;
  // Only a marker created by this client, after a known-ended write.
  private completedMarker:{parent:string;id:string}|null=null;
  async acquireVaultMutation(guard:()=>void):Promise<()=>Promise<void>> {
    return measureFinancePhase('vault.lock-acquire',async()=>{
    if(this.mutationLease||this.mutationAcquiring)throw new VaultOperationBusyError();
    this.mutationAcquiring=true;
    try{
    guard();const parent=await this.folderPath([FINANCE_DIR],true);
    if(!parent)throw new Error('保管庫の操作領域を確認できません。');
    guard();
    if(this.completedMarker?.parent===parent){
      const previous=this.completedMarker;
      const current=await this.readRecoveryMarker(parent,previous.id);guard();
      if(current)await this.releaseMutationMarker(current,guard);
      this.completedMarker=null;
    }
    guard();let item:DriveItem;
    try{
      const response=await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:MUTATION_LOCK_NAME,folder:{},'@microsoft.graph.conflictBehavior':'fail'}),
      },false,true,false,guard);
      if(response.status!==201)throw new Error('操作ロックの新規作成を確認できません。');
      item=await response.json() as DriveItem;
      if(typeof item?.id==='string'&&item.id&&item.name===MUTATION_LOCK_NAME&&item.folder&&!item.eTag){
        const createdId=item.id;
        const metadata=await this.graph(`/me/drive/items/${encodeURIComponent(createdId)}?$select=id,name,eTag,folder`,{cache:'no-store'});
        item=await metadata.json() as DriveItem;
        if(item.id!==createdId)throw new Error('作成したロックのIDが一致しません。');
      }
    }catch(error){
      if(error instanceof GraphError&&[409,412].includes(error.status))throw new VaultOperationBusyError();
      if(error instanceof GraphError&&error.status===429)throw new Error('OneDriveの通信制限（HTTP 429）により保存を開始できませんでした。時間を置いて再試行してください。');
      throw new Error('保管庫の操作権を確認できません。設定の保存ロックを確認し、中断した操作だけを復旧してください。');
    }
    if(typeof item.id!=='string'||!item.id||typeof item.eTag!=='string'||!item.eTag||item.name!==MUTATION_LOCK_NAME||!item.folder||typeof item.folder!=='object'||Array.isArray(item.folder)||(item.folder.childCount!==undefined&&item.folder.childCount!==0))
      throw new Error('OneDriveの操作ロック作成結果が不明です。保存は開始しません。');
    const lease={uncertain:false,guard,released:false};this.mutationLease=lease;
    return async()=>measureFinancePhase('vault.lock-release',async()=>{
      if(this.mutationLease!==lease)throw new Error('保管庫の操作権が変化しました。');
      try{
        // A lost final response might mean the server is still committing.
        // Do not make a destructive operation possible by releasing its fence.
        if(lease.uncertain)throw new VaultMutationUncertainError();
        let marker:MutationMarker={id:item.id,etag:item.eTag!,createdAt:null};
        this.completedMarker={parent,id:marker.id};
        if(this.preferFreshMutationMarker){
          const current=await measureFinancePhase('vault.lock-revalidate',()=>this.readRecoveryMarker(parent,marker.id));
          if(!current){this.completedMarker=null;return;}
          // A stable ETag restores the usual one-request path for the next save.
          this.preferFreshMutationMarker=current.etag!==marker.etag;
          marker=current;
        }
        try{
          await this.releaseMutationMarker(marker,()=>{});
        }catch(error){
          // OneDrive may update the empty coordination folder's metadata after
          // creation. Only the client that created this exact ID may refresh
          // its ETag, and only after a definite conditional DELETE rejection.
          // Never transfer ownership to a successor or bypass If-Match.
          if(!(error instanceof GraphError&&error.status===412&&error.code.toLowerCase()==='resourcemodified'))throw error;
          const current=await measureFinancePhase('vault.lock-revalidate',()=>this.readRecoveryMarker(parent,marker.id));
          if(!current){this.completedMarker=null;return;}
          if(current.id!==marker.id||current.etag===marker.etag)throw error;
          // This is a single revalidation, not an unbounded 412 retry loop.
          countFinanceRetry();
          await this.releaseMutationMarker(current,()=>{});
          this.preferFreshMutationMarker=true;
        }
        this.completedMarker=null;
      }finally{lease.released=true;this.mutationLease=null;}
    });
    }finally{this.mutationAcquiring=false;}
    });
  }
  /** Read-only inspection. Never infer ownership or expiry from the marker age. */
  async inspectVaultMutationLock():Promise<{state:'absent'|'present';createdAt:string|null}>{
    return measureFinancePhase('vault.lock-inspect',async()=>{
    const parent=await this.folderPath([FINANCE_DIR],false);
    if(!parent)return {state:'absent',createdAt:null};
    try{
      const response=await this.graph(`/me/drive/items/${encodeURIComponent(parent)}:/${MUTATION_LOCK_NAME}?$select=id,name,folder,createdDateTime`,{cache:'no-store'});
      const item=await response.json() as DriveItem;
      if(!item||typeof item.id!=='string'||!item.id||item.name!==MUTATION_LOCK_NAME||!item.folder||typeof item.folder!=='object'||Array.isArray(item.folder))throw new Error('保存ロックの形式を確認できません。');
      const created=typeof item.createdDateTime==='string'?new Date(item.createdDateTime):null;
      return {state:'present',createdAt:created&&Number.isFinite(created.valueOf())?created.toISOString():null};
    }catch(error){if(error instanceof GraphError&&error.status===404)return {state:'absent',createdAt:null};throw error;}
    });
  }
  /** Delete only this exact marker. Replaying a conditional DELETE cannot
   * delete a successor (which has a different ID). A 412 is not retried by this helper. */
  private async releaseMutationMarker(marker:MutationMarker,guard:()=>void):Promise<void>{
    for(let attempt=0;attempt<2;attempt++){
      guard();
      try{
        const response=await this.graph(`/me/drive/items/${encodeURIComponent(marker.id)}`,{method:'DELETE',headers:{'If-Match':marker.etag}},false,true,false,guard);
        if(response.status!==204)throw new Error('操作ロックの削除応答が不明です。');
        return;
      }catch(error){
        if(error instanceof GraphError&&error.status===404)return; // this exact ID is already gone
        if(attempt||error instanceof GraphError&&error.status<500&&error.status!==408)throw error;
        await wait(500);countFinanceRetry();
      }
    }
  }
  private async readRecoveryMarker(parent:string,expectedId?:string):Promise<MutationMarker|null>{
    let item:DriveItem;
    try{item=await (await this.graph(`/me/drive/items/${encodeURIComponent(parent)}:/${MUTATION_LOCK_NAME}?$select=id,name,folder,eTag,createdDateTime`,{cache:'no-store'})).json() as DriveItem;}
    catch(error){if(error instanceof GraphError&&error.status===404)return null;throw error;}
    if(!item||typeof item.id!=='string'||!item.id||typeof item.eTag!=='string'||!item.eTag||item.name!==MUTATION_LOCK_NAME||!item.folder||typeof item.folder!=='object'||Array.isArray(item.folder)||(item.folder.childCount!==undefined&&item.folder.childCount!==0))throw new Error('空の保存ロックと更新情報を確認できません。解除しません。');
    if(expectedId!==undefined&&item.id!==expectedId){this.completedMarker=null;throw new VaultOperationBusyError('保存ロックのIDが変化しました。別の操作のロックは解除しません。');}
    const children=await (await this.graph(`/me/drive/items/${encodeURIComponent(item.id)}/children?$select=id&$top=1`,{cache:'no-store'})).json() as {value?:unknown[];'@odata.nextLink'?:unknown};
    if(!Array.isArray(children.value)||children.value.length||children['@odata.nextLink'])throw new Error('保存ロックが空ではない、または一覧を確認できません。解除しません。');
    const date=typeof item.createdDateTime==='string'?new Date(item.createdDateTime):null;
    return {id:item.id,etag:item.eTag,createdAt:date&&Number.isFinite(date.valueOf())?date.toISOString():null};
  }
  /** Explicit recovery only. No expiry or takeover of an active lease.
   * User must stop other clients and confirm interrupted writes; an unchanged
   * marker is not proof that another device has stopped. */
  async recoverVaultMutationLock(guard:()=>void,verify:()=>Promise<void>,approve:(createdAt:string|null)=>Promise<boolean>):Promise<'absent'|'cancelled'|'released'>{
    if(this.mutationLease||this.mutationAcquiring)throw new VaultOperationBusyError();
    this.mutationAcquiring=true;
    try{
      guard();this.clearDirectoryCache();const parent=await this.folderPath([FINANCE_DIR],false);guard();
      if(!parent)return 'absent';
      const marker=await this.readRecoveryMarker(parent);guard();if(!marker)return 'absent';
      if(!await approve(marker.createdAt))return 'cancelled';guard();
      await verify();guard();
      const current=await this.readRecoveryMarker(parent);guard();
      if(!current||current.id!==marker.id||current.etag!==marker.etag)throw new Error('確認中に保存ロックが変化しました。解除せず停止しました。');
      await this.releaseMutationMarker(marker,guard);guard();if(this.completedMarker?.id===marker.id)this.completedMarker=null;return 'released';
    }finally{this.mutationAcquiring=false;}
  }
  private checkMutationGuard():void {if(this.mutationLease){if(this.mutationLease.released)throw new Error('保管庫の操作権が解除されました。');this.mutationLease.guard();}}
  private markMutationUncertain():void {if(this.mutationLease)this.mutationLease.uncertain=true;}

  // Resolve Graph folder IDs once per client session. These are non-secret IDs,
  // retained only in memory; a new sign-in/client receives a fresh cache.
  private appRoot: Promise<string> | null = null;
  private dataSetId:string|null=null;
  // Bounded encrypted-text cache. Each invocation still checks Graph metadata / ETag.
  // Conservative JS string footprint (UTF-16, 2 bytes/code unit). Encrypted
  // originals must never enter this cache, even when their ETag is unchanged.
  private static readonly MAX_ENCRYPTED_CACHE_BYTES=8*1024*1024;
  private readonly encryptedReadCache=new Map<string,{text:string;id:string;etag:string}>();
  private readonly encryptedReadJobs=new Map<string,Promise<{text:string;id:string;etag:string}|null>>();
  private encryptedReadEpoch=0;
  /** v2 data sets are isolated; only index.enc remains at the stable root. */
  setVaultDataSet(id:string|null):void {
    if(id!==null&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))throw new Error('保管庫世代IDが不正です。');
    if(this.dataSetId!==id){this.encryptedReadCache.clear();this.encryptedReadJobs.clear();this.encryptedReadEpoch++;}
    this.dataSetId=id;
  }
  forVaultDataSet(id:string):OneDriveTestClient {
    const stage=new OneDriveTestClient(this.tokenSource,this.http,this.onUnauthorized);stage.setVaultDataSet(id);stage.mutationLease=this.mutationLease;return stage;
  }
  private financeDataPath(...tail:string[]):string[] {
    return this.dataSetId?[FINANCE_DIR,'versions',this.dataSetId,...tail]:[FINANCE_DIR,...tail];
  }
  private readonly directoryIds = new Map<string, string>();
  private readonly resolvingDirectories = new Map<string, Promise<string | null>>();
  private clearDirectoryCache(): void {
    this.directoryIds.clear();
    this.resolvingDirectories.clear();
    this.appRoot = null;
  }
  // Browser fetch is a host method: passing it around unbound can trigger
  // `Failed to execute 'fetch' on 'Window': Illegal invocation`.
  // Call it through globalThis so the native receiver is preserved. Custom
  // HTTP functions can still be injected by tests.
  constructor(
    private readonly tokenSource: GraphTokenSource,
    private readonly http: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly onUnauthorized?:()=>void,
  ) {}
  /** A single read deadline covers headers and the entire response body.
   * Writes are never aborted here because their committed state may be uncertain. */
  private async withReadDeadline<T>(url:string,init:RequestInit,consume:(response:Response)=>Promise<T>,timeoutMs=30000):Promise<T> {
    const controller=new AbortController();
    let timeout:ReturnType<typeof setTimeout>|undefined;
    const expired=new Promise<never>((_,reject)=>{
      timeout=setTimeout(()=>{
        controller.abort();
        reject(new Error(`OneDriveの読み取りが${Math.ceil(timeoutMs/1000)}秒以内に完了しませんでした。`));
      },timeoutMs);
    });
    try {
      return await Promise.race([
        (async()=>consume(await this.http(url,{...init,signal:controller.signal})))(),
        expired,
      ]);
    }catch(error) {
      if(controller.signal.aborted)throw new Error(`OneDriveの読み取りが${Math.ceil(timeoutMs/1000)}秒以内に完了しませんでした。`);
      throw error;
    }finally {
      if(timeout!==undefined)clearTimeout(timeout);
    }
  }
  private async readResponseBytes(response:Response,maxBytes:number):Promise<Uint8Array> {
    if(Number(response.headers.get('Content-Length')??0)>maxBytes)
      throw new Error('OneDriveのファイルがサイズ上限を超えています。');
    if(!response.body) {
      const bytes=new Uint8Array(await response.arrayBuffer());
      if(bytes.length>maxBytes)throw new Error('OneDriveのファイルがサイズ上限を超えています。');
      return bytes;
    }
    const reader=response.body.getReader();
    const chunks:Uint8Array[]=[];
    let length=0;
    try {
      while(true){
        const {value,done}=await reader.read();
        if(done)break;
        length+=value.byteLength;
        if(length>maxBytes)throw new Error('OneDriveのファイルがサイズ上限を超えています。');
        chunks.push(value);
      }
    } catch(error) {
      // Stop the network stream immediately if the limit or read fails.
      try{await reader.cancel();}catch{/* Preserve the original validation error. */}
      throw error;
    } finally {reader.releaseLock();}
    const bytes=new Uint8Array(length);
    let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return bytes;
  }
  private async httpWithReadTimeout(url:string,init:RequestInit):Promise<Response> {
    if((init.method??'GET').toUpperCase()!=='GET')return this.http(url,init);
    // Graph metadata is JSON and must fit within 8 MiB; downloading originals
    // uses the separate size-bounded streaming path below.
    return this.withReadDeadline(url,init,async response=>{
      const data=await this.readResponseBytes(response,8*1024*1024);
      return new Response([204,205,304].includes(response.status)?null:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength) as ArrayBuffer,{
        status:response.status,statusText:response.statusText,headers:response.headers,
      });
    });
  }
  private async graph(path: string, init: RequestInit = {}, allowNotModified = false,lockRequest=false,nonCommitting=false,requestGuard:()=>void=()=>{}): Promise<Response> {
    return traceFinanceOperation('onedrive',async()=>{
    const method=(init.method??'GET').toUpperCase();
    let sent=false;
    const request=async(forceRefresh=false):Promise<Response>=>{
      // An old client remains usable after the access token expires; MSAL owns
      // every token's lifetime. Never hold a bearer token inside this client.
      sent=false;requestGuard();
      if(method!=='GET'&&!lockRequest)this.checkMutationGuard();
      const token=typeof this.tokenSource==='string'
        ? this.tokenSource : await this.tokenSource(forceRefresh);
      requestGuard();if(method!=='GET'&&!lockRequest)this.checkMutationGuard();
      sent=true;
      countFinanceRequest(method==='GET'?'graph.get':'graph.write');
      const result=await measureFinancePhase('graph.request',()=>this.httpWithReadTimeout(GRAPH + path, {
        ...init,
        headers: {...init.headers, Authorization: `Bearer ${token}`},
        redirect: 'error',
      }));
      countFinanceStatus(result.status);return result;
    };
    let response:Response;
    const send=async()=>{
      try{return await request();}catch(error){if(sent&&method!=='GET'&&!lockRequest&&!nonCommitting)this.markMutationUncertain();throw error;}
    };
    response=await send();
    // 429 is an explicit throttling rejection. Honor Retry-After; never replay
    // ambiguous 408/5xx or transport failures for a data write.
    for(let attempt=0;attempt<3&&(response.status===429||(method==='GET'&&response.status===503));attempt++){
      const delay=response.status===429?throttlingDelay(response,attempt):200*(attempt+1);
      if(delay===null)break;
      await wait(delay);countFinanceRetry();response=await send();
    }
    if(!lockRequest&&!nonCommitting&&method!=='GET'&&(response.status===408||response.status>=500))this.markMutationUncertain();
    // One read-only 401 recovery is safe. Never replay writes, upload-session
    // creation, chunk uploads, or any uncertain operation after a 401.
    if(response.status===401&&method==='GET'&&typeof this.tokenSource!=='string'){
      countFinanceRetry();response=await request(true);
    }
    if(response.status===401)this.onUnauthorized?.();
    if (!response.ok && !(allowNotModified && response.status === 304)) {
      let code = '';
      try {
        const json = await response.json() as { error?: {code?: string} };
        code = typeof json.error?.code === 'string' ? json.error.code.slice(0, 80) : '';
      } catch { /* Errors can be HTML or empty. */ }
      throw new GraphError(response.status, code);
    }
    return response;
      });
  }
  private async downloadItemInfo(id: string, maxBytes: number, supplied?: DriveItem,fresh=false): Promise<{text:string;item:DriveItem}> {
    return traceFinanceOperation('onedrive',async()=>{
    let item = supplied;
    // Named-path lookups often already include the temporary download URL.
    // Otherwise fetch by ID exactly once (also gets the freshest ETag).
    if (!item?.['@microsoft.graph.downloadUrl'] || !item.eTag) {
      const response = await this.graph(`/me/drive/items/${encodeURIComponent(id)}`,fresh?{cache:'no-store'}:{});
      item = await response.json() as DriveItem;
    }
    if (!item?.id) throw new Error('OneDriveのファイルIDを取得できませんでした。');
    if (item.size && item.size > maxBytes) throw new Error('OneDriveのファイルがサイズ上限を超えています。');
    const url = item['@microsoft.graph.downloadUrl'];
    if (!url || new URL(url).protocol !== 'https:') throw new Error('安全なダウンロードURLを取得できませんでした。');
    // Originals may be up to 200 MiB. Give only these downloads a longer,
    // bounded full-body deadline; small encrypted files retain 30 seconds.
    const timeoutMs=maxBytes>=100*1024*1024
      ?Math.min(180000,Math.max(90000,Math.ceil((item.size??maxBytes)/(1024*1024))*1000))
      :30000;
    const bytes=await measureFinancePhase('graph.encrypted-download',async()=>{
      for(let attempt=0;;attempt++){
        countFinanceRequest('graph.download');if(attempt>0)countFinanceRetry();
        const result=await this.withReadDeadline(url,{method:'GET',credentials:'omit',...(fresh?{cache:'no-store' as const}:{})},async response=>{
          countFinanceStatus(response.status);
          if(response.status===429&&attempt<3){
            const delay=throttlingDelay(response,attempt);
            if(delay!==null){try{await response.body?.cancel();}catch{/* no retry body is needed */}return {delay};}
          }
          if(!response.ok)throw new Error(`OneDriveからの取得に失敗しました (HTTP ${response.status})。`);
          return {bytes:await this.readResponseBytes(response,maxBytes)};
        },timeoutMs);
        if('bytes' in result&&result.bytes)return result.bytes;
        await wait(result.delay??0);
      }
    });
    return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),item};
      });
  }
  private async downloadItem(id: string, maxBytes: number): Promise<string> {
    return (await this.downloadItemInfo(id,maxBytes)).text;
  }

  async listVaultSnapshots(): Promise<VaultSnapshot[]> {
    const folder = await this.appFolderId();
    const response = await this.graph(`/me/drive/items/${encodeURIComponent(folder)}/children?$select=id,name,size,createdDateTime&$top=200`);
    const data = await response.json() as { value?: unknown; '@odata.nextLink'?: string };
    // No implicit traversal to arbitrary URLs and no silent incomplete listing.
    if (data['@odata.nextLink']) throw new Error('スナップショットが200件を超えました。手動整理が必要です。');
    return asSnapshots(data.value);
  }

  async uploadVaultSnapshot(text: string): Promise<VaultSnapshot> {
    validateBackupText(text);
    const folder = await this.appFolderId();
    const name = snapshotName(new Date(), crypto.randomUUID());
    const namePath = `/me/drive/items/${encodeURIComponent(folder)}:/${encodeURIComponent(name)}:`;
    const payload = new TextEncoder().encode(text);
    let item: DriveItem;
    // This retired, immutable backup is not a current-vault write. Keep its
    // existing small-file PUT, but share the final-response validation and
    // large-file upload session with current encrypted writes.
    if (payload.byteLength <= 4 * 1024 * 1024) {
      const response = await this.graph(`${namePath}/content?@microsoft.graph.conflictBehavior=fail`, {
        method:'PUT', headers:{'Content-Type':'application/octet-stream'}, body: payload,
      });
      item=await this.confirmedUploadItem(response);
    } else item=await this.uploadSession(`${namePath}/createUploadSession`,payload);
    if((item.name!==undefined&&item.name!==name)||(item.size!==undefined&&item.size!==payload.byteLength)){
      this.markMutationUncertain();throw new Error('OneDriveのバックアップ保存結果を確認できませんでした。');
    }
    return { id:item.id, name, size:payload.byteLength, createdDateTime:item.createdDateTime ?? new Date().toISOString() };
  }

  async downloadVaultSnapshot(snapshot: VaultSnapshot): Promise<string> {
    if (!isSnapshotName(snapshot.name) || snapshot.size > MAX_SNAPSHOT_BYTES) throw new Error('選択されたバックアップが不正です。');
    // Never download an arbitrary OneDrive file id without verifying it is still one of our files.
    const current = (await this.listVaultSnapshots()).find(item => item.id === snapshot.id && item.name === snapshot.name);
    if (!current) throw new Error('選択されたスナップショットがOneDriveに見つかりません。');
    const text = await this.downloadItem(current.id, MAX_SNAPSHOT_BYTES);
    validateBackupText(text);
    return text;
  }

  /** The live encrypted document is independent from immutable v0.9 backups. */
  async readLiveVault(): Promise<{text:string; id:string; etag:string}|null> {
    const folder=await this.appFolderId();
    let item:DriveItem;
    try {
      const response=await this.graph(`/me/drive/items/${encodeURIComponent(folder)}:/finance-v1-vault.enc`);
      item=await response.json() as DriveItem;
    } catch(error) {
      if(error instanceof GraphError && error.status===404) return null;
      throw error;
    }
    if(!item.id||!item.eTag)throw new Error('OneDriveの更新情報（ETag）を取得できません。');
    return {text:await this.downloadItem(item.id,25_000_000),id:item.id,etag:item.eTag};
  }

  private async uploadSession(path:string, bytes:Uint8Array, etag?:string, expectedId?:string):Promise<DriveItem> {
    return traceFinanceOperation('onedrive',async()=>{
    if(bytes.byteLength>200*1024*1024)throw new Error('アップロードサイズが200MBを超えています。');
    const response=await this.graph(path,{
      method:'POST',
      headers:{'Content-Type':'application/json',...(etag?{'If-Match':etag}:{})},
      body:JSON.stringify({item:{'@microsoft.graph.conflictBehavior':etag?'replace':'fail'}}),
    },false,false,true);
    const session=await response.json() as {uploadUrl?:string};
    if(!session.uploadUrl||new URL(session.uploadUrl).protocol!=='https:')throw new Error('安全なアップロードセッションを取得できません。');
    const uploadUrl=session.uploadUrl;
    // 3,276,800 is a multiple of 320KiB; upload sequentially without the Graph bearer token.
    const size=3276800;
    for(let start=0;start<bytes.byteLength;start+=size) {
      const end=Math.min(start+size,bytes.byteLength);
      let part:Response;
      const final=end===bytes.byteLength;
      for(let attempt=0;;attempt++){
        this.checkMutationGuard();
        let deadline:ReturnType<typeof setTimeout>|undefined;
        const controller=final?new AbortController():undefined;
        try{
          countFinanceRequest('graph.upload-chunk');if(attempt>0)countFinanceRetry();
          part=await measureFinancePhase('graph.upload-chunk',async()=>{
          const sending=this.http(uploadUrl,{
            method:'PUT',credentials:'omit',
            headers:{'Content-Range':`bytes ${start}-${end-1}/${bytes.byteLength}`},
            body:bytes.slice(start,end),...(controller?{signal:controller.signal}:{}),
          });
          return final?await Promise.race([sending,new Promise<never>((_,reject)=>{
            deadline=setTimeout(()=>{controller?.abort();reject(new Error('OneDriveの保存応答を確認できませんでした。'));},120000);
          })]):await sending;
          });
          countFinanceStatus(part.status);
        }catch(error){if(final)this.markMutationUncertain();throw error;}
        finally{if(deadline!==undefined)clearTimeout(deadline);}
        if(part.status!==429||attempt>=3)break;
        const delay=throttlingDelay(part,attempt);if(delay===null)break;
        await wait(delay);
      }
      if(final&&(part.status===408||part.status>=500))this.markMutationUncertain();
      if(!part.ok) {
        if(part.status>=400&&part.status<500)throw new GraphError(part.status,part.status===429?'throttled':'uploadRejected');
        throw new Error(`OneDriveへのアップロードが失敗しました (HTTP ${part.status})。`);
      }
      if(end<bytes.byteLength) {
        if(part.status!==202){this.markMutationUncertain();throw new Error('OneDriveのアップロードが途中で終了しました。');}
      } else {
        return this.confirmedUploadItem(part,expectedId);
      }
    }
    throw new Error('空のアップロードは許可されません。');
      });
  }

  /** A successful HTTP status alone is not proof of a committed write. */
  private async confirmedUploadItem(response:Response,expectedId?:string):Promise<DriveItem>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      if(response.status!==200&&response.status!==201)throw new Error('OneDriveが保存完了を返しませんでした。');
      const raw:unknown=await Promise.race([response.json(),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('OneDriveの保存応答を確認できませんでした。')),30000);
      })]);
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('OneDriveの保存応答が不正です。');
      const item=raw as DriveItem;
      if(typeof item.id!=='string'||!item.id.trim()||(expectedId!==undefined&&item.id!==expectedId))
        throw new Error('OneDriveの保存IDを確認できません。');
      if(item.eTag!==undefined&&(typeof item.eTag!=='string'||!item.eTag.trim()))throw new Error('OneDriveの保存ETagが不正です。');
      return item;
    }catch(error){this.markMutationUncertain();throw error;}
    finally{if(timer!==undefined)clearTimeout(timer);}
  }

  async writeLiveVault(text:string, existing: {id:string;etag:string}|null):Promise<void> {
    if(!text||new TextEncoder().encode(text).byteLength>25_000_000)throw new Error('暗号化明細がサイズ上限を超えています。');
    const bytes=new TextEncoder().encode(text);
    const folder=await this.appFolderId();
    const path=existing
      ? `/me/drive/items/${encodeURIComponent(existing.id)}/createUploadSession`
      : `/me/drive/items/${encodeURIComponent(folder)}:/finance-v1-vault.enc:/createUploadSession`;
    await this.uploadSession(path,bytes,existing?.etag,existing?.id);
  }

  private async originalsFolder(create:boolean):Promise<string|null> {
    const parent=await this.appFolderId();
    const path=`/me/drive/items/${encodeURIComponent(parent)}:/finance-v1-originals`;
    try {const response=await this.graph(path);const item=await response.json() as DriveItem;return item.id;}
    catch(error) {if(!(error instanceof GraphError&&error.status===404))throw error;}
    if(!create)return null;
    try {
      const response=await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:'finance-v1-originals',folder:{},'@microsoft.graph.conflictBehavior':'fail'}),
      },false,false,true);
      const item=await response.json() as DriveItem;
      if(!item.id)throw new Error('PDF保存フォルダの作成を確認できません。');
      return item.id;
    }catch(error){
      if(error instanceof GraphError&&error.status===409){
        const response=await this.graph(path);const item=await response.json() as DriveItem;return item.id;
      }
      throw error;
    }
  }
  private originalName(id:string):string {
    if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('PDFの識別子が不正です。');
    return `${id}.enc`;
  }
  async uploadOriginal(id:string,encrypted:string):Promise<void> {
    const folder=await this.originalsFolder(true);
    if(!folder)throw new Error('PDF保存フォルダがありません。');
    const name=this.originalName(id);
    // Immutable object: existing originals are never overwritten.
    await this.uploadSession(`/me/drive/items/${encodeURIComponent(folder)}:/${name}:/createUploadSession`,new TextEncoder().encode(encrypted));
  }
  async downloadOriginal(id:string):Promise<string> {
    const folder=await this.originalsFolder(false);
    if(!folder)throw new Error('クラウドにPDF原本がありません。');
    const response=await this.graph(`/me/drive/items/${encodeURIComponent(folder)}:/${this.originalName(id)}`);
    const item=await response.json() as DriveItem;
    if(!item.id)throw new Error('PDF原本の参照IDが不正です。');
    return this.downloadItem(item.id,200*1024*1024);
  }

  /**
   * Some Graph/OneDrive responses can advertise HTTP 200 + JSON but contain
   * invalid metadata JSON. Resolve only the named child through the parent's
   * children collection when the direct named-path metadata cannot be parsed.
   * This fallback is READ ONLY; it never creates or modifies anything.
   */
  private async findChildFolderByListing(parent:string,name:string):Promise<string|null> {
    const response=await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children?$select=id,name,folder&$top=200`);
    let listing:{value?:Array<{id?:unknown;name?:unknown;folder?:unknown}>;'@odata.nextLink'?:unknown};
    try {listing=await response.json() as typeof listing;}
    catch (error) {
      if(error instanceof SyntaxError)throw new Error('OneDriveのフォルダ情報を両方の方法で解析できませんでした。');
      throw error;
    }
    if(!Array.isArray(listing.value))throw new Error('OneDriveのフォルダ一覧の形式が不正です。');
    const folder=listing.value.find(item=>item?.name===name&&typeof item.id==='string'&&item.id.length>0&&item.folder&&typeof item.folder==='object');
    if(folder)return folder.id as string;
    // Never silently treat an incomplete listing as an absent folder.
    if(listing['@odata.nextLink'])throw new Error('OneDriveのフォルダ一覧が200件を超えたため参照できません。');
    return null;
  }

  /** Create/check one folder. Only successful IDs are cached (never a 404). */
  private async childFolder(parent:string,name:string,create:boolean):Promise<string|null> {
    const location=`/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}`;
    let item:DriveItem|undefined;
    // `:/versions` conflicts with the Microsoft Graph driveItem version-history route.
    // Resolve this particular folder by the parent's children collection, regardless
    // of whether the reserved route returns 200 with a different JSON shape or 400.
    if(name==='versions') {
      const found=await this.findChildFolderByListing(parent,name);
      if(found)item={id:found};
    }else{
      try {
        const response=await this.graph(location);
        try {item=await response.json() as DriveItem;}
        catch(error) {
          if(!(error instanceof SyntaxError))throw error;
          const recovered=await this.findChildFolderByListing(parent,name);
          if(recovered)item={id:recovered};
        }
      }catch(error) {
        if(!(error instanceof GraphError&&error.status===404))throw error;
      }
    }
    if(!item) {
      if(!create)return null;
      try {
        const response=await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children`,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({name,folder:{},'@microsoft.graph.conflictBehavior':'fail'}),
        },false,false,true);
        item=await response.json() as DriveItem;
      }catch(collision) {
        if(!(collision instanceof GraphError&&collision.status===409))throw collision;
        if(name==='versions') {
          const recovered=await this.findChildFolderByListing(parent,name);
          if(!recovered)throw new Error('OneDriveのフォルダ作成結果を確認できません。');
          item={id:recovered};
        } else {
          const response=await this.graph(location);
          try {item=await response.json() as DriveItem;}
          catch(error) {
            if(!(error instanceof SyntaxError))throw error;
            const recovered=await this.findChildFolderByListing(parent,name);
            if(!recovered)throw new Error('OneDriveのフォルダ作成結果を確認できません。');
            item={id:recovered};
          }
        }
      }
    }
    if(!item?.id)throw new Error('OneDriveフォルダの識別子を確認できません。');
    return item.id;
  }

  /** Reuse IDs and coalesce concurrent lookups, without assuming a missing folder exists. */
  private async folderPath(parts: string[], create: boolean): Promise<string | null> {
    let parent=await this.appFolderId();
    let prefix='';
    for(const name of parts) {
      if(!/^[a-z0-9-]{1,64}$/i.test(name))throw new Error('不正なクラウドフォルダ名です。');
      prefix+=`/${name}`;
      const cached=this.directoryIds.get(prefix);
      if(cached){parent=cached;continue;}
      const key=`${prefix}:${create?'create':'read'}`;
      // A concurrent creation is useful to both readers and writers.
      const createKey=`${prefix}:create`;
      const pendingKey=this.resolvingDirectories.has(createKey)?createKey:key;
      let pending=this.resolvingDirectories.get(pendingKey);
      if(!pending){
        pending=this.childFolder(parent,name,create);
        this.resolvingDirectories.set(pendingKey,pending);
      }
      let result:string|null;
      try{
        result=await pending;
        if(result&&this.resolvingDirectories.get(pendingKey)===pending)this.directoryIds.set(prefix,result);
      }finally{
        if(this.resolvingDirectories.get(pendingKey)===pending)this.resolvingDirectories.delete(pendingKey);
      }
      if(!result)return null;
      // A concurrent path recheck may have replaced this ID. Never restore it.
      const verified=this.directoryIds.get(prefix);
      if(!verified)throw new Error('取得中にOneDriveのフォルダー情報が変更されました。再試行してください。');
      parent=verified;
    }
    return parent;
  }
  /** A named miss may be a normal absent file or a moved ancestor. Resolve
   * the complete path again, but retain verified siblings when IDs agree. */
  private async recheckDirectoryPath(parts:string[]):Promise<string|null> {
    const pendingRoot=this.appFolderId(),observedRoot=this.appRoot;
    const previous=await pendingRoot;
    const response=await this.graph('/me/drive/special/approot',{cache:'no-store'});
    const root=await response.json() as DriveItem;
    if(!root.id)throw new Error('OneDriveのアプリ専用領域を取得できませんでした。');
    const changed=()=>new Error('取得中にOneDriveのフォルダー情報が変更されました。再試行してください。');
    if(this.appRoot!==observedRoot)throw changed();
    if(root.id!==previous){this.clearDirectoryCache();this.appRoot=Promise.resolve(root.id);}
    const rootJob=this.appRoot;
    let parent=root.id,prefix='';
    for(const name of parts){
      if(!/^[a-z0-9-]{1,64}$/i.test(name))throw new Error('不正なクラウドフォルダ名です。');
      const parentPrefix=prefix;
      prefix+=`/${name}`;
      const before=this.directoryIds.get(prefix);
      const id=await this.childFolder(parent,name,false);
      if(this.appRoot!==rootJob||(parentPrefix&&this.directoryIds.get(parentPrefix)!==parent))throw changed();
      const cached=this.directoryIds.get(prefix);
      if(cached!==before&&cached!==id)throw changed();
      if(cached!==id){
        const affected=(path:string)=>path===prefix||path.startsWith(`${prefix}/`);
        for(const path of this.directoryIds.keys())if(affected(path))this.directoryIds.delete(path);
        for(const key of this.resolvingDirectories.keys())if(affected(key.slice(0,key.lastIndexOf(':'))))this.resolvingDirectories.delete(key);
      }
      if(!id)return null;
      this.directoryIds.set(prefix,id);parent=id;
    }
    return parent;
  }
  private async findNamedFile(parts:string[],name:string,fresh=false):Promise<(DriveItem & {id:string;eTag:string})|null> {
    // A cached directory ID may become stale when a folder is moved outside
    // Finance. Resolve its path again once, then fail closed on an actual miss.
    let item:DriveItem|null=null;
    for(let attempt=0;attempt<2;attempt++){
      const hadCachedPath=parts.some((_,i)=>this.directoryIds.has(`/${parts.slice(0,i+1).join('/')}`));
      const parent=attempt===0?await this.folderPath(parts,false):await this.recheckDirectoryPath(parts);
      if(!parent){
        if(attempt===0&&hadCachedPath)continue;
        return null;
      }
      try {
        const response=await this.graph(`/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}`,fresh?{cache:'no-store'}:{});
        item=await response.json() as DriveItem;
        break;
      }catch(error){
        if(!(error instanceof GraphError&&error.status===404))throw error;
        if(attempt===0&&hadCachedPath)continue;
        return null;
      }
    }
    if(typeof item?.id!=='string'||!item.id||typeof item.eTag!=='string'||!item.eTag)throw new Error('OneDriveの更新情報を取得できません。');
    return item as DriveItem & {id:string;eTag:string};
  }
  private async readNamedFile(parts:string[],name:string,maxBytes:number,fresh=false,reuseVerified=false):Promise<{text:string;id:string;etag:string}|null> {
    const key=JSON.stringify([parts,name,maxBytes]);
    const epoch=this.encryptedReadEpoch;
    const waiting=this.encryptedReadJobs.get(key);
    if(waiting&&!fresh)return waiting;
    // A newer fresh read supersedes the earlier job for cache publication.
    // Older callers may finish, but cannot publish over the newer observation.
    const ownsRead=():boolean=>epoch===this.encryptedReadEpoch&&this.encryptedReadJobs.get(key)===job;
    const job=(async()=>{
      const item=await this.findNamedFile(parts,name,fresh);
      if(!item){if(ownsRead())this.encryptedReadCache.delete(key);return null;}
      // The download ceiling is not the resident size; enforce the actual
      // UTF-16 byte budget below, while always excluding original PDFs.
      const useCache=!parts.includes('originals')&&name.endsWith('.enc');
      const cached=(!fresh||reuseVerified)&&useCache&&ownsRead()?this.encryptedReadCache.get(key):undefined;
      if(cached&&cached.id===item.id&&cached.etag===item.eTag){
        // Simple LRU: ETag-verified hits move to the end of the bounded map.
        this.encryptedReadCache.delete(key);this.encryptedReadCache.set(key,cached);
        return {...cached};
      }
      const downloaded=await this.downloadItemInfo(item.id,maxBytes,item,fresh);
      const value={text:downloaded.text,id:item.id,etag:downloaded.item.eTag??item.eTag};
      if(ownsRead()){
        this.encryptedReadCache.delete(key);
        const limit=OneDriveTestClient.MAX_ENCRYPTED_CACHE_BYTES;
        if(useCache&&value.text.length*2<=limit){
          this.encryptedReadCache.set(key,value);
          let total=[...this.encryptedReadCache.values()].reduce((sum,file)=>sum+file.text.length*2,0);
          while(this.encryptedReadCache.size>12||total>limit){
            const oldest=this.encryptedReadCache.keys().next().value;
            if(oldest===undefined)break;
            total-=this.encryptedReadCache.get(oldest)!.text.length*2;
            this.encryptedReadCache.delete(oldest);
          }
        }
      }
      return {...value};
    })();
    this.encryptedReadJobs.set(key,job);
    try{return await job;}
    finally {if(this.encryptedReadJobs.get(key)===job)this.encryptedReadJobs.delete(key);}
  }
  private async writeNamedFile(parts:string[],name:string,text:string,existing:{id:string;etag:string}|null,maxBytes:number):Promise<{id:string;etag:string}|null> {
    const bytes=new TextEncoder().encode(text);
    if(!bytes.byteLength||bytes.byteLength>maxBytes)throw new Error('暗号ファイルの容量が不正です。');
    const parent=await this.folderPath(parts,true);
    if(!parent)throw new Error('クラウド保存フォルダを作れませんでした。');
    const path=existing
      ? `/me/drive/items/${encodeURIComponent(existing.id)}/createUploadSession`
      : `/me/drive/items/${encodeURIComponent(parent)}:/${encodeURIComponent(name)}:/createUploadSession`;
    const lease=this.mutationLease,wasUncertain=lease?.uncertain;
    try {
      // Upload sessions retain the documented If-Match/409/412 flow for live data.
      // Direct PUT on Personal OneDrive lacks a documented final-boundary ETag guarantee.
      const result=await measureFinancePhase('vault.encrypted-upload',()=>this.uploadSession(path,bytes,existing?.etag,existing?.id));
      const key=JSON.stringify([parts,name,maxBytes]);
      this.encryptedReadCache.delete(key);this.encryptedReadJobs.delete(key);
      if(!result.eTag){
        this.markMutationUncertain();
        if(lease)throw new Error('OneDriveの保存ETagを取得できません。');
        // Confirm the exact target, including a new ETag, rather than accepting
        // a successful HTTP response that cannot identify the committed version.
        const verified=await this.readNamedFile(parts,name,maxBytes,true);this.checkMutationGuard();
        if(!verified||verified.text!==text||verified.id!==result.id||!verified.etag||(existing&&verified.etag===existing.etag))
          throw new Error('OneDriveの保存結果を照合できませんでした。');
        return {id:verified.id,etag:verified.etag};
      }
      if(existing&&result.eTag===existing.etag){this.markMutationUncertain();throw new Error('OneDriveの更新結果を確認できませんでした。');}
      return {id:result.id,etag:result.eTag};
    }catch(error){
      // A folder can be renamed/deleted outside Finance. Next attempt must
      // re-resolve its path rather than keep an invalid directory ID.
      if(error instanceof GraphError&&error.status===404)this.clearDirectoryCache();
      if(lease&&this.mutationLease===lease&&!wasUncertain&&lease.uncertain&&!lease.released){
        // A final response can be lost after Graph committed the encrypted file.
        // Read the precise target, never resend an ambiguous write. The ETag
        // must have advanced for a replacement; do not clear prior uncertainty.
        try{
          this.checkMutationGuard();
          const verified=await this.readNamedFile(parts,name,maxBytes,true);this.checkMutationGuard();
          if(verified&&verified.etag&&verified.text===text&&(!existing||(verified.id===existing.id&&verified.etag!==existing.etag))){
            lease.uncertain=false;return {id:verified.id,etag:verified.etag};
          }
        }catch{/* Keep the original failure and fence. */}
      }
      throw error;
    }
  }
  /** Fresh metadata only; never download encrypted bodies for the closing fence. */
  async readFinanceMetadata(kind:'index'|'rules'|'assets'):Promise<{id:string;etag:string}|null>{
    const [parts,name]:[string[],string]=kind==='index'?[[FINANCE_DIR],'index.enc']:kind==='rules'?[this.financeDataPath('rules'),'merchants.enc']:[this.financeDataPath('settings'),'assets.enc'];
    const file=await this.findNamedFile(parts,name,true);
    return file?{id:file.id,etag:file.eTag}:null;
  }
  /** finance/index.enc contains only encrypted shard discovery metadata. */
  async readFinanceIndex(fresh=false):Promise<{text:string;id:string;etag:string}|null> {
    // A fresh metadata lookup must not join an earlier in-flight read.
    // Identical ID/ETag still proves the cached encrypted index is current.
    return this.readNamedFile([FINANCE_DIR],'index.enc',1_000_000,fresh,true);
  }
  async writeFinanceIndex(text:string,existing:{id:string;etag:string}|null):Promise<{id:string;etag:string}|null> {
    return this.writeNamedFile([FINANCE_DIR],'index.enc',text,existing,1_000_000);
  }
  /** Independent encrypted merchant display rules, shared across billing years. */
  async readMerchantRules(fresh=false):Promise<{text:string;id:string;etag:string}|null> {
    return this.readNamedFile(this.financeDataPath('rules'),'merchants.enc',2_000_000,fresh,true);
  }
  async writeMerchantRules(text:string,existing:{id:string;etag:string}|null):Promise<{id:string;etag:string}|null> {
    return this.writeNamedFile(this.financeDataPath('rules'),'merchants.enc',text,existing,2_000_000);
  }
  /** Independent encrypted asset settings, never stored in the statement index. */
  async readAssetSettings(fresh=false):Promise<{text:string;id:string;etag:string}|null> {
    return this.readNamedFile(this.financeDataPath('settings'),'assets.enc',2_000_000,fresh,true);
  }
  async writeAssetSettings(text:string,existing:{id:string;etag:string}|null):Promise<{id:string;etag:string}|null> {
    return this.writeNamedFile(this.financeDataPath('settings'),'assets.enc',text,existing,2_000_000);
  }
  /** Only strict YYYY-MM encrypted report files are accepted in this generation. */
  async listMonthlyReports():Promise<Array<{period:string;id:string;etag:string}>> {
    const parent=await this.folderPath(this.financeDataPath('reports'),false);
    if(!parent)return [];
    const r=await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children?$select=id,name,eTag&$top=400`);
    const json=await r.json() as {value?:DriveItem[];'@odata.nextLink'?:string};
    if(json['@odata.nextLink']||!Array.isArray(json.value))throw new Error('レポート一覧をすべて取得できませんでした。');
    const found=json.value.filter(item=>/^(19|20|21)\d{2}-(0[1-9]|1[0-2])\.enc$/.test(item.name??''));
    if(found.some(item=>!item.id||!item.eTag)||new Set(found.map(x=>x.name)).size!==found.length)
      throw new Error('レポート一覧が不正です。');
    return found.map(item=>({period:item.name!.slice(0,-4),id:item.id,etag:item.eTag!})).sort((a,b)=>b.period.localeCompare(a.period));
  }
  async readMonthlyReport(period:string,fresh=false):Promise<{text:string;id:string;etag:string}|null> {
    if(!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(period))throw new Error('年月が不正です。');
    return this.readNamedFile(this.financeDataPath('reports'),`${period}.enc`,2_000_000,fresh);
  }
  async writeMonthlyReport(period:string,text:string,existing:{id:string;etag:string}|null):Promise<{id:string;etag:string}|null> {
    if(!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(period))throw new Error('年月が不正です。');
    return this.writeNamedFile(this.financeDataPath('reports'),`${period}.enc`,text,existing,2_000_000);
  }
  /** One listing provides both year discovery and ETags, so unchanged years need no download. */
  async listYearFiles(fresh=false):Promise<Array<{year:string;id:string;etag:string}>> {
    const parent=await this.folderPath(this.financeDataPath('statements'),false);
    if(!parent)return [];
    const r=await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children?$select=id,name,eTag&$top=400`,fresh?{cache:'no-store'}:{});
    const json=await r.json() as {value?:DriveItem[];'@odata.nextLink'?:string};
    if(json['@odata.nextLink'])throw new Error('保存年度が多すぎるため一覧を取得できません。');
    if(!Array.isArray(json.value))throw new Error('年別明細の一覧が不正です。');
    return json.value.filter(x=>/^(19|20|21)\d\d\.enc$|^undated\.enc$/.test(x.name??''))
      .map(x=>({year:checkBucket(x.name!.slice(0,-4)),id:x.id,etag:x.eTag??''}));
  }
  async listYearBuckets():Promise<string[]> {return (await this.listYearFiles()).map(x=>x.year);}

  /** Each year is independently encrypted and concurrency-controlled. */
  async readYearVault(year:string,fresh=false):Promise<{text:string;id:string;etag:string}|null> {
    return this.readNamedFile(this.financeDataPath('statements'),`${checkBucket(year)}.enc`,25_000_000,fresh);
  }
  /** Before a save, ask only for metadata if our existing decrypted year is current.
   * Microsoft Graph 304 avoids downloading and decrypting an unchanged shard.
   * If the file changed, download it and preserve its actual server ETag. */
  async readYearVaultForSave(year:string,known:{id:string;etag:string}|null):Promise<
    {kind:'unchanged'} | {kind:'remote';file:{text:string;id:string;etag:string}|null}
  > {
    checkBucket(year);
    if(!known?.id||!known.etag)return {kind:'remote',file:await this.readYearVault(year,true)};
    let response:Response;
    try {
      response=await this.graph(`/me/drive/items/${encodeURIComponent(known.id)}`,{
        headers:{'If-None-Match':known.etag},cache:'no-store',
      },true);
    }catch(error){
      if(error instanceof GraphError&&error.status===404) {
        // A file may have been replaced with a different drive ID.
        return {kind:'remote',file:await this.readYearVault(year,true)};
      }
      throw error;
    }
    if(response.status===304)return {kind:'unchanged'};
    const item=await response.json() as DriveItem;
    if(!item.id||!item.eTag)throw new Error('年別ファイルの更新情報が不正です。');
    if(item.id===known.id&&item.eTag===known.etag)return {kind:'unchanged'};
    const downloaded=await this.downloadItemInfo(item.id,25_000_000,item,true);
    if(!downloaded.item.eTag)throw new Error('年別ファイルのETagを取得できません。');
    return {kind:'remote',file:{text:downloaded.text,id:item.id,etag:downloaded.item.eTag}};
  }

  async writeYearVault(year:string,text:string,existing:{id:string;etag:string}|null):Promise<{id:string;etag:string}|null> {
    return this.writeNamedFile(this.financeDataPath('statements'),`${checkBucket(year)}.enc`,text,existing,25_000_000);
  }
  /** Read a shard via the ID already returned by the year listing. */
  async readListedYearVault(file:{year:string;id:string;etag:string}):Promise<{text:string;id:string;etag:string}> {
    checkBucket(file.year);
    if(!file.id)throw new Error('年別ファイルの識別子が不正です。');
    const value=await this.downloadItemInfo(file.id,25_000_000);
    if(!value.item.eTag)throw new Error('年別ファイルのETagを取得できません。');
    return {text:value.text,id:file.id,etag:value.item.eTag};
  }
  /** PDF originals are immutable; only the encrypted original bytes are uploaded. */
  async uploadDatedOriginal(id:string,encrypted:string,billingMonth:string|null|undefined):Promise<{id:string;etag:string}|null> {
    const [year,month]=originalParts(billingMonth);checkOriginalMonth(month);
    return this.writeNamedFile(this.financeDataPath('originals',year,month),this.originalName(id),encrypted,null,200*1024*1024);
  }
  async downloadDatedOriginal(id:string,billingMonth:string|null|undefined):Promise<string> {
    const [year,month]=originalParts(billingMonth);checkOriginalMonth(month);
    const file=await this.readNamedFile(this.financeDataPath('originals',year,month),this.originalName(id),200*1024*1024);
    if(!file)throw new Error('指定年月に暗号化PDF原本が見つかりません。');
    return file.text;
  }
  private payrollPublishedPath(folder:readonly string[],name:string):string[] {
    if(folder.length>4||folder.some(part=>!(/^[a-z0-9-]{1,64}$/i.test(part)))||
       !(['index.enc'].includes(name)||/^(19|20|21)\d{2}\.enc$/.test(name)))
      throw new Error('Payroll参照パスが不正です。');
    if(folder.length===0 && name!=='index.enc')throw new Error('Payroll参照パスが不正です。');
    if(folder.length>0 && name==='index.enc')throw new Error('Payroll参照パスが不正です。');
    if(folder.length>0 && !(folder.length===1&&folder[0]==='income') &&
       !(folder.length===3&&folder[0]==='versions'&&folder[2]==='income'&&/^[0-9a-f-]{36}$/i.test(folder[1]!)))
      throw new Error('Payroll参照先は収入公開ファイルに限定されています。');
    return [PAYROLL_DIR,...folder];
  }
  /** Finance may READ Payroll's published income data, never mutate its namespace. */
  async readPayrollPublishedFile(folder:readonly string[],name:string,maxBytes:number):Promise<{text:string;id:string;etag:string}|null> {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>30_000_000)throw new Error('Payroll参照パスが不正です。');
    return this.readNamedFile(this.payrollPublishedPath(folder,name),name,maxBytes,true,true);
  }
  /** Revalidate identity/version without downloading encrypted income again. */
  async readPayrollPublishedMetadata(folder:readonly string[],name:string):Promise<{id:string;etag:string}|null> {
    const item=await this.findNamedFile(this.payrollPublishedPath(folder,name),name,true);
    return item?{id:item.id,etag:item.eTag}:null;
  }
  /** Pre-create the namespace reserved for Payroll, without writing any payroll data. */
  async ensurePayrollNamespace():Promise<void> {await this.folderPath([PAYROLL_DIR],true);}

  /** Strict, complete listings only. Never clean up a truncated folder or unexpected file. */
  private async listCleanupFolder(parts:string[]):Promise<DriveItem[]> {
    const parent=await this.folderPath(parts,false);
    if(!parent)return [];
    const response=await this.graph(`/me/drive/items/${encodeURIComponent(parent)}/children?$select=id,name,eTag,folder,size,createdDateTime&$top=400`);
    const page=await response.json() as {value?:DriveItem[];'@odata.nextLink'?:string};
    if(page['@odata.nextLink']||!Array.isArray(page.value))throw new Error('削除対象の全件確認ができません。安全のため中止しました。');
    if(page.value.some(x=>!x.id||!x.name||!x.eTag))throw new Error('OneDriveのファイル情報を確認できません。削除を中止しました。');
    if(new Set(page.value.map(x=>x.name)).size!==page.value.length||new Set(page.value.map(x=>x.id)).size!==page.value.length)throw new Error('ファイル識別子が重複しています。削除を中止しました。');
    return page.value;
  }
  /** Only exact names at the Finance app root are eligible. Never match arbitrary backup files. */
  async listRetiredRootData():Promise<RetiredRootData> {
    const root=await this.listCleanupFolder([]);
    const legacy=root.filter(item=>(!item.folder&&item.name==='finance-v1-vault.enc')||
      (item.folder&&item.name==='finance-v1-originals'));
    if(legacy.length>2)throw new Error('旧v1保管庫が重複しています。削除できません。');
    const snapshots=root.filter(item=>!item.folder&&isSnapshotName(item.name!));
    for(const item of snapshots){
      if(!Number.isSafeInteger(item.size)||item.size! <= 0||item.size! > MAX_SNAPSHOT_BYTES||
         typeof item.createdDateTime!=='string'||!Number.isFinite(Date.parse(item.createdDateTime)))
        throw new Error('スナップショットのメタデータが不正です。削除を中止しました。');
    }
    return {
      legacyV1:legacy.map(item=>({id:item.id,name:item.name!,etag:item.eTag!})),
      snapshots:snapshots.map(item=>({id:item.id,name:item.name!,etag:item.eTag!,size:item.size!,createdDateTime:item.createdDateTime!}))
        .sort((a,b)=>b.createdDateTime.localeCompare(a.createdDateTime)||b.name.localeCompare(a.name)),
    };
  }
  /** Only directories directly under finance/versions are candidates. */
  async listOldVaultGenerations():Promise<CleanupFile[]> {
    const items=await this.listCleanupFolder([FINANCE_DIR,'versions']);
    return items.filter(x=>x.folder&&GENERATION_NAME.test(x.name!))
      .map(x=>({id:x.id,name:x.name!,etag:x.eTag!}));
  }
  /** Versioned vaults never read these old unversioned paths. Never include index.enc or versions. */
  async listUnversionedFinanceFolders():Promise<CleanupFile[]> {
    const candidates=new Set(['statements','originals','settings','rules','reports']);
    return (await this.listCleanupFolder([FINANCE_DIR]))
      .filter(item=>item.folder&&candidates.has(item.name!))
      .map(item=>({id:item.id,name:item.name!,etag:item.eTag!}));
  }
  /** Enumerate originals under finance/originals/YYYY/MM without following other namespaces. */
  async listDatedOriginals():Promise<DatedOriginalFile[]> {
    const result:DatedOriginalFile[]=[];
    const years=await this.listCleanupFolder(this.financeDataPath('originals'));
    for(const year of years){
      if(!year.folder||!(/^(19|20|21)\d{2}$|^undated$/).test(year.name!))continue;
      const months=await this.listCleanupFolder(this.financeDataPath('originals',year.name!));
      for(const month of months){
        if(!month.folder||!(/^(0[1-9]|1[0-2])$/.test(month.name!)||(year.name==='undated'&&month.name==='00')))continue;
        const files=await this.listCleanupFolder(this.financeDataPath('originals',year.name!,month.name!));
        for(const file of files){
          if(file.folder||!GENERATION_NAME.test((file.name??'').slice(0,-4))||!file.name!.endsWith('.enc'))continue;
          result.push({id:file.id,name:file.name!,etag:file.eTag!,year:year.name!,month:month.name!});
        }
      }
    }
    return result;
  }
  /** Graph DELETE puts the item in OneDrive recycle bin. Require a matching ETag. */
  async deleteCleanupItem(file:CleanupFile):Promise<void> {
    if(!file.id||!file.etag||!file.name)throw new Error('削除対象の識別情報が不正です。');
    await this.graph(`/me/drive/items/${encodeURIComponent(file.id)}`,{method:'DELETE',headers:{'If-Match':file.etag}});
  }
  async appFolderId(): Promise<string> {
    if(!this.appRoot){
      this.appRoot=(async()=>{
        const response=await this.graph('/me/drive/special/approot');
        const folder=await response.json() as DriveItem;
        if(!folder.id)throw new Error('OneDriveのアプリ専用領域を取得できませんでした。');
        return folder.id;
      })();
    }
    try{return await this.appRoot;}catch(error){this.appRoot=null;throw error;}
  }
}
