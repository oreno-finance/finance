import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateFinanceCsp, validateFinanceAuthCsp} from '../scripts/finance-csp.mjs';

const main=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const auth=readFileSync(new URL('../public/auth-bridge.html',import.meta.url),'utf8');
const scanner=readFileSync(new URL('../scripts/finance-csp.mjs',import.meta.url),'utf8');
const meta=main.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)?.[0];
assert.ok(meta);

function reject(candidate,description,authPage=false){
  const issues=authPage?validateFinanceAuthCsp(candidate):validateFinanceCsp(candidate);
  assert.notDeepEqual(issues,[],description);
}

test('no multi-character stripping, CSP is scanned from unchanged source',()=>{
  assert.doesNotMatch(scanner,/html\.replace\s*\(/);
  assert.doesNotMatch(scanner,/head\[1\]\.replace\s*\(/);
  assert.deepEqual(validateFinanceCsp(main),[]);
  assert.deepEqual(validateFinanceAuthCsp(auth),[]);
});

test('comments around head and CSP never manufacture active attributes or tags',()=>{
  const source=main.replace(meta,'');
  for(const bait of [
    `<!-- ${meta} -->`,
    `<!-- <head> ${meta} </head> -->`,
    `<!-- <--><!-- ${meta} -->`,
    `<!-- keep this open ${meta}`,
    `<!-- <script> -->${meta.replace('http-equiv','data-http-equiv')}`,
    `<!--><meta http-equiv="Content-Security-Policy" content="default-src *">${meta.replace('http-equiv','data-http-equiv')}`,
  ])reject(source.replace('<title>',bait+'<title>'),'comment bait must not become a policy');
  const harmless=main.replace('<title>','<!-- A <!-- nested-ish marker -->\n<title>');
  assert.deepEqual(validateFinanceCsp(harmless),[]);
});

test('raw-text elements are skipped by offsets, not by pattern deletion',()=>{
  const source=main.replace(meta,'');
  for(const name of ['script','style','title','textarea']){
    reject(source.replace('<title>',`<${name}>${meta}</${name}>\n<title>`),`${name} text cannot define CSP`);
    reject(source.replace('<title>',`<${name}>${meta}`),`unclosed ${name} cannot define CSP`);
  }
  reject(source.replace('<title>',`<script>const example='<!--'; ${meta} </script><title>`),'script comment text is not markup');
  reject(source.replace('<title>',`<script>const example='</scr'; ${meta} </script><title>`),'split raw closing is not markup');
  reject(source.replace('<title>',`<template>${meta}</template><title>`),'template CSP is inactive');
  reject(source.replace('<title>',`<noscript>${meta}</noscript><title>`),'noscript parsing differs by scripting mode');
});

test('CSP must precede executable scripts in head',()=>{
  const script='<script src="./scripts/theme-boot.js"></script>';
  const late=main.replace(meta,'').replace(script,script+'\n'+meta);
  reject(late,'script before CSP cannot be protected retrospectively');
  assert.deepEqual(validateFinanceCsp(main),[]);
});

test('broken and browser-ambiguous head syntax fails closed',()=>{
  const source=main.replace(meta,'');
  for(const fragment of [
    `<metax http-equiv="Content-Security-Policy" content="${meta}">`,
    meta.replace('<meta','<meta.unknown'),
    meta.replace('content=', 'data-content='),
    meta.replace('http-equiv=', 'data-http-equiv='),
    meta.replace('http-equiv=', 'http-equiv="Content-Security-Policy" HTTP-EQUIV='),
    meta.replace('content=', 'content="x" CONTENT='),
    `<script badsyntax?><meta http-equiv="Content-Security-Policy" content="bad"></script>`,
    `</head>\n${meta}\n<head>`,
  ])reject(source.replace('<title>',fragment+'\n<title>'),'ambiguous markup is forbidden');
});

test('quoted angle brackets in harmless tag attributes do not terminate the tag',()=>{
  const modified=main.replace('<meta charset="utf-8">','<meta name="other" content="a > b < c">');
  assert.deepEqual(validateFinanceCsp(modified),[]);
});

test('auth callback page follows the same strict lexical safeguards',()=>{
  const authMeta=auth.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)?.[0];
  assert.ok(authMeta);
  reject(auth.replace(authMeta,`<script>${authMeta}</script>`),'hidden auth CSP',true);
  reject(auth.replace(authMeta,`<!-- ${authMeta} -->`),'commented auth CSP',true);
  reject(auth.replace(authMeta,authMeta.replace('content=','data-content=')),'fake auth content',true);
  assert.deepEqual(validateFinanceAuthCsp(auth),[]);
});
