import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateFinanceCsp,validateFinanceAuthCsp} from '../scripts/finance-csp.mjs';
import {nearestProjectionIndexSvgX,chartXFromScreenPoint} from '../dist/src/ui/future-projection.js';

const base=new URL('../',import.meta.url);
const main=readFileSync(new URL('public/index.html',base),'utf8');
const auth=readFileSync(new URL('public/auth-bridge.html',base),'utf8');
const ui=readFileSync(new URL('src/ui/future-projection.ts',base),'utf8');
const css=readFileSync(new URL('public/styles/future-projection.css',base),'utf8');
const bank=readFileSync(new URL('src/ui/assets-settings.ts',base),'utf8');
const mainCsp=main.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)?.[0];
const authCsp=auth.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)?.[0];
assert.ok(mainCsp);assert.ok(authCsp);
const before=(html,csp,markup)=>html.replace(csp,`${markup}\n${csp}`);

for(const [page,html,csp,validate] of [
  ['main',main,mainCsp,validateFinanceCsp],
  ['authentication',auth,authCsp,validateFinanceAuthCsp],
]){
  test(`${page}: approved metadata can appear before CSP, but external preload must be rejected`,()=>{
    assert.deepEqual(validate(html),[]);
    const dangers=[
      '<link rel="preload" as="script" href="https://untrusted.invalid/a.js">',
      '<link rel="modulepreload" href="https://untrusted.invalid/module.js">',
      '<link rel="stylesheet" href="https://untrusted.invalid/styles.css">',
      '<link rel="prefetch" href="https://untrusted.invalid/">',
      '<link rel="preconnect" href="https://untrusted.invalid/">',
      '<base href="https://untrusted.invalid/">',
      '<meta http-equiv="refresh" content="0;url=https://untrusted.invalid/">',
      '<meta name="referrer" content="unsafe-url">',
      '<meta charset="shift_jis">',
      '<meta name="viewport" content="width=1024">',
      '<meta data-http-equiv="Content-Security-Policy" content="default-src *">',
      '<meta name="description" content="x" data-extra="oops">',
      '<script src="https://untrusted.invalid/a.js"></script>',
      '<style>@import url(https://untrusted.invalid/a.css);</style>',
    ];
    for(const fragment of dangers){
      const result=validate(before(html,csp,fragment));
      assert.notDeepEqual(result,[],`unsafe markup accepted: ${fragment}`);
      assert.match(result.join(' '),/CSP適用前|未承認/);
    }
  });
  test(`${page}: safe metadata ordering is unaffected`,()=>{
    const safe=[
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="description" content="説明と < 引用 >">',
      '<meta name="theme-color" content="#123abc">',
    ];
    for(const fragment of safe)assert.deepEqual(validate(before(html,csp,fragment)),[],fragment);
  });
}

test('SVG screen CTM accounts for letterboxing and high-density scaling',()=>{
  assert.equal(nearestProjectionIndexSvgX(50,13),0);
  assert.equal(nearestProjectionIndexSvgX(437,13),6);
  assert.equal(nearestProjectionIndexSvgX(824,13),12);
  const scaleWithLetterbox={a:0.5,b:0,c:0,d:0.5,e:120,f:75};
  const rendered=chartXFromScreenPoint(120+437*0.5,100,scaleWithLetterbox);
  assert.equal(rendered,437);
  assert.equal(nearestProjectionIndexSvgX(rendered,13),6);
  assert.equal(nearestProjectionIndexSvgX(2000,13),12);
  assert.equal(nearestProjectionIndexSvgX(-2000,13),0);
});

test('SVG screen mapping supports rotation and fails closed on singular transforms',()=>{
  const rotation={a:0,b:2,c:-2,d:0,e:600,f:50};
  assert.equal(chartXFromScreenPoint(400,924,rotation),437);
  assert.equal(nearestProjectionIndexSvgX(chartXFromScreenPoint(400,924,rotation),13),6);
  assert.equal(chartXFromScreenPoint(200,200,{a:0,b:0,c:0,d:0,e:10,f:10}),null);
  assert.equal(chartXFromScreenPoint(Number.NaN,50,rotation),null);
});

test('touch has no native highlight; keyboard has visible focus and filters restore focused control',()=>{
  assert.match(css,/\.future-chart-svg\{[^}]*outline:none;/);
  assert.match(css,/\.future-chart-svg\{[^}]*-webkit-tap-highlight-color:transparent/);
  assert.match(css,/\.future-chart-svg:focus-visible\{outline:2px solid var\(--accent\)/);
  assert.match(ui,/const hadFocus=document\.activeElement===button/);
  assert.match(ui,/next\?\.focus\(\{preventScroll:true\}\)/);
  assert.match(ui,/svg\.getScreenCTM\(\)/);
  assert.match(ui,/nearestProjectionIndexSvgX\(mapped,points\.length\)/);
});

test('balance comparison explicitly says it is recalculated from current settings',()=>{
  assert.match(bank,/残高照合（再計算と実績）/);
  assert.match(bank,/現在の設定による再計算残高/);
  assert.match(bank,/当時保存していた予測値ではありません/);
  assert.match(bank,/使途不明金とは断定できません/);
  assert.doesNotMatch(bank,/前回予測と今回実績/);
});
