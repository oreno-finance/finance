import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyAssets} from '../dist/src/cloud/assets.js';
import {monthlyReport,monthlyCashflow} from '../dist/src/summary/monthly-summary.js';
import {homeOverview} from '../dist/src/home/overview.js';
import {analyzePeriods} from '../dist/src/analysis/period-analytics.js';
import {reportSnapshot} from '../dist/src/reports/monthly-report.js';
const period='2026-11',today='2026-11-24';
const pay={id:'synthetic-pay',employerId:'main',payPeriod:period,paidOn:'2026-11-27',netPay:250000,grossPay:300000,taxablePay:null,currency:'JPY',kind:'salary',revision:1};
const record=(id='synthetic-record',confirmation='confirmed',amount=10000)=>({id,statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'sample',billingMonth:'2026-10',paymentDate:'2026-11-27',statedTotal:amount,confirmation,warnings:[],rows:[{id:'row-'+id,usedOn:'2026-10-05',merchant:'SHOP',amount}]}});
const expense={id:'synthetic-cash',name:'現金支出',date:'2026-11-15',kind:'expense',amount:9000,status:'done',fromAccountId:'cash-savings',toAccountId:null,categoryId:null};
const source=(assets={},records=[])=>({records,rules:[],categories:[],assets:{...emptyAssets(),...assets},payroll:{ready:true,syncedAt:1000,entries:[pay]},currentPeriod:period});
function check(s,expected,coverage,expense){
 const m=monthlyReport(period,s),c=monthlyCashflow(m),h=homeOverview(s,today),a=analyzePeriods(s,[period],period).months[0],r=reportSnapshot(period,s);
 assert.equal(m.monthlyBalance,expected);assert.equal(m.referenceBalance,expected);
 assert.equal(c.balance,expected);assert.equal(h.report.monthlyBalance,expected);assert.equal(a.balance,expected);assert.equal(r.balance,expected);
 assert.equal(c.coverage,coverage);assert.equal(h.coverage,coverage==='review'?'needs-review':coverage);assert.equal(a.coverage,coverage);
 assert.equal(c.expense,expense);assert.equal(h.outflow,expense);assert.equal(a.expense,expense);assert.equal(r.expense,expense);
}
test('最終監査②: カード未取得では給与実績があっても全画面の収支は算出不可',()=>check(source(),null,'missing',null));
test('最終監査②: カード未取得の銀行・現金支出は判明額のみ、収支は算出不可',()=>check(source({oneTime:[expense]}),null,'partial',9000));
test('最終監査②: 利用なし確認済みの明示的ゼロは全画面で集計する',()=>check(source({cardNoUseMonths:[period],oneTime:[expense]}),241000,'registered',9000));
test('最終監査②: 登録済みカード明細と現金支出は全画面で一致する',()=>check(source({oneTime:[expense]},[record()]),231000,'registered',19000));
test('最終監査②: 暫定明細は参照値を維持し、全画面で暫定状態を共有する',()=>check(source({},[record('p','provisional')]),240000,'provisional',10000));
test('最終監査②: 未取得月の既知支出を前月比として確定しない',()=>{
 const s=source({oneTime:[expense,{...expense,id:'old',date:'2026-10-15',amount:2000}]});
 const r=reportSnapshot(period,s);assert.equal(r.expense,9000);assert.equal(r.previousExpense,2000);assert.equal(r.expenseChange,null);
 assert.equal(r.reasons.some(x=>x.includes('前月')),false);
});
