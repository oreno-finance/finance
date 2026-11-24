import test from 'node:test';
import assert from 'node:assert/strict';
import {pointCoverage,archivedPointCoverage} from '../dist/src/ui/point-benefits.js';
import {forecastAccounts} from '../dist/src/home/account-events.js';
import {emptyAssets} from '../dist/src/cloud/assets.js';

test('ポイント表示は取得不能・確認済みゼロ・登録済み明細を区別し保存形式を変更しない',()=>{
  const missing={cardLines:[],cardNoUseConfirmed:false},zero={cardLines:[],cardNoUseConfirmed:true},known={cardLines:[{}],cardNoUseConfirmed:false};
  assert.equal(pointCoverage([]),'missing');
  assert.equal(pointCoverage([missing]),'missing');
  assert.equal(pointCoverage([zero,missing]),'missing');
  assert.equal(pointCoverage([zero,zero]),'no-use');
  assert.equal(pointCoverage([known,missing]),'registered');
  assert.equal(archivedPointCoverage({cards:[],cardOutflow:null}),'missing');
  assert.equal(archivedPointCoverage({cards:[],cardOutflow:0}),'no-use');
  assert.equal(archivedPointCoverage({cards:[{}],cardOutflow:0}),'registered');
});

test('ホームの振替表示には両口座と実行状態があり、増減額は従来のまま',()=>{
  const assets=emptyAssets();
  assets.oneTime=[{id:'transfer-a',name:'テスト振替',kind:'transfer',amount:2500,date:'2026-11-24',fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',status:'done',categoryId:null}];
  const source={records:[],rules:[],categories:[],assets,payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'};
  const movements=forecastAccounts(source,'2026-11-24').upcomingMovements;
  assert.equal(movements.length,2);
  assert.deepEqual(movements.map(m=>m.amount).sort((a,b)=>a-b),[-2500,2500]);
  assert.ok(movements.every(m=>m.movementStatus==='done'&&m.route==='楽天銀行 → みずほ銀行'));
  assert.equal(movements.reduce((sum,m)=>sum+m.amount,0),0);
});
