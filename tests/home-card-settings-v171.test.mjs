import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emptyAssets,validateAssets,validateCardPreferences,mergeAssets,detectAssetsEditCollisions,describeAssetsEditCollisions} from '../dist/src/cloud/assets.js';
import {statementReviewDate,homeActions} from '../dist/src/home/action-items.js';
import {homeOverview} from '../dist/src/home/overview.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {forecastAccounts} from '../dist/src/home/account-events.js';

const deep=v=>structuredClone(v);
const rawRecord=(confirmation='provisional')=>({
 id:'statement-a',statement:{cardId:'smbc-nl',provider:'smbc',sourceKind:'paste',sourceName:'test',
 billingMonth:'2026-10',paymentDate:'2026-11-27',statedTotal:1000,confirmation,
 warnings:[],rows:[{id:'row-a',usedOn:'2026-10-05',merchant:'Test',amount:1000}]}
});
const source=(pref={})=>({records:[rawRecord()],rules:[],categories:[],assets:{...emptyAssets(),cardPreferences:pref},
 payroll:{ready:true,syncedAt:Date.parse('2026-11-18T00:00:00Z'),entries:[]}});

test('assets-v1 old documents still validate without new card preferences',()=>{
 const doc=validateAssets(emptyAssets());assert.equal(doc.cardPreferences,undefined);
});
test('card preferences validate card names, issuer, bounds and known card IDs',()=>{
 const result=validateCardPreferences({'smbc-nl':{name:'  普段用  ',issuer:'jcb',review:{monthOffset:-1,day:31}}});
 assert.equal(result['smbc-nl'].name,'普段用');
 for(const value of [
   {'not-valid':{name:'foo'}},
   {'smbc-nl':{name:'   '}},
   {'smbc-nl':{issuer:'other'}},
   {'smbc-nl':{review:{monthOffset:-2,day:15}}},
   {'smbc-nl':{review:{monthOffset:0,day:0}}},
   {'smbc-nl':{review:{monthOffset:0,day:32}}},
   {'smbc-nl':{review:{monthOffset:0,day:1.5}}},
 ]) assert.throws(()=>validateCardPreferences(value));
});
test('custom notice date respects payment month, previous month, leap days and disabled guidance',()=>{
 assert.equal(statementReviewDate('smbc-nl','2027-03-10',{review:{monthOffset:-1,day:31}}),'2027-02-28');
 assert.equal(statementReviewDate('smbc-nl','2028-03-10',{review:{monthOffset:-1,day:31}}),'2028-02-29');
 assert.equal(statementReviewDate('smbc-nl','2027-01-10',{review:{monthOffset:-1,day:20}}),'2026-12-20');
 assert.equal(statementReviewDate('smbc-nl','2026-11-27',{issuer:'jcb'}),'2026-10-25');
 assert.equal(statementReviewDate('smbc-nl','2026-11-27',{review:null}),null);
 assert.equal(statementReviewDate('smbc-nl','2026-11-27'),'2026-11-11');
});
test('home notice honors review date, selected name and opt-out, never writes source data',()=>{
 const s=source({'smbc-nl':{name:'生活用カード',review:{monthOffset:0,day:30}}});
 const before=JSON.stringify(s);
 let model=homeOverview(s,'2026-11-20');
 assert.equal(model.actions.some(a=>a.kind==='provisional'),false);
 model=homeOverview(s,'2026-12-01');
 const notice=model.actions.find(a=>a.kind==='provisional');
 assert.match(notice.title,/生活用カード/);
 assert.equal(model.cardNames['smbc-nl'],'生活用カード');
 assert.equal(JSON.stringify(s),before);
 s.assets.cardPreferences['smbc-nl'].review=null;
 assert.equal(homeOverview(s,'2026-12-01').actions.some(a=>a.kind==='provisional'),false);
});
test('monthly summary follows custom display name without changing payment-date cashflow',()=>{
 const s=source({'smbc-nl':{name:'生活用カード'}});
 const report=monthlyReport('2026-11',s);
 assert.equal(report.cardLines[0]?.name,'生活用カード');
 assert.equal(report.cardOutflow,1000);
 assert.equal(monthlyReport('2026-10',s).cardOutflow,null);
});
test('different cards changed on different devices safely merge',()=>{
 const base=emptyAssets(), local=deep(base),remote=deep(base);
 local.cardPreferences={'smbc-nl':{name:'生活用カード'}};
 remote.cardPreferences={'amazon':{issuer:'jcb',review:{monthOffset:-1,day:20}}};
 assert.deepEqual(detectAssetsEditCollisions(base,local,remote),[]);
 const merged=mergeAssets(base,local,remote);
 assert.deepEqual(merged.cardPreferences,{...local.cardPreferences,...remote.cardPreferences});
});
test('same card changed simultaneously shows explicit collision and other settings survive',()=>{
 const base=emptyAssets(),local=deep(base),remote=deep(base);
 local.cardPreferences={'smbc-nl':{review:{monthOffset:0,day:11}}};
 remote.cardPreferences={'smbc-nl':{review:{monthOffset:0,day:12}}};
 const conflicts=detectAssetsEditCollisions(base,local,remote);
 assert.deepEqual(conflicts,[{itemId:'card-preferences',field:'smbc-nl'}]);
 const details=describeAssetsEditCollisions(base,local,remote,conflicts);
 assert.match(details[0].label,/カード設定/);
 const merged=mergeAssets(base,local,remote);
 assert.equal(merged.cardPreferences['smbc-nl'].review.day,11);
 assert.equal(merged.conflicts.at(-1).itemId,'card-preferences');
});
test('UI removes home shortcuts and centered max width, adds conditional return and card settings',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
 const home=readFileSync(new URL('../src/ui/home.ts',import.meta.url),'utf8');
 const css=readFileSync(new URL('../public/styles/home-v171.css',import.meta.url),'utf8');
 assert.doesNotMatch(home,/よく使う機能/);
 assert.match(css,/max-width:none/);
 assert.match(css,/manage-return-bar:has\(>button:not\(\.hidden\)\)/);
 assert.match(html,/id="manage-back-home" class="secondary-action hidden"/);
 assert.match(html,/id="import-back-home" class="secondary-action hidden"/);
 assert.match(html,/id="settings-card-form"/);
 assert.ok(html.indexOf('id="settings-card-disclosure"')<html.indexOf('id="settings-payroll-disclosure"'));
 assert.match(main,/homeNavigationPending=true;showView\(destination\)/);
 assert.match(main,/returnToHome=fromHome/);
});

test('missing statement reminders are per card, start on its review day, and stop only for that card',()=>{
 const s=source({'smbc-nl':{review:{monthOffset:0,day:5}},'amazon':{review:{monthOffset:0,day:5}}});
 s.records=[];
 const notices=day=>homeOverview(s,day).actions.filter(a=>a.kind==='provisional'||(a.kind==='missing-statements'&&a.id.endsWith('|2026-11')));
 assert.equal(notices('2026-11-04').length,0);
 assert.deepEqual(notices('2026-11-05').map(a=>a.id),['missing-statements:amazon|2026-11','missing-statements:smbc-nl|2026-11']);
 assert.ok(notices('2026-11-05').every(a=>a.target==='import'));
 s.records.push(rawRecord());
 assert.deepEqual(notices('2026-11-05').map(a=>a.id),['missing-statements:amazon|2026-11','provisional:smbc-nl|2026-10']);
 s.records[0].statement.confirmation='confirmed';
 assert.deepEqual(notices('2026-11-05').map(a=>a.id),['missing-statements:amazon|2026-11']);
 s.assets.cardPreferences.amazon.review=null;
 assert.equal(notices('2026-11-05').length,0);
});

test('next payment month reminders use previous-month schedule, including year rollover',()=>{
 const s=source({'recruit-jcb':{review:{monthOffset:-1,day:25}},'smbc-nl':{payment:{monthOffset:0,day:10}}});
 s.records=[];
 const has=(day,card,period)=>homeOverview(s,day).actions.some(a=>a.id===`missing-statements:${card}|${period}`);
 assert.equal(has('2026-12-24','recruit-jcb','2027-01'),false);
 assert.equal(has('2026-12-25','recruit-jcb','2027-01'),true);
 assert.equal(has('2026-12-25','smbc-nl','2027-01'),false);
 assert.equal(has('2026-12-26','smbc-nl','2027-01'),true);
 s.assets.cardNoUseMonths=['2027-01'];
 assert.equal(has('2026-12-26','smbc-nl','2027-01'),false);
 assert.equal(has('2026-12-26','recruit-jcb','2027-01'),false);
});

test('missing reminders require use or configuration, respect no-use, and avoid phantom missing cards',()=>{
 const s=source();s.records=[];
 const missing=()=>homeOverview(s,'2026-11-18').actions.filter(a=>a.kind==='missing-statements'&&a.id.endsWith('|2026-11'));
 assert.equal(missing().length,0);
 s.assets.cardDebitAccounts={'rakuten-mizuho':'mizuho-bank'};
 assert.deepEqual(missing().map(a=>a.id),['missing-statements:rakuten-mizuho|2026-11']);
 s.assets.cardNoUseMonths=['2026-11'];assert.equal(missing().length,0);
 s.assets.cardNoUseMonths=[];
 s.records.push({id:'zero',statement:{cardId:'rakuten-mizuho',provider:'rakuten',sourceKind:'pdf',sourceName:'sample',billingMonth:'2026-11',paymentDate:null,statedTotal:0,confirmation:'confirmed',zeroUsage:true,warnings:[],rows:[]}});
 assert.equal(missing().length,0);
 s.assets.cardPreferences={'rakuten-mizuho':{review:null}};assert.equal(missing().length,0);
});

test('previous payment month remains due across New Year, without duplicate or disabled notices',()=>{
 const s=source({'smbc-nl':{review:{monthOffset:0,day:5}},amazon:{review:{monthOffset:0,day:5}}});
 s.records=[];
 const ids=()=>homeOverview(s,'2027-01-01').actions.filter(a=>a.kind==='missing-statements').map(a=>a.id);
 assert.deepEqual(ids(),['missing-statements:amazon|2026-12','missing-statements:smbc-nl|2026-12']);
 s.records=[rawRecord('confirmed')];s.records[0].statement.paymentDate='2026-12-27';
 assert.deepEqual(ids(),['missing-statements:amazon|2026-12']);
 s.assets.cardPreferences.amazon.review=null;assert.deepEqual(ids(),[]);
 s.assets.cardPreferences.amazon.review={monthOffset:0,day:5};s.records=[];s.assets.cardNoUseMonths=['2026-12'];assert.deepEqual(ids(),[]);
});
