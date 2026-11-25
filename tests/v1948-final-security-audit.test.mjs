import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {APPROVED_FINANCE_AUTH_CSP,validateFinanceCsp,validateFinanceAuthCsp} from '../scripts/finance-csp.mjs';

const mainHtml=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const authHtml=readFileSync(new URL('../public/auth-bridge.html',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../.github/workflows/pages.yml',import.meta.url),'utf8');
const authors=JSON.parse(readFileSync(new URL('../scripts/publication-policy.json',import.meta.url),'utf8')).allowedAuthors;

function fixture(){
  const cwd=mkdtempSync(join(tmpdir(),'finance-sec-final-'));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  git('init','-q','-b','main');
  git('config','user.name',authors[0].name);
  git('config','user.email',authors[0].email);
  mkdirSync(join(cwd,'scripts'));
  for(const path of ['audit-publication.mjs','finance-csp.mjs','publication-policy.json']){
    copyFileSync(new URL(`../scripts/${path}`,import.meta.url),join(cwd,'scripts',path));
  }
  writeFileSync(join(cwd,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(cwd,'README.md'),'safe baseline');
  git('add','-A');git('commit','-qm','baseline');
  const audit=(...args)=>spawnSync(process.execPath,['scripts/audit-publication.mjs',...args],{cwd,encoding:'utf8'});
  return {cwd,git,audit};
}

test('real CSP attributes are parsed, not matched inside data-* lookalikes',()=>{
  assert.deepEqual(validateFinanceCsp(mainHtml),[]);
  const meta=mainHtml.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)?.[0];
  assert.ok(meta);
  const cases=[
    meta.replace('http-equiv=', 'data-http-equiv='),
    meta.replace('content=', 'data-content='),
    meta.replace('http-equiv=', 'http-equiv-fake='),
    meta.replace('content=', 'data-content=').replace('http-equiv=', 'data-http-equiv='),
    meta.replace('http-equiv=', 'data-http-equiv=').replace('content=', 'data-content='),
    meta.replace('http-equiv="Content-Security-Policy"', 'http-equiv="Content-Security-Policy" http-equiv="Content-Security-Policy"'),
    meta.replace('content=', 'content="bogus" content='),
    meta.replace('http-equiv="Content-Security-Policy"', 'http-equiv="Content-Security-Policy" data-http-equiv="Content-Security-Policy"').replace('content=', 'data-content='),
  ];
  for(const candidate of cases){
    assert.notDeepEqual(validateFinanceCsp(mainHtml.replace(meta,candidate)),[],candidate.slice(0,100));
  }
  assert.deepEqual(validateFinanceCsp(mainHtml.replace(meta,meta.replace('http-equiv','HTTP-EQUIV').replace('content=','CONTENT='))),[]);
  assert.deepEqual(validateFinanceCsp(mainHtml.replace(meta,meta.replace('http-equiv="Content-Security-Policy"',"http-equiv='Content-Security-Policy'"))),[]);
  assert.notDeepEqual(validateFinanceCsp(mainHtml.replace(meta,`<!-- ${meta} -->`)),[],'HTML comment is not a policy');
  assert.notDeepEqual(validateFinanceCsp(`<!-- <head>${meta}</head> -->\n${mainHtml.replace(meta,'')}`),[],'commented fake head is not a policy');
  assert.notDeepEqual(validateFinanceCsp(mainHtml.replace(meta,`<script type="text/plain">${meta}</script>`)),[],'CSP inside script text is not effective');
  assert.notDeepEqual(validateFinanceCsp(mainHtml.replace(meta,`<template>${meta}</template>`)),[],'CSP inside template is not effective');
  assert.notDeepEqual(validateFinanceCsp(mainHtml.replace(meta,'').replace('</head>',`</head>\n${meta}`)),[],'CSP meta outside <head> is not effective');
});

test('auth bridge uses its own exact policy and rejects tampered source',()=>{
  assert.equal(Object.keys(APPROVED_FINANCE_AUTH_CSP).length,5);
  assert.deepEqual(validateFinanceAuthCsp(authHtml),[]);
  for(const changed of [
    authHtml.replace("connect-src 'self'","connect-src 'self' https://untrusted.invalid"),
    authHtml.replace('http-equiv="Content-Security-Policy"','data-http-equiv="Content-Security-Policy"'),
    authHtml.replace('content="default-src', 'data-content="default-src'),
    authHtml.replace('script-src',"script-src 'unsafe-inline'; script-src"),
  ])assert.notDeepEqual(validateFinanceAuthCsp(changed),[]);
  const f=fixture();mkdirSync(join(f.cwd,'public'));
  writeFileSync(join(f.cwd,'public/auth-bridge.html'),authHtml.replace("connect-src 'self'","connect-src *"));
  f.git('add','public/auth-bridge.html');
  const scan=f.audit('--staged');
  assert.notEqual(scan.status,0);
  assert.match(scan.stderr,/CSP.*connect-src/);
});

test('public and distributed favicon.ico must match the reviewed SHA-256',()=>{
  const original=readFileSync(new URL('../public/favicon.ico',import.meta.url));
  for(const path of ['public/favicon.ico','dist/favicon.ico']){
    const f=fixture();mkdirSync(join(f.cwd,path.split('/')[0]));
    writeFileSync(join(f.cwd,path),original);
    f.git('add',path);
    assert.equal(f.audit('--staged').status,0,`pristine ${path} should pass`);
    const corrupted=Buffer.from(original);corrupted[corrupted.length-1]^=1;
    writeFileSync(join(f.cwd,path),corrupted);
    f.git('add',path);
    const result=f.audit('--staged');
    assert.notEqual(result.status,0,`altered ${path} should fail`);
    assert.match(result.stderr,/favicon.ico.*SHA-256/);
  }
});

test('CI history range catches temporary PII added in an earlier commit then removed',()=>{
  const f=fixture();const base=f.git('rev-parse','HEAD');
  mkdirSync(join(f.cwd,'src'));
  const privateValue=['06','1234','5678'].join('-');
  writeFileSync(join(f.cwd,'src/temporary.mjs'),`export const note=${JSON.stringify(privateValue)};`);
  f.git('add','src/temporary.mjs');f.git('commit','-qm','temporary leaked number');
  writeFileSync(join(f.cwd,'src/temporary.mjs'),'export const note="safe";');
  f.git('add','src/temporary.mjs');f.git('commit','-qm','redacted number');
  const head=f.git('rev-parse','HEAD');
  assert.equal(f.audit('--tree').status,0,'current files are safe');
  const range=f.audit('--range',base,head);
  assert.notEqual(range.status,0,'commit range must block historical PII');
  assert.match(range.stderr,/電話番号/);
  assert.equal(range.stderr.includes(privateValue),false,'never reveal personal data');
  assert.notEqual(f.audit('--range',base,'f'.repeat(40)).status,0,'unknown refs fail closed');
  assert.notEqual(f.audit('--range','0'.repeat(40),head).status,0,'missing previous commit fails closed');
});

test('CI range allows clean sequential commits and inspects deleted intermediate files',()=>{
  const f=fixture();const base=f.git('rev-parse','HEAD');
  mkdirSync(join(f.cwd,'src'));
  writeFileSync(join(f.cwd,'src/okay.mjs'),'export const okay=1;');
  f.git('add','src/okay.mjs');f.git('commit','-qm','clean addition');
  const cleanHead=f.git('rev-parse','HEAD');
  assert.equal(f.audit('--range',base,cleanHead).status,0);
  const secret=['06','1234','5678'].join('-');
  writeFileSync(join(f.cwd,'src/temporary.mjs'),secret);
  f.git('add','src/temporary.mjs');f.git('commit','-qm','introduced temporary PII');
  f.git('rm','src/temporary.mjs');f.git('commit','-qm','deleted temporary file');
  assert.equal(f.audit('--tree').status,0);
  assert.notEqual(f.audit('--range',cleanHead,f.git('rev-parse','HEAD')).status,0);
});

test('GitHub CI audits incoming commit range and pins official Actions to full SHAs',()=>{
  assert.match(workflow,/name: Audit every incoming commit for historical personal information/);
  assert.match(workflow,/node scripts\/audit-publication\.mjs --range "\$FINANCE_PR_BASE_SHA" "\$FINANCE_PR_HEAD_SHA"/);
  assert.match(workflow,/node scripts\/audit-publication\.mjs --range "\$FINANCE_PUSH_BEFORE_SHA" "\$GITHUB_SHA"/);
  for(const action of ['checkout','setup-node','upload-pages-artifact','configure-pages','deploy-pages']){
    assert.match(workflow,new RegExp(`uses: actions/${action}@[0-9a-f]{40}\\b`),`${action} is not pinned`);
  }
  assert.doesNotMatch(workflow,/uses:\s*actions\/[^\s@]+@v\d+/);
});


test('CI builds and typechecks once; weekly inspection never builds or deploys',()=>{
  assert.doesNotMatch(workflow,/npm run check/);
  assert.equal((workflow.match(/npm test/g)??[]).length,1);
  for(const name of ['Build once, typecheck and run regressions','Audit actual published files','Install pinned Playwright in an isolated Python environment','Exercise real desktop and mobile interactions (headless Chromium)','Gitleaks scan of actual published build']){
    const start=workflow.indexOf(`- name: ${name}\n`);
    assert.ok(start>=0,name);
    assert.match(workflow.slice(start,workflow.indexOf('\n      - name:',start+1)),/if: github.event_name != 'schedule'/);
  }
  assert.match(workflow,/node scripts\/audit-publication\.mjs --source/);
  assert.match(workflow,/node scripts\/audit-publication\.mjs --dist/);
  assert.match(workflow,/Periodic full tree and author history inspection\s+if: github.event_name == 'schedule'\s+run: npm run audit:tree/);
});
