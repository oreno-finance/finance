import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {japanBuildDate,stampHtml,stampAppMeta} from '../scripts/stamp-app-meta.mjs';

const row='<div class="sidebar-meta"><span><button type="button" id="release-history-open" aria-haspopup="dialog" aria-controls="release-history-dialog" title="アップデート履歴">Finance v1.9.11</button></span><time id="app-updated-at" datetime="2026-11-19">ビルド 2026/11/19 JST</time></div>';

test('build stamp always uses the package version and JST date, not the stale sidebar literals',()=>{
  assert.equal(japanBuildDate(new Date('2026-11-21T15:10:00Z')),'2026-11-22');
  assert.equal(japanBuildDate(new Date('2026-11-21T14:59:00Z')),'2026-11-21');
  const transformed=stampHtml(row,'1.9.39','2026-11-22');
  assert.match(transformed,/Finance v1\.9\.39/);
  assert.match(transformed,/datetime="2026-11-22">ビルド 2026\/11\/22 JST/);
  assert.equal(stampHtml(transformed,'1.9.39','2026-11-22'),transformed);
});

test('stamping rejects missing or duplicate sidebar rows to avoid silently shipping stale metadata',()=>{
  assert.throws(()=>stampHtml('<main></main>','1.9.39','2026-11-22'),/検出0件/);
  assert.throws(()=>stampHtml(row+row,'1.9.39','2026-11-22'),/検出2件/);
  assert.throws(()=>stampHtml(row,'<script>','2026-11-22'),/形式が不正/);
});

test('build stamps from package.json without changing non-metadata markup and keeps repeated builds stable',async()=>{
  const root=await mkdtemp(join(tmpdir(),'finance-build-meta-'));
  try{
    await mkdir(join(root,'public'));
    await writeFile(join(root,'package.json'),JSON.stringify({version:'1.9.39'}));
    await writeFile(join(root,'public/index.html'),`<html>${row}<main>Keep UI unchanged</main></html>`);
    const first=await stampAppMeta(root,new Date('2026-11-21T16:00:00Z'));
    assert.deepEqual(first,{version:'1.9.39',day:'2026-11-22',changed:true});
    const second=await stampAppMeta(root,new Date('2026-11-21T16:00:00Z'));
    assert.equal(second.changed,false);
    const markup=await readFile(join(root,'public/index.html'),'utf8');
    assert.match(markup,/<main>Keep UI unchanged<\/main>/);
    assert.match(markup,/Finance v1\.9\.39/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('built source and publication carry the same version and day',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const source=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const dist=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  assert.match(source,new RegExp(`Finance v${pkg.version.replaceAll('.','\\.')}`));
  assert.match(source,/datetime="\d{4}-\d{2}-\d{2}">ビルド \d{4}\/\d{2}\/\d{2} JST/);
  assert.equal(source,dist);
});

test('explicit build date is reproducible across calendar days and invalid dates fail before writing',async()=>{
  const root=await mkdtemp(join(tmpdir(),'finance-build-date-'));
  try{
    await mkdir(join(root,'public'));await mkdir(join(root,'scripts'));
    await writeFile(join(root,'package.json'),JSON.stringify({version:'2.0.2'}));
    await writeFile(join(root,'public/index.html'),row);
    const script=join(root,'scripts/stamp-app-meta.mjs');
    await writeFile(script,await readFile(fileURLToPath(new URL('../scripts/stamp-app-meta.mjs',import.meta.url))));
    await symlink(join(root,'scripts'),join(root,'linked-scripts'),'dir');
    const linkedScript=join(root,'linked-scripts/stamp-app-meta.mjs');
    const run=(day,entry=script)=>execFileSync(process.execPath,[entry],{env:{...process.env,FINANCE_BUILD_DATE:day},stdio:'pipe'});
    run('2026-11-25');const first=await readFile(join(root,'public/index.html'),'utf8');
    run('2026-11-26',linkedScript);assert.match(await readFile(join(root,'public/index.html'),'utf8'),/2026-11-26/);
    run('2026-11-25');assert.equal(await readFile(join(root,'public/index.html'),'utf8'),first);
    assert.throws(()=>run('2026-02-30',linkedScript));
    assert.equal(await readFile(join(root,'public/index.html'),'utf8'),first);
  }finally{await rm(root,{recursive:true,force:true});}
});
