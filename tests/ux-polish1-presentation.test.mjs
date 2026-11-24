import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=file=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
const main=read('dist/src/main.js');
test('明細のPDF原本ボタンは保存済みの参照がある場合だけ表示し、処理中は無効にする',()=>{
  const start=main.indexOf("const originalButton = $('manage-original-download');");
  const end=main.indexOf("$('manage-add-row').disabled",start);
  assert.ok(start>=0&&end>start);
  const snippet=main.slice(start,end);
  for(const {saved,unlocked,original,busy,expected} of [
    {saved:true,unlocked:true,original:true,busy:false,expected:[false,false]},
    {saved:true,unlocked:true,original:true,busy:true,expected:[false,true]},
    {saved:true,unlocked:true,original:false,busy:false,expected:[true,true]},
    {saved:false,unlocked:true,original:true,busy:false,expected:[true,true]},
    {saved:true,unlocked:false,original:true,busy:false,expected:[true,true]},
  ]){
    const s={},button={hidden:false,disabled:false,classList:{toggle(name,value){assert.equal(name,'hidden');button.hidden=value;}}};
    vm.runInNewContext(snippet,{$:()=>button,s,savedIds:new Map(saved?[[s,'record-a']]:[]),liveVault:{unlocked,readonlyRecords:()=>[{id:'record-a',originalId:original?'original-a':null}]},batchBusy:busy,filesBusy:false});
    assert.deepEqual([button.hidden,button.disabled],expected);
  }
});
test('表示文言の整理後も保存・差し替え・照合の確認情報を保持する',()=>{
 const html=read('public/index.html');
 assert.doesNotMatch(html,/長い明細は入力欄の中だけスクロール|id="verification-ok"/);
 assert.match(html,/id="import-revision-accept"[^>]*>差し替える<\/button>/);
 assert.match(html,/差し替えは取込待ちに追加され、保存操作でOneDriveへ反映されます/);
 assert.match(html,/id="import-revision-override-accept"/);
 assert.match(main,/button\.textContent = batchBusy \? '保存中…' : '保存'/);
 assert.match(main,/button\.disabled = !drafts\.length \|\| errorCount > 0/);
 assert.match(main,/rule\.priority === 100 \? card :/);
 assert.match(main,/filtered\.length > 60 \?/);
 assert.doesNotMatch(read('src/cloud/cloud-settings.ts'),/npm install → npm run build/);
});
