import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  FOCUS_REFRESH_INTERVAL_MS,hasInterruptionRisk,shouldRefreshOnFocus,
} from '../dist/src/ui/safety-policy.js';
import {MAX_PDF_BYTES,MAX_PDF_PAGES,assertPdfLimits,parsePdfFile} from '../dist/src/importers/pdf-reader.js';

const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const payroll=readFileSync(new URL('../src/ui/assets-settings.ts',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');

const safe={busy:[],unsaved:[]};
test('focus auto-refresh only checks once per 3 minutes; manual refresh remains independent',()=>{
  assert.equal(FOCUS_REFRESH_INTERVAL_MS,180000);
  assert.equal(shouldRefreshOnFocus(30_000,0,true,false,safe),false);
  assert.equal(shouldRefreshOnFocus(180_000,0,true,false,safe),true);
  assert.equal(shouldRefreshOnFocus(200_000,0,false,false,safe),false);
  assert.equal(shouldRefreshOnFocus(200_000,0,true,true,safe),false);
  assert.equal(shouldRefreshOnFocus(200_000,0,true,false,{busy:['saving'],unsaved:[]}),false);
  assert.equal(shouldRefreshOnFocus(200_000,0,true,false,{busy:[],unsaved:['draft']}),false);
  assert.match(main,/lastCloudCheckAt=Date\.now\(\); \/\/ Throttle retries even when the network is down/);
  assert.match(main,/async function refreshCloud\(\)[\s\S]*?assertRefreshSafe\(\)/);
});

test('lock, refresh, sign-in, and beforeunload share the interruption state',()=>{
  assert.equal(hasInterruptionRisk({busy:[],unsaved:[]}),false);
  assert.equal(hasInterruptionRisk({busy:['upload'],unsaved:[]}),true);
  assert.equal(hasInterruptionRisk({busy:[],unsaved:['draft']}),true);
  for(const reason of ['batchBusy','filesBusy','revisionBusy','rulesBusy','categorySaving',
    'assetsUi?.isBusy()','subscriptionsUi?.isBusy()','cardSettingsUi?.isBusy()',
    'reportsUi?.isBusy()','liveVault?.isRotating','liveVault?.hasPendingYearBatch'])
    assert.ok(main.includes(reason),`Missing operation ${reason}`);
  assert.match(main,/onLock:\(\)=>\{\s*if\(!confirmInterruption\('ロック'\)\)return false/);
  assert.match(main,/hasUnsavedChanges:\(\)=>\{const state=interruptionState\(\)/);
  assert.match(main,/canNavigate:\(\)=>confirmInterruption\('認証画面へ移動'\)/);
  assert.match(main,/window\.addEventListener\('beforeunload',[\s\S]*?hasInterruptionRisk\(state\)/);
  assert.match(main,/if\(reportsUi\?\.isDirty\(\)\)unsaved\.push/);
});

test('oversized and excessive-page PDFs are rejected before extraction',async()=>{
  assert.equal(MAX_PDF_BYTES,15*1024*1024);
  assert.equal(MAX_PDF_PAGES,80);
  assert.doesNotThrow(()=>assertPdfLimits(MAX_PDF_BYTES,80));
  assert.throws(()=>assertPdfLimits(0),/15MB/);
  assert.throws(()=>assertPdfLimits(MAX_PDF_BYTES+1),/15MB/);
  assert.throws(()=>assertPdfLimits(100,81),/80ページ/);
  await assert.rejects(parsePdfFile({size:MAX_PDF_BYTES+1}),/15MB/);
  const code=readFileSync(new URL('../src/importers/pdf-reader.ts',import.meta.url),'utf8');
  assert.ok(code.indexOf('assertPdfLimits(file.size)')<code.indexOf('file.arrayBuffer()'));
  assert.match(code,/try \{\s*const pdf\s*=\s*await task.promise;\s*assertPdfLimits\(file.size,pdf.numPages\)/);
  assert.match(code,/finally \{ await task.destroy\(\); \}/);
});

test('stale Payroll data are retained in memory but excluded until explicit opt-in',()=>{
  assert.match(payroll,/const lastVerified=payrollOwner===vault&&payrollSyncedAt>0/);
  assert.match(payroll,/payrollStale=lastVerified/);
  assert.match(payroll,/if\(!lastVerified\)\{payrollOwner=null;payrollIncome=\[\];payrollSyncedAt=0;\}/);
  assert.match(payroll,/payrollStale&&payrollUseStale&&payrollOwner===vault/);
  assert.match(payroll,/payrollUseStale=\(event.target as HTMLInputElement\).checked/);
  assert.match(payroll,/payrollStale=false;payrollUseStale=false/);
  assert.match(html,/id="assets-payroll-stale"/);
  assert.match(html,/id="assets-payroll-use-stale" type="checkbox"/);
});
