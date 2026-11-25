import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {planStatementImport,statementSignature} from '../dist/src/importers/import-policy.js';
import {prepareStatementRevision} from '../dist/src/importers/revision-review.js';
import {parseStatementText} from '../dist/src/importers/statement-parser.js';
import {importErrors} from '../dist/src/importers/batch-policy.js';
import {filteredStatementIndices} from '../dist/src/ui/manage-filter.js';
import {OneDriveTestClient,VaultOperationBusyError} from '../dist/src/cloud/onedrive-api.js';
const main=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
const code=main.slice(main.indexOf('async function acceptStatement('),main.indexOf('function bindImportCardChoices('));
const bill=(confirmation,cardId='rakuten-etc',amount=1000)=>({provider:'rakuten',cardId,sourceKind:'pdf',sourceName:'synthetic.pdf',billingMonth:'2026-01',paymentDate:'2026-01-27',statedTotal:amount,confirmation,rows:[{id:'synthetic-row',usedOn:'2025-12-25',merchant:'SAMPLE',amount}],warnings:[]});
function harness(old,incoming,approve=async()=>true){
 const source={bytes:new Uint8Array([1,2]),mime:'application/pdf'},storedId='stored-record';
 const ctx={statements:[incoming,old],importStaged:new WeakSet([incoming]),pendingSources:new WeakMap([[incoming,source]]),savedIds:new WeakMap([[old,storedId]]),pendingCloudIds:new WeakMap(),savedFingerprints:new WeakMap([[old,'old-fingerprint']]),originalSaved:new WeakSet([old]),importedSignatures:new WeakMap([[old,statementSignature(old)]]),dirty:new WeakSet(),activeIndex:0,batchBusy:false,filesBusy:false,revisionBusy:false,liveVault:{unlocked:true},lockSequence:0,failedImports:[],importUploadFeedback:'',planStatementImport,statementSignature,prepareStatementRevision,importErrors,hasUnsavedChanges:s=>s===incoming,statementWorkingFingerprint:statementSignature,confirmStatementRevision:approve,attachSource:(s,src)=>{if(src)ctx.pendingSources.set(s,src);},cardDisplayName:x=>x,providerLabel:x=>x,toast:()=>{},showActivity:()=>{},operationResult:()=>{},render:()=>{},updateImportUploadFeedback:()=>{},confirmationPending:()=>false,confirmationContext:()=>()=>true,requestConfirmation:async()=>true,ordinaryConfirmationOwner:{},markDirty:()=>{}};
 vm.createContext(ctx);vm.runInContext(main.slice(main.indexOf('function importCollision('),main.indexOf('function needsReview('))+'\n'+code+'\nthis.collision=importCollision;this.resolve=resolveSelectedImport;this.accept=acceptStatement;this.confirmRakuten=confirmUnclassifiedPdfDraft;this.canConfirm=canConfirmUnclassifiedPdfDraft;',ctx);return {ctx,source,storedId,run:()=>ctx.resolve(incoming)};
}
test('カード選択後の暫定→確定の差し替えはIDとPDFを維持し、承認前に書き込まない',async()=>{
 const old=bill('provisional'),incoming=bill('confirmed','rakuten-etc',1200);let called=0;
 const h=harness(old,incoming,async(a,b)=>{called++;assert.equal(a.confirmation,'provisional');assert.equal(b.confirmation,'confirmed');assert.equal(h.ctx.statements.length,2);return true;});
 await h.run();assert.equal(called,1);assert.equal(h.ctx.statements.length,1);const result=h.ctx.statements[0];assert.equal(result.confirmation,'confirmed');assert.equal(result.statedTotal,1200);assert.equal(h.ctx.savedIds.get(result),h.storedId);assert.equal(h.ctx.pendingSources.get(result),h.source);assert.ok(h.ctx.importStaged.has(result));assert.equal(h.ctx.activeIndex,0);
});
test('差し替え取消後に原本付き下書きを維持し、そのまま再承認できる',async()=>{
 const old=bill('provisional'),incoming=bill('confirmed');let accepted=false;const h=harness(old,incoming,async()=>accepted);
 await h.run();assert.deepEqual(h.ctx.statements,[incoming,old]);assert.equal(h.ctx.pendingSources.get(incoming),h.source);assert.ok(h.ctx.importStaged.has(incoming));assert.equal(h.ctx.failedImports.length,0);
 accepted=true;await h.run();assert.equal(h.ctx.statements.length,1);assert.equal(h.ctx.statements[0].confirmation,'confirmed');
});
test('同一確定明細は再登録しない、別カードは差し替えない、暫定への巻き戻しを拒否',async()=>{
 let h=harness(bill('confirmed'),bill('confirmed'));await h.run();assert.equal(h.ctx.statements.length,2);assert.equal(h.ctx.failedImports.length,0);assert.ok(h.ctx.importStaged.has(h.ctx.statements[0]));assert.equal(h.ctx.pendingSources.get(h.ctx.statements[0]),h.source);
 h.ctx.statements[0].cardId='rakuten-mizuho';await h.run();assert.equal(h.ctx.statements.length,2);assert.equal(h.ctx.pendingSources.get(h.ctx.statements[0]),h.source);
 h=harness(bill('confirmed'),bill('confirmed','rakuten-mizuho'));await h.run();assert.equal(h.ctx.statements.length,2);assert.equal(h.ctx.failedImports.length,0);
 h=harness(bill('confirmed'),bill('provisional'));await h.run();assert.equal(h.ctx.statements.length,2);assert.equal(h.ctx.statements[1].confirmation,'confirmed');
});
test('承認中に対象が変化した場合は差し替えない',async()=>{
 const old=bill('provisional'),incoming=bill('confirmed');const h=harness(old,incoming,async()=>{old.statedTotal=1200;return true;});await h.run();assert.equal(h.ctx.statements.length,2);assert.equal(h.ctx.statements[0],incoming);assert.equal(h.ctx.statements[1],old);
});
test('暫定絞り込みは全期間・指定月を扱い、未知状態や確定を含めない',()=>{
 const records=[bill('confirmed'),bill('provisional'),{...bill('provisional'),billingMonth:'2025-12'},bill('unknown')];
 assert.deepEqual(filteredStatementIndices(records,'all','all',true),[1,2]);assert.deepEqual(filteredStatementIndices(records,'2026','01',true),[1]);assert.deepEqual(filteredStatementIndices(records,'2026','01'),[0,1,3]);
});
test('保存ロックの存在・不存在・形式不明・認証失敗を区別し、書き込まない',async()=>{
 let mode='present';const methods=[];const client=new OneDriveTestClient('synthetic-token',async(_url,init)=>{methods.push(init.method??'GET');if(mode==='absent')return Response.json({error:{code:'itemNotFound'}},{status:404});if(mode==='auth')return Response.json({error:{code:'accessDenied'}},{status:403});return Response.json(mode==='invalid'?{id:'synthetic-marker'}:{id:'synthetic-marker',name:'finance-operation-lock',folder:{childCount:0},createdDateTime:'2026-01-01T00:00:00Z'});});client.folderPath=async()=> 'synthetic-parent';
 assert.deepEqual(await client.inspectVaultMutationLock(),{state:'present',createdAt:'2026-01-01T00:00:00.000Z'});mode='absent';assert.deepEqual(await client.inspectVaultMutationLock(),{state:'absent',createdAt:null});mode='invalid';await assert.rejects(client.inspectVaultMutationLock(),/形式/);mode='auth';await assert.rejects(client.inspectVaultMutationLock(),/403/);assert.ok(methods.every(x=>x==='GET'));assert.match(new VaultOperationBusyError().message,/前回の通信中断/);
});

test('既知カードの重複も下書き・原本を保持する',async()=>{
 const old=bill('confirmed'),incoming=bill('confirmed');const h=harness(old,incoming);h.ctx.statements.shift();h.ctx.importStaged.delete(incoming);
 assert.equal(await h.ctx.accept(incoming,h.source),true);assert.equal(h.ctx.statements[0],incoming);assert.equal(h.ctx.statements[1],old);assert.equal(h.ctx.pendingSources.get(incoming),h.source);assert.equal(h.ctx.failedImports.length,0);
});
test('楽天PDFの請求確定日は正式な確定根拠になるが暫定・欠損・無効日を昇格しない',()=>{
 const header='お支払日 返済方法 引落口座 請求確定日 利用獲得ポイント 調整額 返金額';
 const text=`ご利用代金請求明細書\n楽天カード株式会社\n2024年04月ご請求金額 ご利用カード\n1,000円 楽天カード(Visa) ****-****-****-0000\n${header}\n2024/04/27 口座振替 架空銀行 2024/04/12 10 0円 0円\n利用日 利用店名 利用者 支払方法 利用金額 手数料/利息 支払総額 当月請求額 翌月繰越残高\n2024/03/03 架空商店 本人 1回払い 1,000 0 1,000 1,000 0`;
 const parse=(raw,kind='pdf')=>parseStatementText(raw,kind,'synthetic');
 const confirmed=parse(text);assert.equal(confirmed.confirmation,'confirmed');assert.deepEqual(importErrors({...confirmed,cardId:'rakuten-etc'},true),[]);
 assert.equal(parse(text+'\n請求金額確定前の明細').confirmation,'provisional');
 for(const value of ['-','2024/04/31','2024/04/28','2099/04/12'])assert.equal(parse(text.replace('2024/04/12',value)).confirmation,'unknown');
 assert.equal(parse(text,'paste').confirmation,'unknown');
 assert.equal(planStatementImport([bill('provisional')],bill('confirmed')).kind,'revision');
});

test('保存済み暫定と同額で自動判定が不明でも、原本確認を承認して確定への差替えが可能',async()=>{
 const old=bill('provisional'),incoming=bill('unknown');const h=harness(old,incoming);assert.equal(h.ctx.canConfirm(incoming),true);
 h.ctx.requestConfirmation=async()=>false;await h.ctx.confirmRakuten(incoming);assert.equal(incoming.confirmation,'unknown');assert.equal(h.ctx.statements.length,2);
 h.ctx.requestConfirmation=async()=>true;await h.ctx.confirmRakuten(incoming);assert.equal(h.ctx.statements.length,1);assert.equal(h.ctx.statements[0].confirmation,'confirmed');assert.equal(h.ctx.savedIds.get(h.ctx.statements[0]),h.storedId);
});
test('原本未取得・別カード・確定済み・不正金額では手動確定を許可しない',()=>{
 let h=harness(bill('confirmed'),bill('provisional'));assert.equal(h.ctx.canConfirm(h.ctx.statements[0]),false);
 h=harness(bill('provisional'),bill('unknown','rakuten-mizuho'));assert.equal(h.ctx.canConfirm(h.ctx.statements[0]),false);
 h=harness(bill('provisional'),bill('unknown'));h.ctx.pendingSources.delete(h.ctx.statements[0]);assert.equal(h.ctx.canConfirm(h.ctx.statements[0]),false);
 h=harness(bill('provisional'),bill('unknown'));h.ctx.statements[0].statedTotal=9000;assert.equal(h.ctx.canConfirm(h.ctx.statements[0]),false);
});
test('古いインポート署名が一致しても確定状態の違いを重複にしない',()=>{
 const old=bill('provisional'),incoming=bill('confirmed');assert.equal(planStatementImport([old],incoming,()=>statementSignature(incoming)).kind,'revision');
});
test('トーストの本文のみマウス操作とテキスト選択が可能',()=>{
 const css=readFileSync(new URL('../public/styles/activity-v199.css',import.meta.url),'utf8');assert.match(css,/\.activity-toast \.activity-message\s*\{[^}]*pointer-events:auto;user-select:text;-webkit-user-select:text/);
});

 test('明示的な暫定PDFを手動確定できない。確定確認後の差し替え取消でも不明に戻る',async()=>{
 const old=bill('provisional'),incoming=bill('unknown');const h=harness(old,incoming,async()=>false);
 assert.equal(h.ctx.canConfirm(incoming),true);await h.ctx.confirmRakuten(incoming);assert.equal(incoming.confirmation,'unknown');assert.equal(h.ctx.statements.length,2);
 incoming.cardId='rakuten-mizuho';assert.equal(h.ctx.canConfirm(incoming),false);
 incoming.cardId='rakuten-etc';incoming.confirmation='provisional';assert.equal(h.ctx.canConfirm(incoming),false);
 });
 test('全対応カードの同一請求月で暫定→確定と逆方向を共通判定する',()=>{
 for(const [provider,cardId] of [['rakuten','rakuten-etc'],['rakuten','rakuten-mizuho'],['smbc','smbc-nl'],['smbc','amazon'],['jcb','recruit-jcb'],['view','bic-suica'],['goldpoint','goldpoint']]){
 const make=(status,amount=1000)=>({...bill(status,cardId,amount),provider});
 for(const amount of [1000,1200]){assert.equal(planStatementImport([make('provisional')],make('confirmed',amount)).kind,'revision');assert.equal(planStatementImport([make('confirmed')],make('provisional',amount)).kind,'blocked');assert.equal(planStatementImport([make('confirmed')],make('unknown',amount)).kind,'blocked');}
 assert.equal(planStatementImport([make('confirmed')],make('confirmed')).kind,'duplicate');assert.equal(planStatementImport([make('provisional')],make('provisional')).kind,'duplicate');
 }
 });

 test('確定状態不明の有効な他社PDFでも原本確認の導線があり、暫定と判明済みなら不可',()=>{
 for(const [provider,cardId] of [['smbc','smbc-nl'],['jcb','recruit-jcb'],['view','bic-suica'],['goldpoint','goldpoint']]){
 const old={...bill('provisional',cardId),provider},incoming={...bill('unknown',cardId),provider};const h=harness(old,incoming);assert.equal(h.ctx.canConfirm(incoming),true);incoming.confirmation='provisional';assert.equal(h.ctx.canConfirm(incoming),false);
 }
 });

 test('複数の同月候補がある場合、一致する原本があっても任意の差し替え先を選ばない',async()=>{
 const incoming=bill('confirmed'),old=bill('confirmed');
 assert.equal(planStatementImport([old,bill('provisional')],incoming).kind,'blocked');
 const h=harness(old,incoming,async()=>{throw new Error('unexpected approval');});
 h.ctx.statements.push(bill('provisional'));assert.equal(h.ctx.collision(incoming),'blocked');await h.run();assert.equal(h.ctx.statements.length,3);assert.equal(h.ctx.pendingSources.get(incoming),h.source);
 });
 test('同じ内容のCSV昇格は共通判定で差し替え、確定から暫定への逆戻りは拒否',async()=>{
 const old={...bill('confirmed'),sourceKind:'paste'},csv={...old,sourceKind:'csv'};
 assert.equal(planStatementImport([old],csv).kind,'revision');
 assert.equal(planStatementImport([csv],csv).kind,'duplicate');
 assert.equal(planStatementImport([old],{...csv,confirmation:'provisional'}).kind,'blocked');
 const h=harness(old,csv);assert.equal(h.ctx.collision(csv),'revision');await h.run();assert.equal(h.ctx.statements.length,1);assert.equal(h.ctx.statements[0].sourceKind,'csv');
 });

 test('別カードや別請求月では原本署名の再計算が不要',()=>{
 const incoming=bill('confirmed'),other=bill('confirmed','rakuten-mizuho');
 const noSignature=()=>{throw new Error('unnecessary signature');};
 assert.equal(planStatementImport([other],incoming,noSignature).kind,'add');
 assert.equal(planStatementImport([{...incoming,billingMonth:'2026-02'}],incoming,noSignature).kind,'add');
 });

test('bulk exclusion checks original references, manual edits, pending IDs and never deletes saved data',async()=>{
 const {redundantImportDrafts}=await import('../dist/src/importers/batch-policy.js');
 const old=bill('confirmed'),a=bill('confirmed'),b=bill('confirmed');
 const {ctx}=harness(old,a);ctx.redundantImportDrafts=redundantImportDrafts;ctx.importedSignatures.set(a,statementSignature(a));
 ctx.statements.unshift(b);ctx.importStaged.add(b);ctx.pendingSources.set(b,{bytes:new Uint8Array([1]),mime:'application/pdf'});ctx.importedSignatures.set(b,statementSignature(b));
 vm.runInContext('this.removable=removableDuplicateDrafts',ctx);
 assert.deepEqual(Array.from(ctx.removable()),[b,a]);
 ctx.pendingSources.delete(b);assert.equal(ctx.removable().length,0);ctx.pendingSources.set(b,{});
 ctx.pendingCloudIds.set(b,'pending-id');assert.equal(ctx.removable().length,0);ctx.pendingCloudIds.delete(b);
 b.rows[0].merchantOverride='edited';assert.equal(ctx.removable().length,0);delete b.rows[0].merchantOverride;
 ctx.savedIds.set(b,'replacement-id');assert.equal(ctx.removable().length,0);ctx.savedIds.delete(b);
 ctx.originalSaved.delete(old);assert.equal(ctx.removable().length,0);ctx.originalSaved.add(old);
 const listeners={};ctx.$=id=>({addEventListener:(_,fn)=>{listeners[id]=fn;}});ctx.discardImportDraft=(i,announce)=>{assert.equal(announce,false);assert.notEqual(ctx.statements[i],old);ctx.statements.splice(i,1);};
 const start=main.indexOf("$('import-discard-duplicates').addEventListener");const end=main.indexOf("$('clear-all').addEventListener",start);
 vm.runInContext(main.slice(start,end),ctx);ctx.liveVault.hasPendingYearBatch=true;listeners['import-discard-duplicates']();assert.equal(ctx.statements.length,3);
 ctx.liveVault.hasPendingYearBatch=false;listeners['import-discard-duplicates']();assert.deepEqual(ctx.statements,[old]);
});
