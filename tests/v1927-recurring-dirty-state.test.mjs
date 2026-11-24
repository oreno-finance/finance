import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {recurringDraftSnapshot,recurringSwitchNeedsConfirmation} from '../dist/src/ui/assets-settings.js';
const source=readFileSync(new URL('../src/ui/assets-settings.ts',import.meta.url),'utf8');

const initial=[
  {id:'assets-recurring-name',type:'text',value:'保険料'},
  {id:'assets-recurring-amount',type:'number',value:'10000'},
  {id:'assets-recurring-kind',type:'select-one',value:'expense'},
  {id:'assets-recurring-day',type:'select-one',value:'27'},
  {id:'assets-recurring-enabled',type:'checkbox',value:'on',checked:true},
];
const copy=()=>initial.map(field=>({...field}));

test('opening a recurring editor does not count as a change or prompt on switching and clearing',()=>{
  const baseline=recurringDraftSnapshot(initial);
  assert.equal(recurringDraftSnapshot(copy()),baseline);
  assert.equal(recurringSwitchNeedsConfirmation(false,'insurance','internet'),false);
  assert.match(source,/recurringBaseline=recurringSnapshot\(\);/g);
  assert.match(source,/if\(recurringHasChanges\(\)\)\{\s*if\(!await requestConfirmation\(/);
  assert.match(source,/isDirty:\(\)=>onceHasChanges\(\)\|\|recurringHasChanges\(\)/);
  assert.doesNotMatch(source,/editingId=item\.id;dirty=true/);
});

test('editing text, amount, select or checkbox prompts before switching to a different item',()=>{
  const baseline=recurringDraftSnapshot(initial);
  for(const [index,patch] of [
    [0,{value:'通信費'}],
    [1,{value:'11000'}],
    [2,{value:'income'}],
    [3,{value:'31'}],
    [4,{checked:false}],
  ]){
    const draft=copy();Object.assign(draft[index],patch);
    assert.notEqual(recurringDraftSnapshot(draft),baseline);
    assert.equal(recurringSwitchNeedsConfirmation(true,'insurance','internet'),true);
    assert.equal(recurringSwitchNeedsConfirmation(true,'insurance','insurance'),false);
    Object.assign(draft[index],initial[index]);
    assert.equal(recurringDraftSnapshot(draft),baseline,'restored input is not dirty');
  }
});

test('a new unsaved recurring draft remains protected, but unchanged defaults do not prompt',()=>{
  assert.equal(recurringSwitchNeedsConfirmation(true,null,'internet'),true);
  assert.equal(recurringSwitchNeedsConfirmation(false,null,'internet'),false);
  assert.match(source,/const recurringHasChanges=\(\):boolean=>recurringSnapshot\(\)!==recurringBaseline/);
  assert.match(source,/recurringSwitchNeedsConfirmation\(recurringHasChanges\(\),editingId,item\.id\)/);
});
