import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync('dist/index.html','utf8');
const js=readFileSync('dist/src/main.js','utf8');
const css=readFileSync('dist/styles/app.css','utf8');
test('status of cloud saves/deletions remains in a visible live region',()=>{
  assert.match(html,/id="toast" class="toast activity-toast" role="status" aria-live="polite"/);
  assert.match(js,/operationResult\(mutationWarning\s*\?\?\s*'変更内容をOneDriveに保存しました。'/);
  assert.match(js,/operationResult\(mutationWarning\s*\?\?\s*result/);
  assert.match(js,/operationResult\(.*'working'/s);
  assert.match(css,/\.operation-result\.hidden\s*\{display:none\}/);
});
test('only two retention choices remain and each unlock is explicit',()=>{
  assert.match(html,/id="vault-retention-every-time" type="radio" name="vault-retention" value="always" checked/);
  assert.match(html,/id="vault-browser-keep" type="radio" name="vault-retention" value="browser"/);
  assert.doesNotMatch(html,/vault-tab-keep|2時間保持/);
  assert.match(js,/forgetBrowserKey\(context\)/);
  assert.doesNotMatch(js,/unlockTab|exportTabKey|saveTabSession|readTabSession/);
});
