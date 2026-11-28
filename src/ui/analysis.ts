import {statementPeriod} from '../models/types.js';
import {DATA_STATUS,financialStatusClass,formatYen as sharedYen,formatSignedYen,formatMonth} from './formatters.js';
/** Finance P1-A: in-browser multi-month / annual analysis, no additional persistence. */
import {annualAnalytics,comparableDelta,priorYearAnalytics,rollingAnalytics,cumulativeBalances,balanceWithoutNisa,type AnalysisDimension,type AnalysisMonth,type PeriodAnalytics} from '../analysis/period-analytics.js';
import type {MonthlySource} from '../summary/monthly-summary.js';
import type {AnalysisReportContext} from './analysis-drilldown.js';
import type {AnalysisDrilldown} from './analysis-drilldown.js';
import {monthNavigator,yearNavigator,localMonth} from './period-navigator.js';
import { periodPointBenefitsFromReports } from '../summary/point-benefits.js';
import { pointBenefitsSection,pointCoverage } from './point-benefits.js';
import { measureFinanceSync } from '../cloud/performance-diagnostics.js';

export interface AnalysisUi {render():void;reset():void}
export interface AnalysisDeps {source():MonthlySource|null;openMonth(period:string):void;openDrilldown(request:AnalysisDrilldown,context:AnalysisReportContext|null):void;openSettings():void}
type Mode='month'|'year';
const formatYen=(amount:number|null,digits=0)=>sharedYen(amount,digits,DATA_STATUS.missing);
const signedYen=formatSignedYen;
const monthLabel=(period:string)=>`${Number(period.slice(5))}月`;
const labelYearMonth=formatMonth;
const currentLocal=localMonth;
function el<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text?:string):HTMLElementTagNameMap[K]{
  const node=document.createElement(tag);if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}
function action(text:string,handler:()=>void,className=''):HTMLButtonElement{
  const button=el('button',className,text);button.type='button';button.addEventListener('click',handler);return button;
}
function title(text:string):HTMLElement{return el('h2','analysis-heading',text);}
function panel(heading:string):{root:HTMLElement;body:HTMLElement}{
  const root=el('section','panel analysis-panel');root.append(title(heading));
  const body=el('div','analysis-panel-body');root.append(body);return {root,body};
}
const quality=(month:AnalysisMonth):string=>month.coverage==='missing'?DATA_STATUS.missing:month.coverage==='partial'?'一部未取得':month.coverage==='provisional'?DATA_STATUS.provisional:month.coverage==='review'?DATA_STATUS.review:'登録済み';
/** Explain the same review conditions used by monthlyCashflow, without altering totals. */
function qualityReasons(month:AnalysisMonth):string {
  const r=month.report;
  return [r.issues.some(i=>i.month===null)?'支払日不明の明細（全期間共通）':'',
    r.issues.some(i=>i.month===month.period)?'集計対象外の明細':'',
    r.unknownConfirmationCount?`確定状態不明 ${r.unknownConfirmationCount}件`:'',
    r.recurringCardOverlap?`支出の重複候補 ${r.recurringCardOverlap}件`:'',
    r.provisional.length?`暫定明細 ${r.provisional.length}件`:''].filter(Boolean).join(' · ');
}
const amountText=(value:number|null)=>value===null?DATA_STATUS.missing:formatYen(value);
function metric(label:string,value:string,sub:string,tone=''):HTMLElement{
  const root=el('div',`analysis-metric ${tone}`);root.append(el('span','analysis-muted',label),el('strong',financialStatusClass(value),value));if(sub)root.append(el('small','analysis-muted',sub));return root;
}
function note(text:string):HTMLElement{return el('p','analysis-muted analysis-note',text);}
/** Display coverage separately from the existing sums of known months. */
function periodMetrics(data:PeriodAnalytics){
  const totals=data.totals,count=data.months.length;
  const balanceMonths=data.months.filter(month=>month.balance!==null).length;
  const incompleteExpense=totals.knownExpenseMonths<count;
  const incompleteBalance=balanceMonths<count;
  const coverage=(known:number)=>`${known}/${count}か月`;
  return {
    income:{value:formatYen(totals.income),detail:coverage(totals.knownIncomeMonths)},
    expense:{value:incompleteExpense?DATA_STATUS.unavailable:formatYen(totals.expense),detail:[incompleteExpense&&totals.expense!==null?`判明分 ${formatYen(totals.expense)}（一部未取得）`:'',coverage(totals.knownExpenseMonths)].filter(Boolean).join(' · ')},
    balance:{value:incompleteBalance?DATA_STATUS.unavailable:sharedYen(totals.balance,0,DATA_STATUS.unavailable),detail:[incompleteBalance&&totals.balance!==null?`判明分 ${signedYen(totals.balance)}`:'',coverage(balanceMonths),totals.comparable?'':'欠測・暫定などを含む参考値'].filter(Boolean).join(' · '),tone:incompleteBalance||totals.balance===null?'':totals.balance<0?'cashflow-negative':'cashflow-positive'}
  };
}
function periodMetricCell(value:string,detail:string):HTMLTableCellElement{
  const cell=el('td','analysis-number');
  cell.append(el('div',financialStatusClass(value),value),el('div','analysis-muted',detail));
  return cell;
}
export function initAnalysis(deps:AnalysisDeps):AnalysisUi{
  const root=document.getElementById('analysis-content');
  if(!root)throw new Error('収支分析画面が見つかりません。');
  let mode:Mode='month';let count:3|6|12=6;let end=currentLocal();let year=Number(end.slice(0,4));
  let dimension:AnalysisDimension='category';
  const go=(period:string)=>deps.openMonth(period);
  let reportContext:AnalysisReportContext|null=null;
  const drill=(dimension:AnalysisDimension,id:string,label:string,periods:readonly string[])=>
    deps.openDrilldown({dimension,value:id,label,periods},reportContext);
  function controls(today:string,source:MonthlySource|null):HTMLElement{
    const area=el('div','analysis-controls');
    const modes=el('div','analysis-switch');
    for(const [value,label] of [['month','月次'],['year','年間']] as const){
      const button=action(label,()=>{mode=value;render();},'analysis-switch-button'+(mode===value?' selected':''));
      button.setAttribute('aria-pressed',String(mode===value));modes.append(button);
    }
    area.append(modes);
    if(mode==='month'){
      const options=el('div','analysis-switch analysis-duration');
      for(const len of [3,6,12] as const){
        const button=action(`${len}か月`,()=>{count=len;render();},'analysis-switch-button'+(count===len?' selected':''));
        button.setAttribute('aria-pressed',String(count===len));options.append(button);
      }
      area.append(options);
      area.append(monthNavigator(end,(next)=>{end=next;render();},{label:'分析終了月',max:today,min:'1900-12',today}));
    }else{
      const years=[...(source?.records??[]).map(r=>Number(statementPeriod(r.statement)?.slice(0,4))),
        ...(source?.payroll.entries??[]).map(p=>Number(p.paidOn.slice(0,4))),year,Number(today.slice(0,4))-5];
      const first=Math.max(1900,Math.min(...years.filter(y=>Number.isInteger(y)&&y>=1900)));
      area.append(yearNavigator(year,(next)=>{year=next;render();},{min:first,max:Number(today.slice(0,4))}));
    }
    return area;
  }
  function summary(data:PeriodAnalytics):HTMLElement{
    const result=el('div','analysis-metrics');const totals=data.totals;
    const range=`${labelYearMonth(data.months[0]!.period)}〜${labelYearMonth(data.months.at(-1)!.period)}`;
    const {income,expense,balance}=periodMetrics(data);
    result.append(metric('収入',income.value,`${income.detail} · ${range} · 実績・見込み`),
      metric('支出',expense.value,`${expense.detail} · NISAを含む`),
      metric('収支',balance.value,`${balance.detail} · NISAを除く：${sharedYen(balanceWithoutNisa(data.months),0,DATA_STATUS.unavailable)}`,balance.tone),
      metric('平均支出',sharedYen(totals.avgExpense,0,DATA_STATUS.unavailable),`${totals.comparableExpenseMonths}か月分の平均`));
    return result;
  }
  function qualitySummary(data:PeriodAnalytics):HTMLElement|null{
    const {provisionalMonths,reviewMonths}=data.totals;const missingMonths=data.months.filter(m=>m.coverage==='missing'||m.coverage==='partial').length;
    if(!missingMonths&&!provisionalMonths&&!reviewMonths)return null;
    const bits=[missingMonths?`未取得 ${missingMonths}か月`:'',provisionalMonths?`暫定 ${provisionalMonths}か月`:'',reviewMonths?`要確認 ${reviewMonths}か月`:''].filter(Boolean);
    const text=el('div','analysis-coverage');
    text.append(el('strong','',bits.join(' · ')),el('span','','登録済み明細分の集計'));
    if(data.months.some(m=>m.report.issues.some(i=>i.month===null)))text.append(el('span','','支払日不明の明細は全期間共通の要確認です。'));
    if(reviewMonths||provisionalMonths)text.append(el('span','','月を選択すると該当明細と確認理由を表示します。'));
    return text;
  }
  function chart(data:PeriodAnalytics):HTMLElement{
    const block=panel('収入・支出の推移');
    const legend=el('div','analysis-chart-legend');legend.append(el('span','analysis-income-key','収入'),el('span','analysis-expense-key','支出'));
    block.body.append(legend);
    const values=data.months.flatMap(m=>[m.income,m.expense]).filter((v):v is number=>v!==null&&v>=0);
    const max=Math.max(1,...values);
    const scroll=el('div','analysis-chart-scroll');
    const bars=el('div','analysis-chart-bars');
    for(const month of data.months){
      const cell=action('',()=>go(month.period),'analysis-chart-month');
      cell.setAttribute('aria-label',`${labelYearMonth(month.period)} · 収入 ${amountText(month.income)} · 支出 ${amountText(month.expense)} · ${quality(month)}${qualityReasons(month)?' · '+qualityReasons(month):''}`);
      cell.title=qualityReasons(month)||quality(month);
      const pair=el('span','analysis-bar-pair');
      for(const [value,cls] of [[month.income,'income'],[month.expense,'expense']] as const){
        const slot=el('span','analysis-bar-slot');
        if(value===null)slot.append(el('span','analysis-bar-missing','·'));
        else if(value<0)slot.append(el('span','analysis-bar-negative','−'));
        else{
          const bar=el('span',`analysis-bar analysis-bar-${cls}`);
          bar.style.height=`${value===0?2:Math.max(3,Math.min(100,value/max*100))}%`;
          slot.append(bar);
        }
        pair.append(slot);
      }
      cell.append(pair,el('span','analysis-bar-label',monthLabel(month.period)),el('small',`analysis-muted ${financialStatusClass(quality(month))}`,month.coverage==='registered'?'':quality(month)));
      bars.append(cell);
    }
    scroll.append(bars);block.body.append(scroll);
    block.body.append(note('月を選択して詳細を表示'));
    return block.root;
  }
  function cumulativeChart(data:PeriodAnalytics):HTMLElement{
    const block=panel('累積収支の推移');
    const points=cumulativeBalances(data.months),last=points.at(-1)!;
    const known=points.filter((p):p is typeof p & {amount:number}=>p.amount!==null);
    block.body.append(el('strong','analysis-cumulative-total',sharedYen(last.amount,0,DATA_STATUS.unavailable)));
    if(known.length){
      const scroll=el('div','analysis-chart-scroll');
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      const width=Math.max(480,points.length*86+100),height=200,left=74,right=24,top=16,bottom=32;
      const low=Math.min(0,...known.map(p=>p.amount)),high=Math.max(0,...known.map(p=>p.amount));
      const span=high-low||1;
      const x=(index:number)=>left+(width-left-right)*index/points.length;
      const y=(amount:number)=>high===low?(top+height-bottom)/2:top+(height-top-bottom)*(high-amount)/span;
      const node=(name:string,attrs:Record<string,string|number>,text?:string)=>{
        const item=document.createElementNS('http://www.w3.org/2000/svg',name);
        for(const [key,value] of Object.entries(attrs))item.setAttribute(key,String(value));
        if(text!==undefined)item.textContent=text;svg.append(item);return item;
      };
      svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('width',String(width));svg.setAttribute('class','analysis-cumulative-svg');
      svg.setAttribute('role','img');svg.setAttribute('aria-label','選択期間の累積収支。各月の金額は下の表でも確認できます。');
      for(const amount of new Set([low,0,high])){
        node('line',{x1:left,x2:width-right,y1:y(amount),y2:y(amount),class:amount===0?'analysis-cumulative-zero':'analysis-cumulative-grid'});
        node('text',{x:left-6,y:y(amount)+4,'text-anchor':'end'},formatYen(amount));
      }
      let previous={x:x(0),y:y(0)};
      node('text',{x:x(0),y:height-8,'text-anchor':'middle'},'開始');
      points.forEach((point,index)=>{
        const px=x(index+1);
        node('text',{x:px,y:height-8,'text-anchor':'middle'},monthLabel(point.period));
        if(point.amount===null)return;
        const py=y(point.amount);
        node('line',{x1:previous.x,y1:previous.y,x2:px,y2:py,class:'analysis-cumulative-line'+(point.reference?' reference':'')});
        const circle=node('circle',{cx:px,cy:py,r:4,class:'analysis-cumulative-point'});
        const label=document.createElementNS('http://www.w3.org/2000/svg','title');label.textContent=`${labelYearMonth(point.period)} ${signedYen(point.amount)}${point.reference?'（参考値）':''}`;circle.append(label);
        previous={x:px,y:py};
      });
      scroll.append(svg);block.body.append(scroll);
    }
    if(last.amount===null)block.body.append(note('未取得の月があるため、その月以降の累積収支は算出できません。'));
    if(known.some(p=>p.reference))block.body.append(note('暫定明細・給与見込みなどを含む参考値は破線で表示します。'));
    block.body.append(note('選択期間の開始を0円として、毎月の収支（NISA積立を含む）を積み上げます。口座残高ではありません。'));
    return block.root;
  }
  function monthTable(data:PeriodAnalytics):HTMLElement{
    const block=panel('月ごとの収支');
    const scroll=el('div','analysis-table-scroll');const table=el('table','analysis-table');
    const header=el('thead');const tr=el('tr');
    for(const label of ['月','収入','支出','収支','累積収支','NISA','状態'])tr.append(el('th','',label));
    header.append(tr);table.append(header);const body=el('tbody');
    const accumulated=new Map(cumulativeBalances(data.months).map(point=>[point.period,point]));
    for(const month of [...data.months].reverse()){
      const row=el('tr');
      const first=el('td');first.append(action(labelYearMonth(month.period),()=>go(month.period),'analysis-link'));row.append(first);
      for(const [index,amount] of [month.income,month.expense,month.balance,accumulated.get(month.period)?.amount??null,month.nisa].entries()){
        const value=index===2||index===3?sharedYen(amount,0,DATA_STATUS.unavailable):formatYen(amount);
        row.append(el('td',`analysis-number ${financialStatusClass(value)}`,value));
      }
      const state=el('td',financialStatusClass(quality(month)));
      const reasons=qualityReasons(month);
      if(month.coverage!=='registered'){
        const review=action(quality(month),()=>go(month.period),'analysis-link');
        review.setAttribute('aria-label',`${labelYearMonth(month.period)} ${quality(month)}の詳細を確認`);
        if(reasons)review.title=reasons;
        state.append(review);
        if(reasons)state.append(el('small','analysis-muted',reasons));
      }else state.textContent=quality(month);
      row.append(state);body.append(row);
    }
    table.append(body);scroll.append(table);block.body.append(scroll);
    block.body.append(note('支出はカード引落月基準。NISA積立を含みます。登録済みは登録された明細の状態であり、全カードの取得完了を保証するものではありません。'));
    return block.root;
  }
  function rangeInsights(data:PeriodAnalytics):HTMLElement{
    const block=panel('期間の特徴');const totals=data.totals;
    const grid=el('div','analysis-insights');
    grid.append(metric('支出が最大の月',totals.maxExpense?labelYearMonth(totals.maxExpense.period):DATA_STATUS.missing,totals.maxExpense?`${formatYen(totals.maxExpense.amount)} · 比較可能な${totals.comparableExpenseMonths}か月`:'比較可能な月なし'),
      metric('支出が最小の月',totals.minExpense?labelYearMonth(totals.minExpense.period):DATA_STATUS.missing,totals.minExpense?`${formatYen(totals.minExpense.amount)} · 比較可能な${totals.comparableExpenseMonths}か月`:'比較可能な月なし'));
    block.body.append(grid);
    const latest=data.months.at(-1),previous=data.months.at(-2);
    if(latest&&previous){
      const change=latest.expense===null||previous.expense===null?null:latest.expense-previous.expense;
      block.body.append(el('p','analysis-insight-line',`直近の前月比：${change===null?'比較不可':signedYen(change)}`));
    }
    if(data.categoryChanges.length||data.merchantChanges.length){
      const changes=el('div','analysis-change-columns');
      for(const [heading,entries] of [['カテゴリーの増減',data.categoryChanges],['利用先の増減',data.merchantChanges]] as const){
        const section=el('section');section.append(el('h3','',heading));
        if(!entries.length)section.append(note('比較できる増減はありません。'));
        else entries.slice(0,4).forEach(entry=>{
          const line=el('div','analysis-change-item');
          const dimension:AnalysisDimension=heading==='カテゴリーの増減'?'category':'merchant';
          const periods=data.months.slice(-2).map(m=>m.period);
          line.append(action(entry.name,()=>drill(dimension,entry.id,entry.name,periods),'analysis-link'),el('strong',entry.delta>0?'analysis-increase':'',signedYen(entry.delta)));section.append(line);
        });
        changes.append(section);
      }
      block.body.append(changes);
    }
    return block.root;
  }
  function ranking(data:PeriodAnalytics):HTMLElement{
    const block=panel('カード・カテゴリー・利用先');
    const switcher=el('div','analysis-switch analysis-group-switch');
    for(const [value,label] of [['card','カード'],['category','カテゴリー'],['merchant','利用先']] as const){
      const button=action(label,()=>{dimension=value;render();},'analysis-switch-button'+(dimension===value?' selected':''));
      button.setAttribute('aria-pressed',String(dimension===value));switcher.append(button);
    }
    block.body.append(switcher);
    const groups=data.groups[dimension].slice(0,12);if(data.groups[dimension].length>12)block.body.append(note(`上位12件 / 全${data.groups[dimension].length}件`));
    if(!groups.length){block.body.append(note('分析できる取引がありません。'));return block.root;}
    const scroll=el('div','analysis-table-scroll');const table=el('table','analysis-table analysis-detail-table');
    const head=el('thead'),row=el('tr');row.append(el('th','','名称'),el('th','','登録済み合計'));
    for(const month of data.months)row.append(el('th','',monthLabel(month.period)));
    head.append(row);table.append(head);const body=el('tbody');
    for(const group of groups){
      const item=el('tr');
      const nameCell=el('th');nameCell.append(action(group.label,()=>drill(dimension,group.id,group.label,data.months.map(m=>m.period)),'analysis-link'));
      const totalCell=el('td','analysis-number');totalCell.append(action(formatYen(group.total),()=>drill(dimension,group.id,group.label,data.months.map(m=>m.period)),'analysis-link'));
      item.append(nameCell,totalCell);
      for(let index=0;index<data.months.length;index++){
        const cell=el('td','analysis-number');
        const amount=group.amounts[index]??null;
        if(amount===null||amount===0)cell.textContent=amount===null?DATA_STATUS.missing:formatYen(0);
        else cell.append(action(formatYen(amount),()=>drill(dimension,group.id,group.label,[data.months[index]!.period]),'analysis-link'));
        item.append(cell);
      }
      body.append(item);
    }
    table.append(body);scroll.append(table);block.body.append(scroll);
    const caveat=dimension==='card'?'カードごとの引落月で集計しています。':dimension==='category'?'カード利用・定期支出・実行済み単発支出・NISA積立の分類です。':'カード利用先だけを集計しています。';
    block.body.append(note(`${caveat} 名称・金額から明細を表示できます。`));
    return block.root;
  }
  function annualCompare(data:PeriodAnalytics,prior:PeriodAnalytics|null):HTMLElement{
    const block=panel('前年との比較');
    const years=[data,prior].filter((item):item is PeriodAnalytics=>item!==null);
    const yearTable=el('div','analysis-table-scroll'),table=el('table','analysis-table');
    const head=el('thead'),tr=el('tr');
    ['期間','収入・見込み','支出・予定','収支','明細登録月'].forEach(name=>tr.append(el('th','',name)));
    head.append(tr);table.append(head);const body=el('tbody');
    for(const item of years){
      const {income,expense,balance}=periodMetrics(item);
      const line=el('tr');line.append(el('td','',`${item.months[0]!.period.slice(0,4)}年 1〜${item.months.length}月`),
        periodMetricCell(income.value,income.detail),periodMetricCell(expense.value,expense.detail),
        periodMetricCell(balance.value,balance.detail),el('td','',`${item.totals.knownExpenseMonths}/${item.months.length}か月`));body.append(line);
    }
    table.append(body);yearTable.append(table);block.body.append(yearTable);
    const delta=comparableDelta(data,prior,'expense');
    block.body.append(note(delta?`登録済み支出の前年比：${signedYen(delta.amount)}${delta.percent===null?'':`（${delta.percent>0?'+':''}${delta.percent.toFixed(1)}%）`}`:
      '前年比：比較できる明細が揃っていません。'));
    if(prior&&data.months.length===prior.months.length&&
      [data,prior].every(item=>item.months.every(m=>m.coverage==='registered'))){
      const comparisons=el('div','analysis-change-columns');
      for(const [dimension,heading] of [['category','カテゴリーの登録分前年比'],['merchant','利用先の登録分前年比']] as const){
        const old=new Map(prior.groups[dimension].map(g=>[g.id,g.total]));
        const current=new Map(data.groups[dimension].map(g=>[g.id,g.total]));
        const labels=new Map([...prior.groups[dimension],...data.groups[dimension]].map(g=>[g.id,g.label]));
        const changes=[...new Set([...old.keys(),...current.keys()])].map(id=>({id,name:labels.get(id)??id,delta:(current.get(id)??0)-(old.get(id)??0)}))
          .filter(item=>item.delta!==0).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,5);
        const section=el('section');section.append(el('h3','',heading));
        if(!changes.length)section.append(note('大きな変化はありません。'));
        for(const change of changes){
          const line=el('div','analysis-change-item');
          line.append(action(change.name,()=>drill(dimension,change.id,change.name,[...prior.months.map(m=>m.period),...data.months.map(m=>m.period)]),'analysis-link'),
            el('strong',change.delta>0?'analysis-increase':'',signedYen(change.delta)));section.append(line);
        }
        comparisons.append(section);
      }
      block.body.append(comparisons,note('前年比の項目から、前年・今年の両方の明細と月別内訳を確認できます。'));
    }
    return block.root;
  }
  function render():void{
    return measureFinanceSync('ui.analysis.render',()=>{
    root!.replaceChildren();
    const today=currentLocal();
    if(end>today)end=today;if(year>Number(today.slice(0,4)))year=Number(today.slice(0,4));
    const source=deps.source();
    reportContext=null;
    root!.append(controls(today,source));
    if(!source){
      const locked=panel('OneDrive保管庫を開く');locked.body.append(action('設定を開く',deps.openSettings,'analysis-primary'));
      root!.append(locked.root);return;
    }
    try{
      const data=measureFinanceSync('ui.analysis.aggregate',()=>mode==='month'
        ?rollingAnalytics(source,end,count,today):annualAnalytics(source,year,today));
      reportContext={source,reports:new Map(data.months.map(m=>[m.period,m.report]))};
      const header=el('div','analysis-range');header.append(el('strong','',mode==='month'?`${labelYearMonth(data.months[0]!.period)}〜${labelYearMonth(data.months.at(-1)!.period)}`:`${year}年の収支`));
      root!.append(header,summary(data));
      const warning=qualitySummary(data);if(warning)root!.append(warning);
      root!.append(measureFinanceSync('ui.analysis.chart',()=>chart(data)),cumulativeChart(data),monthTable(data));
      if(mode==='year')root!.append(annualCompare(data,priorYearAnalytics(source,year,today)));
      root!.append(ranking(data),rangeInsights(data),pointBenefitsSection('推定ポイント',measureFinanceSync('ui.analysis.points',
        ()=>periodPointBenefitsFromReports(data.months.map(m=>m.report),source)),pointCoverage(data.months.map(m=>m.report))));
    }catch(error){
      const problem=panel('収支分析を表示できません');
      problem.body.append(note(error instanceof Error?error.message:'データを確認してください。'));
      root!.append(problem.root);
    }
    });
  }
  return {render,reset:()=>{reportContext=null;end=currentLocal();year=Number(end.slice(0,4));mode='month';count=6;dimension='category';render();}};
}
