import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarBillingPeriod, filteredStatementIndices } from '../dist/src/ui/manage-filter.js';
import { readFileSync } from 'node:fs';
test('明細管理の初期年月は暦に従い、保存済みデータの最新月には依存しない',()=>{
  assert.deepEqual(calendarBillingPeriod(new Date(2026,10,16)),{year:'2026',month:'11'});
  assert.deepEqual(calendarBillingPeriod(new Date(2027,0,1)),{year:'2027',month:'01'});
  const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  assert.match(main,/let manageYear = initialCalendar\.year;/);
  assert.match(main,/let manageMonth = initialCalendar\.month;/);
  assert.match(main,/function manageChangePeriod/);
  assert.match(main,/bindMonthNavigator\(\$\('manage-period-controls'\)/);
  assert.deepEqual(filteredStatementIndices([{billingMonth:'2026-10'}],'2026','11'),[]);
});
