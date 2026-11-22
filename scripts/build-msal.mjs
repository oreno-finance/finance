import { mkdir, stat, copyFile } from 'node:fs/promises';
const isInstalled = async (p) => { try { await stat(p); return true; } catch { return false; } };
const msalPresent = await isInstalled('node_modules/@azure/msal-browser/package.json');
const esbuildPresent = await isInstalled('node_modules/esbuild/package.json');
if (!msalPresent || !esbuildPresent) {
  console.warn('MSAL: 未インストール。npm install && npm run build でOneDrive認証モジュールを生成してください。');
} else {
  const { build } = await import('esbuild');
  await mkdir('dist/vendor/msal', { recursive: true });
  await build({
    entryPoints: ['scripts/msal-entry.mjs'],
    outfile: 'dist/vendor/msal/msal-browser.bundle.js',
    format: 'esm', platform:'browser', bundle:true, minify:true, target:'es2022',
    legalComments: 'none',
  });
  // Ship the official MSAL v5 redirect bridge UMD bundle unmodified.
  await copyFile('node_modules/@azure/msal-browser/lib/redirect-bridge/msal-redirect-bridge.min.js',
    'dist/vendor/msal/msal-redirect-bridge.min.js');
  console.log('MSAL: library + dedicated redirect bridge bundles generated.');
}
