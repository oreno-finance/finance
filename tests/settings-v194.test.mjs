import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {estimateCardPoints} from '../dist/src/summary/card-points.js';
import {validateCardPreferences} from '../dist/src/cloud/assets.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const transaction=(cardId,amount,confirmation='confirmed')=>({statement:{cardId,confirmation,rows:[{amount}]}});

test('cumulative points use imported bill totals, including signed refunds and multiple cards',()=>{
 const items=[transaction('smbc-nl',10000),transaction('smbc-nl',20000),transaction('smbc-nl',-5000),transaction('amazon',100000)];
 assert.deepEqual(estimateCardPoints(items,'smbc-nl',1.2),{sumYen:25000,rows:3,statements:3,points:300,provisional:0});
 assert.equal(estimateCardPoints(items,'amazon',1.5).points,1500);
 assert.equal(estimateCardPoints(items,'goldpoint',1).points,0);
 assert.equal(estimateCardPoints(items,'smbc-nl',undefined).points,null);
 const unknown=estimateCardPoints([transaction('smbc-nl',1000,'provisional')],'smbc-nl',1);
 assert.equal(unknown.provisional,1);
});

test('point rates are opt-in, accept decimals, and reject invalid or impossible values',()=>{
 assert.equal(validateCardPreferences({'smbc-nl':{pointRatePercent:0.5}})['smbc-nl'].pointRatePercent,0.5);
 assert.equal(validateCardPreferences({'amazon':{pointRatePercent:1.2}}).amazon.pointRatePercent,1.2);
 assert.equal(validateCardPreferences({'goldpoint':{pointRatePercent:0}}).goldpoint.pointRatePercent,0);
 for(const rate of [-1,101,NaN,Infinity,'1.2',0.001])
  assert.throws(()=>validateCardPreferences({'smbc-nl':{pointRatePercent:rate}}),/還元率/);
});

test('active UI uses shared arrows, settings inputs and one atomic save; outdated CSS removed from imports',()=>{
 const html=read('public/index.html'),settings=read('public/styles/settings-v194.css');
 const shared=read('public/styles/ui-v152.css'),sidebar=read('public/styles/ui-v153.css');
 const card=read('src/ui/card-settings.ts'),reports=read('src/ui/monthly-reports.ts');
 assert.match(styleOrder,/styles\/settings-v194\.css/);
 assert.doesNotMatch(html,/styles\/(?:settings-v193|ui-v194|card-settings-v171|card-settings-v192)\.css/);
 assert.match(shared,/details > summary::after/);
 assert.doesNotMatch(settings,/summary::after\{/);
 assert.doesNotMatch(sidebar,/\.sidebar \.sidebar-group>summary::before/);
 assert.match(settings,/card-setting-flat-section/);
 assert.doesNotMatch(card,/createElement\('details'\)/);
 assert.match(card,/setCardConfiguration\(next,nextDebit\)/);
 assert.doesNotMatch(html,/id="assets-card-debits-form"/);
 assert.match(reports,/reports-purpose/);
 assert.match(reports,/el\('details','reports-detail'\)/);
 assert.match(reports,/el\('details','reports-detail reports-history'\)/);
});

class Storage {
 constructor(){this.rows=new Map();this.assetWrites=0;}
 read(key){const x=this.rows.get(key);return x?{text:x.text,id:key,etag:`"${x.version}"`}:null;}
 write(key,text,ref){const old=this.rows.get(key);
  if((old&&(!ref||ref.etag!==`"${old.version}"`))||(!old&&ref))throw new GraphError(412,'conflict');
  const version=(old?.version??0)+1;this.rows.set(key,{text,version});return {id:key,etag:`"${version}"`};}
 async readFinanceIndex(){return this.read('index');}
 async writeFinanceIndex(text,ref){return this.write('index',text,ref);}
 async readLiveVault(){return null;}
 async ensurePayrollNamespace(){}
 async listYearFiles(){return [];}
 async readMerchantRules(){return null;}
 async readAssetSettings(){return this.read('assets');}
 async writeAssetSettings(text,ref){this.assetWrites++;return this.write('assets',text,ref);}
}

test('single encrypted OneDrive write saves both point rate and card withdrawal account',async()=>{
 const graph=new Storage(),vault=new LiveVault(graph);await vault.create('safe test passphrase 2026!');
 const before=graph.assetWrites;
 await vault.setCardConfiguration({'smbc-nl':{pointRatePercent:1.2,payment:{day:27,monthOffset:1}}},{'smbc-nl':'rakuten-bank'});
 assert.equal(graph.assetWrites-before,1,'both fields must be saved in one assets write');
 assert.equal(vault.assetSettings().cardPreferences['smbc-nl'].pointRatePercent,1.2);
 assert.equal(vault.assetSettings().cardDebitAccounts['smbc-nl'],'rakuten-bank');
 assert.doesNotMatch(graph.rows.get('assets').text,/rakuten-bank|pointRatePercent|1\.2/);
 const second=new LiveVault(graph);await second.unlock('safe test passphrase 2026!');
 assert.equal(second.assetSettings().cardPreferences['smbc-nl'].payment.day,27);
 assert.equal(second.assetSettings().cardPreferences['smbc-nl'].pointRatePercent,1.2);
 assert.equal(second.assetSettings().cardDebitAccounts['smbc-nl'],'rakuten-bank');
});

test('an enabled Mizuho transfer plan refuses a conflicting debit account configuration',async()=>{
 const graph=new Storage(),vault=new LiveVault(graph);await vault.create('safe test passphrase 2026!');
 await vault.setMizuhoTransferPlan({enabled:true,leadDays:3,extraForSmallBills:true});
 const before=graph.assetWrites;
 await assert.rejects(()=>vault.setCardConfiguration({}, {'rakuten-mizuho':'rakuten-bank'}),/みずほ銀行/);
 assert.equal(graph.assetWrites,before,'rejected change must not write anything');
 await vault.setCardConfiguration({}, {'rakuten-mizuho':'mizuho-bank'});
 assert.equal(vault.assetSettings().cardDebitAccounts['rakuten-mizuho'],'mizuho-bank');
});


test('card basics show name and debit account side by side without redundant help copy',()=>{
 const card=read('src/ui/card-settings.ts'),css=read('public/styles/settings-v194.css');
 assert.match(card,/basicFields\.append\(field\('表示名',name\),field\('引落口座',debit\)\)/);
 assert.match(css,/\.card-setting-basic-fields\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(css,/@media\(max-width:720px\)\{\.card-setting-basic-fields\{grid-template-columns:1fr\}/);
 for(const legacy of ['空欄なら標準のカード名','引き落とされる口座','口座管理の残高予測に','card-setting-guidance'])
  assert.doesNotMatch(card,new RegExp(legacy));
});
