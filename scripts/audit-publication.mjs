/** Finance publication gate. Never prints the contents of suspected secrets. */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, basename } from 'node:path';

const mode=process.argv[2];
if(!['--staged','--tree'].includes(mode)){
  console.error('Usage: node scripts/audit-publication.mjs --staged|--tree');
  process.exit(2);
}
const policy=JSON.parse(readFileSync(new URL('./publication-policy.json',import.meta.url),'utf8'));
const git=(...args)=>execFileSync('git',args,{encoding:'buffer',maxBuffer:64*1024*1024});
const str=(...args)=>git(...args).toString('utf8').trim();
const splitNul=(raw)=>raw.toString('utf8').split('\0').filter(Boolean);
const errors=[];
const allowedIdentity=(name,email)=>policy.allowedAuthors.some(row=>row.name===name&&row.email===email);
const checkIdentity=(name,email,kind)=>{
  if(!allowedIdentity(name,email))errors.push(`${kind}: 公開用Git作成者の許可リストにありません`);
};
try {
  if(mode==='--staged'){
    checkIdentity(str('config','user.name'),str('config','user.email'),'現在のGit作成者');
  }
  for(const line of str('log','--all','--format=%an%x09%ae%x09%cn%x09%ce').split('\n').filter(Boolean)){
    const [name,email,committer,committerEmail]=line.split('\t');
    checkIdentity(name,email,'コミット履歴のAuthor');
    checkIdentity(committer,committerEmail,'コミット履歴のCommitter');
  }
}catch(error){errors.push('Git作成者・履歴を取得できません');}
const names=mode==='--staged'
  ?splitNul(git('diff','--cached','--name-only','--diff-filter=ACMR','-z'))
  :[...new Set(splitNul(git('ls-files','--cached','--others','--exclude-standard','-z')))].filter(existsSync);
// This commit's MSAL vendor finding is only allowed while its exact bundle bytes match.
const pinnedMsalBundleSha256 = '148f7091b42d0ff43a50262325d48322596c582f859b2eed1f291ac62584b484';
const pinnedMsalPath = 'dist/vendor/msal/msal-browser.bundle.js';
if ((mode==='--staged' && names.includes(pinnedMsalPath)) || (mode==='--tree' && existsSync(pinnedMsalPath))) {
  const data = mode==='--staged' ? git('show', `:${pinnedMsalPath}`) : readFileSync(pinnedMsalPath);
  if (createHash('sha256').update(data).digest('hex') !== pinnedMsalBundleSha256) {
    errors.push(`${pinnedMsalPath}: 例外登録済みMSALバンドルのSHA-256が変更されています`);
  }
}

const blockedExt=new Set(['.pdf','.csv','.zip','.7z','.rar','.xlsx','.xls','.docx','.doc','.sqlite','.sqlite3','.db','.enc','.p12','.pfx','.pem','.key','.kdbx','.bak','.backup','.env','.log']);
const allowedText=new Set(['.ts','.js','.mjs','.cjs','.json','.css','.html','.md','.txt','.svg','.yml','.yaml','.toml','.sh']);
const secrets=[
  ['秘密鍵',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHubトークン',/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{25,}\b/],
  ['GitHubトークン',/\bgithub_pat_[A-Za-z0-9_]{35,}\b/],
  ['クラウドアクセスキー',/\bAKIA[0-9A-Z]{16}\b/],
  ['OpenAI形式の秘密鍵',/\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/],
  ['Bearerトークン',/\bAuthorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._=-]{30,}/i],
  ['秘密値の直書き',/\b(?:client_secret|access_token|refresh_token|api_key|private_key)\s*[=:]\s*["'][A-Za-z0-9_.\/+\-=]{20,}["']/i],
  ['個人メールアドレス',/\b(?![A-Za-z0-9_.+-]+@users\.noreply\.github\.com\b)[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i],
  ['端末のユーザーパス',/\/(?:Users|home)\/[a-zA-Z0-9._-]+\/(?:Documents|Desktop|Downloads|Library|Pictures|OneDrive)\b/],
  ['電話番号',/(?:\+81[-\s]?)?0[789]0[-\s]?\d{4}[-\s]?\d{4}\b/],
  ['住所・郵便番号',/〒\s*\d{3}[-－]\d{4}/],
  ['銀行口座番号',/口座番号\s*[:：]\s*\d{7}\b/],
];
const disallowedFilename=(path)=>{
  const lower=path.toLowerCase();
  const ext=extname(lower);
  if(blockedExt.has(ext))return true;
  if(/(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials?(?:\.|$)|private-data|local-data|backups?|exports?|secrets?)(?:\/|$)/i.test(path))return true;
  if(/(?:^|\/)(?:statement[-_]?(?:20\d\d)?|financial[-_]?(?:data|export)|payroll[-_]?(?:data|statement))\.(?:json|txt)$/i.test(path))return true;
  if(ext==='.ico')return !/^(public|dist)\/favicon\.ico$/.test(path);
  if(ext==='.json')return !['package.json','package-lock.json','tsconfig.json','scripts/publication-policy.json'].includes(path);
  if(ext==='.txt')return !/^README-v[0-9]+\.txt$/.test(path);
  if(['.bcmap','.pfb','.ttf'].includes(ext))return !path.startsWith('dist/vendor/pdfjs/');
  // Permit only the four official PDF.js WASM decoder names under its vendor directory.
  if(ext==='.wasm')return !/^dist\/vendor\/pdfjs\/wasm\/(?:jbig2|openjpeg|qcms_bg|quickjs-eval)\.wasm$/.test(path);
  if(!ext){
    if(['LICENSE','.gitignore','.gitattributes','.githooks/pre-commit','.gitleaksignore'].includes(path))return false;
    // Only the reviewed, redistributable PDF.js dependency license files are allowed.
    if(path==='dist/vendor/pdfjs/cmaps/LICENSE')return false;
    if(/^dist\/vendor\/pdfjs\/standard_fonts\/LICENSE_(?:FOXIT|LIBERATION)$/.test(path))return false;
    if(/^dist\/vendor\/pdfjs\/wasm\/LICENSE_(?:JBIG2|OPENJPEG|QCMS|QUICKJS|PDFJS_(?:JBIG2|OPENJPEG|QCMS|QUICKJS))$/.test(path))return false;
    return true;
  }
  return !allowedText.has(ext);
};
for(const path of names){
  if(disallowedFilename(path)){
    errors.push(`${path}: 公開禁止または未承認のファイル形式`);
    continue;
  }
  if(path.endsWith('/favicon.ico'))continue;
  if(path.startsWith('dist/vendor/'))continue; // Vendor binaries/scripts remain covered by Gitleaks history scan in CI.
  const bytes=mode==='--staged'?git('show',`:${path}`):readFileSync(path);
  if(bytes.includes(0)){
    errors.push(`${path}: テキスト内にバイナリデータ`);
    continue;
  }
  if(bytes.length>2*1024*1024){errors.push(`${path}: ソースファイルが大きすぎます`);continue;}
  const content=bytes.toString('utf8');
  if(path==='.gitleaksignore'){
    // Keep the only two explicitly reviewed historical findings; fail closed on broader exclusions.
    const expected=new Set([
      '667644e138623d9606c25f7d559d9476e38459a5:tests/write-outcome-v1612.test.mjs:generic-api-key:8',
      'fdb7f28954406964f35ec11c89169098e7d9f36b:dist/vendor/msal/msal-browser.bundle.js:generic-api-key:1',
      'dist/vendor/msal/msal-browser.bundle.js:generic-api-key:1',
    ]);
    const ignored=content.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
    if(ignored.length!==expected.size || new Set(ignored).size!==expected.size || ignored.some(line=>!expected.has(line))){
      errors.push('.gitleaksignore: 承認済みの3件以外を除外しようとしています');
    }
  }
  for(const [label,pattern] of secrets){
    if(pattern.test(content))errors.push(`${path}: ${label}の疑い`);
  }
}
if(errors.length){
  for(const issue of [...new Set(errors)])console.error('BLOCKED:',issue);
  console.error(`[FINANCE] 公開監査に失敗 (${errors.length}件)。コミット・デプロイを中止してください。`);
  process.exit(1);
}
console.log(`[FINANCE] 公開監査OK (${names.length}ファイル、Git作成者・履歴・個人情報・秘密情報)`);
