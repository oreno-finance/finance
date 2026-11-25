import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const section=(from,to)=>main.slice(main.indexOf(from),main.indexOf(to,main.indexOf(from)));

test('取込画面はクラウド保存済みデータではなく新規取込キューを表示する',()=>{
  assert.match(main,/const importStaged = new WeakSet<ParsedStatement>/);
  const list=section('function buildStatementList(): void {','/** Discard a pending import');
  assert.match(list,/importQueue\(\)/);
  assert.match(list,/if \(importStaged\.has\(statements\[index\]!\)\) list\.append/);
  const summary=section('function renderSummary(): void {','function makeInput(');
  assert.match(summary,/const s = importActive\(\)/);
  const rows=section('function renderRows(): void {','function updateBatchStatus(');
  assert.match(rows,/const s = importActive\(\)/);
  assert.match(html,/>取込待ちの明細<\/h2>/);
});

test('クラウド保存成功後だけキューを消して、保存失敗時は下書きを維持',()=>{
  const batch=section('async function saveAllPending():Promise<void> {','function acceptStatement(');
  assert.match(batch,/const latest=importBatchPlan\(\)\.eligible/);
  assert.match(batch,/savedFingerprints\.set\(s,fingerprints\[index\]!\);dirty\.delete\(s\);pendingSources\.delete\(s\);importStaged\.delete\(s\)/);
  assert.match(batch,/catch\(error\)/);
  assert.doesNotMatch(batch,/catch\(error\)[\s\S]*?importStaged\.delete/);
});

test('下書きを破棄してもOneDriveの保存済み明細を削除しない',()=>{
  const discard=section('function discardImportDraft(index: number','async function deleteStatement(');
  assert.match(discard,/liveVault\?\.records\(\)/);
  assert.match(discard,/statements\.splice\(index, 1, restored\)/);
  assert.doesNotMatch(discard,/await liveVault\.delete/);
  assert.match(main,/if \(withDelete\) discardImportDraft\(index\)/);
});
