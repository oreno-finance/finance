import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateFinanceCsp,validateFinanceAuthCsp} from '../scripts/finance-csp.mjs';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {analysisDrilldownBreakdown} from '../dist/src/ui/analysis-drilldown.js';
const str=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

for(const [file,fn] of [['public/index.html',validateFinanceCsp],['public/auth-bridge.html',validateFinanceAuthCsp]]){
  const baseline=str(file),match=baseline.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i);
  assert.ok(match,`required CSP for ${file}`);
  test(`${file}: reject meta refresh and other http-equiv after CSP`,()=>{
    assert.deepEqual(fn(baseline),[]);
    const injections=[
      '<meta http-equiv="refresh" content="0;url=https://example.invalid/">',
      '<META HTTP-EQUIV="REFRESH" CONTENT="0;url=https://example.invalid/">',
      '<meta http-equiv="set-cookie" content="x=1">',
      '<meta http-equiv="content-type" content="text/html">',
      '<meta http-equiv="refresh" http-equiv="Content-Security-Policy" content="foo">',
      '<meta name="description" content="x" http-equiv="refresh">',
    ];
    for(const fragment of injections){
      const injected=baseline.replace(match[0],match[0]+'\n'+fragment);
      const result=fn(injected);
      assert.ok(result.length,`unexpectedly accepted ${fragment}`);
      assert.match(result.join(' '),/http-equiv|重複属性|未承認/);
      const before=baseline.replace(match[0],fragment+'\n'+match[0]);
      assert.ok(fn(before).length,`pre-CSP unsafe meta accepted: ${fragment}`);
    }
  });
  test(`${file}: safe non-redirect meta after CSP does not break policy`,()=>{
    for(const fragment of ['<meta name="description" content="追加説明">','<meta name="viewport" content="width=device-width, initial-scale=1">']){
      assert.deepEqual(fn(baseline.replace(match[0],match[0]+'\n'+fragment)),[],fragment);
    }
  });
}

test('monthly summary exposes category/merchant drilldown with the selected payment month',()=>{
  const ui=str('src/ui/monthly-summary.ts'),main=str('src/main.ts');
  assert.match(ui,/openDrilldown\(request:AnalysisDrilldown\)/);
  assert.match(ui,/dimension:'category',value:item\.id,label:item\.name,periods:\[period\]/);
  assert.match(ui,/dimension:'merchant',value:item\.name,label:item\.name,periods:\[period\]/);
  assert.match(main,/manageReturnToSummary=true;\s*activeIndex=-1;\s*showView\('manage'\)/);
  assert.match(main,/\!activeAnalysisDrilldown \|\| fromHome \|\| manageReturnToSummary/);
  assert.match(main,/\$\('manage-back-summary'\)\.addEventListener/);
});
test('summary category including recurring bank expense equals the existing detailed breakdown',()=>{
  const row={id:'r',usedOn:'2026-10-09',merchant:'MARKET',amount:300};
  const rec={id:'a',statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'test',paymentDate:'2026-11-27',billingMonth:'2026-10',statedTotal:300,confirmation:'confirmed',warnings:[],rows:[row]}};
  const schedule={id:'repeat',name:'保険',amount:500,kind:'expense',fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:'food',enabled:true};
  const source={records:[rec],rules:[{id:'food',pattern:'MARKET',mode:'contains',displayName:'スーパー',cardId:null,enabled:true,priority:100,categoryId:'food'}],categories:[{id:'food',name:'食費',color:'orange'}],assets:{nisaCardRule:null,recurring:[schedule],oneTime:[]},payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'};
  const fromSummary=monthlyReport('2026-11',source).categories.find(c=>c.id==='food');
  const fromDetails=analysisDrilldownBreakdown(source,{dimension:'category',value:'food',label:'食費',periods:['2026-11']});
  assert.equal(fromSummary.amount,800);
  assert.equal(fromDetails.total,800);
});
test('asset reconciliation restores its own account details open state before re-render',()=>{
  const ui=str('src/ui/assets-settings.ts');
  assert.match(ui,/reconciliation\.querySelector<HTMLDetailsElement>\('details\.assets-reconcile-card'\)\?\.open\?\?false/);
  assert.match(ui,/block\.open=reconciliationWasOpen/);
});
test('archived reports show selected year only, preserving selected month and keyboard focus',()=>{
  const ui=str('src/ui/monthly-reports.ts');
  assert.match(ui,/new Set\(periods\.map\(period=>period\.slice\(0,4\)\)\)/);
  assert.match(ui,/periods\.filter\(period=>period\.startsWith\(archiveYear\+'-'\)\)/);
  assert.match(ui,/yearSelect\.setAttribute\('aria-label','保存済みレポートの年'\)/);
  assert.match(ui,/querySelector<HTMLSelectElement>\('\.reports-year-select'\)\?\.focus/);
});
test('Playwright E2E remains a mandatory headless check before publication',()=>{
  const workflow=str('.github/workflows/pages.yml');
  const tests=str('tests/e2e/run.py');
  assert.match(workflow,/playwright==1\.57\.0/);
  assert.match(workflow,/playwright install --with-deps chromium/);
  assert.match(workflow,/tests\/e2e\/run\.py/);
  assert.ok(workflow.indexOf('tests/e2e/run.py')<workflow.indexOf('Upload exactly the audited Pages build'));
  for(const name of ['test_graph_pointer_drag_keyboard_zoom_desktop','test_graph_mobile_touch_and_vertical_page_scroll','test_month_summary_ranking_uses_real_drilldown_filter','test_month_reports_year_selector_limits_months'])assert.ok(tests.includes(name));
  assert.match(workflow,/actions\/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09/);
  assert.match(workflow,/actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444/);
});
