import {requestConfirmation,confirmationPending,cancelConfirmation} from './modal.js';
import {monthlyReport} from '../summary/monthly-summary.js';
import {formatYen as sharedYen,formatSignedYen,formatShortDate,formatDateTime} from './formatters.js';
import type { MonthlySource } from '../summary/monthly-summary.js';
import type { MizuhoBillSnapshot } from '../cloud/assets.js';
import { pointBenefitsFromMonthlyReport } from '../summary/point-benefits.js';
import { pointBenefitsSection,pointCoverage } from './point-benefits.js';
import { homeOverview, type HomeOverview } from '../home/overview.js';
import {mizuhoFundingStatus,mizuhoFundingStatusForMonth,type MizuhoFundingStatus} from '../home/mizuho-funding.js';
import { measureFinanceSync } from '../cloud/performance-diagnostics.js';
import type { HomeDestination } from '../home/action-items.js';
import type { AnalysisDrilldown } from './analysis-drilldown.js';

export interface HomeUi {render():void; reset():void;isBusy():boolean}
export interface HomeDeps {
  source():MonthlySource|null;
  navigate(destination:HomeDestination,recordId?:string,drilldown?:AnalysisDrilldown):void;
  openCardSettings?():void;
  saveMizuhoFunding?(month:string,done:boolean,snapshot?:MizuhoBillSnapshot):Promise<void>;
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
const yen=(value:number|null)=>sharedYen(value,0,'未取得');
const shortDay=formatShortDate;
function todayLocal():string {
  const now=new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
function confirmationLabel(value:string):string {
  return value==='provisional'?'暫定':value==='confirmed'?'確定':'未確認';
}
function metric(title:string,value:string,sub:string,go:()=>void,tone=''):HTMLElement {
  const button=link('',go,`home-metric ${tone}`);
  button.append(element('span','home-muted',title),element('strong','',value));if(sub)button.append(element('small','home-muted',sub));
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
  const confirmationOwner={};let epoch=0;
  const go=(destination:HomeDestination,recordId?:string,drilldown?:AnalysisDrilldown)=>deps.navigate(destination,recordId,drilldown);
  function fundingPanel(status:MizuhoFundingStatus):HTMLElement {
    const section=element('section','panel home-funding'+(status.overdue&&status.billConfirmed?' home-funding-overdue':''));
    const head=element('div','home-funding-heading');
    const state=status.changedSinceCheck?'要再確認':status.completed?'確認済み':!status.periodOpen?'12日から確認':!status.billConfirmed?'明細未確定':status.overdue?'期限超過':'未確認';
    head.append(element('h2','home-section-title','みずほ送金'),element('strong','home-funding-state',state));
    section.append(head,element('p','home-muted home-funding-facts',`${Number(status.month.slice(5))}月分 · ${status.dueDate?shortDay(status.dueDate)+'まで':'期限未取得'}${!status.billConfirmed&&state!=='明細未確定'?' · 明細未確定':''}`),
      element('strong','home-funding-amount',yen(status.amount)));
    if(status.changedSinceCheck){
      const warning=element('p','home-funding-error',
        '以前の「送金済み」確認は無効です。請求額・支払日・送金予定額を確認し、不足額があれば送金してください。');
      warning.setAttribute('role','alert');section.append(warning);
    }
    if(status.completed&&status.updatedAt)section.append(element('p','home-muted home-funding-facts',
      `確認日時：${formatDateTime(status.updatedAt,true)}`));
    const controls=element('div','home-funding-controls');
    if(status.periodOpen&&deps.saveMizuhoFunding&&(status.completed||status.billConfirmed)){
      const button=link(fundingBusy?'保存中…':status.completed?'送金済みを取り消す':status.changedSinceCheck?'再確認して送金済みにする':status.overdue?'送金済みを記録':'送金済みにする',async()=>{
        if(fundingBusy||confirmationPending())return;
        if(!status.completed&&(!status.billConfirmed||!status.billSnapshot))return;
        const started=epoch,baseline=JSON.stringify(status);
        const current=()=>{
          const source=deps.source();if(!source)return null;
          const today=todayLocal();
          try{return mizuhoFundingStatusForMonth(source,monthlyReport(status.month,source),today);}catch{return null;}
        };
        if(JSON.stringify(current())!==baseline)return;
        const snapshot=status.billSnapshot;
        if(!await requestConfirmation({owner:confirmationOwner,title:status.completed?'送金済み記録を取り消しますか？':'送金済みとして記録しますか？',
          message:status.completed?`${status.month}分の送金済み記録を取り消します。`:
            `${status.month}分の確定請求額 ${yen(snapshot!.billAmount)}、支払日 ${snapshot!.paymentDate}、送金目安 ${yen(snapshot!.transferAmount)}。\n実際の送金完了後に記録してください。残高や振替実績は変更されません。`,
          acceptLabel:status.completed?'取り消す':'送金済みを記録',destructive:status.completed}))return;
        if(started!==epoch||fundingBusy||!deps.source())return;
        if(JSON.stringify(current())!==baseline){fundingError='請求内容または送金記録が変更されました。再確認してください。';render();return;}
        fundingBusy=true;fundingError='';render();
        try{await deps.saveMizuhoFunding!(status.month,!status.completed,status.completed?undefined:snapshot??undefined);}
        catch(error){if(started===epoch)fundingError=error instanceof Error?error.message:'保存できませんでした。';}
        finally{fundingBusy=false;if(started===epoch)render();}
      },status.completed?'home-funding-revoke':'home-funding-save');
      button.disabled=fundingBusy||(!status.completed&&!status.billConfirmed);controls.append(button);
    }
    if(status.periodOpen&&!status.billConfirmed&&!status.completed){
      const source=deps.source();
      const bills=source?.records.filter(record=>record.statement.cardId==='rakuten-mizuho'&&record.statement.paymentDate?.slice(0,7)===status.month)??[];
      controls.append(link(bills.length===1?'明細を確認':bills.length?'明細管理':'明細を取り込む',()=>go(bills.length?'manage':'import',bills.length===1?bills[0]!.id:undefined),'home-funding-review'));
      section.append(element('p','home-muted home-funding-facts','請求明細の確定後に送金済みを記録できます。'));
    }
    if(controls.childElementCount)section.append(controls);
    if(fundingError){const error=element('p','home-funding-error',fundingError);error.setAttribute('role','alert');section.append(error);}
    return section;
  }
  function renderOverview(model:HomeOverview,source:MonthlySource):void {
    const {report,forecast,accounts,actions}=model;
    const metrics=element('div','home-metrics');
    const dataNotice=model.coverage==='missing'?'カード明細未取得':model.coverage==='partial'?(report.cardLines.length?'一部カードのみ確認済み':'一部未取得・銀行支出は反映'):model.coverage==='needs-review'?'明細要確認':
      model.coverage==='provisional'?'暫定明細を含む':'';
    metrics.append(
      metric('今月の収入',yen(report.income),report.incomeEstimates.length||report.recurringIncome>0?'給与見込み・入金予定を含む':'',()=>go('summary')),
      metric('今月の支出',yen(model.outflow),[dataNotice,report.nisaOutflow>0?`NISA積立 ${yen(report.nisaOutflow)} を含む`:''].filter(Boolean).join(' · '),()=>go('summary')),
      metric('収支見込み',report.monthlyBalance===null?'算出不可':yen(report.monthlyBalance),report.cardOutflow===null?'カード明細未取得':report.income===null?'収入未取得':dataNotice,()=>go('summary'),
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
    if(actions.length){
      const actionSection=section('確認すること');
      const visible=showAllActions?actions:actions.slice(0,6);
      for(const action of visible){
        const drilldown:AnalysisDrilldown|undefined=action.kind==='unclassified'
          ?{periods:[report.period],dimension:'category',value:'__unclassified',label:'未分類'}:undefined;
        const item=link('',()=>{if(action.kind==='card-account'&&deps.openCardSettings)deps.openCardSettings();else go(action.target,action.recordId,drilldown);},`home-action home-${action.severity}`);
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
    const debitSection=section('次の入出金');
    const movementRows:Array<{date:string;node:HTMLElement}>=[];
    const next=forecast.debits.slice(0,3);

    for(const debit of next){
      const item=debit.estimated?element('div','home-list-row home-debit'):link('',()=>go('manage',debit.id),'home-list-row home-debit');
      const left=element('span','home-debit-main');
      left.append(element('strong','',debit.estimated?debit.name:(model.cardNames[debit.cardId]??debit.name)),element('small','home-muted',`${shortDay(debit.date)} · ${debit.estimated?'固定費から推定・未確定':confirmationLabel(debit.confirmation)}`));
      const right=element('span','home-debit-amount');
      right.append(element('b','',formatSignedYen(-debit.amount)),element('small','home-muted',debit.accountId?
        debit.balanceReliable?`引落後 ${yen(debit.afterBalance)}`:'引落後残高は未確定':'引落口座未設定'));
      item.append(left,right);movementRows.push({date:debit.date,node:item});
    }
    // Use the same forecast events as the account cards. Card events already
    // have their own rows above; transfers are shown per affected account.
    for(const event of forecast.upcomingMovements.slice(0,3)){
      const item=link('',()=>go('assets'),'home-list-row home-debit');
      const left=element('span','home-debit-main');
      const account=accounts.find(a=>a.id===event.accountId);
      left.append(element('strong','',event.title),element('small','home-muted',`${shortDay(event.date)} · ${event.route?event.route+' · '+(event.amount<0?'出金':'入金'):account?.name??'口座'} · ${event.kind==='salary'?'給与実績':event.kind==='salary-estimate'||event.movementStatus==='estimated'?'見込み':event.movementStatus==='done'?'実行済み':'予定'}`));
      const right=element('span','home-debit-amount');
      right.append(element('b','',formatSignedYen(event.amount)));
      item.append(left,right);movementRows.push({date:event.date,node:item});
    }
    if(!movementRows.length)debitSection.body.append(element('p','home-empty','直近の登録済み入出金予定はありません。'));
    movementRows.sort((a,b)=>a.date.localeCompare(b.date));
    debitSection.body.append(...movementRows.map(row=>row.node));
    root!.append(debitSection.section);
    const accountSection=section('口座と資産');
    const list=element('div','home-account-grid');
    for(const account of accounts){
      const row=link('',()=>go('assets'),'home-account');
      const title=element('div','home-account-title');
      title.append(element('strong','',account.name),element('span','home-account-balance',yen(account.snapshot?.balance??null)));
      const date=account.snapshot?formatDateTime(account.snapshot.observedAt).split(' ')[0]:null;
      row.append(title,element('small','home-muted',date?`確認 ${date}`:'残高未登録'));
      if(account.id!=='nisa')row.append(element('small','home-account-forecast',account.predictedReliable&&account.predicted!==null?
        `今後45日の見込み ${yen(account.predicted)}`:'予測残高は未確定'));
      list.append(row);
    }
    accountSection.body.append(list);root!.append(accountSection.section);
    root!.append(pointBenefitsSection('今月の推定ポイント',measureFinanceSync('ui.home.points',
      ()=>pointBenefitsFromMonthlyReport(report,source)),pointCoverage([report])));

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
  return {render,isBusy:()=>fundingBusy||confirmationPending(confirmationOwner),reset:()=>{epoch++;cancelConfirmation(confirmationOwner);showAllActions=false;fundingError='';render();}};
}
