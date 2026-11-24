import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const shipped=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const style=readFileSync(new URL('../public/styles/settings-cleanup.css',import.meta.url),'utf8');
const bundled=readFileSync(new URL('../public/styles/app.css',import.meta.url),'utf8');
const shippedCss=readFileSync(new URL('../dist/styles/app.css',import.meta.url),'utf8');

test('encrypted cleanup actions reuse the shared OneDrive secondary button design',()=>{
  for(const html of [source,shipped]){
    for(const id of ['cloud-cleanup-scan','cloud-cleanup-delete']){
      const button=html.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>`,'i'))?.[0];
      assert.ok(button,`${id}: button must exist`);
      assert.match(button,id.endsWith('delete')?/class="secondary-action cloud-button danger-action"/:/class="secondary-action cloud-button"/,`${id}: shared button classes`);
      assert.match(button,/type="button"/,`${id}: must never submit a form`);
    }
    assert.match(html,/<button[^>]*id="cloud-folder-check"[^>]*class="secondary-action cloud-button"/);
  }
  assert.equal(source,shipped,'the distributed HTML must match source');
});

test('cleanup buttons respect compact desktop sizing and full-width mobile controls',()=>{
  assert.match(style,/\.settings-view \.cloud-cleanup-panel \.cloud-button\s*\{/);
  assert.match(style,/max-width:100%;width:auto;min-height:40px;/);
  assert.match(style,/@media\(max-width:680px\)[\s\S]*?\.cloud-cleanup-panel \.cloud-button\{display:flex;width:100%\}/);
  assert.ok(bundled.includes(style.trim()),'source style must be included in bundled stylesheet');
  assert.equal(bundled,shippedCss,'distributed CSS must match source bundle');
});
