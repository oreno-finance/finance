import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('public/index.html', root), 'utf8');
const css = await readFile(new URL('public/styles/style.css', root), 'utf8');
const script = await readFile(new URL('src/ui/assets-settings.ts', root), 'utf8');

const settings = html.slice(html.indexOf('id="settings-view"'));

test('Payroll is a compact metrics-only card alongside connect and deposit forms',async()=>{
  assert.match(settings,/<section id="assets-payroll-summary" class="assets-payroll-history-card" aria-label="Payroll同期状況">/);
  assert.match(settings,/<div class="assets-payroll-layout">[\s\S]*?id="assets-payroll-connect"[\s\S]*?id="assets-payroll-deposit-form"[\s\S]*?id="assets-payroll-summary"/);
  assert.match(script,/const haveLast=payrollOwner===vault&&payrollSyncedAt>0/);
  assert.doesNotMatch(script,/months\.replaceChildren\(\)|incomeByMonth\(/);
  const layout=await readFile(new URL('public/styles/navigation-payroll-v1915.css',root),'utf8');
  assert.match(layout,/overflow:visible!important/);
});

test('Settings exposes only sync diagnostics rather than salary amounts', () => {
  const payrollSection = settings.slice(settings.indexOf('id="settings-payroll-disclosure"'), settings.indexOf('<footer>'));
  assert.doesNotMatch(payrollSection, /総手取り|月別の給与実績|assets-payroll-net|amounts\.netPay/);
  assert.match(payrollSection, /id="assets-payroll-count"/);
  assert.match(payrollSection, /id="assets-payroll-last"/);
  assert.doesNotMatch(settings, /id="assets-payroll-months"/);
  assert.doesNotMatch(script, /\$\('assets-payroll-net'\)|yen\(amounts\.netPay\)/);
  assert.match(script, /renderAccounts\(\);renderPayroll\(\)/); // account forecasting still refreshed
});

test('Password-change help text no longer claims a connection is required before an action', () => {
  assert.match(settings, /<p id="cloud-rotate-status" class="cloud-status" role="status" aria-live="polite"><\/p>/);
  assert.doesNotMatch(settings, /変更にはMicrosoftアカウントへの接続と保管庫のロック解除が必要です。/);
  assert.match(css, /\.cloud-rotate-panel #cloud-rotate-status:empty\{display:none\}/);
});
