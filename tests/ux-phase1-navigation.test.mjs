import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {forecastAccounts} from '../dist/src/home/account-events.js';
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const html=read('public/index.html'), main=read('src/main.ts'), home=read('src/ui/home.ts');
test('四つの用途別グループに既存画面を一度ずつ並べ、Payrollは外部リンクのまま',()=>{
 const nav=html.split('id="mobile-nav-panel"')[1].split('class="sidebar-footer"')[0];
 const actual=[...nav.matchAll(/class="side-label nav-section-label">([^<]+)|id="nav-([a-z]+)"/g)].map(m=>m[1]??m[2]);
 assert.deepEqual(actual,['ダッシュボード','home','summary','analysis','データ管理','import','manage','subscriptions','assets','記録・将来設計','reports','future','環境設定','rules','settings','payroll']);
 assert.match(nav,/id="nav-payroll"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
 assert.match(nav,/data-nav-label="利用先ルール"/);
 assert.match(nav,/data-nav-label="固定費管理"/);
});
test('インポートだけにSTEPを残し、両方の明細テーブルで見出しとソート操作を共有する',()=>{
 assert.equal((html.match(/class="step">STEP /g)??[]).length,3);
 for(const prefix of ['', 'manage-']){
   assert.match(html,new RegExp(`id="${prefix}sort-date"[^>]*><span>利用日</span><span class="sort-arrow"`));
   assert.match(html,new RegExp(`id="${prefix}sort-amount"[^>]*><span>当月請求額</span><span class="sort-arrow"`));
 }
 assert.equal((main.match(/renderStatementSortControl\(id,label,/g)??[]).length,2);
 assert.match(main,/button.textContent = batchBusy \? '保存中…' : eligible\.length/);
 assert.match(main,/\$\{eligible.length\}件の明細/);
 assert.match(main,/await vault\.saveBatch/);
});
test('ホームは収支、確認、入出金、資産、ポイントの順で描画する',()=>{
 const markers=['root!.append(metrics)','fundingPanel(previous)',"section('確認すること')","section('次の入出金')","section('口座と資産')","pointBenefitsSection('今月の推定ポイント'"];
 let previous=-1;
 for(const marker of markers){const index=home.indexOf(marker);assert.ok(index>previous,marker);previous=index;}
});
test('残高未登録でも予定入出金を表示用に取得でき、過去分やカードの重複は除外される',()=>{
 const source={records:[],rules:[],categories:[],currentPeriod:'2026-11',assets:{snapshots:[],recurring:[],nisaCardRule:null,oneTime:[
 {id:'past',date:'2026-11-01',name:'過去',amount:1000,kind:'income',status:'done',fromAccountId:null,toAccountId:'rakuten-bank'},
 {id:'future',date:'2026-11-27',name:'入金予定',amount:2000,kind:'income',status:'planned',fromAccountId:null,toAccountId:'rakuten-bank'}]},payroll:{ready:false,entries:[],syncedAt:null}};
 const before=JSON.stringify(source),forecast=forecastAccounts(source,'2026-11-24');
 assert.equal(forecast.accounts[0].projected,null);
 assert.deepEqual(forecast.upcomingMovements.map(x=>[x.title,x.amount]),[['入金予定',2000]]);
 assert.equal(JSON.stringify(source),before);
});
