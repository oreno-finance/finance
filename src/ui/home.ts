import type { MonthlySource } from '../summary/monthly-summary.js';
import { pointBenefitsFromMonthlyReport } from '../summary/point-benefits.js';
import { pointBenefitsSection } from './point-benefits.js';
import { homeOverview, type HomeOverview } from '../home/overview.js';
import {mizuhoFundingStatus,mizuhoFundingStatusForMonth,mizuhoFundingDescription,type MizuhoFundingStatus} from '../home/mizuho-funding.js';
import { measureFinanceSync } from '../cloud/performance-diagnostics.js';
import type { HomeDestination } from '../home/action-items.js';
import type { AnalysisDrilldown } from './analysis-drilldown.js';

export interface HomeUi {render():void; reset():void}
export interface HomeDeps {
  source():MonthlySource|null;
  navigate(destination:HomeDestination,recordId?:string,drilldown?:AnalysisDrilldown):void;
  saveMizuhoFunding?(month:string,done:boolean):Promise<void>;
}
function element(tag:string,className='',content?:string):HTMLElement {
  const node=document.createElement(tag);if(className)node.className=className;
  if(content!==undefined)node.textContent=content;
  return node;
}
function link(label:string,handler:()=>void,cls=''):HTMLButtonElement {
  const button=document.createElement('button');button.type='button';button.className=cls;
  button.textContent=label;button.addEventListener('click',handler);return button;
}
const yen=(value:number|null)=>value===null?'未取得':`${value.toLocaleString('ja-JP')}円`;
const shortDay=(date:string)=>`${Number(date.slice(5,7))}/${Number(date.slice(8,10))}`;
function todayLocal():string {
  const now=new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
function confirmationLabel(value:string):string {
  return value==='provisional'?'暫定':value==='confirmed'?'確定':'未確認';
}
function metric(title:string,value:string,sub:string,go:()=>void,tone=''):HTMLElement {
  const button=link('',go,`home-metric ${tone}`);
  button.append(element('span','home-muted',title),element('strong','',value),element('small','home-muted',sub));
  return button;
}
function section(title:string):{section:HTMLElement;body:HTMLElement} {
  const box=element('section','panel home-section');
  box.append(element('h2','home-section-title',title));
  const body=element('div','home-section-body');box.append(body);
  return {section:box,body};
}
export function initHome(deps:HomeDeps):HomeUi {
  const root=document.getElementById('home-content');
  if(!root)throw new Error('ホーム画面が見つかりません。');
  let showAllActions=false;
  let fundingBusy=false,fundingError='';
  const go=(destination:HomeDestination,recordId?:string,drilldown?:AnalysisDrilldown)=>deps.navigate(destination,recordId,drilldown);
  function fundingPanel(status:MizuhoFundingStatus):HTMLElement {
    const section=element('section','panel home-funding'+(status.overdue?' home-funding-overdue':''));
    section.append(element('h2','home-section-title','みずほ楽天カードへの送金確認'));
    section.append(element('strong','home-funding-state',mizuhoFundingDescription(status)));
    const facts=element('p','home-muted home-funding-facts');
    facts.textContent=`${status.month.slice(5)}月の送金 · 送金目安：${status.dueDate??'請求明細待ち'} · `+
      `送金予定：${status.amount===null?'金額未取得':yen(status.amount)}`;
    section.append(facts);
    if(!status.billConfirmed)section.append(element('p','home-muted home-funding-facts',
      '確定済みのカード明細がないため、表示金額は未確定です。'));
    if(status.completed&&status.updatedAt)section.append(element('p','home-muted home-funding-facts',
      `確認日時：${new Date(status.updatedAt).toLocaleString('ja-JP')}`));
    const controls=element('div','home-funding-controls');
    if(status.periodOpen&&deps.saveMizuhoFunding){
      const button=link(fundingBusy?'保存中…':status.completed?'送金済みを取り消す':'送金済みにする',()=>{
        if(fundingBusy)return;
        if(status.completed&&!window.confirm('今月の送金済み記録を取り消しますか？'))return;
        fundingBusy=true;fundingError='';render();
        void deps.saveMizuhoFunding!(status.month,!status.completed)
          .catch(error=>{fundingError=error instanceof Error?error.message:'保存できませんでした。';})
          .finally(()=>{fundingBusy=false;render();});
      },status.completed?'home-funding-revoke':'home-funding-save');
      button.disabled=fundingBusy;controls.append(button);
    }
    if(controls.childElementCount)section.append(controls);
    if(fundingError){const error=element('p','home-funding-error',fundingError);error.setAttribute('role','alert');section.append(error);}
    section.append(element('small','home-muted home-funding-disclaimer',
      '送金済みは手動チェックです。楽天銀行・みずほ銀行の残高や振替実績は変更しません。'));
    return section;
  }
  function renderOverview(model:HomeOverview,source:MonthlySource):void {
    const {report,forecast,accounts,actions}=model;
    const metrics=element('div','home-metrics');
    const dataNotice=model.coverage==='missing'?'カード明細未取得':model.coverage==='needs-review'?'明細要確認':
      model.coverage==='provisional'?'暫定明細を含む':'登録済みの明細';
    metrics.append(
      metric('今月の収入',yen(report.income),report.incomeEstimates.length?'給与見込みを含む':'給与・入金',()=>go('summary')),
      metric('今月の支出',yen(model.outflow),dataNotice,()=>go('summary')),
      metric('収支見込み',report.cardOutflow===null?'算出不可':yen(report.monthlyBalance),report.cardOutflow===null?'カード明細未取得':report.income===null?'収入未取得':'登録済みの情報から算出',()=>go('summary'),
        report.monthlyBalance!==null&&report.monthlyBalance<0?'home-negative':'')
    );
    root!.append(metrics);
    const funding=mizuhoFundingStatus(source,report,model.today);
    // An unpaid previous month must remain visible after the calendar rolls
    // over. Only show this warning when there really was a card bill.
    if(model.priorFundingReport?.cardLines.some(card=>card.cardId==='rakuten-mizuho')){
      const previous=mizuhoFundingStatusForMonth(source,model.priorFundingReport,model.today);
      if(previous&&!previous.completed){
        const warning=fundingPanel(previous);
        warning.classList.add('home-funding-prior');
        root!.append(warning);
      }
    }
    if(funding)root!.append(fundingPanel(funding));
    if(report.nisaOutflow>0){
      const note=element('div','home-subtle-note',`支出にはNISA積立 ${yen(report.nisaOutflow)} を含みます（資産移動）。`);
      root!.append(note);
    }
    root!.append(pointBenefitsSection('今月獲得したポイント',measureFinanceSync('ui.home.points',
      ()=>pointBenefitsFromMonthlyReport(report,source))));
    const debitSection=section('次のカード引落');
    const next=forecast.debits.slice(0,3);
    if(!next.length)debitSection.body.append(element('p','home-empty','直近の登録済み引落予定はありません。'));
    for(const debit of next){
      const item=link('',()=>go('manage',debit.id),'home-list-row home-debit');
      const left=element('span','home-debit-main');
      left.append(element('strong','',(model.cardNames[debit.cardId]??debit.name)),element('small','home-muted',`${shortDay(debit.date)} · ${confirmationLabel(debit.confirmation)}`));
      const right=element('span','home-debit-amount');
      right.append(element('b','',yen(debit.amount)),element('small','home-muted',debit.accountId?
        debit.balanceReliable?`引落後 ${yen(debit.afterBalance)}`:'引落後残高は未確定':'引落口座未設定'));
      item.append(left,right);debitSection.body.append(item);
    }
    root!.append(debitSection.section);
    if(actions.length){
      const actionSection=section('確認すること');
      const visible=showAllActions?actions:actions.slice(0,6);
      for(const action of visible){
        const drilldown:AnalysisDrilldown|undefined=action.kind==='unclassified'
          ?{periods:[report.period],dimension:'category',value:'__unclassified',label:'未分類'}:undefined;
        const item=link('',()=>go(action.target,action.recordId,drilldown),`home-action home-${action.severity}`);
        const contents=element('span','home-action-copy');
        contents.append(element('strong','',action.title));
        if(action.detail)contents.append(element('small','home-muted',action.detail));
        item.append(element('span','home-action-dot'),contents,element('span','home-action-arrow','›'));
        actionSection.body.append(item);
      }
      if(actions.length>6)actionSection.body.append(link(showAllActions?'表示を減らす':`他${actions.length-6}件を表示`,()=>{
        showAllActions=!showAllActions;render();},'home-more'));
      root!.append(actionSection.section);
    }
    const accountSection=section('口座と資産');
    const list=element('div','home-account-grid');
    for(const account of accounts){
      const row=link('',()=>go('assets'),'home-account');
      const title=element('div','home-account-title');
      title.append(element('strong','',account.name),element('span','home-account-balance',yen(account.snapshot?.balance??null)));
      const date=account.snapshot?new Date(account.snapshot.observedAt).toLocaleDateString('ja-JP',{year:'numeric',month:'numeric',day:'numeric'}):null;
      row.append(title,element('small','home-muted',date?`確認 ${date}`:'残高未登録'));
      if(account.id!=='nisa')row.append(element('small','home-account-forecast',account.predictedReliable&&account.predicted!==null?
        `今後45日の見込み ${yen(account.predicted)}`:'予測残高は未確定'));
      list.append(row);
    }
    accountSection.body.append(list);root!.append(accountSection.section);
  }
  function render():void {
    return measureFinanceSync('ui.home.render',()=>{
    root!.replaceChildren();
    const title=document.getElementById('home-period-label');
    const today=todayLocal();
    if(title)title.textContent=`${Number(today.slice(5,7))}月の状況`;
    const source=deps.source();
    if(!source){
      const locked=element('section','panel home-locked');
      locked.append(element('h2','','OneDrive保管庫を開く'),element('p','home-muted','接続・ロック解除後にホームを表示します。'),
        link('設定を開く',()=>go('settings'),'home-primary'));
      root!.append(locked);return;
    }
    try{renderOverview(measureFinanceSync('ui.home.overview',()=>homeOverview(source,today)),source);}
    catch(error){
      const failed=element('section','panel home-locked');
      failed.append(element('h2','','ホームを表示できません'),element('p','home-muted',error instanceof Error?error.message:'データを確認してください。'),
        link('月別サマリーを開く',()=>go('summary'),'home-primary'));
      root!.append(failed);
    }
    });
  }
  return {render,reset:()=>{showAllActions=false;fundingBusy=false;fundingError='';render();}};
}
