import { showActivity, finishActivity } from './activity-feedback.js';
/** P1-B monthly report archive. Nothing is written without pressing Save. */
import { reportSnapshot, snapshotHash, type MonthlyReportDocument, type ReportRevision, type ReportSnapshot } from '../reports/monthly-report.js';
import type { MonthlySource } from '../summary/monthly-summary.js';
import { CloudWriteUncertainError, type LiveVault } from '../cloud/live-vault.js';
import {monthNavigator} from './period-navigator.js';
import { pointBenefitsSection } from './point-benefits.js';

export interface MonthlyReportsUi { render():void; openPeriod(period:string):void; reset():void; isBusy():boolean; isDirty():boolean }
export interface MonthlyReportsDeps { source():MonthlySource|null; vault():LiveVault|null; openMonth(period:string):void }
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;};
const yen=(x:number|null)=>x===null?'未取得':`${x.toLocaleString('ja-JP')}円`;
const month=(x:string)=>`${x.slice(0,4)}年${Number(x.slice(5))}月`;
function el<K extends keyof HTMLElementTagNameMap>(tag:K,cls='',content?:string):HTMLElementTagNameMap[K]{
  const node=document.createElement(tag);node.className=cls;if(content!==undefined)node.textContent=content;return node;
}
function button(text:string,action:()=>void,cls='secondary-action'):HTMLButtonElement{
  const node=el('button',cls,text);node.type='button';node.addEventListener('click',action);return node;
}
function section(title:string):{root:HTMLElement;body:HTMLElement}{
  const root=el('section','panel reports-panel'),body=el('div','reports-panel-body');root.append(el('h2','',title),body);return {root,body};
}
function row(parent:HTMLElement,label:string,value:string):void {
  const root=el('div','reports-row');root.append(el('span','',label),el('strong','',value));parent.append(root);
}
function renderSnapshot(root:HTMLElement,snapshot:ReportSnapshot,showMetrics=true):void {
  const metrics=el('div','reports-metrics');
  for(const [label,value] of [['収入',snapshot.income],['支出',snapshot.expense],['収支',snapshot.balance]] as const){
    const item=el('div','reports-metric');item.append(el('span','',label),el('strong','',yen(value)));metrics.append(item);
  }
  if(showMetrics)root.append(metrics);
  if(snapshot.quality.length){const note=el('p','reports-quality',snapshot.quality.join(' · '));root.append(note);}
  if(snapshot.reasons.length){const block=section('この月の特徴');for(const text of snapshot.reasons)block.body.append(el('p','reports-insight',text));root.append(block.root);}
  const cards=section('カード請求');
  if(!snapshot.cards.length)cards.body.append(el('p','reports-muted','登録済みの請求はありません。'));
  else for(const item of snapshot.cards)row(cards.body,item.name,yen(item.amount));
  root.append(cards.root);
  const cats=section('カテゴリー別支出');
  for(const item of snapshot.categories)row(cats.body,item.name,yen(item.amount));
  if(snapshot.nisaOutflow)row(cats.body,'NISA積立（資産移動）',yen(snapshot.nisaOutflow));
  if(!cats.body.childNodes.length)cats.body.append(el('p','reports-muted','登録済みの内訳はありません。'));
  root.append(cats.root);
  const merchants=section('主な利用先');
  for(const item of snapshot.merchants.slice(0,8))row(merchants.body,item.name,yen(item.amount));
  if(!merchants.body.childNodes.length)merchants.body.append(el('p','reports-muted','登録済みの利用先はありません。'));
  root.append(merchants.root);
  const assets=section('口座・資産の確認記録');
  if(!snapshot.balances.length)assets.body.append(el('p','reports-muted','対象月までの残高記録はありません。'));
  for(const item of snapshot.balances)row(assets.body,`${item.name} · ${item.observedAt.slice(0,10)}`,yen(item.balance));
  root.append(assets.root);
}
export function initMonthlyReports(deps:MonthlyReportsDeps):MonthlyReportsUi {
  const root=document.getElementById('reports-content');if(!root)throw new Error('月次レポート画面がありません。');
  const container:HTMLElement=root;
  let selected=today();let loadedPeriod='';let archive:MonthlyReportDocument|null=null;
  let periods:string[]=[];let busy=false;let message='';let draft='';let chosenRevision:string|null=null;
  let request=0;let changed=false;let loadFailed=false;let draftConflict=false;
  const drafts=new Map<string,{note:string;revision:string|null}>();
  const active=()=>deps.vault()?.unlocked===true;
  function reset():void {++request;selected=today();loadedPeriod='';archive=null;periods=[];busy=false;message='';draft='';changed=false;loadFailed=false;draftConflict=false;chosenRevision=null;drafts.clear();container.replaceChildren();}
  async function fetch():Promise<void>{
    const vault=deps.vault();if(!vault?.unlocked)return;
    const id=++request;busy=true;message='';loadFailed=false;showActivity('月次レポートを読み込み中…','working');render();
    try{
      const [list,document]=await Promise.all([vault.listArchivedMonths(),vault.loadArchivedReport(selected)]);
      if(id!==request)return;
      periods=list;archive=document;loadedPeriod=selected;
      const held=drafts.get(selected);
      draftConflict=!!held&&held.revision!==(document?.current.id??null);
      draft=held?.note??document?.current.note??'';changed=false;loadFailed=false;chosenRevision=null;
      // Only decrypted in the unlocked session. Do not cache report bodies in browser storage.
      message='';
    }catch(error){if(id!==request)return;loadedPeriod=selected;loadFailed=true;archive=null;periods=[];message=`取得失敗：${error instanceof Error?error.message:'レポートを取得できませんでした。'}`;}
    finally{if(id===request){busy=false;finishActivity('月次レポート');if(loadFailed)showActivity(message,'bad');render();if(!loadFailed&&archive)void compareSource();}}
  }
  async function save():Promise<void>{
    const vault=deps.vault(),source=deps.source();if(!vault?.unlocked||!source||busy||loadFailed||draftConflict||loadedPeriod!==selected)return;
    busy=true;message='';showActivity('月次レポートを保存中…','working');render();
    try{
      const snapshot=reportSnapshot(selected,source);
      const result=await vault.saveArchivedReport(snapshot,draft,archive?.current.id??null);
      archive=result;loadedPeriod=selected;draft=result.current.note;drafts.delete(selected);changed=false;draftConflict=false;chosenRevision=null;
      if(!periods.includes(selected))periods=[selected,...periods].sort().reverse();
      message='';showActivity('月次レポートを保存しました。','good');
    }catch(error){message=`${error instanceof CloudWriteUncertainError?'保存結果未確認':'保存失敗'}：${error instanceof Error?error.message:'保存できませんでした。'}`;showActivity(message,'bad');}
    finally{busy=false;render();}
  }
  async function compareSource():Promise<void>{
    const id=request;
    const source=deps.source();if(!source||!archive)return;
    try {const hash=await snapshotHash(reportSnapshot(selected,source));if(id===request){changed=hash!==archive.current.sourceHash;render();}}
    catch {if(id===request){changed=false;}}
  }
  function render():void{
    container.replaceChildren();
    if(!active()) {container.append(el('div','panel reports-locked','OneDrive保管庫を解除してください。'));return;}
    container.append(el('p','reports-purpose','月別サマリーは最新データの集計。このレポートは、保存した時点の集計とメモを後から振り返るための記録です。保存しなくても日常の収支管理には影響しません。'));
    const top=el('div','reports-controls');
    const choosePeriod=(period:string)=>{selected=period;loadedPeriod='';archive=null;draft='';chosenRevision=null;message='';++request;void fetch();};
    const nav=monthNavigator(selected,choosePeriod,{label:'レポート対象年月',min:'1900-02',max:'2199-12',today:today()});
    if(busy)nav.querySelectorAll('button,input').forEach(item=>{(item as HTMLButtonElement|HTMLInputElement).disabled=true;});
    const refresh=button('最新を取得',()=>{void fetch();});refresh.disabled=busy;
    top.append(nav,refresh);container.append(top);
    // Keep failures beside the operation, even after the activity card expires.
    if(busy)return;
    if(loadFailed){const error=el('p','reports-feedback-error',message);error.setAttribute('role','alert');container.append(error);return;}
    if(loadedPeriod!==selected){void fetch();return;}
    if(periods.length){
      const list=el('div','reports-period-list');list.append(el('span','reports-muted','保存済み'));
      for(const period of periods){const item=button(month(period),()=>{selected=period;loadedPeriod='';archive=null;++request;void fetch();},'reports-period-button'+(period===selected?' selected':''));item.setAttribute('aria-pressed',String(period===selected));list.append(item);}
      container.append(list);
    }
    const control=section(month(selected));
    if(message){const error=el('p','reports-feedback-error',message);error.setAttribute('role','alert');control.body.append(error);}
    const state=archive?.current;
    control.body.append(el('p','reports-muted',state?`保存：${new Date(state.savedAt).toLocaleString('ja-JP')}`:'まだレポートがありません。'));
    if(changed&&state)control.body.append(el('p','reports-quality','明細や設定に変更があります。レポートを更新できます。'));
    if(draftConflict){
      control.body.append(el('p','reports-quality','別の端末でメモが更新されました。編集中の内容を確認してください。'));
      control.body.append(button('編集内容を破棄して最新を表示',()=>{drafts.delete(selected);draftConflict=false;draft=archive?.current.note??'';render();}));
    }
    const noteLabel=el('label','reports-memo-label','メモ');noteLabel.htmlFor='reports-memo';control.body.append(noteLabel);
    const memo=el('textarea','reports-memo');memo.id='reports-memo';memo.rows=3;memo.maxLength=2000;memo.value=draft;
    memo.placeholder='今月の振り返り';memo.addEventListener('input',()=>{draft=memo.value;drafts.set(selected,{note:draft,revision:archive?.current.id??null});});
    control.body.append(memo);
    const submit=button(state?'レポートを更新':'レポートを作成',()=>{void save();},'primary-action');
    submit.disabled=draftConflict;control.body.append(submit);
    control.body.append(button('月別サマリーを開く',()=>deps.openMonth(selected)));
    container.append(control.root);
    const revision=chosenRevision?archive?.history.find(item=>item.id===chosenRevision)??state:state;
    if(revision){
      const heading=el('div','reports-revision-bar');heading.append(el('strong','',chosenRevision?'過去の版':'保存した時点の収支'));
      if(chosenRevision)heading.append(button('最新版へ戻る',()=>{chosenRevision=null;render();}));
      container.append(heading);
      const metrics=el('div','reports-metrics');
      for(const [label,value] of [['収入',revision.snapshot.income],['支出',revision.snapshot.expense],['収支',revision.snapshot.balance]] as const){
        const item=el('div','reports-metric');item.append(el('span','',label),el('strong','',yen(value)));metrics.append(item);
      }
      container.append(metrics);
      if(revision.snapshot.points)container.append(pointBenefitsSection('獲得ポイント',revision.snapshot.points));
      if(chosenRevision)container.append(el('p','reports-insight',revision.note||'この版のメモはありません。'));
      const detail=el('details','reports-detail');detail.append(el('summary','','カード・カテゴリー・利用先などの内訳を見る'));
      const body=el('div','reports-detail-body');renderSnapshot(body,revision.snapshot,false);detail.append(body);container.append(detail);
    }
    if(archive?.history.length){
      const history=el('details','reports-detail reports-history');
      history.append(el('summary','','以前の保存履歴を見る（最大5件）'));
      const inner=el('div','reports-history-body');
      for(const version of archive.history)inner.append(button(new Date(version.savedAt).toLocaleString('ja-JP'),()=>{chosenRevision=version.id;render();},'reports-history-button'));
      history.append(inner);container.append(history);
    }
  }
  function openPeriod(period:string):void {
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))return;
    selected=period;loadedPeriod='';archive=null;draft='';++request;
  }
  return {render:()=>{render();if(archive&&!busy)void compareSource();},openPeriod,reset,
    isBusy:()=>busy,isDirty:()=>[...drafts].some(([period,entry])=>
      entry.note!==((period===selected&&loadedPeriod===selected)?archive?.current.note??'':''))};
}
