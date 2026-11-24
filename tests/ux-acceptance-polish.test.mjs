import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const js=readFileSync('dist/src/main.js','utf8');
const code=js.slice(js.indexOf('async function clearManagerChanges('),js.indexOf('async function saveEditedStatement('));
const original=()=>({rows:[{id:'a',merchant:'SAMPLE',amount:100,usedOn:'2026-11-01'},{id:'b',merchant:'SAMPLE 2',amount:200,usedOn:'2026-11-02'}],statedTotal:300});
function fixture(){
 const saved=original(),s=structuredClone(saved);s.rows.shift();s.rows[0].merchant='EDIT';s.rows[0].usedOn='2026-11-03';s.rows.push({id:'c',merchant:'NEW',amount:50});
 const other=original(),record={id:'a',statement:saved,originalId:'pdf-id'};let answer,rendered=0,writes=0;
 const env={JSON,structuredClone,Map,Set,activeIndex:0,statements:[s,other],savedIds:new Map([[s,'a'],[other,'b']]),savedFingerprints:new Map(),importedSignatures:new Map(),originalSaved:new Set(),importStaged:new Set(),
  liveVault:{unlocked:true,readonlyRecords:()=>[record],saveBatch(){writes++;}},lockSequence:0,batchBusy:false,filesBusy:false,cloudRefreshing:false,revisionBusy:false,confirmationPending:()=>false,
  active:()=>env.statements[env.activeIndex],hasUnsavedChanges:()=>true,ordinaryConfirmationOwner:{},requestConfirmation:()=>new Promise(r=>answer=r),statementWorkingFingerprint:JSON.stringify,statementSignature:JSON.stringify,render:()=>rendered++,$:()=>({focus(){}}),toast(){}};
 const context=vm.createContext(env);vm.runInContext(code,context);return {env,s,other,record,saved,run:()=>context.clearManagerChanges(),answer:v=>answer(v),rendered:()=>rendered,writes:()=>writes};
}
test('変更クリアは行追加・削除・名称・日付をまとめて復元し別明細・OneDriveを変更しない',async()=>{
 const h=fixture(),pending=h.run();h.answer(true);await pending;assert.deepEqual(h.env.statements[0],h.saved);assert.equal(h.env.statements[1],h.other);assert.equal(h.env.savedIds.get(h.env.statements[0]),'a');assert.equal(h.env.originalSaved.has(h.env.statements[0]),true);assert.equal(h.rendered(),1);assert.equal(h.writes(),0);
});
test('変更クリアは取消・別明細への移動・ロック・確認中の編集・保存済み明細の更新では復元しない',async()=>{
 for(const scenario of ['cancel','switch','lock','edit','remote','busy']){const h=fixture(),pending=h.run();if(scenario==='switch')h.env.activeIndex=1;if(scenario==='lock')h.env.lockSequence++;if(scenario==='edit')h.s.rows[0].amount=999;if(scenario==='remote')h.record.statement.rows[0].amount=999;if(scenario==='busy')h.env.batchBusy=true;h.answer(scenario!=='cancel');await pending;assert.equal(h.env.statements[0],h.s);assert.equal(h.rendered(),0);assert.equal(h.writes(),0);}
});
test('変更クリアは取込待ち・未保存の新規明細を破棄しない',async()=>{
 for(const scenario of ['import','new']){const h=fixture();if(scenario==='import')h.env.importStaged.add(h.s);else h.env.savedIds.delete(h.s);await h.run();assert.equal(h.env.statements[0],h.s);assert.equal(h.writes(),0);}
});
