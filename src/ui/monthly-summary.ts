/** Monthly summary view. DOM updates only; all financial figures are computed from vault snapshots. */
import { monthlyReport, prepareMonthlyReports, changePeriod, type MonthlyReport, type MonthlySource, type SummaryCard } from '../summary/monthly-summary.js';
import { PALETTE } from '../cloud/merchant-rules.js';
import { pointBenefitsFromMonthlyReport } from '../summary/point-benefits.js';
import { pointBenefitsSection } from './point-benefits.js';
import { bankTimeline, type BankEvent } from '../summary/bank-timeline.js';
import { bankChartData, type BankChartPoint } from './bank-chart-data.js';
import { ASSET_ACCOUNTS, type AssetAccountId } from '../cloud/assets.js';
import type { AnalysisDrilldown } from './analysis-drilldown.js';

export interface MonthlySummaryUi {render():void;reset():void;setPeriod(period:string):void}
export interface MonthlySummaryDeps {source():MonthlySource|null;openRecord(id:string):void;openDrilldown(request:AnalysisDrilldown):void;openReport?(period:string):void;openRecurring?(entryId:string):void;openFixedCost?(id:string):void;saveCardAccounts?(accounts:Record<string,'rakuten-bank'|'cash-savings'>):Promise<void>}
function element(tag:string, cls='',text?:string):HTMLElement{
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(text!==undefined)node.textContent=text;
  return node;
}
function yen(value:number|null):string{return value===null?'未取得':`${value.toLocaleString('ja-JP')}円`;}
function localPeriod():string{const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;}
function periodDisplay(value:string):string{return `${value.slice(0,4)}年${Number(value.slice(5))}月`;}
const employerName=(name:string):string=>name==='main'?'本業':name==='side'?'副業':name;
const kindName=(kind:string):string=>kind==='bonus'?'賞与':kind==='salary'?'給与':kind==='adjustment'?'調整':kind;
const accountName=(id:AssetAccountId|null):string=>ASSET_ACCOUNTS.find(a=>a.id===id)?.name??'口座未設定';
function line(parent:HTMLElement,name:string,value:string,action?:()=>void):void{
  const holder=element('div','monthly-line');
  const title=action?document.createElement('button'):document.createElement('span');
  title.textContent=name;
  if(action){title.className='monthly-link';(title as HTMLButtonElement).type='button';title.addEventListener('click',action);}
  const sum=element('strong','',value);
  title.title=name;
  holder.append(title,sum);parent.append(holder);
}
function scheduledLine(parent:HTMLElement,date:string,name:string,route:string,amount:number):void {
  const row=element('div','monthly-schedule-row');
  row.append(element('time','monthly-schedule-date',date.slice(5).replace('-','/')));
  const description=element('div','monthly-schedule-description');
  description.append(element('strong','',name),element('small','monthly-muted',route));
  row.append(description,element('b','monthly-schedule-amount',yen(amount)));parent.append(row);
}
function empty(parent:HTMLElement,text:string):void{parent.append(element('p','monthly-muted',text));}
function cardRows(root:HTMLElement,items:SummaryCard[],open:(id:string)=>void):void{
  if(!items.length){empty(root,'この月に該当するカード明細はありません。');return;}
  for(const item of items){
    const title=`${item.name} · ${item.paymentDate.replace(/-/g,'/')}（請求月 ${item.billingMonth??'不明'}）${item.confirmation==='provisional'?' · 暫定':''}`;
    line(root,title,yen(item.amount),()=>open(item.id));
  }
}
function statusText(report:MonthlyReport):string{
  if(!report.payrollReady)return 'Payroll未同期です。給与実績・前月給与の見込みを取得できません。設定からPayroll連携を確認してください。';
  if(report.incomeMissingRegular)return '本業給与の実績がなく、直近の通常給与からも見込みを算出できません。';
  if(report.income===null)return '給与実績・給与見込みがありません。収支額は算出できません。';
  if(report.incomeEstimates.length)return '給与の見込みと、登録済みの定期入出金予定を含めた月間収支です。';
  if(report.provisional.length)return '暫定カード請求・定期入出金予定を含む月間収支です。';
  return '給与実績・カード請求・定期入出金を集計した月間収支です。';
}
/** Interactive, read-only projection. No bank event or snapshot is modified here. */
function bankEventType(item:BankEvent):string {
  if(item.provisional)return '暫定';
  switch(item.kind){
    case 'card': return 'カード引落';
    case 'salary': return 'Payroll登録';
    case 'salary-estimate': return '給与見込み';
    case 'recurring': return '定期予定';
    case 'transfer': return '送金予測';
    case 'one-time': return '単発入出金';
  }
}
function bankChart(timeline:ReturnType<typeof bankTimeline>,period:string):HTMLElement|null {
  const chart=bankChartData(timeline,period);
  if(!chart)return null;
  const points=chart.series, selectable=chart.selectable;
  const values=points.map(point=>point.balance);
  let low=Math.min(0,...values),high=Math.max(0,...values);
  if(low===high){low-=10000;high+=10000;}
  const range=high-low,W=630,H=142,L=60,R=13,T=10,B=23;
  const x=(day:number)=>L+(day-1)/Math.max(1,chart.lastDay-1)*(W-L-R);
  const y=(value:number)=>T+(high-value)/range*(H-T-B);
  const ns='http://www.w3.org/2000/svg';
  const node=(tag:string,attrs:Record<string,string>)=>{const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e;};
  const svg=node('svg',{viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':'楽天銀行の月内予測残高。点をタップ、または下の日付ボタンで詳細を選べます。',class:'monthly-balance-svg'});
  for(let i=0;i<=2;i++){
    const val=low+range*i/2,yy=y(val);
    svg.append(node('line',{x1:String(L),x2:String(W-R),y1:String(yy),y2:String(yy),class:Math.abs(val)<range/8?'monthly-chart-zero':'monthly-chart-grid'}));
    const t=node('text',{x:String(L-9),y:String(yy+4),'text-anchor':'end',class:'monthly-chart-label'});
    t.textContent=`${Math.round(val/10000).toLocaleString('ja-JP')}万`;svg.append(t);
  }
  const path:string[]=[`M${x(points[0]!.day).toFixed(2)} ${y(points[0]!.balance).toFixed(2)}`];
  for(let i=1;i<points.length;i++){
    const point=points[i]!;
    path.push(`H${x(point.day).toFixed(2)}`,`V${y(point.balance).toFixed(2)}`);
  }
  svg.append(node('path',{d:path.join(' '),class:'monthly-chart-path',fill:'none'}));
  const markers:SVGElement[]=[],buttons:HTMLButtonElement[]=[];
  const section=element('div','monthly-chart');
  const plot=element('div','monthly-chart-plot');plot.append(svg);section.append(plot);
  const hint=element('p','monthly-chart-hint','グラフの点か日付を選択すると、入出金の内訳を確認できます。');
  section.append(hint);
  const dateList=element('div','monthly-chart-dates');dateList.setAttribute('role','group');dateList.setAttribute('aria-label','グラフの日付を選択');
  section.append(dateList);
  const detail=element('section','monthly-chart-detail');detail.setAttribute('aria-label','選択日の残高と入出金内訳');
  section.append(detail);
  function dateText(p:BankChartPoint):string{return `${Number(period.slice(0,4))}年${Number(period.slice(5))}月${p.day}日`;}
  function paintDetail(point:BankChartPoint):void {
    detail.replaceChildren();
    const isConfirmedBaseline=point.kind==='opening'&&point.date===timeline.startDay;
    const name=point.kind==='opening'?(isConfirmedBaseline?'確認済み残高の基準日':'月初時点の予測'):point.kind==='month-end'?'月末の予測':'登録済みの入出金反映後';
    const header=element('div','monthly-chart-detail-heading');
    header.append(element('strong','',dateText(point)),element('span','monthly-chart-detail-status',name));detail.append(header);
    const totals=element('div','monthly-chart-detail-totals');
    const total=(title:string,value:string,tone='')=>{
      const item=element('div','monthly-chart-detail-total');
      item.append(element('span','monthly-muted',title),element('strong',tone,value));totals.append(item);
    };
    total('この日の増減',`${point.delta>0?'+':''}${yen(point.delta)}`);
    total(isConfirmedBaseline?'登録した基準残高':'日末の予測残高',yen(point.balance),point.balance<0?'monthly-negative':'');
    detail.append(totals);
    if(point.items.length){
      const list=element('div','monthly-chart-detail-events');
      for(const item of point.items){
        const row=element('div','monthly-chart-detail-event');
        const description=element('div','monthly-chart-detail-event-name');
        description.append(element('strong','',item.title),element('small','monthly-muted',bankEventType(item)));
        row.append(description,element('b','',`${item.amount>0?'+':''}${yen(item.amount)}`));list.append(row);
      }
      detail.append(list);
    }else{
      detail.append(element('p','monthly-muted',isConfirmedBaseline?'この日は登録済みの残高を基準にしています。':'この日付に登録された入出金はありません。'));
    }
    detail.append(element('p','monthly-chart-caveat','予測残高は登録情報による計算値です。銀行の実際の残高を取得しているわけではありません。'));
  }
  let selected=-1;
  function choose(index:number,focus=false):void {
    if(index<0||index>=selectable.length)return;
    selected=index;
    for(let i=0;i<markers.length;i++){
      markers[i]!.classList.toggle('is-selected',i===index);
    }
    for(let i=0;i<buttons.length;i++){
      buttons[i]!.setAttribute('aria-pressed',String(i===index));
      if(i===index&&focus)buttons[i]!.focus();
    }
    paintDetail(selectable[index]!);
  }
  for(const [index,point] of selectable.entries()){
    const group=node('g',{class:'monthly-chart-marker'});
    group.append(node('circle',{cx:String(x(point.day)),cy:String(y(point.balance)),r:'4',class:'monthly-chart-point'}));
    const hit=node('circle',{cx:String(x(point.day)),cy:String(y(point.balance)),r:'17',class:'monthly-chart-hit'});
    const title=node('title',{});title.textContent=`${dateText(point)}：${yen(point.balance)}。タップして詳細を表示`;
    group.append(hit,title);group.addEventListener('click',()=>choose(index));svg.append(group);markers.push(group);
    const button=element('button','monthly-chart-date') as HTMLButtonElement;
    button.type='button';button.textContent=`${point.day}日`;
    button.setAttribute('aria-label',`${dateText(point)}の入出金内訳`);
    button.setAttribute('aria-pressed','false');
    button.addEventListener('click',()=>choose(index));
    button.addEventListener('keydown',(event:KeyboardEvent)=>{
      const next=event.key==='ArrowRight'||event.key==='ArrowDown'?index+1:event.key==='ArrowLeft'||event.key==='ArrowUp'?index-1:event.key==='Home'?0:event.key==='End'?buttons.length-1:null;
      if(next!==null){event.preventDefault();choose(Math.max(0,Math.min(buttons.length-1,next)),true);}
    });
    dateList.append(button);buttons.push(button);
  }
  for(const day of [1,Math.ceil(chart.lastDay/2),chart.lastDay]){
    const t=node('text',{x:String(x(day)),y:String(H-10),'text-anchor':day===1?'start':day===chart.lastDay?'end':'middle',class:'monthly-chart-label'});
    t.textContent=`${day}日`;svg.append(t);
  }
  // Prefer a real event over the synthetic month-end marker on first display.
  const defaultIndex=selectable.map(p=>p.kind).lastIndexOf('event');
  choose(defaultIndex>=0?defaultIndex:selectable.length-1);
  return section;
}
export function initMonthlySummary(deps:MonthlySummaryDeps):MonthlySummaryUi {
  const reportOpen=document.getElementById('monthly-report-open');
  reportOpen?.addEventListener('click',()=>deps.openReport?.(period));

  let period=localPeriod();
  const picker=document.getElementById('monthly-period') as HTMLInputElement;
  const main=document.getElementById('monthly-content') as HTMLElement;
  const label=document.getElementById('monthly-heading-period') as HTMLElement;
  const $=(id:string)=>document.getElementById(id) as HTMLElement;
  picker.value=period;
  const go=(next:string)=>{period=next;picker.value=next;render();};
  $('monthly-prev').addEventListener('click',()=>go(changePeriod(period,-1)));
  $('monthly-next').addEventListener('click',()=>go(changePeriod(period,1)));
  $('monthly-today').addEventListener('click',()=>go(localPeriod()));
  picker.addEventListener('change',()=>{if(/^\d{4}-(0[1-9]|1[0-2])$/.test(picker.value))go(picker.value);else picker.value=period;});
  function metric(grid:HTMLElement,title:string,value:string,detail:string,tone=''):void{
    const box=element('section',`monthly-metric ${tone}`);
    box.append(element('span','monthly-metric-label',title),element('strong','monthly-metric-value',value),element('small','monthly-muted',detail));grid.append(box);
  }
  function section(title:string):{box:HTMLElement;body:HTMLElement}{
    const box=element('section','panel monthly-panel');
    box.append(element('h2','monthly-section-heading',title));
    const body=element('div','monthly-section-body');box.append(body);main.append(box);
    return {box,body};
  }
  function render():void {
    label.textContent=periodDisplay(period);
    main.replaceChildren();
    const source=deps.source();
    if(source===null){main.append(element('div','panel monthly-lock','月別サマリーを見るにはOneDrive保管庫のロック解除が必要です。'));return;}
    let report:MonthlyReport,prev:MonthlyReport;
    try{const prepared=prepareMonthlyReports(source.records);
      report=monthlyReport(period,source,prepared);prev=monthlyReport(changePeriod(period,-1),source,prepared);}
    catch(err){main.append(element('div','panel monthly-lock',`集計できませんでした：${err instanceof Error?err.message:'データエラー'}`));return;}
    const grid=element('div','monthly-metrics');main.append(grid);
    metric(grid,report.incomeEstimates.length?'月間収入（給与見込み含む）':'月間収入',yen(report.income),
      `定期入金 ${yen(report.recurringIncome)} · 単発入金 ${yen(report.oneTimeIncome)}`);
    metric(grid,'カード引落予定額',yen(report.cardOutflow),report.provisional.length?'暫定明細を含む · 支払日基準':'登録済み明細 · 支払日基準');
    metric(grid,'定期・単発支出',yen(report.recurringExpense+report.oneTimeExpense),`定期 ${yen(report.recurringExpense)} · 単発 ${yen(report.oneTimeExpense)}`);
    metric(grid,'月間収支',report.monthlyBalance===null?'算出不可':yen(report.monthlyBalance),
      '収入 − カード − 定期・単発支出',report.monthlyBalance!==null?(report.monthlyBalance>=0?'monthly-positive':'monthly-negative'):'');
    const delta=report.monthlyBalance===null||prev.monthlyBalance===null?null:report.monthlyBalance-prev.monthlyBalance;
    const alert=element('div','monthly-alert');alert.append(element('strong','',statusText(report)));
    alert.append(element('p','',`前月比：${delta===null?'比較不可':yen(delta)} · 内部振替は月間収支に含めません。`));
    if(report.cardOutflow===null)alert.append(element('p','', 'この月に集計できるカード明細がありません（未登録または要修正）。計算上の引落額は0円として扱いますが、実際に0円とは確認できていません。'));
    if(report.recurringCardOverlap){
      alert.prepend(element('strong','monthly-overlap-warning','要確認：カードと定期支出が重複している可能性があります。収支は両方を含む暫定的な登録額です。'));
      alert.append(element('p','',`名称・金額が一致する定期支出が${report.recurringCardOverlap}件あります。実際の支払いを照合し、二重登録なら支出の登録内容を修正してください。`));
      for(const entry of report.recurringLines.filter(item=>item.cardOverlap)){
        const open=entry.entryId.startsWith('cash:')
          ?(deps.openFixedCost?()=>deps.openFixedCost!(entry.entryId.slice(5)):undefined)
          :(deps.openRecurring?()=>deps.openRecurring!(entry.entryId):undefined);
        line(alert,`確認・修正：${entry.name}（${entry.date}）`,yen(entry.amount),open);
      }
    }
    if(report.recurringSalaryExcluded)alert.append(element('p','',`給与に見える定期収入${report.recurringSalaryExcluded}件は、Payrollとの二重計上を防ぐため除外しました。`));
    main.append(alert);
    main.append(pointBenefitsSection('獲得ポイント',pointBenefitsFromMonthlyReport(report,source)));
    // Bank cash flow is separate from whole-household monthly income/expense.
    // It starts from a manually confirmed bank balance, never a fabricated zero.
    const bank=section('楽天銀行の残高推移');
    const localDate=new Date();
    const localToday=`${localDate.getFullYear()}-${String(localDate.getMonth()+1).padStart(2,'0')}-${String(localDate.getDate()).padStart(2,'0')}`;
    const timeline=bankTimeline(period,source,localToday);
    const bankroll=element('div','monthly-bank-overview');bank.body.append(bankroll);
    const bankMetric=(title:string,value:string,tone:string)=>{
      const card=element('div',`monthly-bank-metric ${tone}`);
      card.append(element('span','monthly-muted',title),element('strong','',value));bankroll.append(card);
    };
    bankMetric('月末の予測残高',yen(timeline.endBalance),timeline.endBalance!==null&&timeline.endBalance<0?'monthly-negative':'');
    bankMetric('期間内の最低残高',yen(timeline.minimum),timeline.minimum!==null&&timeline.minimum<0?'monthly-negative':'');
    const chart=bankChart(timeline,period);if(chart)bank.body.append(chart);
    if(timeline.warning)bank.body.append(element('p','monthly-bank-notice',timeline.warning));
    if(timeline.missingCardAccounts.length)bank.body.append(element('p','monthly-bank-notice',`引落口座未設定：${timeline.missingCardAccounts.join('、')}。口座管理で設定できます。`));
    if(timeline.minimum!==null&&timeline.minimum<0)bank.body.append(element('p','monthly-bank-danger','引落予定に対して残高不足となる日があります。'));
    if(timeline.days.length){
      const allDays=element('details','monthly-bank-all');
      allDays.append(element('summary','','すべての入出金予定を表示'));
      const timelineList=element('div','monthly-bank-days');allDays.append(timelineList);bank.body.append(allDays);
      for(const day of timeline.days){
        const item=element('div','monthly-bank-day');
        const date=element('div','monthly-bank-day-date',day.date.slice(5).replace('-','/'));
        const descriptions=element('div','monthly-bank-events');
        for(const event of day.items){
          const line=element('div','monthly-bank-event');
          line.append(element('span','',event.title+(event.provisional?'（暫定）':'')),element('b',event.amount<0?'monthly-bank-minus':'',`${event.amount>0?'+':''}${yen(event.amount)}`));
          descriptions.append(line);
        }
        const balance=element('strong',day.balance<0?'monthly-bank-balance monthly-negative':'monthly-bank-balance',yen(day.balance));
        item.append(date,descriptions,balance);timelineList.append(item);
      }

    }else if(timeline.startDay)empty(bank.body,'基準残高以降、この月末までの登録済み入出金はありません。');
    const grid2=element('div','monthly-paired monthly-triptych');main.append(grid2);
    const addPair=(title:string)=>{
      const box=element('section','panel monthly-panel');box.append(element('h2','monthly-section-heading',title));
      const body=element('div','monthly-section-body');box.append(body);grid2.append(box);return body;
    };
    const incomes=addPair('収入の内訳（給与・定期入金）');
    if(!report.payrollReady)empty(incomes,'Payroll未同期。設定から連携状態を確認してください。');
    else if(!report.incomeLines.length && !report.incomeEstimates.length)empty(incomes,'この月の公開済み給与実績はありません。');
    else for(const row of [...report.incomeLines].sort((a,b)=>a.date.localeCompare(b.date))){
      line(incomes,`${employerName(row.employer)} · ${kindName(row.kind)} · ${row.date.replace(/-/g,'/')}`,yen(row.amount));
    }
    for(const estimate of report.incomeEstimates){ /* finance-v149 */
      line(incomes,`本業 · 給与見込み（${estimate.sourcePeriod.slice(5)}月実績）`,yen(estimate.amount));
    }
    for(const item of report.oneTimeLines.filter(e=>e.kind==='income'))line(incomes,`${item.name} · ${item.date.replace(/-/g,'/')} · ${item.status==='planned'?'予定':'実行済み'}`,yen(item.amount));
    for(const item of report.recurringLines.filter(e=>e.kind==='income'))line(incomes,`${item.name} · ${accountName(item.toAccountId)}入金予定 · ${item.date.replace(/-/g,'/')}`,yen(item.amount));
    if(report.payrollReady&&report.payrollSyncedAt)incomes.append(element('p','monthly-muted',`Payroll最終同期：${new Date(report.payrollSyncedAt).toLocaleString('ja-JP')}`));
    const cards=addPair('カード別引落予定額');
    cardRows(cards,[...report.cardLines].sort((a,b)=>a.paymentDate.localeCompare(b.paymentDate)||a.name.localeCompare(b.name,'ja')),deps.openRecord);
    if(report.cardOutflow!==null){line(cards,'カード合計',yen(report.cardOutflow));line(cards,'うちNISA積立（資産移動）',yen(report.nisaOutflow));line(cards,'NISA積立を除いた金額',yen(report.livingOutflow));}
    const debits={body:addPair('定期入出金の予定')};
    const expenseItems=report.recurringLines.filter(e=>e.kind==='expense');
    if(!report.recurringLines.length && !report.oneTimeLines.length)empty(debits.body,'この月の入出金予定はありません。');
    for(const item of expenseItems)scheduledLine(debits.body,item.date,item.name,item.entryId.startsWith('cash:')?'現金支出予定':`${accountName(item.fromAccountId)} → 支出`,item.amount);
    if(expenseItems.length)line(debits.body,'定期支出合計',yen(report.recurringExpense));
    const transfers=report.recurringLines.filter(e=>e.kind==='transfer');
    for(const item of transfers)scheduledLine(debits.body,item.date,item.name,`${accountName(item.fromAccountId)} → ${accountName(item.toAccountId)}`,item.amount);
    for(const item of report.oneTimeLines.filter(e=>e.kind!=='income')){
      const route=item.kind==='transfer'?`${accountName(item.fromAccountId)} → ${accountName(item.toAccountId)}`:
        `${accountName(item.fromAccountId)} · ${item.kind==='withdrawal'?'現金引出':'支出'}`;
      scheduledLine(debits.body,item.date,`${item.name}（${item.status==='planned'?'予定':'実行済み'}）`,route,item.amount);
    }
    if(transfers.length)debits.body.append(element('p','monthly-muted','口座間振替は月間収支に含めません。'));
    // Keep the two insights in one responsive row. /* finance-v147 */
    const insightGrid=element('div','monthly-insights');main.append(insightGrid);
    const insightSection=(title:string)=>{
      const result=section(title);
      insightGrid.append(result.box);
      return result;
    };
    const category=insightSection('カテゴリー別支出（カード＋定期支出）');
    if(!report.categories.length && !report.nisaOutflow)empty(category.body,'分類できるカード・定期支出がありません。');
    const largest=Math.max(1,...report.categories.map(item=>Math.max(0,item.amount)),Math.max(0,report.nisaOutflow));
    for(const item of report.categories){
      const wrapper=element('div','monthly-bar-line');
      const head=element('div','monthly-bar-head');
      const categoryLink=element('button','monthly-link monthly-ranking-link',`${item.name}（${item.count}件）`) as HTMLButtonElement;
      categoryLink.type='button';categoryLink.title=`${item.name}の明細と定期支出内訳を見る`;
      categoryLink.addEventListener('click',()=>deps.openDrilldown({dimension:'category',value:item.id,label:item.name,periods:[period]}));
      head.append(categoryLink,element('strong','',yen(item.amount)));
      const track=element('div','monthly-bar-track'),fill=element('div','monthly-bar-fill');
      fill.style.width=`${Math.max(0,item.amount)/largest*100}%`;
      const color=PALETTE.find(p=>p.id===item.color)?.hex;
      if(color)fill.style.backgroundColor=color;
      track.append(fill);wrapper.append(head,track);category.body.append(wrapper);
    }
    if(report.nisaOutflow!==0){
      const wrapper=element('div','monthly-bar-line');
      const head=element('div','monthly-bar-head');head.append(element('span','', 'NISA積立（資産移動）'),element('strong','',yen(report.nisaOutflow)));
      const track=element('div','monthly-bar-track'),fill=element('div','monthly-bar-fill');fill.style.width=`${Math.max(0,report.nisaOutflow)/largest*100}%`;fill.style.backgroundColor='#43A778';track.append(fill);wrapper.append(head,track);category.body.append(wrapper);
    }
    category.body.append(element('p','monthly-muted','NISAはカード資金流出に含め、生活費カテゴリーの集計からは除外しています。'));
    const merchants=insightSection('カード利用先ランキング');
    if(!report.merchants.length)empty(merchants.body,'対象となる利用先はありません。');
    else for(const [index,item] of report.merchants.slice(0,10).entries()){
      line(merchants.body,`${index+1}. ${item.name}（${item.count}件）`,yen(item.amount),
        ()=>deps.openDrilldown({dimension:'merchant',value:item.name,label:item.name,periods:[period]}));
    }
    const quality=section('データの確認');
    const problemCount=report.issues.filter(item=>item.month===period).length;
    line(quality.body,'集計対象外の明細',`${problemCount}件`);
    line(quality.body,'支払日が不明な明細（全期間）',`${report.issues.filter(item=>item.month===null).length}件`);
    line(quality.body,'暫定明細（集計に含む）',`${report.provisional.length}件`);
    line(quality.body,'確定状態が不明な明細',`${report.unknownConfirmationCount}件`);
    line(quality.body,'未分類の取引',`${report.unclassifiedCount}件`);
    line(quality.body,'定期入出金予定',`${report.recurringLines.length}件`);
    line(quality.body,'カードとの重複要確認',`${report.recurringCardOverlap}件`);
    if(report.provisional.length){quality.body.append(element('h3','monthly-subheading','暫定明細（集計済み・後で金額が変動する可能性あり）'));cardRows(quality.body,report.provisional,deps.openRecord);}
    if(report.issues.length){
      quality.body.append(element('h3','monthly-subheading','修正が必要な明細'));
      for(const issue of report.issues){
        const row=element('div','monthly-issue');
        const action=document.createElement('button');action.type='button';action.className='monthly-link';action.textContent=issue.title;
        action.addEventListener('click',()=>deps.openRecord(issue.id));
        row.append(action,element('small','monthly-muted',issue.reason));quality.body.append(row);
      }
    }
    line(quality.body,'単発入出金',`${report.oneTimeLines.length}件`);
  }
  return {render,setPeriod:(next:string)=>{if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(next))throw new Error("年月が不正です。");go(next);},reset:()=>{period=localPeriod();picker.value=period;main.replaceChildren();label.textContent=periodDisplay(period);}};
}
