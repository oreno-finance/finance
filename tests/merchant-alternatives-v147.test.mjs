import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRule, validateRules, emptyRules, matchingRule, displayMerchant, mergeRules} from '../dist/src/cloud/merchant-rules.js';
import {readFile} from 'node:fs/promises';
const rule={
 id:'taxi-merchant-1',pattern:'AA運送',patterns:['BB大阪支店'],mode:'exact',
 displayName:'タクシー',cardId:null,enabled:true,priority:100,categoryId:'transport',
};
test('multiple merchants share exactly one display name and category',()=>{
 const saved=validateRule(rule);
 assert.deepEqual(saved.patterns,['BB大阪支店']);
 for(const name of ['AA運送','BB大阪支店']){
   assert.equal(displayMerchant(name,'smbc-nl',[saved]),'タクシー');
   assert.equal(matchingRule(name,'smbc-nl',[saved])?.categoryId,'transport');
 }
 assert.equal(matchingRule('CC東京',null,[saved]),undefined);
 assert.equal(validateRules({...emptyRules(),rules:[saved]}).rules.length,1);
});
test('old single-pattern rules remain valid',()=>{
 const {patterns,...old}=rule;
 assert.equal(validateRule(old).patterns,undefined);
 assert.equal(matchingRule('AA運送',null,[old])?.id,'taxi-merchant-1');
});
test('prefix/contains alternatives match normalized merchant names',()=>{
 const prefix=validateRule({...rule,mode:'prefix'});
 assert.equal(matchingRule('ＢＢ大阪支店　夜間',null,[prefix])?.id,'taxi-merchant-1');
 const contains=validateRule({...rule,mode:'contains'});
 assert.equal(matchingRule('決済 AA運送 2026',null,[contains])?.id,'taxi-merchant-1');
});
test('duplicates, excessive alternatives and invalid shapes fail closed',()=>{
 assert.throws(()=>validateRule({...rule,patterns:['ＡＡ運送']}),/同じ利用先条件/);
 assert.throws(()=>validateRule({...rule,patterns:['']}),/追加条件/);
 assert.throws(()=>validateRule({...rule,patterns:Array.from({length:20},(_,i)=>`駅-${i}`)}),/追加条件/);
 assert.throws(()=>validateRule({...rule,patterns:['a'.repeat(201)]}),/追加条件/);
 assert.throws(()=>validateRule({...rule,patterns:'BB大阪支店'}),/追加条件/);
});
test('independent edits merge added alternatives and renamed target',()=>{
 const {patterns,...previous}=rule;
 const base={...emptyRules(),rules:[previous]};
 const local={...emptyRules(),rules:[rule]};
 const remote={...emptyRules(),rules:[{...previous,displayName:'タクシー代'}]};
 const merged=mergeRules(base,local,remote);
 assert.equal(merged.rules.length,1);
 assert.deepEqual(merged.rules[0].patterns,['BB大阪支店']);
 assert.equal(merged.rules[0].displayName,'タクシー代');
});
test('UI keeps one rule editor and verifies side-by-side layouts',async()=>{
 const root=new URL('../',import.meta.url);
 const html=await readFile(new URL('public/index.html',root),'utf8');
 const main=await readFile(new URL('src/main.ts',root),'utf8');
 const monthly=await readFile(new URL('src/ui/monthly-summary.ts',root),'utf8');
 const css=await readFile(new URL('public/styles/layout-v147.css',root),'utf8');
 assert.match(html,/id="rule-pattern"[^>]*type="text"/);
 assert.match(html,/id="rule-pattern-add"/);
 assert.match(main,/patterns\.length>1\?\{patterns:patterns\.slice\(1\)\}/);
 assert.doesNotMatch(html,/id="manage-total"/);
 assert.doesNotMatch(main,/\$\('manage-total'\)/);
 assert.doesNotMatch(html,/id="nav-payroll"/);
 assert.match(html,/class="recurring-top-row"/);
 assert.match(html,/class="recurring-account-row"/);
 assert.match(html,/class="recurring-schedule-row"/);
 assert.match(html,/class="cloud-settings-left"/);
 assert.match(monthly,/const merchants=insightSection\(report\.merchants\.length>10\?'カード利用先ランキング（上位10件）':'カード利用先ランキング'\)/);
 assert.match(css,/grid-template-columns:minmax\(0,7fr\) minmax\(265px,3fr\)/);
 assert.match(css,/background-position:right 13px center/);
});
