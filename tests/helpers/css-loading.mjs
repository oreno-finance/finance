// Source order mirrors the real CSS bundle; HTML intentionally loads only app.css.
import {sourceSheets} from '../../scripts/build-styles.mjs';
export const styleOrder = sourceSheets.map(file => `styles/${file}`).join('\n');

import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
export function shippedSheet(filename){
  const bundle=readFileSync(new URL('../../dist/styles/app.css',import.meta.url),'utf8');
  const marker=`/* SOURCE: ${filename} */\n`;
  const start=bundle.indexOf(marker);
  assert.ok(start>=0,`Missing shipped CSS: ${filename}`);
  const offset=start+marker.length;
  const next=bundle.indexOf('\n/* SOURCE: ',offset);
  return bundle.slice(offset,next<0?undefined:next).trimEnd()+'\n';
}
