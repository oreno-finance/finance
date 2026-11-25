import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {releaseChangelog} from '../scripts/build-release-notes.mjs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('release history has one canonical source, current version and stable generated outputs',()=>{
  const entries=JSON.parse(read('public/release-notes.json')),version=JSON.parse(read('package.json')).version;
  assert.equal(entries[0].version,version);
  assert.equal(read('public/release-notes.json'),read('dist/release-notes.json'));
  assert.equal(read('CHANGELOG.md'),releaseChangelog(entries,version));
  assert.throws(()=>releaseChangelog(entries,'0.0.0'),/バージョン/);
  assert.throws(()=>releaseChangelog([...entries,entries[0]],version),/項目/);
  const versions=entries.filter(e=>e.version).map(e=>e.version);
  const order=(a,b)=>{const aa=a.split('.').map(Number),bb=b.split('.').map(Number);return bb[0]-aa[0]||bb[1]-aa[1]||bb[2]-aa[2];};
  assert.deepEqual(versions,[...versions].sort(order));
  assert.equal(entries.filter(e=>e.period).length,1);
  for(const e of entries){
    if(e.date)assert.match(e.date,/^\d{4}-\d{2}-\d{2}$/);
    if(e.through)assert.ok(e.through>=e.date);
    if(e.stats)assert.ok(Object.values(e.stats).every(n=>Number.isSafeInteger(n)&&n>=0));
    for(const items of Object.values(e.sections))assert.ok(items.length>0);
  }
});
