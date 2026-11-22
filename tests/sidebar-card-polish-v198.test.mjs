import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {statementReviewDate} from '../dist/src/home/action-items.js';
import {cardPaymentDate} from '../dist/src/importers/payment-date.js';
const root=new URL('../',import.meta.url);
const file=path=>readFileSync(new URL(path,root),'utf8');

test('sidebar has a delayed, temporary mouse peek, with hover-only animation and reduced-motion support',()=>{
 const source=file('src/main.ts'),css=file('public/styles/layout-v196.css');
 assert.match(source,/function scheduleDesktopMenuPeek\(\):void/);
 assert.match(source,/window\.setTimeout\([\s\S]*?,340\)/);
 assert.match(source,/event\.pointerType==='mouse'/);
 assert.match(source,/pointerleave',\(\)=>\{closeDesktopMenuPeek\(\);\}/);
 assert.match(source,/function showView\(view: FinanceView\): void \{[\s\S]*?if\(document\.querySelector\('\.app-shell\.nav-peeking'\)\)closeDesktopMenuPeek\(\)/);
 assert.match(source,/function clearDesktopMenuPeek\(preserveManualTransition=false\):void[\s\S]*?classList\.remove\('nav-peeking','nav-peek-closing'\)/);
 assert.match(css,/\.app-shell\.nav-collapsed/);
 assert.match(css,/transition:width 320ms/);
 assert.match(file('public/styles/layout-v1911.css'),/@keyframes finance-peek-open/);
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
 // Storing a collapsed preference must only happen from an explicit toggle, never a peek.
 const peekBody=source.split('function scheduleDesktopMenuPeek():void {')[1].split('/** Mobile disclosure')[0];
 assert.doesNotMatch(peekBody,/localStorage\.setItem/);
});

test('card settings show only configuration fields, not earned point totals',()=>{
 const source=file('src/ui/card-settings.ts');
 assert.match(source,/field\('還元率（%）',rate\)/);
 assert.doesNotMatch(source,/estimateCardPoints|card-setting-choice-points|card-setting-points-total|累計概算|累計 約/);
});

test('placeholder examples never have an 例: prefix',()=>{
 for(const relative of ['public/index.html','src/ui/card-settings.ts']){
  const source=file(relative);
  assert.doesNotMatch(source,/placeholder\s*=\s*['"]例\s*[:：]/,relative);
 }
});

test('custom notice day 30/31 uses the last day in short months, including leap days',()=>{
 const review=(payment,day,monthOffset=-1)=>statementReviewDate('smbc-nl',payment,{review:{monthOffset,day}});
 assert.equal(review('2027-03-10',30),'2027-02-28');
 assert.equal(review('2028-03-10',30),'2028-02-29');
 assert.equal(review('2027-05-10',30),'2027-04-30');
 assert.equal(review('2027-05-10',31),'2027-04-30');
 assert.equal(review('2027-03-10',30,0),'2027-03-30');
 assert.equal(cardPaymentDate('2027-02',{monthOffset:0,day:30}),'2027-03-01');
});
