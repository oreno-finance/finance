import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {adjacentMonth,monthInRange,localMonth,bindMonthNavigator} from '../dist/src/ui/period-navigator.js';
import {formatYen,formatSignedYen,formatMonth,formatDate,formatShortDate,formatTime,formatDateTime,formatRate,formatRateList,formatPoints} from '../dist/src/ui/formatters.js';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('年月操作は各画面の範囲と年またぎを維持し、全期間からは現在月を基準に移動する',()=>{
 const options={label:'請求月',today:'2026-11'};
 assert.equal(localMonth(new Date(2026,10,24)),options.today);
 assert.equal(adjacentMonth('2026-12',1,options),'2027-01');
 assert.equal(adjacentMonth('2026-01',-1,options),'2025-12');
 assert.equal(adjacentMonth('',-1,options),'2026-10');
 assert.equal(adjacentMonth('',1,options),'2026-12');
 assert.equal(adjacentMonth('1900-01',-1,options),null);
 assert.equal(adjacentMonth('2199-12',1,options),null);
 assert.equal(adjacentMonth('2026-11',1,{...options,max:'2026-11'}),null);
 for(const month of ['','2026-13','2026-1','2200-01','1899-12'])assert.equal(monthInRange(month,options),false);
 assert.equal(monthInRange('1900-01',{...options,min:'1900-02'}),false);
});
test('年月操作は一度だけ登録され、再描画後の現在値と全期間・範囲制限を参照する',()=>{
 const node=()=>{const handlers={};return {handlers,attrs:{},classList:{add(){},toggle(){}},addEventListener(k,fn){assert.ok(!handlers[k]);handlers[k]=fn;},setAttribute(k,v){this.attrs[k]=v;}};};
 const root=node(),controls={previous:node(),picker:node(),next:node(),current:node(),all:node()};
 let period='2026-12',changes=0;const options={label:'請求月',today:'2026-11',min:'2026-01',max:'2027-01',all:()=>{period='';}};
 const sync=bindMonthNavigator(root,controls,()=>period,value=>{period=value;changes++;},()=>options);
 controls.next.handlers.click();assert.equal(period,'2027-01');assert.equal(controls.next.disabled,true);
 controls.next.handlers.click();assert.equal(changes,1);
 controls.all.handlers.click();assert.equal(period,'');assert.equal(controls.all.attrs['aria-pressed'],'true');
 controls.previous.handlers.click();assert.equal(period,'2026-10');
 controls.picker.value='2025-12';controls.picker.handlers.change();assert.equal(controls.picker.value,'2026-10');assert.equal(changes,2);
 period='2026-01';sync();assert.equal(controls.previous.disabled,true);
 controls.current.handlers.click();assert.equal(period,'2026-11');assert.equal(changes,3);
});
test('表示専用フォーマッターは欠損・ゼロ・負数・小数還元率・うるう日を区別する',()=>{
 assert.equal(formatYen(123456),'123,456円');assert.equal(formatYen(0),'0円');assert.equal(formatYen(null),'—');assert.equal(formatYen(NaN),'—');assert.equal(formatYen(null,0,'未取得'),'未取得');
 assert.equal(formatSignedYen(12345),'+12,345円');assert.equal(formatSignedYen(-12345),'−12,345円');assert.equal(formatSignedYen(-0),'0円');assert.equal(formatYen(1775.4),'1,775円');
 assert.equal(formatMonth('2026-11'),'2026年11月');assert.equal(formatDate('2024-02-29'),'2024/02/29');assert.equal(formatDate('2026-02-29'),'—');assert.equal(formatDate('2026-04-31'),'—');assert.equal(formatShortDate('2026-01-05'),'1/5');
 const date=new Date(2026,10,24,9,30,7);assert.equal(formatTime(date),'09:30');assert.equal(formatDateTime(date,true),'2026/11/24 09:30:07');assert.equal(formatDateTime('invalid'),'—');
 assert.equal(formatRate(2),'2.0%');assert.equal(formatRate(1.25),'1.25%');assert.equal(formatRate(0),'0.0%');assert.equal(formatPoints(1234),'1,234 pt');assert.equal(formatRateList('2% / 1.25%'),'2.0% / 1.25%');assert.equal(formatRateList(' / '),'—');
});
test('既存四画面は共通の年月操作を使い、明細管理はタイトル直下・破壊操作は共通クラスを使用する',()=>{
 const html=read('public/index.html'),main=read('src/main.ts'),summary=read('src/ui/monthly-summary.ts'),reports=read('src/ui/monthly-reports.ts'),analysis=read('src/ui/analysis.ts');
 assert.match(summary,/bindMonthNavigator\(\$\('monthly-period-controls'\)/);assert.match(main,/bindMonthNavigator\(\$\('manage-period-controls'\)/);
 assert.match(reports,/monthNavigator\(selected,choosePeriod/);assert.match(analysis,/monthNavigator\(end/);
 assert.match(html,/<section id="manage-view"[^>]*>\s*<header[^>]*>[\s\S]*?<\/header>\s*<div id="manage-period-controls"/);
 assert.match(html,/id="manage-delete" class="danger-action"/);assert.match(reports,/レポートを作成[\s\S]*?'save-action'/);
 for(const file of ['home','monthly-summary','monthly-reports','analysis','assets-settings','subscriptions','future-projection','card-settings','point-benefits'])assert.match(read(`src/ui/${file}.ts`),/from '\.\/formatters\.js'/);
});
