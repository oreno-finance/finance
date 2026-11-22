import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ignoreFile = new URL('../.gitleaksignore', import.meta.url);
const auditFile = new URL('../scripts/audit-publication.mjs', import.meta.url);
const expected = [
  '667644e138623d9606c25f7d559d9476e38459a5:tests/write-outcome-v1612.test.mjs:generic-api-key:8',
  'fdb7f28954406964f35ec11c89169098e7d9f36b:dist/vendor/msal/msal-browser.bundle.js:generic-api-key:1',
  'dist/vendor/msal/msal-browser.bundle.js:generic-api-key:1',
];

test('Gitleaks ignore is limited to three reviewed fingerprints', () => {
  const text = readFileSync(ignoreFile, 'utf8');
  const entries = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  assert.deepEqual(entries, expected);
  assert.ok(entries.slice(0,2).every(s => /^[a-f0-9]{40}:[^:]+:generic-api-key:\d+$/.test(s)));
  assert.equal(entries[2], 'dist/vendor/msal/msal-browser.bundle.js:generic-api-key:1');
});

test('publication audit validates the exact Gitleaks ignore file', () => {
  const text = readFileSync(auditFile, 'utf8');
  assert.match(text, /path==='\.gitleaksignore'/);
  assert.match(text, /承認済みの3件以外を除外/);
  assert.match(text, /expected\.has\(line\)/);
});

// The single-line vendor exception must fail closed when its actual bytes change.
test('reviewed MSAL vendor fingerprint is tied to the exact generated bundle digest', () => {
  const audit = readFileSync(auditFile, 'utf8');
  const bundle = readFileSync(new URL('../dist/vendor/msal/msal-browser.bundle.js', import.meta.url));
  const match = /const pinnedMsalBundleSha256 = '([a-f0-9]{64})';/.exec(audit);
  assert.ok(match, 'bundle pin missing');
  assert.equal(createHash('sha256').update(bundle).digest('hex'), match[1]);
});
