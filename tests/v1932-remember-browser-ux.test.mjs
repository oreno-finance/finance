import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync('public/index.html','utf8');
const main=readFileSync('src/main.ts','utf8');
const css=readFileSync('public/styles/style.css','utf8');

test('unlock shows one understandable radio group with a safe default',()=>{
  assert.match(html,/<fieldset id="vault-retention-options"[^>]*>/);
  for(const [id,value] of [['vault-retention-every-time','always'],['vault-browser-keep','browser']])
    assert.match(html,new RegExp(`id="${id}" type="radio" name="vault-retention" value="${value}"`));
  assert.match(html,/id="vault-retention-every-time"[^>]*checked/);
  assert.doesNotMatch(html,/id="vault-browser-keep"[^>]*checked/);
  assert.match(main,/\$\('vault-retention-options'\)\.classList\.toggle\('hidden',mode==='migrate'\)/);
  assert.match(main,/\$<HTMLInputElement>\('vault-retention-every-time'\)\.checked=true/);
  assert.doesNotMatch(main,/vault-browser-keep'\)\.addEventListener\('change'/);
});

test('settings displays only the relevant action, never two confusing disabled buttons',()=>{
  assert.match(html,/id="cloud-remember-register" class="secondary-action hidden" disabled/);
  assert.match(html,/id="cloud-remember-forget" class="cloud-link-action hidden" disabled/);
  assert.match(main,/register\.classList\.add\('hidden'\);register\.disabled=true/);
  assert.match(main,/forget\.classList\.add\('hidden'\);forget\.disabled=true/);
  assert.match(main,/if\(remembered\)\{/);
  assert.match(main,/保管庫の解除時に「このブラウザを記憶する」を選べます/);
  assert.match(main,/forget\.classList\.remove\('hidden'\);forget\.disabled=false/);
  assert.match(css,/\.vault-retention-options \.vault-tab-option:has\(input:checked\)/);
});
