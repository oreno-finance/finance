import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,cpSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {monthlyReport} from '../dist/src/summary/monthly-summary.js';
import {analysisDrilldownBreakdown} from '../dist/src/ui/analysis-drilldown.js';
import {analyzePeriods} from '../dist/src/analysis/period-analytics.js';
const row=(id,merchant,amount)=>({id,usedOn:'2026-10-09',merchant,amount});
const record=(id,period,rows)=>({id,statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'fixture',paymentDate:`${period}-27`,billingMonth:period==='2026-11'?'2026-10':'2026-09',statedTotal:rows.reduce((a,r)=>a+r.amount,0),confirmation:'confirmed',warnings:[],rows}});
const repeat=(id,name,amount,categoryId='food')=>({id,name,amount,kind:'expense',fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId,enabled:true});
const source=(records=[],recurring=[])=>({records,rules:[{id:'r',pattern:'MARKET',mode:'contains',displayName:'スーパー',cardId:null,enabled:true,priority:100,categoryId:'food'}],categories:[{id:'food',name:'食費',color:'orange'}],assets:{nisaCardRule:null,recurring,oneTime:[]},payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'});
const request=(periods,dimension,value)=>({periods,dimension,value,label:'検査'});
test('category drilldown exactly reconciles bank recurring plus card rows',()=>{
 const data=source([record('a','2026-11',[row('r1','MARKET',500)])],[repeat('bank','保険料',1500)]),before=JSON.stringify(data);
 const summary=monthlyReport('2026-11',data),details=analysisDrilldownBreakdown(data,request(['2026-11'],'category','food'));
 assert.equal(summary.categories.find(c=>c.id==='food').amount,2000);
 assert.deepEqual([details.cardAmount,details.recurringAmount,details.total],[500,1500,2000]);
 assert.deepEqual(details.recurring.map(e=>[e.entryId,e.date]),[['bank','2026-11-20']]);
 assert.equal(JSON.stringify(data),before);
});
test('multi-month and unclassified category reconcile to annual group totals',()=>{
 const data=source([record('a','2026-10',[row('r1','MARKET',200),row('r2','OTHER',100)]),record('b','2026-11',[row('r3','MARKET',500)])],[repeat('food','保険',1200),repeat('no-cat','不明',300,null)]);
 const periods=['2026-10','2026-11'];
 const food=analysisDrilldownBreakdown(data,request(periods,'category','food'));
 assert.deepEqual([food.cardAmount,food.recurringAmount,food.total],[700,2400,3100]);
 assert.equal(analyzePeriods(data,periods,'2026-11').groups.category.find(g=>g.id==='food').total,3100);
 assert.equal(analysisDrilldownBreakdown(data,request(periods,'category','__unclassified')).total,700);
 assert.equal(analysisDrilldownBreakdown(data,request(periods,'merchant','スーパー')).total,700);
 assert.equal(analysisDrilldownBreakdown(data,request(periods,'card','smbc-nl')).total,800);
});
test('duplicate card and bank schedules remain counted but flagged per occurrence',()=>{
 const data=source([record('a','2026-11',[row('r1','MARKET',500)])],[repeat('bank','スーパー',500)]);
 const summary=monthlyReport('2026-11',data),details=analysisDrilldownBreakdown(data,request(['2026-11'],'category','food'));
 assert.equal(summary.recurringCardOverlap,1);
 assert.equal(summary.recurringLines[0].cardOverlap,true);
 assert.equal(details.total,1000);
 assert.equal(details.recurring[0].cardOverlap,true);
});
test('bank-only category and NISA exclusion preserve all valid amounts',()=>{
 const data=source([],[repeat('bank','保険',1500)]);
 assert.equal(analysisDrilldownBreakdown(data,request(['2026-11'],'category','food')).total,1500);
 data.records=[record('a','2026-11',[row('nisa','RAKUTEN SECURITIES',10000),row('food','MARKET',500)])];
 data.assets.nisaCardRule={cardId:'smbc-nl',merchantContains:'RAKUTEN',enabled:true};
 assert.equal(analysisDrilldownBreakdown(data,request(['2026-11'],'category','food')).total,2000);
 assert.equal(analysisDrilldownBreakdown(data,request(['2026-11'],'card','smbc-nl')).total,10500);
});
test('manager displays only card transactions while monthly summary retains recurrence editing',()=>{
 const html=readFileSync('public/index.html','utf8'),main=readFileSync('src/main.ts','utf8');
 assert.doesNotMatch(html,/id="manage-drilldown-breakdown"/);
 assert.doesNotMatch(main,/renderManagerDrilldownBreakdown/);
 assert.match(main,/支払月で絞り込み中 · カード取引のみ表示/);
 assert.match(main,/openRecurring:openRecurringForReview/);
 assert.match(readFileSync('src/ui/assets-settings.ts','utf8'),/openRecurring:async\(id:string\)/);
 assert.match(readFileSync('src/ui/monthly-summary.ts','utf8'),/report\.recurringLines\.filter\(item=>item\.cardOverlap\)/);
});
function auditFixture(){
 const cwd=mkdtempSync(join(tmpdir(),'finance-v191-scan-'));const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'});
 git('init','-q');git('config','user.name','Morbee');git('config','user.email','114388961+morbachev@users.noreply.github.com');
 mkdirSync(join(cwd,'scripts'));cpSync('scripts/audit-publication.mjs',join(cwd,'scripts/audit-publication.mjs'));
 cpSync('scripts/publication-policy.json',join(cwd,'scripts/publication-policy.json'));
  cpSync('scripts/finance-csp.mjs',join(cwd,'scripts/finance-csp.mjs'));
 writeFileSync(join(cwd,'package.json'),JSON.stringify({type:'module'}));
 writeFileSync(join(cwd,'README.md'),'safe');git('add','package.json','README.md');git('commit','-qm','baseline');
 const run=(mode)=>spawnSync(process.execPath,['scripts/audit-publication.mjs',mode],{cwd,encoding:'utf8'});
 return {cwd,git,run};
}
test('audit:tree includes untracked files without adding to Git index',()=>{
 const {cwd,git,run}=auditFixture();assert.equal(run('--tree').status,0);
 writeFileSync(join(cwd,'untracked.pdf'),'fake PDF');let result=run('--tree');
 assert.notEqual(result.status,0);assert.match(result.stderr,/untracked.pdf/);
 assert.equal(git('status','--porcelain').includes('?? untracked.pdf'),true);
});
test('audit:tree detects untracked private email without printing it',()=>{
 const {cwd,run}=auditFixture();const secret=['private.person','private.example'].join('@');writeFileSync(join(cwd,'newfile.md'),secret);
 const result=run('--tree');assert.notEqual(result.status,0);assert.match(result.stderr,/個人メールアドレス/);
 assert.equal(result.stderr.includes(secret),false);
});
test('pre-commit denies commit if Gitleaks unavailable',()=>{
 const {cwd}=auditFixture();mkdirSync(join(cwd,'.githooks'));cpSync('.githooks/pre-commit',join(cwd,'.githooks/pre-commit'));
 const bindir=join(cwd,'fake-bin');mkdirSync(bindir);symlinkSync(process.execPath,join(bindir,'node'));
 symlinkSync(execFileSync('which',['git'],{encoding:'utf8'}).trim(),join(bindir,'git'));
 const result=spawnSync('/bin/sh',['.githooks/pre-commit'],{cwd,env:{...process.env,PATH:bindir},encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/Gitleaksが未インストール/);
});
