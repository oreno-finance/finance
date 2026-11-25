import {shippedSheet} from './helpers/css-loading.mjs';
import {styleOrder} from './helpers/css-loading.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dist = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles/page-headings-v181.css', import.meta.url), 'utf8');

test('all eleven top-level Finance views have the shared page heading', () => {
  assert.equal((html.match(/finance-page-heading/g) || []).length, 11); // 11 headers
  for (const view of ['home-view','import-view','summary-view','analysis-view','subscriptions-view','reports-view','manage-view','rules-view','assets-view','future-view','settings-view']) {
    const start = html.indexOf(`id="${view}"`);
    assert.ok(start !== -1, `${view} exists`);
    assert.match(html.slice(start, start + 380), /finance-page-heading/);
  }
  assert.match(css, /\.finance-page-heading h1\s*\{/);
  assert.match(css, /#import-view > \.finance-page-heading/);
  assert.match(css, /#manage-view > \.finance-page-heading/);
});

test('forecast heading avoids a repeated eyebrow', () => {
  const start = html.indexOf('id="future-view"');
  const end = html.indexOf('id="settings-view"', start);
  const segment = html.slice(start,end);
  assert.equal((segment.match(/SAVINGS FORECAST/g) || []).length, 1);
});

test('distribution includes the same page layout and new stylesheet', () => {
  assert.equal(dist, html);
  assert.equal(shippedSheet('page-headings-v181.css'),css);
  assert.match(styleOrder, /styles\/page-headings-v181\.css/);
});
