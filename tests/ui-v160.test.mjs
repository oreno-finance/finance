import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const html=source('public/index.html');
const css=source('public/styles/ui-v160.css');
const main=source('src/main.ts');

test('mobile PDF chooser uses an intrinsic compact width without stretching',()=>{
  assert.doesNotMatch(css,/#pdf-pane \.dropzone[^}]*width:100%!important/);
  assert.match(source('public/styles/mobile-v151.css'),/#pdf-pane \.dropzone[^}]*width:auto!important;max-width:100%;height:44px!important/);
});
test('mobile manager statement list uses document scroll rather than nested scrolling',()=>{
  assert.match(css,/#manage-view \.manage-index \.statement-list\{height:auto!important;max-height:none!important;min-height:0!important/);
  assert.match(css,/overflow:visible!important;overscroll-behavior:auto!important/);
});
test('mobile manager transactions avoid overlapping row and panel outlines',()=>{
  assert.match(css,/#manage-view \.manage-editor \.transaction-table tbody tr\{[^}]*border:0!important;border-radius:0!important/s);
  assert.match(css,/#manage-view \.manage-editor \.transaction-table tbody tr\+tr\{border-top:1px solid var\(--line\)!important\}/);
});
test('mobile navigation header is sticky and accessible while document scrolls',()=>{
  assert.match(css,/#finance-sidebar\.sidebar\{position:sticky!important;top:0!important;z-index:80!important/);
});
test('matching mode radios drive legacy rule save selector and editing preselection',()=>{
  assert.match(html,/name="rule-mode-choice" value="exact" checked/);
  assert.match(html,/name="rule-mode-choice" value="prefix"/);
  assert.match(html,/name="rule-mode-choice" value="contains"/);
  assert.match(html,/id="rule-mode" hidden aria-hidden="true" tabindex="-1"/);
  assert.match(main,/function syncRuleModeRadios\(\)/);
  assert.match(main,/\$<HTMLSelectElement>\('rule-mode'\)\.value=radio\.value/);
  assert.match(main,/\$<HTMLSelectElement>\('rule-mode'\)\.value=rule\.mode;\s*syncRuleModeRadios\(\)/);
});
test('details border is decluttered and payroll action buttons align to same baseline',()=>{
  assert.match(css,/\.assets-account-info \.assets-info-row\{border:0!important/);
  assert.match(css,/#assets-payroll-forget\{display:inline-flex;align-items:center;justify-content:center/);
});
test('summary-originated statement navigation has a dedicated return action',()=>{
  assert.match(html,/id="manage-back-summary"[^>]*>← 月別サマリーへ戻る/);
  assert.match(main,/manageReturnToSummary=true;\s*showView\('manage'\)/);
  assert.match(main,/if \(view !== 'manage'\) manageReturnToSummary = false;/);
  assert.match(main,/\$\('manage-back-summary'\)\.addEventListener\('click',\(\)=>\{/);
  assert.match(main,/summaryReturnPageY=window\.scrollY/);
  assert.match(main,/if\(content\)content\.scrollTop=summaryReturnContentY/);
  assert.match(main,/window\.scrollTo\(0,summaryReturnPageY\)/);
});
