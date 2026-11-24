import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyRules,validateRules,listCategories,validateCategory,mergeRules,categoryMeta} from '../dist/src/cloud/merchant-rules.js';
import {LiveVault} from './helpers/coordinated-vault.mjs';
import {GraphError} from '../dist/src/cloud/onedrive-api.js';

const id='cat-550e8400-e29b-41d4-a716-446655440000';
const cat=(categoryId=id,name='ペット',color='brown')=>({id:categoryId,name,color});
const rule=(categoryId)=>({id:'rule-category',pattern:'PET SHOP',mode:'exact',displayName:'ペットショップ',cardId:null,enabled:true,priority:100,categoryId});
const secret='1Passwordの強いテストパスフレーズ';

class FakeGraph {
  constructor(store){this.store=store;}
  async readFinanceIndex(){return this.read('index');}
  async writeFinanceIndex(text,ref){return this.write('index',text,ref);}
  async readLiveVault(){return null;}
  async ensurePayrollNamespace(){}
  async listYearFiles(){return [];}
  async readMerchantRules(){return this.read('rules');}
  async writeMerchantRules(text,ref){return this.write('rules',text,ref);}
  read(k){const x=this.store.get(k);return x?{text:x.text,id:k,etag:`"${x.rev}"`}:null;}
  write(k,text,ref){const old=this.store.get(k);if(old&&ref?.etag!==`"${old.rev}"`)throw new GraphError(412,'conflict');if(!old&&ref)throw new GraphError(412,'conflict');const rev=(old?.rev??0)+1;this.store.set(k,{text,rev});return {id:k,etag:`"${rev}"`};}
}

test('v1.2.1 legacy named colors are preserved and default categories remain editable',()=>{
  const previous={...emptyRules(),categoryColors:{food:'blue'},rules:[rule('food')]};
  assert.deepEqual(validateRules(previous),previous);
  const before=listCategories(previous);
  assert.equal(before.find(x=>x.id==='food').color,'blue');
  assert.equal(before.find(x=>x.id==='food').name,'食費');
  const updated={...previous,categoryDefinitions:[{id:'food',name:'外食・食料品',color:'pink'}]};
  assert.equal(listCategories(validateRules(updated)).find(x=>x.id==='food').name,'外食・食料品');
  assert.equal(listCategories(updated).find(x=>x.id==='food').color,'pink');
});

test('custom category IDs and colors are validated; unknown category cannot corrupt rules',()=>{
  assert.equal(validateCategory(cat()).name,'ペット');
  assert.throws(()=>validateCategory(cat(id,' ', 'blue')),/不正/);
  assert.throws(()=>validateCategory(cat(id,'ペット','#ff0000')),/不正/);
  assert.throws(()=>validateRules({...emptyRules(),rules:[rule(id)]}),/存在しない/);
  const doc=validateRules({...emptyRules(),rules:[rule(id)],categoryDefinitions:[cat()]});
  assert.equal(listCategories(doc).find(x=>x.id===id).name,'ペット');
  assert.equal(categoryMeta(id,undefined,doc.categoryDefinitions)?.color,'brown');
  assert.throws(()=>validateRules({...doc,categoryDefinitions:[cat(),cat()]}),/重複/);
});

test('different category additions merge and same-category name/color changes merge independently',()=>{
  const base=emptyRules();
  const a={...base,categoryDefinitions:[cat()]};
  const b={...base,categoryDefinitions:[cat('cat-650e8400-e29b-41d4-a716-446655440000','教育','blue')]};
  const merged=mergeRules(base,a,b);
  assert.equal(listCategories(merged).length,14);
  const left={...merged,categoryDefinitions:merged.categoryDefinitions.map(x=>x.id===id?{...x,name:'ペット用品'}:x)};
  const right={...merged,categoryDefinitions:merged.categoryDefinitions.map(x=>x.id===id?{...x,color:'pink'}:x)};
  const combined=mergeRules(merged,left,right);
  const item=listCategories(combined).find(x=>x.id===id);
  assert.deepEqual([item.name,item.color],['ペット用品','pink']);
});

test('delete category does not resurrect via stale replica; unrelated rules stay intact',()=>{
  const base={...emptyRules(),categoryDefinitions:[cat()],rules:[rule(id)]};
  const local={...base,categoryDefinitions:[],deletedCategories:[id],rules:[rule(null)]};
  const remote={...base};
  const merged=mergeRules(base,local,remote);
  assert.equal(listCategories(merged).some(x=>x.id===id),false);
  assert.equal(merged.rules[0].categoryId,null);
  const another=mergeRules(merged,merged,{...merged,categoryDefinitions:[cat()],deletedCategories:[id]});
  assert.equal(listCategories(another).some(x=>x.id===id),false);
});

test('Cloud vault saves category CRUD encrypted and merges another client updates',async()=>{
  const store=new Map();const a=new LiveVault(new FakeGraph(store)),b=new LiveVault(new FakeGraph(store));
  await a.create(secret);await b.unlock(secret);
  await a.upsertCategory(cat());
  await b.upsertCategory(cat('cat-650e8400-e29b-41d4-a716-446655440000','教育','blue'));
  await a.refresh();
  assert.equal(a.merchantCategories().length,14);
  assert.equal(store.get('rules').text.includes('ペット'),false);
  await a.upsertMerchantRule(rule(id));
  await b.refresh();
  assert.equal(b.merchantRules()[0].categoryId,id);
  await b.upsertCategory(cat(id,'ペット・動物','green'));
  await a.refresh();
  assert.equal(a.merchantCategories().find(x=>x.id===id).name,'ペット・動物');
  assert.equal(await a.removeCategory(id),1);
  await b.refresh();
  assert.equal(b.merchantRules()[0].categoryId,null);
  assert.equal(b.merchantCategories().some(x=>x.id===id),false);
  assert.equal(store.size,2);
});
