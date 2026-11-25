import { mkdir, cp, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sourceSheets } from './build-styles.mjs';

const sourceCss=new Set(sourceSheets.map(filename=>resolve('public','styles',filename)));

await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true, force: true, filter: path=>!sourceCss.has(resolve(path)) });
const source = 'node_modules/pdfjs-dist/build';
const target = join('dist', 'vendor', 'pdfjs');
try {
  await access(join(source, 'pdf.mjs'));
  await mkdir(target, { recursive: true });
  await Promise.all(['pdf.mjs', 'pdf.worker.mjs'].map(filename =>
    cp(join(source, filename), join(target, filename), { force: true })
  ));
  await Promise.all(['cmaps', 'standard_fonts'].map(folder =>
    cp(join('node_modules/pdfjs-dist', folder), join(target, folder), { recursive: true, force: true })
  ));
  // PDF.js 6 uses bundled WebAssembly for some image decoders. Keep it same-version.
  try {
    await access('node_modules/pdfjs-dist/wasm');
    await cp('node_modules/pdfjs-dist/wasm', join(target, 'wasm'), { recursive: true, force: true });
  } catch { /* Older releases may not ship a wasm directory. */ }
  console.log('PDF.js: self-hosted vendor copied into dist/vendor/pdfjs');
} catch {
  console.warn('PDF.js package unavailable. Run npm install and npm run build before opening PDFs.');
}
