import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync('public/index.html','utf8');
const ui=name=>readFileSync(`src/ui/${name}.ts`,'utf8');

test('パスフレーズは常時表示し整理は詳細設定内、安全確認と操作IDを維持する',()=>{
  const group=html;
  assert.doesNotMatch(html,/id="cloud-management"/);
  assert.ok(html.indexOf('id="cloud-rotate-form"')<html.indexOf('id="cloud-advanced"'));
  assert.ok(html.indexOf('id="cloud-cleanup-scan"')>html.indexOf('id="cloud-advanced"'));
  for(const id of ['cloud-rotate-form','cloud-current-secret','cloud-next-secret','cloud-next-confirm','cloud-cleanup-scan','cloud-cleanup-backup','cloud-cleanup-delete','cloud-cleanup-v1','cloud-cleanup-snapshot-list']){
    assert.match(group,new RegExp(`id="${id}"`));
    assert.equal((html.match(new RegExp(`id="${id}"`,'g'))??[]).length,1);
  }
  assert.match(group,/すべての端末を最新版に更新し、旧版のタブを閉じてください/);
  assert.match(group,/バックアップを確認しました/);
  assert.match(html,/<span>Microsoftアカウント<\/span>[\s\S]*?<span class="cloud-vault-label">暗号化保管庫<\/span>/);
});

test('固定費・資産予測の表示変更は契約履歴の更新経路とロック時の消去を維持する',()=>{
  const costs=ui('subscriptions'),future=ui('future-projection'),assets=ui('assets-settings');
  assert.match(costs,/const routes=contractPaymentHistory\(origin\);[\s\S]*?routes.length>1/);
  assert.match(costs,/delta!==0\?/);
  assert.match(costs,/edit\.payment=\{cancelDate:futurePaymentDate\}[\s\S]*?await vault\.editContract\(existing,edit\)/);
  assert.match(costs,/priceOnDay\(contract\.pricing\?\?\[\],next,contract\.amount\)/);
  assert.match(future,/yearListOpen=false/);
  assert.match(future,/find\('future-scenario-hint'\)\.textContent=''/);
  assert.match(assets,/assets-payroll-stale-note','assets-payroll-mapping-warning'/);
  assert.match(assets,/使途不明金とは断定できません/);
  assert.doesNotMatch(html,/>4口座<|>残高予測に反映中</);
});
