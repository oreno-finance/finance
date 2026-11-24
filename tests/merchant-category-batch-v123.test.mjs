import test from 'node:test';
import assert from 'node:assert/strict';
import {planCategoryBatch,categoryBatchChanged} from '../dist/src/ui/category-draft.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';

const secret='Finance v1.2.3 1Password test passphrase';
const id='cat-550e8400-e29b-41d4-a716-446655440000';
const custom={id,name:'ペット',color:'brown'};
const rule={id:'rule-for-cat',pattern:'PETS',mode:'exact',displayName:'ペット用品',cardId:null,enabled:true,priority:100,categoryId:id};
class FakeGraph {
 constructor(store){this.store=store;}
 async readFinanceIndex(){return this.read('index');}
 async writeFinanceIndex(text,ref){return this.write('index',text,ref);}
 async readLiveVault(){return null;}
 async ensurePayrollNamespace(){}
 async listYearFiles(){return [];}
 async readMerchantRules(){return this.read('rules');}
 async writeMerchantRules(text,ref){return this.write('rules',text,ref);}
 read(k){const value=this.store.get(k);return value?{text:value.text,id:k,etag:`"${value.rev}"`}:null;}
 write(k,text,ref){const value=this.store.get(k);if(value&&ref?.etag!==`"${value.rev}"`)throw new GraphError(412,'conflict');if(!value&&ref)throw new GraphError(412,'conflict');const rev=(value?.rev??0)+1;this.store.set(k,{text,rev});return {id:k,etag:`"${rev}"`};}
}

test('modal stage: changed rows are collected without mutating cloud categories',()=>{
 const before=[{id:'food',name:'食費',color:'orange'},custom];
 const draft=structuredClone(before);
 draft[0].name='食料品'; draft[1].color='blue';
 assert.deepEqual(before[0],{id:'food',name:'食費',color:'orange'});
 const changes=planCategoryBatch(before,draft);
 assert.equal(changes.upserts.length,2);
 assert.equal(changes.removeIds.length,0);
 assert.equal(categoryBatchChanged(changes),true);
 assert.equal(categoryBatchChanged(planCategoryBatch(before,before)),false);
 assert.deepEqual(planCategoryBatch(before,[before[0]]).removeIds,[id]);
});

test('duplicate category names and invalid draft are rejected before network writes',()=>{
 const before=[{id:'food',name:'食費',color:'orange'}];
 assert.throws(()=>planCategoryBatch(before,[before[0],{...custom,name:' 食費 '}]),/同じ名前/);
 assert.throws(()=>planCategoryBatch(before,[{...before[0],color:'unknown'}]),/不正/);
 assert.throws(()=>planCategoryBatch(before,[{...before[0],name:' '}]),/不正/);
});

test('batch updates multiple categories and unassigns removed category with exactly one Graph write',async()=>{
 const store=new Map(),graph=new FakeGraph(store),vault=new LiveVault(graph);
 await vault.create(secret);
 await vault.applyCategoryBatch({upserts:[custom],removeIds:[]});
 await vault.upsertMerchantRule(rule);
 const old=store.get('rules').rev;
 await vault.applyCategoryBatch({upserts:[{id:'food',name:'食料品',color:'pink'}, {id:'fixed',name:'毎月の支払',color:'blue'}],removeIds:[id]});
 assert.equal(store.get('rules').rev,old+1,'one encrypted cloud write, not one per row');
 assert.equal(vault.merchantCategories().some(item=>item.id===id),false);
 assert.equal(vault.merchantCategories().find(item=>item.id==='food').name,'食料品');
 assert.equal(vault.merchantCategories().find(item=>item.id==='fixed').name,'毎月の支払');
 assert.equal(vault.merchantRules()[0].categoryId,null);
 assert.equal(store.get('rules').text.includes('食料品'),false,'plaintext must never be sent');
});

test('category batch preserves concurrent changes from a second device',async()=>{
 const store=new Map(),mac=new LiveVault(new FakeGraph(store)),galaxy=new LiveVault(new FakeGraph(store));
 await mac.create(secret);await galaxy.unlock(secret);
 await mac.applyCategoryBatch({upserts:[{id:'food',name:'食料品',color:'orange'}],removeIds:[]});
 await galaxy.applyCategoryBatch({upserts:[{id:'subscription',name:'定期課金',color:'violet'}],removeIds:[]});
 await mac.refresh();
 assert.equal(mac.merchantCategories().find(x=>x.id==='food').name,'食料品');
 assert.equal(mac.merchantCategories().find(x=>x.id==='subscription').name,'定期課金');
});

test('invalid batches never write and never remove existing categories',async()=>{
 const store=new Map(),vault=new LiveVault(new FakeGraph(store));await vault.create(secret);
 const before=store.size;
 await assert.rejects(vault.applyCategoryBatch({upserts:[{...custom,name:'食費'}],removeIds:[]}),/同じ名前/);
 await assert.rejects(vault.applyCategoryBatch({upserts:[custom],removeIds:[id]}),/重複/);
 assert.equal(store.size,before);
 assert.equal(vault.merchantCategories().length,12);
});
