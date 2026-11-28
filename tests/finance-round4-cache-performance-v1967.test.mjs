import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {OneDriveTestClient,GraphError} from '../dist/src/cloud/onedrive-api.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {emptyAssets} from '../dist/src/cloud/assets.js';
import {emptyIndex} from '../dist/src/cloud/layout.js';
import {deriveCloudKey,encryptIndex,encryptAssets,freshSalt} from '../dist/src/cloud/cloud-crypto.js';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {homeOverview} from '../dist/src/home/overview.js';
import {mizuhoFundingStatusForMonth} from '../dist/src/home/mizuho-funding.js';
import {pointBenefitsFromMonthlyReport,periodPointBenefitsFromReports,monthlyPointBenefits,periodPointBenefits} from '../dist/src/summary/point-benefits.js';
import {annualAnalytics} from '../dist/src/analysis/period-analytics.js';
import {clearFinancePerformance,financePerformanceReport,measureFinanceSync} from '../dist/src/cloud/performance-diagnostics.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const GRAPH='https://graph.microsoft.com/v1.0';
const original='12345678-1234-1234-1234-123456789abc';

/** Local fake Graph: no account sign-in, no real network, no personal data. */
function fakeDrive(){
  const folders=new Map([
    ['root/finance','f'],['f/statements','s'],['f/settings','a'],
    ['f/originals','o'],['o/2026','y'],['y/11','m'],
  ]);
  const files=new Map();const stats={gets:0,downloads:0,retries:0};
  const http=async (url,init={})=>{
    if(url===GRAPH+'/me/drive/special/approot')return Response.json({id:'root'});
    if(url.startsWith('https://files.test/')){
      stats.downloads++;
      assert.equal(init.headers?.Authorization,undefined);
      assert.equal(init.credentials,'omit');
      const file=[...files.values()].find(x=>x.id===url.slice('https://files.test/'.length));
      return file?new Response(file.text):new Response('',{status:404});
    }
    stats.gets++;
    const match=url.match(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/items\/([^:]+):\/([^?]+)$/);
    if(!match)throw Error('unrecognized test request');
    const [,parent,name]=match;
    const folder=folders.get(`${parent}/${decodeURIComponent(name)}`);
    if(folder)return Response.json({id:folder,folder:{}});
    const file=files.get(`${parent}/${decodeURIComponent(name)}`);
    return file?Response.json({id:file.id,eTag:file.etag,size:file.text.length,
      '@microsoft.graph.downloadUrl':`https://files.test/${file.id}`}):Response.json({error:{code:'itemNotFound'}},{status:404});
  };
  let serial=0;
  const add=(parent,name,text)=>{const file={id:`item-${++serial}`,etag:'"1"',text};files.set(`${parent}/${name}`,file);return file;};
  return {api:new OneDriveTestClient('stub',http),http,folders,files,stats,add};
}

test('PDF originals bypass the in-memory ciphertext cache on repeated downloads',async()=>{
  const f=fakeDrive();f.add('m',`${original}.enc`,'ciphertext-only');
  assert.equal(await f.api.downloadDatedOriginal(original,'2026-11'),'ciphertext-only');
  assert.equal(await f.api.downloadDatedOriginal(original,'2026-11'),'ciphertext-only');
  assert.equal(f.stats.downloads,2,'an original must be downloaded each time');
  assert.equal(f.api.encryptedReadCache.size,0);
});

test('ciphertext cache has a true memory budget, including UTF-16 string overhead',async()=>{
  const f=fakeDrive();
  f.add('s','2025.enc','a'.repeat(3*1024*1024));
  f.add('s','2026.enc','b'.repeat(3*1024*1024));
  f.add('s','2027.enc','c'.repeat(5*1024*1024));
  await f.api.readYearVault('2025');await f.api.readYearVault('2026');await f.api.readYearVault('2027');
  assert.ok([...f.api.encryptedReadCache.values()].reduce((sum,v)=>sum+v.text.length*2,0)<=8*1024*1024);
  assert.ok(f.api.encryptedReadCache.size<=12);
  const before=f.stats.downloads;
  await f.api.readYearVault('2025');
  assert.equal(f.stats.downloads,before+1,'evicted data must not be reused blindly');
});

test('stale folder ID is re-resolved via fresh Graph path, not mistaken for a missing settings file',async()=>{
  const f=fakeDrive();f.add('a','assets.enc','encrypted-settings');
  assert.equal((await f.api.readAssetSettings()).text,'encrypted-settings');
  f.folders.set('f/settings','a-new');
  const file=f.files.get('a/assets.enc');f.files.delete('a/assets.enc');f.files.set('a-new/assets.enc',file);
  assert.equal((await f.api.readAssetSettings()).text,'encrypted-settings');
  assert.ok(f.stats.gets>4);
});

test('verified assets disappearing cannot downgrade a running unlocked vault to empty defaults',async()=>{
  const salt=freshSalt(),key=await deriveCloudKey('plain language passphrase for a test',salt);
  let present=true;
  const index=await encryptIndex(emptyIndex(),key,salt);
  const encrypted=await encryptAssets({...emptyAssets(),birthMonth:'2003-05'},key,salt);
  const client={setVaultDataSet(){},async readFinanceIndex(){return {text:index,id:'idx',etag:'"1"'};},
    async listYearFiles(){return [];},async readMerchantRules(){return null;},
    async readAssetSettings(){return present?{text:encrypted,id:'a',etag:'"1"'}:null;}};
  const vault=new LiveVault(client);await vault.unlock('plain language passphrase for a test');
  assert.equal(vault.assetSettings().birthMonth,'2003-05');
  present=false;
  await assert.rejects(vault.refresh(),/消失|上書きしません/);
  assert.equal(vault.assetSettings().birthMonth,'2003-05','failed refresh must not publish empty assets');
});

test('GET 429 and 503 retry is bounded, and POST is never replayed',async()=>{
  let calls=0;
  const client=new OneDriveTestClient('dummy',async()=>{
    calls++;
    return calls===1?Response.json({error:{code:'throttled'}},{status:429}):
      calls===2?Response.json({error:{code:'serviceUnavailable'}},{status:503}):Response.json({id:'root'});
  });
  assert.equal((await client.graph('/fake')).status,200);assert.equal(calls,3);
  calls=0;
  const posting=new OneDriveTestClient('dummy',async()=>{calls++;return Response.json({error:{code:'serviceUnavailable'}},{status:503});});
  await assert.rejects(posting.graph('/fake',{method:'POST'}),err=>err instanceof GraphError&&err.status===503);
  assert.equal(calls,1);
});

test('large original download has longer deadline; ordinary encrypted documents retain 30 seconds',async()=>{
  const f=fakeDrive();
  const captured=[];const originalDeadline=f.api.withReadDeadline.bind(f.api);
  f.api.withReadDeadline=(url,init,consume,timeout)=>{
    captured.push({url,timeout});return originalDeadline(url,init,consume,timeout);
  };
  f.add('m',`${original}.enc`,'ciphertext');
  f.add('s','2025.enc','year');
  await f.api.downloadDatedOriginal(original,'2026-11');
  await f.api.readYearVault('2025');
  assert.ok(captured.some(x=>x.url.startsWith('https://files.test/')&&x.timeout>=90000));
  assert.ok(captured.some(x=>x.url.startsWith('https://files.test/')&&x.timeout===30000));
});

const record=(id,paymentDate,amount,usedOn=paymentDate)=>({id,originalId:null,statement:{
  provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'csv',sourceName:'mock.csv',
  billingMonth:paymentDate==='2026-11-27'?'2026-10':'2026-09',paymentDate,statedTotal:amount,
  confirmation:'confirmed',warnings:[],rows:[{id:`row-${id}`,usedOn,merchant:'SYNTHETIC SHOP',amount}],
}});
const baseSource=(records)=>({records,rules:[],categories:[],assets:{nisaCardRule:null,recurring:[],oneTime:[],snapshots:[],
    mizuhoTransferPlan:{enabled:true,leadDays:3,extraForSmallBills:true},cardDebitAccounts:{'rakuten-mizuho':'mizuho-bank'},
    cardPreferences:{'rakuten-mizuho':{pointRatePercent:1,pointRateHistory:[{effectiveOn:'1900-01-01',ratePercent:2},{effectiveOn:'2026-11-01',ratePercent:1}]}}},
  payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'});

test('cached monthly reports preserve historical point rates and month-specific rounding',()=>{
  const s=baseSource([record('a','2026-10-27',199,'2026-10-03'),record('b','2026-11-27',999,'2026-11-04')]);
  for(const period of ['2026-10','2026-11']){
    assert.deepEqual(pointBenefitsFromMonthlyReport(monthlyReport(period,s),s),monthlyPointBenefits(period,s));
  }
  const periods=['2026-10','2026-11'];
  assert.deepEqual(periodPointBenefitsFromReports(periods.map(period=>monthlyReport(period,s)),s),periodPointBenefits(periods,s));
});

test('unconfirmed previous month remains actionable after rollover and its status does not alter financial forecasts',()=>{
  const records=[record('a','2026-11-27',24245)];
  const s=baseSource(records);
  const current=homeOverview(s,'2026-12-03');
  assert.equal(current.priorFundingReport?.period,'2026-11');
  const prior=mizuhoFundingStatusForMonth(s,current.priorFundingReport,'2026-12-03');
  assert.equal(prior?.month,'2026-11');assert.equal(prior?.completed,false);assert.equal(prior?.overdue,true);
  assert.equal(prior?.periodOpen,true);
  const done={...s,assets:{...s.assets,mizuhoFundingChecks:{'2026-11':{done:true,updatedAt:'2026-11-23T00:00:00.000Z'}}}};
  // Phase 7: a legacy done-only receipt does not prove that the current bill was funded.
  const legacyReport=homeOverview(done,'2026-12-03').priorFundingReport;
  assert.equal(legacyReport?.period,'2026-11');
  const legacyStatus=mizuhoFundingStatusForMonth(done,legacyReport,'2026-12-03');
  assert.equal(legacyStatus?.completed,false);
  assert.equal(legacyStatus?.changedSinceCheck,true);
  const verified={...s,assets:{...s.assets,mizuhoFundingChecks:{'2026-11':{
    done:true,updatedAt:'2026-11-23T00:00:00.000Z',
    billAmount:24245,paymentDate:'2026-11-27',transferAmount:30000,billId:'a'
  }}}};
  const verifiedReport=homeOverview(verified,'2026-12-03').priorFundingReport;
  assert.equal(verifiedReport?.period,'2026-11');
  assert.equal(mizuhoFundingStatusForMonth(verified,verifiedReport,'2026-12-03')?.completed,true);
  assert.deepEqual(homeOverview(s,'2026-12-03').forecast,homeOverview(done,'2026-12-03').forecast);
});

test('whole-render and points/chart phase timings remain aggregate-only, with no financial contents',()=>{
  clearFinancePerformance();
  for(const name of ['ui.home.render','ui.home.points','ui.analysis.render','ui.analysis.points','ui.analysis.chart'])
    assert.equal(measureFinanceSync(name,()=>1),1);
  const metrics=financePerformanceReport();
  for(const name of ['ui.home.render','ui.home.points','ui.analysis.render','ui.analysis.points','ui.analysis.chart'])
    assert.equal(metrics.phases[name].count,1);
  assert.doesNotMatch(JSON.stringify(metrics),/passphrase|ciphertext|SYNTHETIC SHOP|2026-11-27/);
  const home=readFileSync('src/ui/home.ts','utf8'),analysis=readFileSync('src/ui/analysis.ts','utf8');
  assert.match(home,/measureFinanceSync\('ui\.home\.render'/);
  assert.match(analysis,/measureFinanceSync\('ui\.analysis\.render'/);
  assert.match(analysis,/periodPointBenefitsFromReports\(data\.months\.map\(m=>m\.report\),source\)/);
});

test('v2.2.1: missing optional rules recheck the path but preserve unrelated folder IDs',async()=>{
 const f=fakeDrive();f.folders.set('f/rules','r');f.add('a','assets.enc','settings');f.add('s','2026.enc','year');
 await f.api.readAssetSettings();await f.api.readYearVault('2026');
 assert.equal(await f.api.readMerchantRules(true),null);
 assert.equal(await f.api.readMerchantRules(true),null);
 let before=f.stats.gets;await f.api.readAssetSettings(true);assert.equal(f.stats.gets-before,1);
 before=f.stats.gets;await f.api.readYearVault('2026');assert.equal(f.stats.gets-before,1);
 // A moved branch is re-resolved rather than keeping a stale ID.
 f.folders.set('f/rules','r-new');f.add('r-new','merchants.enc','new rules');
 assert.equal((await f.api.readMerchantRules(true)).text,'new rules');
 before=f.stats.gets;await f.api.readAssetSettings(true);assert.equal(f.stats.gets-before,1);
});

test('v2.2.1: a replaced common ancestor invalidates its other cached descendants',async()=>{
 const f=fakeDrive();f.folders.set('f/rules','r');f.add('a','assets.enc','old settings');
 await f.api.readAssetSettings();await f.api.readMerchantRules(true);
 f.folders.set('root/finance','f-new');f.folders.set('f-new/rules','r-new');f.folders.set('f-new/settings','a-new');
 f.add('r-new','merchants.enc','new rules');f.add('a-new','assets.enc','new settings');
 assert.equal((await f.api.readMerchantRules(true)).text,'new rules');
 assert.equal((await f.api.readAssetSettings(true)).text,'new settings');
});
