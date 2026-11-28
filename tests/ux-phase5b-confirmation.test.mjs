import {traceFinanceOperation} from '../dist/src/cloud/performance-diagnostics.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const js=readFileSync(new URL('../dist/src/main.js',import.meta.url),'utf8');
const extract=(start,end)=>{
  const a=js.indexOf(start),b=js.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a);return js.slice(a,b);
};
function harness(code,extra={}){
  let accept=null;const prompts=[],writes=[],notices=[];
  const nodes=new Map();const $=id=>{
    if(!nodes.has(id))nodes.set(id,{open:true,value:'',textContent:'',classList:{contains:()=>true},close(){this.open=false;}});
    return nodes.get(id);
  };
  const env={traceFinanceOperation,JSON,structuredClone,Error,Map,Set,WeakMap,Array,$,batchBusy:false,filesBusy:false,revisionBusy:false,rulesBusy:false,
    lockSequence:0,ordinaryConfirmationOwner:{},confirmationPending:()=>accept!==null,
    requestConfirmation(options){prompts.push(options);return new Promise(resolve=>{accept=resolve;});},
    render(){},renderRules(){},updateCloudStatus(){},operationResult(){},showActivity(){},toast(message){notices.push(message);},
    CloudWriteUncertainError:class extends Error{},...extra};
  const context=vm.createContext(env);
  vm.runInContext(code,context);
  return {env,prompts,writes,notices,$,context,answer(value){assert.ok(accept);const resolve=accept;accept=null;resolve(value);}};
}
const statement=()=>({cardId:'smbc-nl',provider:'smbc',billingMonth:'2026-11',sourceKind:'pdf',rows:[{id:'r',amount:500}]});
function deletion(){
  const s=statement(),other={...statement(),billingMonth:'2026-10'},savedIds=new Map([[s,'record-a'],[other,'record-b']]);
  const h=harness(extract('async function deleteStatement(', 'function providerLabel('),{
    statements:[s,other],savedIds,conflictStorageYears:new WeakMap(),activeIndex:0,cardDisplayName:()=> 'カード',needsReview:()=>true,
    pending:()=>[],replaceCloudRecords(){},selectVisibleManagerStatement(){},
  });
  h.env.liveVault={unlocked:true,async delete(id){h.writes.push(id);},takeMutationWarning:()=>null,records:()=>[]};
  return {...h,s,other,run:()=>h.context.deleteStatement(0)};
}
test('保存済み明細は確認が必須で、取消・ロック・明細変更・ID変更では削除しない',async()=>{
  for(const scenario of ['cancel','lock','edit','id','vault','busy']){
    const h=deletion(),pending=h.run();assert.equal(h.prompts.length,1);assert.match(h.prompts[0].message,/暗号化PDF原本はOneDriveに保持/);
    await h.run();assert.equal(h.prompts.length,1);
    if(scenario==='lock')h.env.lockSequence++;
    if(scenario==='edit')h.s.rows[0].amount=900;
    if(scenario==='id')h.env.savedIds.set(h.s,'record-b');
    if(scenario==='vault')h.env.liveVault={...h.env.liveVault};
    if(scenario==='busy')h.env.batchBusy=true;
    h.answer(scenario!=='cancel');await pending;assert.deepEqual(h.writes,[]);assert.equal(h.env.statements.length,2);
  }
});
test('明細の表示位置が変わっても承認済みのIDだけを削除し、別明細を残す',async()=>{
  const h=deletion(),pending=h.run();h.env.statements.reverse();h.answer(true);await pending;
  assert.deepEqual(h.writes,['record-a']);assert.equal(h.env.statements.length,1);assert.equal(h.env.statements[0],h.other);
});
test('利用先ルール削除は確認後の同一内容と編集中の入力を検証する',async()=>{
  for(const scenario of ['cancel','edit','form','lock','ok']){
    const rule={id:'rule-a',pattern:'SAMPLE',displayName:'テスト'};let current=structuredClone(rule),form='draft';
    const h=harness(extract('async function deleteRule(', 'async function refreshVaultControls('),{
      editingRuleId:'rule-a',ruleFormFingerprint:()=>form,ruleFormHasChanges:()=>true,resetRuleEditor(){},
    });
    h.env.liveVault={unlocked:true,merchantRules:()=>[structuredClone(current)],async removeMerchantRule(id){h.writes.push(id);}};
    const pending=h.context.deleteRule(rule);assert.match(h.prompts[0].message,/元のカード明細は変更されません/);
    if(scenario==='edit')current.pattern='OTHER';if(scenario==='form')form='new';if(scenario==='lock')h.env.lockSequence++;
    h.answer(scenario!=='cancel');await pending;assert.deepEqual(h.writes,scenario==='ok'?['rule-a']:[]);
  }
});
test('カテゴリーの変更破棄は元の下書きだけを対象とし、キャンセルと再編集を保持する',async()=>{
  for(const scenario of ['cancel','edit','lock','ok','typed']){
    const draft=[{id:'category-a',name:'テスト'}];const vault={unlocked:true};
    const h=harness(extract('async function closeCategoryDialog(', 'async function saveCategoryDialog('),{
      categorySaving:false,categoryDraft:draft,categoryBaseline:[],categoryBatchChanged:()=>scenario!=='typed',categoryPlan:()=>({}),liveVault:vault,
    });
    if(scenario==='typed')h.$('rules-category-name').value='未追加';
    const pending=h.context.closeCategoryDialog();assert.equal(h.prompts.length,1);
    if(scenario==='edit')draft[0].name='新しい入力';if(scenario==='lock')h.env.lockSequence++;
    h.answer(scenario!=='cancel');await pending;
    const closed=scenario==='ok'||scenario==='typed';assert.equal(h.$('categories-dialog').open,!closed);assert.equal(h.env.categoryDraft,closed?null:draft);
  }
});
test('一括破棄の承認は下書きと解析失敗の同じ集合にだけ適用する',async()=>{
  const callback=extract("$('clear-all').addEventListener('click', async () => {", "$('vault-cancel').addEventListener");
  // Register the actual compiled handler, rather than reimplementing its conditions.
  for(const scenario of ['cancel','new','edit','failure','lock','ok']){
    const draft=statement(),statements=[draft],failedImports=['parse error'];let handler;
    const h=harness(callback,{statements,failedImports,currentUploadFailures:[],importUploadFeedback:'',activeIndex:0,
      liveVault:{unlocked:true},importQueue:()=>statements.slice(),discardImportDraft(index){statements.splice(index,1);},
      $:()=>({addEventListener(_event,fn){handler=fn;}}),
    });
    const pending=handler();assert.equal(h.prompts.length,1);
    if(scenario==='new')statements.push(statement());if(scenario==='edit')draft.rows[0].amount=900;
    if(scenario==='failure')failedImports.push('new error');if(scenario==='lock')h.env.lockSequence++;
    h.answer(scenario!=='cancel');await pending;
    assert.equal(statements.length,scenario==='ok'?0:scenario==='new'?2:1);assert.equal(failedImports.length,scenario==='ok'?0:scenario==='failure'?2:1);
  }
});
