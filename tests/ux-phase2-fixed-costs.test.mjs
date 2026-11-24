import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nextFixedCostDate, changeFixedCostState, fixedCostOccurrences, fixedCostState} from '../dist/src/fixed-costs/contracts.js';
import {recurringInMonth} from '../dist/src/cloud/recurring-schedule.js';
const base={id:'contract-demo',name:'契約例',payment:'cash',cardId:null,merchantKey:null,categoryId:null,frequency:'monthly',dayOfMonth:31,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,amount:1000,priceKind:'fixed',pricing:[{effectiveOn:'2026-01-01',amount:1000}],pauses:[],note:'',updatedAt:'2026-01-01T00:00:00.000Z'};
const bank={...base,kind:'expense',enabled:true,fromAccountId:'rakuten-bank',toAccountId:null};
test('次回契約予定は毎月・年払い・毎週・月末の既存集計規則に一致する',()=>{
  for(const item of [base,{...base,dayOfMonth:0},{...base,frequency:'yearly',monthOfYear:2},{...base,frequency:'weekly',weekday:0,dayOfMonth:null}]){
    const period='2026-02',from=period+'-01';
    const expected=fixedCostOccurrences(period,[item])[0].date;
    assert.equal(nextFixedCostDate(item,from),expected);
    const recurrence={...bank,frequency:item.frequency,dayOfMonth:item.dayOfMonth,monthOfYear:item.monthOfYear,weekday:item.weekday};
    assert.equal(nextFixedCostDate(recurrence,from),recurringInMonth(period,[recurrence])[0].date);
  }
  assert.equal(nextFixedCostDate({...base,startOn:'2028-02-01',frequency:'yearly',monthOfYear:2},'2026-11-24'),'2028-02-29');
});
test('次回支払予定は開始前・停止中・終了済み・再開予定を区別し、遠い再開日にも対応する',()=>{
  assert.equal(nextFixedCostDate({...base,pauses:[{startOn:'2026-02-01',endOn:'2035-07-31'}]},'2026-02-01'),'2035-08-31');
  assert.equal(nextFixedCostDate({...base,pauses:[{startOn:'2026-02-01',endOn:null}]},'2026-02-01'),null);
  assert.equal(nextFixedCostDate({...base,endOn:'2026-02-28'},'2026-02-01'),'2026-02-28');
  assert.equal(nextFixedCostDate({...base,endOn:'2026-02-27'},'2026-02-01'),null);
  assert.equal(nextFixedCostDate({...bank,enabled:false},'2026-02-01'),null);
  assert.equal(nextFixedCostDate(base,'2026-02-31'),null);
});
test('停止・再開・終了は過去の支払と料金履歴を維持し、予定の発生だけを変更する',()=>{
  const snapshot=structuredClone(base);
  const paused={...base,...changeFixedCostState(base,'paused','2026-03-01')};
  assert.equal(nextFixedCostDate(paused,'2026-03-01'),null);
  const resumed={...paused,...changeFixedCostState(paused,'active','2026-05-01')};
  assert.deepEqual(resumed.pauses,[{startOn:'2026-03-01',endOn:'2026-04-30'}]);
  assert.equal(fixedCostOccurrences('2026-02',[resumed])[0].amount,1000);
  assert.equal(fixedCostOccurrences('2026-04',[resumed]).length,0);
  assert.equal(nextFixedCostDate(resumed,'2026-05-01'),'2026-05-31');
  const ended={...resumed,...changeFixedCostState(resumed,'ended','2026-06-15')};
  const renewed={...ended,...changeFixedCostState(ended,'active','2026-08-01')};
  assert.deepEqual(renewed.pauses,[{startOn:'2026-03-01',endOn:'2026-04-30'},{startOn:'2026-06-16',endOn:'2026-07-31'}]);
  assert.equal(fixedCostOccurrences('2026-07',[renewed]).length,0);
  assert.deepEqual(base,snapshot);assert.deepEqual(renewed.pricing,base.pricing);
  assert.throws(()=>changeFixedCostState(base,'','2026-03-01'));
  assert.throws(()=>changeFixedCostState(base,'paused','2026-02-31'));
  assert.throws(()=>changeFixedCostState(base,'ended','2025-01-01'));
});
test('旧形式の停止フラグは明示的に再開した場合だけ解除し、過去を復活させない',()=>{
  const old={...bank,enabled:false};
  const restored={...old,...changeFixedCostState(old,'active','2026-04-01')};
  assert.equal(restored.enabled,true);
  assert.equal(recurringInMonth('2026-03',[restored]).length,0);
  assert.equal(recurringInMonth('2026-04',[restored])[0].entry.amount,1000);
  assert.equal(old.enabled,false);
});
test('口座管理の登録と編集は入金・振替だけに限定し、支出への遷移は固定費管理へ集約する',()=>{
  const html=readFileSync('public/index.html','utf8'),ui=readFileSync('src/ui/assets-settings.ts','utf8'),main=readFileSync('src/main.ts','utf8');
  const form=html.split('id="assets-recurring-form"')[1].split('</form>')[0];
  assert.doesNotMatch(form,/<option value="expense"/);
  assert.match(form,/<option value="income"/);assert.match(form,/<option value="transfer"/);
  assert.match(ui,/if\(kind!=='income'&&kind!=='transfer'\)throw/);
  assert.match(ui,/if\(item.kind==='expense'\)\{openFixedCosts\(item.id\);return true;\}/);
  assert.match(ui,/const entries=all.filter\(item=>item.kind!=='expense'\)/);
  assert.match(ui,/if\(busy\|\|confirming\(\)\|\|item.kind==='expense'\|\|!vault\?\.unlocked\)return/);
  assert.match(main,/if\(entryId.startsWith\('cash:'\)\)\{[\s\S]*?subscriptionsUi\?\.openFixedCost\(id\);return;/);
  assert.match(main,/if\(entry.kind==='expense'\)\{showView\('subscriptions'\);subscriptionsUi\?\.openFixedCost\(entryId\);return;\}/);
});
