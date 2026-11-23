import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateFixedCosts,fixedCostOccurrences,fixedCostState,priceOnDay,pausedOnDay} from '../dist/src/fixed-costs/contracts.js';
import {validateAssets,validateCardPreferences,emptyAssets,mergeAssets,detectAssetsEditCollisions} from '../dist/src/cloud/assets.js';
import {recurringInMonth} from '../dist/src/cloud/recurring-schedule.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {pointRate,monthlyPointBenefits} from '../dist/src/summary/point-benefits.js';

const cash=(rest={})=>({
  id:'fixed-cash-001',name:'毎月の現金払い',payment:'cash',cardId:null,merchantKey:null,categoryId:null,
  frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,
  startOn:'2026-01-01',endOn:null,amount:1300,priceKind:'fixed',
  pricing:[{effectiveOn:'2026-01-01',amount:1000},{effectiveOn:'2027-01-01',amount:1300}],pauses:[],
  note:'',updatedAt:'2026-11-23T00:00:00Z',...rest
});
const bank=(rest={})=>({id:'bank-fixed-01',name:'銀行引落',amount:1300,kind:'expense',fromAccountId:'rakuten-bank',toAccountId:null,
  frequency:'monthly',dayOfMonth:27,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,
  categoryId:null,enabled:true,pricing:[{effectiveOn:'2026-01-01',amount:1000},{effectiveOn:'2027-01-01',amount:1300}],pauses:[],priceKind:'fixed',note:'',...rest});
const source=assets=>({records:[],rules:[],categories:[],assets:{...assets,nisaCardRule:null},payroll:{ready:true,syncedAt:1,entries:[]},currentPeriod:'2026-11'});

test('現金固定費は銀行残高に触れず、契約料金と停止期間を日付別に計算',()=>{
  const item=cash({pauses:[{startOn:'2027-03-01',endOn:'2027-04-30'}]});
  assert.equal(validateFixedCosts([item]).length,1);
  assert.equal(fixedCostOccurrences('2026-11',[item])[0].amount,1000);
  assert.equal(fixedCostOccurrences('2027-01',[item])[0].amount,1300);
  assert.equal(fixedCostOccurrences('2027-03',[item]).length,0);
  assert.equal(fixedCostOccurrences('2027-05',[item]).length,1);
  assert.equal(fixedCostState(item,'2027-03-20'),'paused');
  assert.equal(fixedCostState(item,'2027-05-20'),'active');
  assert.equal(priceOnDay(item.pricing,'2026-03-15',1300),1000);
  assert.equal(pausedOnDay(item.pauses,'2027-04-30'),true);
  assert.equal(monthlyReport('2026-11',source({recurring:[],fixedCosts:[item]})).recurringExpense,1000);
  assert.equal(monthlyReport('2027-01',source({recurring:[],fixedCosts:[item]})).recurringExpense,1300);
  assert.equal(monthlyReport('2027-03',source({recurring:[],fixedCosts:[item]})).recurringExpense,0);
});
test('銀行定期支出の料金変更・一時停止は過去月へ遡及しない',()=>{
  const item=bank({pauses:[{startOn:'2027-02-01',endOn:'2027-02-28'}]});
  assert.equal(recurringInMonth('2026-11',[item])[0].entry.amount,1000);
  assert.equal(recurringInMonth('2027-01',[item])[0].entry.amount,1300);
  assert.equal(recurringInMonth('2027-02',[item]).length,0);
  assert.equal(recurringInMonth('2027-03',[item]).length,1);
  assert.equal(monthlyReport('2026-11',source({recurring:[item]})).recurringExpense,1000);
  assert.equal(monthlyReport('2027-01',source({recurring:[item]})).recurringExpense,1300);
});
test('不正な重複・改ざん・範囲外金額は暗号化保管庫の読み込み時に拒否',()=>{
  assert.throws(()=>validateFixedCosts([cash(),cash({id:'fixed-cash-001'})]));
  assert.throws(()=>validateFixedCosts([cash({pricing:[{effectiveOn:'2026-01-01',amount:1000},{effectiveOn:'2026-01-01',amount:1300}]})]));
  assert.throws(()=>validateFixedCosts([cash({pauses:[{startOn:'2026-10-01',endOn:null},{startOn:'2026-11-01',endOn:null}]})]));
  assert.throws(()=>validateFixedCosts([cash({note:'x'.repeat(501)})]));
  const good=emptyAssets();good.fixedCosts=[cash()];
  assert.equal(validateAssets(good).fixedCosts.length,1);
});
test('カード還元率は利用日の履歴に固定し、支払月で表示する',()=>{
  const preferences={'rakuten-mizuho':{pointRatePercent:1,pointRateHistory:[{effectiveOn:'1900-01-01',ratePercent:2},{effectiveOn:'2027-01-01',ratePercent:1}]}};
  assert.deepEqual(validateCardPreferences(preferences)['rakuten-mizuho'].pointRateHistory,preferences['rakuten-mizuho'].pointRateHistory);
  assert.equal(pointRate('rakuten-mizuho',preferences,'2026-12-31'),2);
  assert.equal(pointRate('rakuten-mizuho',preferences,'2027-01-01'),1);
  const record={id:'stmt-1',originalId:null,statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'csv',sourceName:'statement.csv',
    billingMonth:'2027-01',paymentDate:'2027-02-27',statedTotal:200000,confirmation:'confirmed',warnings:[],
    rows:[{id:'row-a',usedOn:'2026-12-31',merchant:'A SHOP',amount:100000},{id:'row-b',usedOn:'2027-01-01',merchant:'B SHOP',amount:100000}]}};
  const report=monthlyPointBenefits('2027-02',{...source({recurring:[],cardPreferences:preferences}),records:[record]});
  assert.equal(report.total,3000);assert.match(report.cards[0].rateLabel,/2%/);assert.match(report.cards[0].rateLabel,/1%/);
});
test('別端末の独立した契約追加を三者マージし、同一契約の競合を検出',()=>{
  const base=emptyAssets(),local=emptyAssets(),remote=emptyAssets();
  local.fixedCosts=[cash()];remote.fixedCosts=[cash({id:'fixed-cash-002',name:'別の契約'})];
  assert.deepEqual(detectAssetsEditCollisions(base,local,remote),[]);
  const merged=mergeAssets(base,local,remote);assert.equal(merged.fixedCosts.length,2);
  const a=emptyAssets(),b=emptyAssets(),c=emptyAssets();a.fixedCosts=[cash()];
  b.fixedCosts=[cash({amount:1500,pricing:[{effectiveOn:'2026-01-01',amount:1000},{effectiveOn:'2027-01-01',amount:1500}]})];
  c.fixedCosts=[cash({amount:1800,pricing:[{effectiveOn:'2026-01-01',amount:1000},{effectiveOn:'2027-01-01',amount:1800}]})];
  assert.ok(detectAssetsEditCollisions(a,b,c).some(x=>x.field==='amount'));
});
test('月別操作は見出しの直下、固定費UIに保存操作と履歴確認がある',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/<section id="summary-view"[\s\S]*?monthly-heading[\s\S]*?<\/div>\s*<div class="monthly-controls finance-period-nav"/);
  assert.match(html,/固定費・サブスク管理/);
  const ui=readFileSync(new URL('../src/ui/subscriptions.ts',import.meta.url),'utf8');
  assert.match(ui,/料金変更履歴/);assert.match(ui,/候補から除外/);
  assert.match(ui,/if\(\!force&&isDirty\(\)/);
  assert.match(ui,/await vault\.upsertFixedCost\(contract,decision\)/);
});
