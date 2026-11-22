import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,readFileSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {validateFinanceCsp} from '../scripts/finance-csp.mjs';

const sourceHtml=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function fixture(){
  const cwd=mkdtempSync(join(tmpdir(),'finance-sec-regression-'));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'});
  git('init','-q');
  const authors=JSON.parse(readFileSync(new URL('../scripts/publication-policy.json',import.meta.url),'utf8')).allowedAuthors;
  git('config','user.name',authors[0].name);
  git('config','user.email',authors[0].email);
  mkdirSync(join(cwd,'scripts'),{recursive:true});
  for(const p of ['audit-publication.mjs','publication-policy.json','finance-csp.mjs'])cpSync(new URL(`../scripts/${p}`,import.meta.url),join(cwd,'scripts',p));
  writeFileSync(join(cwd,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(cwd,'README.md'),'public test fixture');
  git('add','package.json','README.md','scripts');git('commit','-qm','baseline');
  const run=(mode='--tree')=>spawnSync(process.execPath,['scripts/audit-publication.mjs',mode],{cwd,encoding:'utf8'});
  return {cwd,git,run};
}
function blocked(filename,content,expected,{vendor=false,staged=false}={}){
  const f=fixture();
  const path=join(f.cwd,filename);
  mkdirSync(path.slice(0,path.lastIndexOf('/')),{recursive:true});
  writeFileSync(path,content);
  if(staged)f.git('add','--',filename);
  const output=f.run(staged?'--staged':'--tree');
  assert.notEqual(output.status,0,`${filename} unexpectedly passed`);
  assert.match(output.stderr,new RegExp(expected));
  assert.equal(output.stderr.includes(content),false,'raw sensitive value must never appear in diagnostic');
}

test('publication scanner detects several real-world PII representations without printing their values',()=>{
  const cases=[
    ['住所・郵便番号',['530','0001'].join('-')],
    ['電話番号',['06','1234','5678'].join('-')],
    ['電話番号',['+81','90','1234','5678'].join('-')],
    ['銀行口座番号',['銀行の口座 ','123','4567'].join('')],
    ['秘密値の直書き',JSON.stringify({['client'+'_'+'secret']:'aBcDeF0123456789AbCdEf0123456789'})],
    ['クレジットカード番号の疑い',['4111','1111','1111','1111'].join('-')],
  ];
  for(const [pattern,value] of cases)blocked('src/example.mjs',value,pattern,{staged:true});
});
test('a vendor .mjs file with personal information cannot bypass scanner',()=>{
  const sensitive=['06','1234','5678'].join('-');
  blocked('dist/vendor/pdfjs/pdf.mjs',`const localContact=${JSON.stringify(sensitive)};`,'電話番号');
});
test('vendor text is scanned but legitimate binary formats are scoped to approved paths',()=>{
  const f=fixture();
  mkdirSync(join(f.cwd,'dist/vendor/pdfjs/wasm'),{recursive:true});
  writeFileSync(join(f.cwd,'dist/vendor/pdfjs/wasm/jbig2.wasm'),Buffer.from([0,97,115,109]));
  assert.equal(f.run().status,0);
  writeFileSync(join(f.cwd,'dist/vendor/pdfjs/wasm/evil.wasm'),Buffer.from([0,97,115,109]));
  assert.match(f.run().stderr,/evil.wasm.*未承認/);
});
test('only the pristine lockfile-verified PDF.js worker may contain upstream contributor emails',()=>{
  const f=fixture();
  const worker='dist/vendor/pdfjs/pdf.worker.mjs';
  const upstream='node_modules/pdfjs-dist/build/pdf.worker.mjs';
  writeFileSync(join(f.cwd,'.gitignore'),'node_modules/\n');
  const text='// Upstream contributor: dev-contact'+'@'+'upstream.test\n';
  mkdirSync(join(f.cwd,'node_modules/pdfjs-dist/build'),{recursive:true});
  mkdirSync(join(f.cwd,'dist/vendor/pdfjs'),{recursive:true});
  writeFileSync(join(f.cwd,'node_modules/pdfjs-dist/package.json'),JSON.stringify({version:'6.5.438'}));
  writeFileSync(join(f.cwd,'package-lock.json'),JSON.stringify({packages:{'node_modules/pdfjs-dist':{version:'6.5.438',integrity:'sha512-'+'A'.repeat(84)+'=='}}}));
  writeFileSync(join(f.cwd,upstream),text);
  writeFileSync(join(f.cwd,worker),text);
  assert.equal(f.run().status,0,'unaltered upstream worker should be accepted');
  writeFileSync(join(f.cwd,worker),text+'// app-owner'+'@'+'private.test\n');
  const changed=f.run();
  assert.notEqual(changed.status,0,'modified vendor worker should be rejected');
  assert.match(changed.stderr,/個人メールアドレス/);
  assert.doesNotMatch(changed.stderr,new RegExp('app-owner'+'@'+'private\\.test'));
  writeFileSync(join(f.cwd,worker),text);
  writeFileSync(join(f.cwd,'node_modules/pdfjs-dist/package.json'),JSON.stringify({version:'6.4.299'}));
  assert.match(f.run().stderr,/個人メールアドレス/,'version mismatch must not bypass scan');
  writeFileSync(join(f.cwd,'node_modules/pdfjs-dist/package.json'),JSON.stringify({version:'6.5.438'}));
  writeFileSync(join(f.cwd,worker),text+'// +81'+'-90-1234-5678\n');
  writeFileSync(join(f.cwd,upstream),text+'// +81'+'-90-1234-5678\n');
  assert.match(f.run().stderr,/電話番号/,'other PII rules must remain enabled for verified vendor copy');
});
test('real CSP is strict and mutated unsafe-inline, unsafe-eval, script-src-elem or duplicate directive is rejected',()=>{
  assert.deepEqual(validateFinanceCsp(sourceHtml),[]);
  for(const injected of [
    "script-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-eval'",
    "script-src https://evil.example",
    "script-src 'self'; script-src-elem https://evil.example",
    "script-src 'self'; script-src 'self'",
  ]){
    const mutated=sourceHtml.replace("script-src 'self'",injected);
    assert.notDeepEqual(validateFinanceCsp(mutated),[],`unsafe CSP accepted: ${injected}`);
  }
});
test('publication gate rejects a staged HTML document whose CSP is weakened',()=>{
  const modified=sourceHtml.replace("script-src 'self'","script-src 'self' 'unsafe-inline'");
  blocked('public/index.html',modified,'CSP',{staged:true});
});
test('pre-push commit inspection detects personal data even if the working tree no longer contains it',()=>{
  const f=fixture();
  const name='private-note.md';
  const secret=['06','1234','5678'].join('-');
  writeFileSync(join(f.cwd,name),secret);
  f.git('add',name);f.git('commit','-qm','accidental private data');
  const sha=f.git('rev-parse','HEAD').trim();
  writeFileSync(join(f.cwd,name),'redacted in working tree');
  assert.equal(f.run('--tree').status,0,'working tree alone must not reveal historical issue');
  const result=spawnSync(process.execPath,['scripts/audit-publication.mjs','--commit',sha],{cwd:f.cwd,encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/電話番号/);
  assert.equal(result.stderr.includes(secret),false);
});
test('pre-push hook fails closed when Gitleaks is unavailable',()=>{
  const f=fixture();mkdirSync(join(f.cwd,'.githooks'),{recursive:true});
  cpSync(new URL('../.githooks/pre-push',import.meta.url),join(f.cwd,'.githooks/pre-push'));
  chmodSync(join(f.cwd,'.githooks/pre-push'),0o755);
  f.git('config','core.hooksPath','.githooks');
  const bin=join(f.cwd,'bin');mkdirSync(bin);
  // Test only checks that missing Gitleaks blocks the operation, even if audit succeeds.
  for(const name of ['node','git'])symlinkSync(name==='node'?process.execPath:execFileSync('which',['git'],{encoding:'utf8'}).trim(),join(bin,name));
  const result=spawnSync('/bin/sh',['.githooks/pre-push'],{cwd:f.cwd,env:{...process.env,PATH:bin},encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Gitleaksが未インストール/);
});
test('pull requests run security checks and cannot deploy Pages',()=>{
  const yaml=readFileSync(new URL('../.github/workflows/pages.yml',import.meta.url),'utf8');
  assert.match(yaml,/pull_request:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(yaml,/name: security/);
  assert.match(yaml,/deploy:\s*\n\s+needs: security\s*\n\s+if: \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && github\.ref == 'refs\/heads\/main'/);
  assert.match(yaml,/npm audit --audit-level=high/);
});
