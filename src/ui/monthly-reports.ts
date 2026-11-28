import { traceFinanceOperation } from '../cloud/performance-diagnostics.js';
import {requestConfirmation,confirmationPending,cancelConfirmation} from './modal.js';
import {localDay} from '../cloud/asset-projection.js';
import {DATA_STATUS,financialStatusClass,formatYen as sharedYen,formatMonth,formatDateTime,formatDate} from './formatters.js';
import { showActivity, finishActivity } from './activity-feedback.js';
/** P1-B monthly report archive. Nothing is written without pressing Save. */
import { reportSnapshot, snapshotHash, type MonthlyReportDocument, type ReportSnapshot } from '../reports/monthly-report.js';
import type { MonthlySource } from '../summary/monthly-summary.js';
import { CloudWriteUncertainError, type LiveVault } from '../cloud/live-vault.js';
import {monthNavigator,localMonth} from './period-navigator.js';
import { pointBenefitsSection,archivedPointCoverage } from './point-benefits.js';

type ReportComparisonState='unchecked'|'checking'|'unchanged'|'changed'|'unavailable';
export interface MonthlyReportsUi { render():void; openPeriod(period:string):void; reset():void; isBusy():boolean; isDirty():boolean }
export interface MonthlyReportsDeps { source():MonthlySource|null; vault():LiveVault|null }
const today=localMonth;
const yen=(value:number|null)=>sharedYen(value,0,DATA_STATUS.missing);
const month=formatMonth;
const metricValue=(label:string,value:number|null,snapshot:ReportSnapshot)=>label==='収支'?sharedYen(value,0,DATA_STATUS.unavailable):label==='支出'&&snapshot.cardOutflow===null?DATA_STATUS.unavailable:yen(value);
function reportMetrics(snapshot:ReportSnapshot):HTMLElement {
  const metrics=el('div','reports-metrics');
  for(const [label,value] of [['収入',snapshot.income],['支出',snapshot.expense],['収支',snapshot.balance]] as const){
    const tone=label==='収支'&&value!==null?(value<0?' cashflow-negative':' cashflow-positive'):'';
    const item=el('div',`reports-metric${tone}`),text=metricValue(label,value,snapshot);
    item.append(el('span','',label),el('strong',financialStatusClass(text),text));
    if(label==='支出'&&snapshot.cardOutflow===null&&value!==null)item.append(el('small','reports-muted',`判明分 ${yen(value)}`));
    metrics.append(item);
  }
  return metrics;
}
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
  const root=el('div','reports-row');root.append(el('span','',label),el('strong',financialStatusClass(value),value));parent.append(root);
}
function renderSnapshot(root:HTMLElement,snapshot:ReportSnapshot,showMetrics=true):void {
  if(showMetrics)root.append(reportMetrics(snapshot));
  if(showMetrics&&snapshot.quality.length){const note=el('p','reports-quality',snapshot.quality.join(' · '));root.append(note);}
  if(snapshot.reasons.length){const block=section('この月の特徴');for(const text of snapshot.reasons)block.body.append(el('p','reports-insight',text));root.append(block.root);}
  const cards=section('カード請求');
  if(!snapshot.cards.length)cards.body.append(el('p','reports-muted',snapshot.cardOutflow===0?'利用なし確認済み':'明細未取得'));
  else for(const item of snapshot.cards)row(cards.body,item.name,yen(item.amount));
  root.append(cards.root);
  const cats=section('カテゴリー別支出');
  for(const item of snapshot.categories)row(cats.body,item.name,yen(item.amount));
  // NISA is already a row of snapshot.categories; do not append it twice.
  if(!cats.body.childNodes.length)cats.body.append(el('p','reports-muted','登録済みの内訳はありません。'));
  root.append(cats.root);
  const merchants=section('主な利用先');
  for(const item of snapshot.merchants.slice(0,8))row(merchants.body,item.name,yen(item.amount));
  if(!merchants.body.childNodes.length)merchants.body.append(el('p','reports-muted','登録済みの利用先はありません。'));
  root.append(merchants.root);
  const assets=section('口座・資産の確認記録');
  if(!snapshot.balances.length)assets.body.append(el('p','reports-muted','対象月までの残高記録はありません。'));
  for(const item of snapshot.balances)row(assets.body,`${item.name} · ${formatDate(localDay(new Date(item.observedAt)))}`,yen(item.balance));
  root.append(assets.root);
}
export function initMonthlyReports(deps:MonthlyReportsDeps):MonthlyReportsUi {
  const root=document.getElementById('reports-content');if(!root)throw new Error('月次レポート画面がありません。');
  const container:HTMLElement=root;
  let selected=today();let loadedPeriod='';let archive:MonthlyReportDocument|null=null;
  let periods:string[]=[];let archiveYear=today().slice(0,4);let busy=false;let saving=false;let message='';let draft='';let chosenRevision:string|null=null;
  let request=0;let comparisonRequest=0;let comparison:ReportComparisonState='unchecked';let loadFailed=false;let draftConflict=false;
  const confirmationOwner={};
  const drafts=new Map<string,{note:string;revision:string|null}>();
  const active=()=>deps.vault()?.unlocked===true;
  function reset():void {++request;cancelConfirmation(confirmationOwner);selected=today();archiveYear=selected.slice(0,4);loadedPeriod='';archive=null;periods=[];busy=false;saving=false;message='';draft='';comparison='unchecked';++comparisonRequest;loadFailed=false;draftConflict=false;chosenRevision=null;drafts.clear();container.replaceChildren();}
  async function fetch():Promise<void>{
    return traceFinanceOperation('report-read',async()=>{
    const vault=deps.vault();if(!vault?.unlocked||busy)return;
    const period=selected,id=++request;busy=true;message='';loadFailed=false;showActivity('月次レポートを読み込み中…','working');render();
    try{
      const [list,document]=await vault.loadArchivedReports(period);
      if(id!==request||vault!==deps.vault()||!vault.unlocked)return;
      periods=list;archive=document;loadedPeriod=selected;
      if(drafts.get(selected)?.note===(document?.current.note??''))drafts.delete(selected);
      const held=drafts.get(selected);
      draftConflict=!!held&&held.revision!==(document?.current.id??null);
      draft=held?.note??document?.current.note??'';comparison='unchecked';++comparisonRequest;loadFailed=false;chosenRevision=null;
      // Only decrypted in the unlocked session. Do not cache report bodies in browser storage.
      message='';
    }catch(error){if(id!==request||vault!==deps.vault()||!vault.unlocked)return;loadFailed=true;message=`取得失敗：${error instanceof Error?error.message:'レポートを取得できませんでした。'}`;}
    finally{if(id===request){if(vault!==deps.vault()||!vault.unlocked){reset();finishActivity('月次レポート');return;}busy=false;finishActivity('月次レポート');if(loadFailed)showActivity(message,'bad');render();if(!loadFailed&&archive)void compareSource();}}
      });
  }
  async function save(noteOnly=false):Promise<void>{
    return traceFinanceOperation('report-save',async()=>{
    const vault=deps.vault();if(!vault?.unlocked||busy||loadFailed||draftConflict||chosenRevision||loadedPeriod!==selected||(noteOnly&&(!archive||draft===archive.current.note)))return;
    const id=++request;let saved=false;busy=true;saving=true;message='';showActivity('月次レポートを保存中…','working');render();
    try{
      let result:MonthlyReportDocument;
      if(noteOnly){
        if(!archive)throw new Error('保存済みレポートがありません。');
        result=await vault.saveArchivedReportNote(selected,draft,archive.current.id);
      }else{
        const source=deps.source();if(!source)throw new Error('現在の集計データを確認できません。');
        const snapshot=reportSnapshot(selected,source);
        result=await vault.saveArchivedReport(snapshot,draft,archive?.current.id??null);
      }
      if(id!==request||vault!==deps.vault()||!vault.unlocked)return;
      archive=result;loadedPeriod=selected;draft=result.current.note;drafts.delete(selected);comparison='unchecked';++comparisonRequest;draftConflict=false;chosenRevision=null;
      if(!periods.includes(selected))periods=[selected,...periods].sort().reverse();
      saved=true;message='';showActivity(noteOnly?'メモを保存しました。':'月次レポートを保存しました。','good');
    }catch(error){if(id!==request||vault!==deps.vault()||!vault.unlocked)return;if(!noteOnly&&archive)comparison='unavailable';message=`${error instanceof CloudWriteUncertainError?'保存結果未確認':'保存失敗'}：${error instanceof Error?error.message:'保存できませんでした。'}`;showActivity(message,'bad');}
    finally{if(id===request){if(vault!==deps.vault()||!vault.unlocked){reset();finishActivity('月次レポート');return;}busy=false;saving=false;render();if(saved&&archive)void compareSource();}}
      });
  }
  async function compareSource():Promise<void>{
    const id=request,job=++comparisonRequest,vault=deps.vault(),revision=archive?.current,period=selected;
    if(!revision||chosenRevision||!vault?.unlocked)return;
    const valid=()=>id===request&&job===comparisonRequest&&vault===deps.vault()&&vault.unlocked&&
      revision===archive?.current&&period===selected&&!chosenRevision;
    comparison='checking';syncSourceNotice();
    try {
      const source=deps.source();if(!source)throw new Error('集計データ未取得');
      const snapshot=reportSnapshot(period,source);
      const hash=await snapshotHash(snapshot);
      if(!valid())return;
      // Source updates normally start a new comparison through render(). Also
      // reject a changed snapshot when a source update has not rendered yet.
      const latest=deps.source();
      if(!latest||JSON.stringify(reportSnapshot(period,latest))!==JSON.stringify(snapshot)){
        comparison='unavailable';syncSourceNotice();return;
      }
      comparison=hash===revision.sourceHash?'unchanged':'changed';syncSourceNotice();
    }catch {if(valid()){comparison='unavailable';syncSourceNotice();}}
  }
  function syncSourceNotice():void {
    const notice=container.querySelector<HTMLElement>('.reports-source-changed');
    if(!notice)return;
    notice.hidden=comparison!=='changed'&&comparison!=='unavailable'&&comparison!=='checking';
    notice.textContent=comparison==='changed'?'明細や設定に変更があります。レポートを更新できます。':
      comparison==='checking'?'現在の集計結果を確認中…':comparison==='unavailable'?'現在のデータとの一致を確認できません。':'';
  }
  function selectPeriod(period:string):boolean {
    // A cloud save must finish against its original month. Loading requests may
    // be superseded; revoke their busy state before starting the next request.
    if(saving)return false;
    ++request;
    if(busy){busy=false;finishActivity('月次レポート');}
    selected=period;archiveYear=period.slice(0,4);loadedPeriod='';archive=null;draft='';chosenRevision=null;
    message='';loadFailed=false;draftConflict=false;comparison='unchecked';++comparisonRequest;
    return true;
  }
  let renderedPeriod='';
  function render():void{
    const openDetails=renderedPeriod===selected?Array.from(container.querySelectorAll<HTMLDetailsElement>('details.reports-detail')).map(node=>node.open):[];
    renderedPeriod=selected;container.replaceChildren();
    if(!active()) {container.append(el('div','panel reports-locked','OneDrive保管庫を解除してください。'));return;}
    const top=el('div','reports-controls');
    const choosePeriod=(period:string)=>{if(selectPeriod(period))void fetch();};
    const nav=monthNavigator(selected,choosePeriod,{label:'レポート対象年月',min:'1900-02',max:'2199-12',today:today()});
    const refresh=button('最新を取得',()=>{if(refresh.isConnected)void fetch();});
    refresh.disabled=busy;
    if(saving)for(const control of nav.querySelectorAll<HTMLInputElement|HTMLButtonElement>('button,input'))control.disabled=true;
    top.append(nav,refresh);container.append(top,el('p','reports-purpose','保存時点の収支・メモを記録'));
    // Suggest preserving the previous month's point-in-time view after rollover;
    // never create an archive without a deliberate Save action.
    const current=today(),previous=(()=>{const [y,m]=current.split('-').map(Number);const d=new Date(Date.UTC(y!,m!-2,1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;})();
    if(!loadFailed&&loadedPeriod===selected&&selected===current&&!periods.includes(previous)){
      const reminder=el('div','reports-previous-reminder');
      const openPrevious=button(`${month(previous)}を開く`,()=>choosePeriod(previous),'monthly-link');openPrevious.disabled=saving;reminder.append(el('span','reports-muted','前月：未保存'),openPrevious);
      container.append(reminder);
    }
    // Keep failures beside the operation, even after the activity card expires.
    if(loadedPeriod!==selected){
      if(loadFailed){const error=el('p','reports-feedback-error',message);error.setAttribute('role','alert');container.append(error);}
      else if(busy){const pending=el('p','reports-muted','読み込み中…');pending.setAttribute('role','status');container.append(pending);}
      else void fetch();
      return;
    }
    if(periods.length){
      const years=[...new Set(periods.map(period=>period.slice(0,4)))].sort().reverse();
      if(!years.includes(archiveYear))archiveYear=years.includes(selected.slice(0,4))?selected.slice(0,4):years[0]!;
      const list=el('div','reports-period-list');
      list.append(el('span','reports-muted','保存済み'));
      const yearSelect=el('select','reports-year-select');
      yearSelect.setAttribute('aria-label','保存済みレポートの年');
      for(const year of years){
        const count=periods.filter(period=>period.startsWith(year+'-')).length;
        yearSelect.append(new Option(`${year}年（${count}か月）`,year));
      }
      yearSelect.value=archiveYear;yearSelect.disabled=saving;
      yearSelect.addEventListener('change',()=>{
        archiveYear=yearSelect.value;render();
        container.querySelector<HTMLSelectElement>('.reports-year-select')?.focus();
      });
      list.append(yearSelect);
      const months=el('div','reports-year-months');
      for(const period of periods.filter(period=>period.startsWith(archiveYear+'-'))){
        const item=button(`${Number(period.slice(5))}月`,()=>{if(selectPeriod(period))void fetch();},'reports-period-button'+(period===selected?' selected':''));
        item.setAttribute('aria-pressed',String(period===selected));item.disabled=saving;months.append(item);
      }
      list.append(months);container.append(list);
    }
    const control=section('メモ・保存');
    if(message){const error=el('p','reports-feedback-error',message);error.setAttribute('role','alert');container.append(error);}
    const state=archive?.current;
    if(state){const notice=el('p','reports-quality reports-source-changed');notice.setAttribute('role','status');control.body.append(notice);}
    if(draftConflict){
      control.body.append(el('p','reports-quality','別の端末でメモが更新されました。編集中の内容を確認してください。'));
      const discard=button('編集を破棄',async()=>{
        const id=request,period=selected,vault=deps.vault(),note=draft,revision=archive?.current.id;
        if(!await requestConfirmation({owner:confirmationOwner,title:'編集中のメモを破棄しますか？',message:'保存済みの最新レポートを表示します。',acceptLabel:'破棄する',destructive:true}))return;
        if(id!==request||period!==selected||vault!==deps.vault()||!vault?.unlocked||busy||!draftConflict||draft!==note||archive?.current.id!==revision)return;
        drafts.delete(selected);draftConflict=false;draft=archive?.current.note??'';render();
      });discard.disabled=busy;control.body.append(discard);
    }
    const noteLabel=el('label','reports-memo-label','メモ');noteLabel.htmlFor='reports-memo';control.body.append(noteLabel);
    const memo=el('textarea','reports-memo');memo.id='reports-memo';memo.rows=3;memo.maxLength=2000;memo.value=draft;memo.disabled=busy;
    memo.placeholder='今月の振り返り';memo.addEventListener('input',()=>{
      if(!memo.isConnected||busy||!active()||loadedPeriod!==selected)return;
      draft=memo.value;
      // Keep the original revision during a conflict; typing cannot approve a remote overwrite.
      if(!draftConflict&&draft===(archive?.current.note??''))drafts.delete(selected);
      else {const held=drafts.get(selected);drafts.set(selected,{note:draft,revision:held?held.revision:archive?.current.id??null});}
      const noteOnly=container.querySelector<HTMLButtonElement>('.reports-note-only');
      if(noteOnly)noteOnly.disabled=busy||loadFailed||draftConflict||draft===archive?.current.note;
    });
    control.body.append(memo);
    const submit=button(state?'レポートを更新':'レポートを作成',()=>{void save();},'save-action');
    submit.disabled=busy||loadFailed||draftConflict;control.body.append(submit);
    if(state){
      const noteOnly=button('メモのみ保存',()=>{void save(true);},'secondary-action reports-note-only');
      noteOnly.disabled=busy||loadFailed||draftConflict||draft===state.note;control.body.append(noteOnly);
    }
    const revision=chosenRevision?archive?.history.find(item=>item.id===chosenRevision)??state:state;
    let preview:ReportSnapshot|null=null;
    if(!revision){const source=deps.source();if(source)try{preview=reportSnapshot(selected,source);}catch{control.body.append(el('p','reports-feedback-error','プレビューを算出できません。集計データを確認してください。'));submit.disabled=true;}}
    const snapshot=revision?.snapshot??preview;
    if(snapshot){
      const heading=el('div','reports-revision-bar');heading.append(el('strong','',`${month(selected)} · ${chosenRevision?'過去の版':revision?'保存済み':'未保存プレビュー'}`));
      if(revision)heading.append(el('span','reports-muted',`保存：${formatDateTime(revision.savedAt,true)}`));
      if(chosenRevision){const latest=button('最新版へ戻る',()=>{if(busy)return;chosenRevision=null;comparison='unchecked';render();void compareSource();});latest.disabled=busy;heading.append(latest);}
      container.append(heading);
      container.append(reportMetrics(snapshot));
      if(snapshot.quality.length)container.append(el('p','reports-quality',snapshot.quality.join(' · ')));
      if(chosenRevision&&revision)container.append(el('p','reports-insight',revision.note||'この版のメモはありません。'));
      else container.append(control.root);
      const detail=el('details','reports-detail');detail.append(el('summary','','収支・口座の内訳'));
      const body=el('div','reports-detail-body');renderSnapshot(body,snapshot,false);detail.append(body);container.append(detail);
      if(snapshot.points)container.append(pointBenefitsSection('推定ポイント',snapshot.points,archivedPointCoverage(snapshot)));
    }else{container.append(el('p','reports-muted','未保存・集計データ未取得'),control.root);submit.disabled=true;}
    if(archive?.history.length){
      const history=el('details','reports-detail reports-history');
      history.append(el('summary','',`保存履歴（${archive.history.length}件）`));
      const inner=el('div','reports-history-body');
      for(const version of archive.history){const item=button(formatDateTime(version.savedAt,true),()=>{if(busy)return;chosenRevision=version.id;++comparisonRequest;comparison='unchecked';render();},'reports-history-button');item.disabled=busy;inner.append(item);}
      history.append(inner);container.append(history);
    }
    Array.from(container.querySelectorAll<HTMLDetailsElement>('details.reports-detail')).forEach((node,index)=>{node.open=openDetails[index]??false;});
    syncSourceNotice();
  }
  function openPeriod(period:string):void {
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))return;
    selectPeriod(period);
  }
  return {render:()=>{render();if(archive&&!busy)void compareSource();},openPeriod,reset,
    isBusy:()=>busy||confirmationPending(confirmationOwner),isDirty:()=>drafts.size>0};
}
