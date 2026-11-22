import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {monthlyPointBenefits,periodPointBenefits,pointBenefitsFromCards,pointsForAmount,statementPoints,pointRate} from '../dist/src/summary/point-benefits.js';
import {reportSnapshot,validateReportDocument,reportRevision,revisedDocument} from '../dist/src/reports/monthly-report.js';
import {futureProjection} from '../dist/src/cloud/future-projection.js';
const sourceFile=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const main=sourceFile('src/main.ts');const html=sourceFile('public/index.html');const css=sourceFile('public/styles/points-workspace-v1914.css');
const row=(id,merchant,amount)=>({id,usedOn:'2026-10-12',merchant,amount});
const rec=(id,cardId,bill,payment,amount)=>({id,originalId:null,statement:{provider:cardId.startsWith('rakuten')?'rakuten':'smbc',cardId,sourceKind:'csv',sourceName:'source.csv',billingMonth:bill,paymentDate:payment,statedTotal:amount,confirmation:'confirmed',warnings:[],rows:[row(`r-${id}`,'SHOP',amount)]}});
const records=[rec('a','rakuten-mizuho','2026-10','2026-11-27',10000),rec('b','smbc-nl','2026-10','2026-11-27',20000),rec('c','smbc-nl','2026-11','2026-12-27',10000)];
const source=(prefs={})=>({records,rules:[],categories:[],assets:{nisaCardRule:null,recurring:[],cardPreferences:prefs},payroll:{ready:true,syncedAt:1,entries:[]},currentPeriod:'2026-12'});
test('ポイントはカードID別、支払月別で計算し、月をまたぐ集計で丸め誤差を持ち越さない',()=>{
 const month=monthlyPointBenefits('2026-11',source());
 assert.equal(month.total,300);assert.deepEqual(Object.fromEntries(month.cards.map(c=>[c.cardId,c.points])),{'rakuten-mizuho':200,'smbc-nl':100});
 assert.equal(month.cards.find(c=>c.cardId==='smbc-nl').ratePercent,0.5);
 assert.equal(monthlyPointBenefits('2026-10',source()).cards.length,0);
 const period=periodPointBenefits(['2026-11','2026-12'],source());
 assert.equal(period.total,350);assert.equal(period.cards.find(c=>c.cardId==='smbc-nl').points,150);
});
test('カード別還元率の設定は優先され、異なる楽天カードは合算しない',()=>{
 const prefs={'smbc-nl':{pointRatePercent:1.75},'rakuten-mizuho':{pointRatePercent:2.5}};
 const benefit=monthlyPointBenefits('2026-11',source(prefs));assert.equal(benefit.total,600);
 assert.equal(pointRate('smbc-nl',prefs),1.75);
 assert.equal(pointBenefitsFromCards([{id:'a',cardId:'rakuten-etc',name:'楽天カード',billingMonth:'2026-10',paymentDate:'2026-11-27',confirmation:'confirmed',amount:10000},{id:'b',cardId:'rakuten-mizuho',name:'みずほ楽天カード',billingMonth:'2026-10',paymentDate:'2026-11-27',confirmation:'confirmed',amount:10000}],prefs).cards.length,2);
 assert.equal(pointsForAmount(10000,1.2),120);
 assert.equal(statementPoints({cardId:'smbc-nl',rows:[row('x','SHOP',10000)]},prefs),175);
});
test('無効な取引や重複月はポイント算定対象にならず返金はマイナス調整',()=>{
 assert.equal(monthlyPointBenefits('2026-11',{...source(),records:[records[0],records[0]]}).cards.length,0);
 assert.equal(pointsForAmount(-1000,2),0);
 assert.equal(pointsForAmount(399,0.5),1);
 assert.equal(pointBenefitsFromCards([{cardId:'smbc-nl',amount:1000,name:'NL'},{cardId:'smbc-nl',amount:-200,name:'NL'}]).cards[0].points,4);
});
test('月次レポートにはカード別ポイントが暗号化スナップショットに保存される',()=>{
 const snapshot=reportSnapshot('2026-11',source());
 assert.equal(snapshot.points.total,300);
 const rev=reportRevision(snapshot,'a'.repeat(64),'');
 const doc=revisedDocument(null,rev);
 assert.equal(validateReportDocument(doc).current.snapshot.points.cards.length,2);
 const legacy=structuredClone(doc);delete legacy.current.snapshot.points;
 assert.doesNotThrow(()=>validateReportDocument(legacy));
 const tampered=structuredClone(doc);tampered.current.snapshot.points.cards[0].points=-1;
 assert.throws(()=>validateReportDocument(tampered));
});
test('明細管理は手動保存のみ。下書きを切り替えても自動同期しない',()=>{
 const dirty=main.slice(main.indexOf('function markDirty('),main.indexOf('function dateDisplay('));
 assert.doesNotMatch(dirty,/saveEditedStatement|saveBatch|setTimeout/);
 assert.doesNotMatch(main,/autoSaveTimer/);
 assert.match(main,/\$\('manage-save'\)\.addEventListener\('click',[\s\S]*saveEditedStatement\(s,true\)/);
 assert.match(main,/if\(pending\(\)\.length\|\|failedImports\.length\)unsaved\.push/);
 assert.match(html,/id="manage-points"/);
 assert.match(css,/td\[data-label="利用日"\] input\{width:116px/);
});
test('取込下書きがある場合はアップロード欄が非表示となり、モーダルで追加できる',()=>{
 assert.match(html,/id="import-inline-entry"/);
 assert.match(html,/id="import-add-dialog"/);
 assert.match(main,/\$\('import-inline-entry'\)\.classList\.toggle\('hidden',compact\)/);
 assert.match(main,/classList\.toggle\('has-import-drafts',hasDrafts\)/);
 assert.match(css,/\.statement-index-panel>\.statement-list\{flex:1 1 auto!important/);
 assert.match(css,/\.transactions-panel-inner>\.table-scroll\{display:block!important;flex:1 1 0!important;min-height:0!important/);
 assert.match(css,/\.batch-bar\{order:3!important;flex:0 0 auto!important/);
});
test('ポイントの表示は明細管理のみで取込プレビューには出ない。4集計画面が共通コンポーネント利用',()=>{
 const imported=html.slice(html.indexOf('<div id="import-view">'),html.indexOf('<dialog id="import-revision-dialog"'));
 assert.doesNotMatch(imported,/id="manage-points"|points-benefits/);
 for(const path of ['src/ui/home.ts','src/ui/monthly-summary.ts','src/ui/analysis.ts','src/ui/monthly-reports.ts'])
  assert.match(sourceFile(path),/pointBenefitsSection\(/);
});
test('積立額変更の比較は変更開始月からのみ適用し、過去のNISA基準残高は変えない',()=>{
 const doc={format:'finance-assets-v1',snapshots:[
  {id:'s0',accountId:'cash-savings',balance:100000,observedAt:'2026-09-30T00:00:00Z'},
  {id:'s1',accountId:'nisa',balance:500000,observedAt:'2026-09-30T00:00:00Z'}],recurring:[],oneTime:[],nisaCardRule:null};
 const base={today:'2026-10-01',targetMonth:'2027-04',changeMonth:'2027-01',savingsRuleId:null,savingsAmount:0,nisaMonthly:10000,nisaAnnualReturn:0,nisaScenarioMonthly:20000};
 const result=futureProjection(doc,[],base);
 assert.equal(result.nisaStart,500000);
 for(const point of result.points.filter(p=>p.month<'2027-01'))assert.equal(point.nisa,point.nisaScenario);
 assert.ok(result.points.find(p=>p.month==='2027-03').nisaScenario>result.points.find(p=>p.month==='2027-03').nisa);
});
