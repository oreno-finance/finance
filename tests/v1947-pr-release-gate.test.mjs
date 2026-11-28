import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,chmodSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {APPROVED_FINANCE_CSP,validateFinanceCsp} from '../scripts/finance-csp.mjs';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const workflow=readFileSync(new URL('../.github/workflows/pages.yml',import.meta.url),'utf8');
const policy=JSON.parse(readFileSync(new URL('../scripts/publication-policy.json',import.meta.url),'utf8'));
function setup(){
  const base=mkdtempSync(join(tmpdir(),'finance-pr-gate-'));
  const cwd=join(base,'working');mkdirSync(cwd);
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  git('init','-q','-b','main');
  git('config','user.name',policy.allowedAuthors[0].name);
  git('config','user.email',policy.allowedAuthors[0].email);
  mkdirSync(join(cwd,'scripts'));mkdirSync(join(cwd,'.githooks'));
  for(const path of ['audit-publication.mjs','finance-csp.mjs','publication-policy.json']){
    copyFileSync(new URL(`../scripts/${path}`,import.meta.url),join(cwd,'scripts',path));
  }
  for(const path of ['pre-push','pre-commit']){
    copyFileSync(new URL(`../.githooks/${path}`,import.meta.url),join(cwd,'.githooks',path));
    chmodSync(join(cwd,'.githooks',path),0o755);
  }
  writeFileSync(join(cwd,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(cwd,'README.md'),'clean fixture');
  git('add','-A');git('commit','-qm','baseline');
  const bin=join(base,'bin');mkdirSync(bin);
  const mock=join(bin,'gitleaks');writeFileSync(mock,'#!/bin/sh\nexit 0\n');chmodSync(mock,0o755);
  const env={...process.env,PATH:`${bin}:${process.env.PATH??''}`};
  const audit=(args=['--tree'],extra={})=>spawnSync(process.execPath,['scripts/audit-publication.mjs',...args],{cwd,env:{...env,...extra},encoding:'utf8'});
  return {base,cwd,git,env,audit};
}

test('CSP all 11 directives and all approved origins are mandatory',()=>{
  assert.equal(Object.keys(APPROVED_FINANCE_CSP).length,11);
  assert.deepEqual(validateFinanceCsp(html),[]);
  for(const directive of Object.keys(APPROVED_FINANCE_CSP)){
    const missing=html.replace(`${directive} ${APPROVED_FINANCE_CSP[directive]}`, '');
    assert.notDeepEqual(validateFinanceCsp(missing),[],`deleted directive accepted: ${directive}`);
    const added=html.replace(`${directive} ${APPROVED_FINANCE_CSP[directive]}`,
      `${directive} ${APPROVED_FINANCE_CSP[directive]} https://untrusted.invalid`);
    assert.notDeepEqual(validateFinanceCsp(added),[],`unreviewed origin accepted: ${directive}`);
  }
});

test('CSP rejects new directives, widened origins and duplicated or missing CSP meta',()=>{
  for(const directive of [
    "connect-src 'self' https://untrusted.invalid",
    "img-src *",
    "worker-src 'self' https:",
    "form-action *",
    "frame-src https://untrusted.invalid",
    "style-src 'unsafe-inline' *",
    "script-src-elem 'self'",
    'upgrade-insecure-requests',
    'report-uri https://untrusted.invalid',
  ]){
    const modified=html.replace('form-action',`${directive}; form-action`);
    assert.notDeepEqual(validateFinanceCsp(modified),[],`unreviewed CSP accepted: ${directive}`);
  }
  const meta=html.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/)?.[0];
  assert.ok(meta);
  assert.notDeepEqual(validateFinanceCsp(html.replace(meta,meta+'\n'+meta)),[]);
  assert.notDeepEqual(validateFinanceCsp(html.replace(meta,'')),[]);
});

test('publication gate runs strict CSP validation for staged HTML, not only isolated function',()=>{
  const f=setup();
  mkdirSync(join(f.cwd,'public'));
  const altered=html.replace('https://graph.microsoft.com','https://graph.microsoft.com https://untrusted.invalid');
  writeFileSync(join(f.cwd,'public/index.html'),altered);
  f.git('add','public/index.html');
  const r=f.audit(['--staged']);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/CSP .*connect-src/);
});

test('PR CI tests merge result, and the audited artifact is the only deployed build',()=>{
  assert.match(workflow,/pull_request:\s*\n\s+branches:\s*\n\s+- main/);
  assert.doesNotMatch(workflow,/ref:\s*\$\{\{\s*github\.event_name.*pull_request/);
  assert.match(workflow,/FINANCE_PR_HEAD_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow,/FINANCE_PR_BASE_SHA:\s*\$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.equal((workflow.match(/npm test/g)??[]).length,1,'the final build must not be rebuilt during deployment');
  assert.equal((workflow.match(/actions\/upload-pages-artifact@[0-9a-f]{40}/g)??[]).length,1);
  assert.equal((workflow.match(/actions\/deploy-pages@[0-9a-f]{40}/g)??[]).length,1);
  assert.match(workflow,/Gitleaks scan of actual published build[\s\S]*?dir --redact --no-banner dist/);
  const deploy=workflow.slice(workflow.indexOf('\n  deploy:'));
  assert.doesNotMatch(deploy,/npm (?:ci|test|run build)|actions\/checkout@|upload-pages-artifact@/);
  assert.match(deploy,/needs: security/);
  assert.match(deploy,/if: \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && github\.ref == 'refs\/heads\/main'/);
});

test('a synthetic GitHub PR merge is exempt only with the exact CI SHA and two expected parents',()=>{
  const f=setup();
  f.git('switch','-qc','feature');
  writeFileSync(join(f.cwd,'feature.md'),'clean feature');
  f.git('add','feature.md');f.git('commit','-qm','feature change');
  const head=f.git('rev-parse','HEAD');
  f.git('switch','main');
  writeFileSync(join(f.cwd,'base.md'),'independent base change');
  f.git('add','base.md');f.git('commit','-qm','base change');
  const base=f.git('rev-parse','HEAD');
  const mergeEnv={...f.env,GIT_AUTHOR_NAME:'GitHub',GIT_AUTHOR_EMAIL:['noreply','github.com'].join('@'),GIT_COMMITTER_NAME:'GitHub',GIT_COMMITTER_EMAIL:['noreply','github.com'].join('@')};
  const merge=spawnSync('git',['merge','--no-ff','-m','Synthetic PR merge','feature'],{cwd:f.cwd,env:mergeEnv,encoding:'utf8'});
  assert.equal(merge.status,0,merge.stderr);
  const sha=f.git('rev-parse','HEAD');
  assert.notEqual(f.audit().status,0,'the untrusted merge is never accepted by default');
  const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'pull_request',GITHUB_BASE_REF:'main',GITHUB_SHA:sha,FINANCE_PR_BASE_SHA:base,FINANCE_PR_HEAD_SHA:head};
  assert.equal(f.audit(['--tree'],env).status,0,'exact synthetic PR merge must be accepted');
  assert.notEqual(f.audit(['--tree'],{...env,FINANCE_PR_HEAD_SHA:base}).status,0,'wrong parent must fail');
  assert.notEqual(f.audit(['--tree'],{...env,GITHUB_SHA:head}).status,0,'wrong merge SHA must fail');
  assert.notEqual(f.audit(['--tree'],{...env,GITHUB_EVENT_NAME:'push'}).status,0,'not a PR must fail');
});

test('real GitHub merge committer is narrowly permitted; arbitrary GitHub committer is rejected',()=>{
  const f=setup();
  f.git('switch','-qc','feature');
  writeFileSync(join(f.cwd,'feature.md'),'feature');f.git('add','feature.md');f.git('commit','-qm','feature');
  f.git('switch','main');
  writeFileSync(join(f.cwd,'base.md'),'base');f.git('add','base.md');f.git('commit','-qm','base');
  const env={...f.env,GIT_COMMITTER_NAME:'GitHub',GIT_COMMITTER_EMAIL:['noreply','github.com'].join('@')};
  const ok=spawnSync('git',['merge','--no-ff','-m','Merge pull request #12 from demo/feature','feature'],{cwd:f.cwd,env,encoding:'utf8'});
  assert.equal(ok.status,0,ok.stderr);
  assert.equal(f.audit().status,0,'approved author plus exact GH merge metadata is allowed');
  writeFileSync(join(f.cwd,'impostor.md'),'safe');f.git('add','impostor.md');
  const impostor=spawnSync('git',['commit','-qm','ordinary user commit'],{cwd:f.cwd,env,encoding:'utf8'});
  assert.equal(impostor.status,0,impostor.stderr);
  assert.notEqual(f.audit().status,0,'nonmerge GH committer is never accepted');
});

test('an unreviewed custom-subject GitHub merge is still rejected',()=>{
  const f=setup();
  f.git('switch','-qc','feature');
  writeFileSync(join(f.cwd,'feature.md'),'feature');f.git('add','feature.md');f.git('commit','-qm','feature');
  f.git('switch','main');
  const env={...f.env,GIT_COMMITTER_NAME:'GitHub',GIT_COMMITTER_EMAIL:['noreply','github.com'].join('@')};
  const merge=spawnSync('git',['merge','--no-ff','-m','Finance v2.2.2：操作性の改善とOneDrive通信の最適化','feature'],{cwd:f.cwd,env,encoding:'utf8'});
  assert.equal(merge.status,0,merge.stderr);
  const result=f.audit(['--commit',f.git('rev-parse','HEAD')]);
  assert.notEqual(result.status,0,'custom subject alone does not permit a GitHub committer');
  assert.match(result.stderr,/コミット履歴のCommitter/);
});

test('an actual pre-commit Git hook rejects staged PII without revealing the value',()=>{
  const f=setup();f.git('config','core.hooksPath','.githooks');
  const sensitive=['06','1234','5678'].join('-');
  writeFileSync(join(f.cwd,'README.md'),sensitive);f.git('add','README.md');
  const blocked=spawnSync('git',['commit','-m','bad change'],{cwd:f.cwd,env:f.env,encoding:'utf8'});
  assert.notEqual(blocked.status,0);
  assert.match(blocked.stderr,/電話番号/);
  assert.equal(blocked.stderr.includes(sensitive),false);
  writeFileSync(join(f.cwd,'README.md'),'safe revised content');f.git('add','README.md');
  const accepted=spawnSync('git',['commit','-m','safe change'],{cwd:f.cwd,env:f.env,encoding:'utf8'});
  assert.equal(accepted.status,0,accepted.stderr);
});

test('an actual Git push triggers pre-push: hidden committed PII is blocked despite clean working tree',()=>{
  const f=setup();f.git('config','core.hooksPath','.githooks');
  const remote=join(f.base,'remote.git');
  execFileSync('git',['init','--bare','-q',remote]);
  f.git('remote','add','origin',remote);
  const initial=spawnSync('git',['push','origin','HEAD:refs/heads/main'],{cwd:f.cwd,env:f.env,encoding:'utf8'});
  assert.equal(initial.status,0,initial.stderr);
  const sensitive=['06','1234','5678'].join('-');
  writeFileSync(join(f.cwd,'README.md'),sensitive);
  f.git('add','README.md');
  // Deliberately bypass the hook once to emulate an accidentally committed secret.
  f.git('-c','core.hooksPath=/dev/null','commit','-qm','accidental private content');
  writeFileSync(join(f.cwd,'README.md'),'redacted in working tree');
  f.git('add','README.md');f.git('-c','core.hooksPath=/dev/null','commit','-qm','redacted');
  assert.equal(f.audit().status,0,'working tree is clean, but Git history is not');
  const blocked=spawnSync('git',['push','origin','HEAD:refs/heads/main'],{cwd:f.cwd,env:f.env,encoding:'utf8'});
  assert.notEqual(blocked.status,0);
  assert.match(blocked.stderr,/電話番号/);
  assert.equal(blocked.stderr.includes(sensitive),false);
  const remoteSha=execFileSync('git',['--git-dir',remote,'rev-parse','refs/heads/main'],{encoding:'utf8'}).trim();
  assert.notEqual(remoteSha,f.git('rev-parse','HEAD'),'remote must remain at safe baseline');
});

test('Round4C historical merge exception rejects an imitation with identical custom subject',()=>{
  const f=setup();
  f.git('switch','-qc','feature');
  writeFileSync(join(f.cwd,'feature.md'),'clean feature');
  f.git('add','feature.md');f.git('commit','-qm','feature');
  f.git('switch','main');
  writeFileSync(join(f.cwd,'base.md'),'clean base');
  f.git('add','base.md');f.git('commit','-qm','base');
  const env={...f.env,GIT_COMMITTER_NAME:'GitHub',GIT_COMMITTER_EMAIL:['noreply','github.com'].join('@')};
  const merge=spawnSync('git',['merge','--no-ff','-m','Payrollの勤務先IDをFinanceの給与連携へ反映（#12）','feature'],{cwd:f.cwd,env,encoding:'utf8'});
  assert.equal(merge.status,0,merge.stderr);
  const r=f.audit();
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/コミット履歴のCommitter/);
});


test('push audits new branch commits once, not unrelated local notes or local-only history',()=>{
  const f=setup();f.git('config','core.hooksPath','.githooks');
  const remote=join(f.base,'remote.git');
  execFileSync('git',['init','--bare','-q',remote]);
  const calls=join(f.base,'scanner-calls');
  const mock=join(f.base,'bin','gitleaks');
  writeFileSync(mock,'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FINANCE_TEST_SCAN_LOG"\n');
  const env={...f.env,FINANCE_TEST_SCAN_LOG:calls};
  const push=(...args)=>spawnSync('git',['push',remote,...args],{cwd:f.cwd,env,encoding:'utf8'});
  assert.equal(push('HEAD:refs/heads/main').status,0);
  const base=f.git('rev-parse','HEAD');
  f.git('switch','-qc','private-local');
  writeFileSync(join(f.cwd,'README.md'),['06','1234','5678'].join('-'));
  f.git('add','README.md');f.git('-c','core.hooksPath=/dev/null','commit','-qm','local only');
  f.git('switch','-qc','feature',base);
  writeFileSync(join(f.cwd,'local.pdf'),'not part of the commit');
  writeFileSync(join(f.cwd,'README.md'),'first safe change');f.git('add','README.md');assert.equal(spawnSync('git',['commit','-qm','日本語の変更'],{cwd:f.cwd,env,encoding:'utf8'}).status,0);
  const first=f.git('rev-parse','HEAD');
  writeFileSync(join(f.cwd,'README.md'),'second safe change');f.git('add','README.md');assert.equal(spawnSync('git',['commit','-qm','二件目'],{cwd:f.cwd,env,encoding:'utf8'}).status,0);
  const second=f.git('rev-parse','HEAD');
  writeFileSync(calls,'');
  const accepted=push('HEAD:refs/heads/feature','HEAD:refs/heads/other');
  assert.equal(accepted.status,0,accepted.stderr);
  assert.match(accepted.stderr+accepted.stdout,/push対象: 2コミット/);
  const scans=readFileSync(calls,'utf8').trim().split('\n');
  assert.equal(scans.length,1,'one scan for overlapping outgoing ranges');
  assert.ok(scans[0].includes(second)&&scans[0].includes('^'+base));
  assert.ok(!scans[0].includes('--all'));
  assert.equal(f.audit(['--commit',first]).status,0);
  assert.notEqual(f.audit().status,0,'explicit worktree audit still diagnoses local notes');
});

test('outgoing message and identity checks reject private values without echoing them',()=>{
  const f=setup();
  const base=f.git('rev-parse','HEAD');
  const secret=['06','1234','5678'].join('-');
  f.git('commit','--allow-empty','-qm',`private ${secret}`);
  const head=f.git('rev-parse','HEAD');
  const r=f.audit(['--range',base,head]);
  assert.notEqual(r.status,0);assert.match(r.stderr,/コミットメッセージ: 電話番号/);
  assert.ok(!r.stderr.includes(secret));
  const staged=f.audit(['--staged'],{GIT_AUTHOR_NAME:'private local',GIT_AUTHOR_EMAIL:['private','invalid.test'].join('@')});
  assert.notEqual(staged.status,0);assert.match(staged.stderr,/現在のGit AUTHOR/);
});

test('push stops on unknown old object rather than silently omitting the range',()=>{
  const f=setup();const head=f.git('rev-parse','HEAD');
  const r=spawnSync(process.execPath,['scripts/audit-publication.mjs','--push','unused'],{
    cwd:f.cwd,env:f.env,encoding:'utf8',input:`refs/heads/main ${head} refs/heads/main ${'f'.repeat(40)}\n`,
  });
  assert.notEqual(r.status,0);assert.match(r.stderr,/push対象の履歴を確認できません/);
});
