import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
test('card optional controls use one two-column row with only field labels',()=>{
 const card=read('src/ui/card-settings.ts'),css=read('public/styles/layout-v195.css');
 assert.match(card,/field\('還元率（%）',rate\)/);
 assert.match(card,/field\('ホームの明細確定案内',mode\)/);
 assert.match(card,/extras\.append\(points,reminder\);panel\.append\(extras\)/);
 assert.doesNotMatch(card,/make\('h3','card-setting-section-heading','累計獲得ポイント/);
 assert.match(css,/card-setting-secondary-fields\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(css,/@media\(max-width:720px\)/);
});
test('monthly summary, reports and analytics all use same month navigator controls',()=>{
 const html=read('public/index.html');const reports=read('src/ui/monthly-reports.ts');const analysis=read('src/ui/analysis.ts');
 const navigator=read('src/ui/period-navigator.ts'),css=read('public/styles/layout-v195.css');
 assert.match(html,/monthly-controls finance-period-nav/);
 assert.match(reports,/monthNavigator\(selected,choosePeriod/);
 assert.match(analysis,/monthNavigator\(end/);
 assert.match(analysis,/yearNavigator\(year/);
 assert.match(navigator,/create\('‹','前月'/);
 assert.match(navigator,/create\('›','翌月'/);
 assert.match(navigator,/今月/);
 assert.match(css,/\.finance-period-nav>button,\.finance-period-nav>input,\.finance-period-nav>select/);
});
test('bank timeline expand link is neutral and import CSV notice has been removed',()=>{
 const bank=read('public/styles/bank-chart-v184.css'),html=read('public/index.html');
 assert.match(bank,/\.monthly-bank-all>summary\{[^}]*color:var\(--ink\)/);
 assert.doesNotMatch(html,/三井住友カードNL・Amazon・ヨドバシは確定CSVに対応/);
});
test('only navigation from home shows assets return control',()=>{
 const html=read('public/index.html'),main=read('src/main.ts');
 assert.match(html,/id="assets-back-home" class="secondary-action hidden"/);
 assert.match(main,/view==='assets'\)\?view:null/);
 assert.match(main,/returnToHome!=='assets'/);
 assert.match(main,/\$\('assets-back-home'\)\.addEventListener\('click',\(\)=>showView\('home'\)\)/);
});
test('drilldown layout is isolated to analysis-origin manager and scrolls normally',()=>{
 const css=read('public/styles/drilldown-v190.css'),settings=read('public/styles/settings-v194.css');
 assert.match(css,/#manage-view\.manage-with-drilldown>\.manage-grid\{display:grid/);
 assert.doesNotMatch(css,/manage-breakdown-(?:totals|recurring)/);
 assert.match(css,/\.workspace>\.content:has\(#manage-view\.manage-with-drilldown:not\(\.hidden\)\)/);
 assert.doesNotMatch(settings,/One analysis drilldown/);
});
