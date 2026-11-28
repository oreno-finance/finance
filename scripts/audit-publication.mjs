/** Finance publication gate. Never prints the contents of suspected secrets. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFinanceCsp, validateFinanceAuthCsp } from './finance-csp.mjs';

const mode=process.argv[2];
// Only the history actually sent to this remote belongs to the push gate.
// Remote-tracking refs may be stale or belong to another remote, so never use --remotes as an exclusion.
if(mode==='--push'){
  try{
    const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    const sha=/^[0-9a-f]{40}$/i, zero='0'.repeat(40);
    const heads=new Set(), bases=new Set();
    let newBranch=false;
    for(const line of readFileSync(0,'utf8').trim().split(/\r?\n/).filter(Boolean)){
      const fields=line.split(/\s+/), [,local,,remote]=fields;
      if(fields.length!==4||!sha.test(local)||!sha.test(remote))throw new Error('invalid ref');
      if(local===zero)continue;
      git('cat-file','-e',`${local}^{commit}`);heads.add(local);
      if(remote===zero)newBranch=true;
      else {git('cat-file','-e',`${remote}^{commit}`);bases.add(remote);}
    }
    if(!heads.size)process.exit(0);
    if(git('rev-parse','--is-shallow-repository')!=='false')throw new Error('shallow history');
    if(newBranch){
      const remoteUrl=process.argv[3];
      if(!remoteUrl)throw new Error('missing remote');
      for(const line of git('ls-remote','--heads','--',remoteUrl).split('\n').filter(Boolean)){
        const [id,ref]=line.split('\t');
        if(!sha.test(id)||!ref?.startsWith('refs/heads/'))throw new Error('invalid remote ref');
        // Unknown remote objects cannot be proven locally: scan more, not less.
        if(spawnSync('git',['cat-file','-e',`${id}^{commit}`],{stdio:'ignore'}).status===0)bases.add(id);
      }
    }
    const range=[...heads,...[...bases].map(id=>`^${id}`)];
    const commits=git('rev-list','--reverse',...range).split('\n').filter(Boolean);
    console.log(`[FINANCE] push対象: ${commits.length}コミット`);
    for(const id of commits){
      const r=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--commit',id],{stdio:'inherit'});
      if(r.error||r.status!==0)process.exit(r.status||1);
    }
    if(commits.length){
      // Scan the same range, including merge-parent differences; no unrelated local history.
      const r=spawnSync('gitleaks',['git','--redact','--no-banner',`--log-opts=-m --full-history ${range.join(' ')}` ,'.'],{stdio:'inherit'});
      if(r.error||r.status!==0)process.exit(r.status||1);
    }
    process.exit(0);
  }catch{
    console.error('[FINANCE] push対象の履歴を確認できません。送信先・ブランチ・取得済み履歴を確認してください。');
    process.exit(1);
  }
}
// CI must inspect EACH incoming commit, not only the final clean working tree.
// Run the same --commit publication policy that the local pre-push hook uses.
if(mode==='--range'){
  const [base,head]=process.argv.slice(3);
  const sha=/^[0-9a-f]{40}$/i;
  if(process.argv.length!==5||!sha.test(base??'')||!sha.test(head??'')||/^0{40}$/.test(base)){
    console.error('Usage: node scripts/audit-publication.mjs --range BASE_SHA HEAD_SHA');
    process.exit(2);
  }
  try {
    execFileSync('git',['cat-file','-e',`${base}^{commit}`],{stdio:'pipe'});
    execFileSync('git',['cat-file','-e',`${head}^{commit}`],{stdio:'pipe'});
    const commits=execFileSync('git',['rev-list','--reverse',`${base}..${head}`],{encoding:'utf8'})
      .trim().split(/\r?\n/).filter(Boolean);
    console.log(`[FINANCE] 受信コミット履歴監査: ${commits.length}コミット`);
    for(const shaValue of commits){
      const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--commit',shaValue],{
        cwd:process.cwd(),env:process.env,stdio:'inherit',
      });
      if(result.error||result.status!==0)process.exit(result.status||1);
    }
  }catch{
    console.error('[FINANCE] 履歴監査のコミット範囲を取得できません。');
    process.exit(1);
  }
  process.exit(0);
}
const commitSha=process.argv[3];
if(!['--staged','--tree','--commit','--source','--dist'].includes(mode) || (mode==='--commit'&&!/^[0-9a-f]{40,64}$/i.test(commitSha??''))){
  console.error('Usage: node scripts/audit-publication.mjs --staged|--tree|--commit SHA|--source [--history]|--dist');
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
    for(const kind of ['AUTHOR','COMMITTER']){
      const identity=/^(.*) <([^<>]+)> \d+ [+-]\d{4}$/.exec(str('var',`GIT_${kind}_IDENT`));
      if(!identity)throw new Error('invalid identity');
      checkIdentity(identity[1],identity[2],`現在のGit ${kind}`);
    }
  }
  // The pull_request checkout checks out GitHub's *synthetic* test-merge.
  // Trust only the exact CI-provided SHA with the expected base/head parents;
  // never skip the source branch's author/committer validation.
  const syntheticPrMerge=(sha,parents)=>
    process.env.GITHUB_ACTIONS==='true' &&
    process.env.GITHUB_EVENT_NAME==='pull_request' &&
    process.env.GITHUB_BASE_REF==='main' &&
    process.env.GITHUB_SHA===sha &&
    /^[0-9a-f]{40}$/i.test(process.env.FINANCE_PR_BASE_SHA??'') &&
    /^[0-9a-f]{40}$/i.test(process.env.FINANCE_PR_HEAD_SHA??'') &&
    parents.length===2 &&
    parents[0]===process.env.FINANCE_PR_BASE_SHA &&
    parents[1]===process.env.FINANCE_PR_HEAD_SHA;
  // --tree is the explicit worktree / history diagnostic and remains compatible with CI.
  const history=mode==='--staged'||mode==='--dist'||(mode==='--source'&&process.argv[3]!=='--history')?[]:str('log',...(mode==='--commit'?['-1',commitSha]:['--all']),'--format=%H%x09%an%x09%ae%x09%cn%x09%ce%x09%P%x09%s').split('\n').filter(Boolean);
  for(const line of history){
    const [sha,name,email,committer,committerEmail,parentField,subject]=line.split('\t');
    const parents=parentField.split(' ').filter(Boolean);
    if(syntheticPrMerge(sha,parents))continue;
    checkIdentity(name,email,'コミット履歴のAuthor');
    // GitHub's official "Create a merge commit" flow uses its own exact
    // committer identity. Restrict the exception to two-parent PR merges,
    // an already-allowed human author, and the standard merge subject.
    // PR 12 used a custom Japanese subject. Its exact signed commit was
    // independently verified on GitHub; permit only this immutable object.
    const reviewedPr12=sha==='1dd14e5998b4328e081202749a5968a72ab26be3' &&
      parents[0]==='128f210a1b1ec51fc4f815c68669169630ed204f' &&
      parents[1]==='72acd5a9b66c2eea0932b77d24a1da1a6ac015f4';
    // PR 16: independently verified GitHub-signed merge with custom subject.
    const reviewedPr16=sha==='8f82d025b61f3744a9eb9aa2e404c989129bb970' &&
      parents[0]==='0edaa5b0a9a8abd27b1993f903702744e2225794' &&
      parents[1]==='22d4f7fe7bea4156b982105666a35776f9b22565';
    // PR 24: independently verified GitHub-signed merge with custom subject.
    const reviewedPr24=sha==='c243f0120b5c9124b602bb6c07c0c48ce2ed6e81' &&
      parents[0]==='5d9b70f573e51fc142075f4f9c1138d4f94a4808' &&
      parents[1]==='53111417a06fa2d7d793e4ad83cf519624b0e709';
    const githubMergeCommitter=allowedIdentity(name,email) &&
      committer==='GitHub' && committerEmail==='noreply'+'@github.com' &&
      parents.length===2 && (reviewedPr12 || reviewedPr16 || reviewedPr24 || /^Merge pull request #\d+ from /i.test(subject));
    if(!githubMergeCommitter)checkIdentity(committer,committerEmail,'コミット履歴のCommitter');
  }
}catch(error){errors.push('Git作成者・履歴を取得できません');}
// Inspect every file that will be published, including ignored/generated files.
// Refuse links rather than following them outside the artifact.
function artifactFiles(path){
  const stat=lstatSync(path);
  if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())){
    errors.push(`${path}: 公開成果物に通常ファイル以外が存在します`);return [];
  }
  return stat.isFile()?[path]:readdirSync(path).flatMap(name=>artifactFiles(`${path}/${name}`));
}
const names=mode==='--dist'?artifactFiles('dist')
  :mode==='--source'?splitNul(git('ls-files','--cached','-z')).filter(path=>!path.startsWith('dist/'))
  :mode==='--staged'
  ?splitNul(git('diff','--cached','--name-only','--diff-filter=ACMR','-z'))
  :mode==='--commit'?splitNul(git('diff-tree','--root','--no-commit-id','-m','-r','--diff-filter=ACMR','--name-only','-z',commitSha))
  :[...new Set(splitNul(git('ls-files','--cached','--others','--exclude-standard','-z')))].filter(existsSync);
// This commit's MSAL vendor finding is only allowed while its exact bundle bytes match.
const pinnedFaviconSha256 = '97167321d1dcd34af3b45b4803e7abe85cd0647469581e45d1c39b57e6ed1195';
const pinnedMsalBundleSha256 = '148f7091b42d0ff43a50262325d48322596c582f859b2eed1f291ac62584b484';
const pinnedMsalPath = 'dist/vendor/msal/msal-browser.bundle.js';
if (((mode==='--staged'||mode==='--commit') && names.includes(pinnedMsalPath)) || (['--tree','--dist'].includes(mode) && existsSync(pinnedMsalPath))) {
  const data = mode==='--staged' ? git('show', `:${pinnedMsalPath}`)
    : mode==='--commit'?git('show',`${commitSha}:${pinnedMsalPath}`):readFileSync(pinnedMsalPath);
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
  ['秘密値の直書き',/["']?(?:client_secret|access_token|refresh_token|api_key|private_key)["']?\s*[:=]\s*["'][A-Za-z0-9_.\/+\-=]{20,}["']/i],
  ['個人メールアドレス',/\b(?![A-Za-z0-9_.+-]+@users\.noreply\.github\.com\b)[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i],
  ['端末のユーザーパス',/\/(?:Users|home)\/[a-zA-Z0-9._-]+\/(?:Documents|Desktop|Downloads|Library|Pictures|OneDrive)\b/],
  ['電話番号',/(?:^|[^0-9])(?:\+81[-\s]?(?:[789]0[-\s]?\d{4}[-\s]?\d{4})|0(?:[789]0[-\s]?\d{4}[-\s]?\d{4}|[1-9]\d{0,3}[-\s]\d{1,4}[-\s]\d{4}))(?!\d)/],
  ['住所・郵便番号',/(?:〒\s*)?\b\d{3}[-－]\d{4}\b/],
  ['銀行口座番号',/(?:口座番号|銀行(?:の)?口座|普通(?:預金)?口座)\s*[:：=]?\s*\d{7}\b/],
  ['住所',/(?:住所|所在地)\s*[:：]\s*(?:東京都|北海道|大阪府|京都府|[一-龥]{2,3}県)[^\r\n]{3,60}\d/],
];
// Basic payment-card detector. An issuer prefix AND Luhn checksum are required.
// Avoid matching arbitrary build hashes or long decimal IDs by accident.
/** PDF.js ships its worker verbatim from the installed, lockfile-verified package.
 * Third-party contributor addresses must not be mistaken for app-owner PII.
 * Only the email-address rule can be exempted, and only for an unchanged copy.
 * Copied binary assets must also match the installed package byte for byte.
 * CI installs with npm ci; local dependency updates must do the same. */
let pdfPackageVerified;
function trustedPdfAsset(path,bytes){
  if(!path.startsWith('dist/vendor/pdfjs/'))return false;
  try {
    if(pdfPackageVerified===undefined){
      const installed=JSON.parse(readFileSync('node_modules/pdfjs-dist/package.json','utf8'));
      const lock=JSON.parse(mode==='--staged'?git('show',':package-lock.json').toString('utf8'):mode==='--commit'?git('show',`${commitSha}:package-lock.json`).toString('utf8'):readFileSync('package-lock.json','utf8'));
      const locked=lock.packages?.['node_modules/pdfjs-dist'];
      pdfPackageVerified=!!locked&&installed.version===locked.version&&/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(locked.integrity??'');
    }
    if(!pdfPackageVerified)return false;
    const relative=path.slice('dist/vendor/pdfjs/'.length);
    const upstream=/^pdf(?:\.worker)?\.mjs$/.test(relative)?`build/${relative}`:relative;
    return bytes.equals(readFileSync(`node_modules/pdfjs-dist/${upstream}`));
  }catch{return false;}
}
const isPotentialPaymentCard=(content)=>{
  const candidate=/(?<![\dA-Za-z.])(?:\d[ -]?){12,18}\d(?![\dA-Za-z.])/g;
  for(const match of content.matchAll(candidate)){
    const digits=match[0].replace(/[^\d]/g,'');
    if(digits.length<13||digits.length>19)continue;
    const prefix=Number(digits.slice(0,4));
    const known=digits.startsWith('4') ||
      (prefix>=5100&&prefix<=5599)||(prefix>=2221&&prefix<=2720)||
      digits.startsWith('34')||digits.startsWith('37')||digits.startsWith('35')||digits.startsWith('6');
    if(!known)continue;
    let sum=0,doubling=false;
    for(let i=digits.length-1;i>=0;i--){
      let n=Number(digits[i]);if(doubling){n*=2;if(n>9)n-=9;}
      sum+=n;doubling=!doubling;
    }
    if(sum%10===0)return true;
  }
  return false;
};
const approvedVendor=(path)=>{
  if(!path.startsWith('dist/vendor/'))return true;
  if(/^dist\/vendor\/msal\/(?:msal-browser\.bundle\.js|msal-redirect-bridge\.min\.js)$/.test(path))return true;
  if(/^dist\/vendor\/pdfjs\/(?:pdf|pdf\.worker)\.mjs$/.test(path))return true;
  if(/^dist\/vendor\/pdfjs\/(?:cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+$/.test(path))return true;
  return false;
};
const disallowedFilename=(path)=>{
  // The only permitted Python source is the reviewed, synthetic-data,
  // headless Chromium test. All other Python files remain prohibited.
  if(path==='tests/e2e/run.py')return false;
  const lower=path.toLowerCase();
  const ext=extname(lower);
  if(blockedExt.has(ext))return true;
  if(/(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials?(?:\.|$)|private-data|local-data|backups?|exports?|secrets?)(?:\/|$)/i.test(path))return true;
  if(/(?:^|\/)(?:statement[-_]?(?:20\d\d)?|financial[-_]?(?:data|export)|payroll[-_]?(?:data|statement))\.(?:json|txt)$/i.test(path))return true;
  if(ext==='.ico')return !/^(public|dist)\/favicon\.ico$/.test(path);
  if(ext==='.json')return !['package.json','package-lock.json','tsconfig.json','scripts/publication-policy.json','public/release-notes.json','dist/release-notes.json'].includes(path);
  if(ext==='.txt')return !/^README-v[0-9]+\.txt$/.test(path);
  if(['.bcmap','.pfb','.ttf'].includes(ext))return !path.startsWith('dist/vendor/pdfjs/');
  // Permit only the four official PDF.js WASM decoder names under its vendor directory.
  if(ext==='.wasm')return !/^dist\/vendor\/pdfjs\/wasm\/(?:jbig2|openjpeg|qcms_bg|quickjs-eval)\.wasm$/.test(path);
  if(!ext){
    if(['LICENSE','.gitignore','.gitattributes','.githooks/pre-commit','.githooks/pre-push','.gitleaksignore'].includes(path))return false;
    // Only the reviewed, redistributable PDF.js dependency license files are allowed.
    if(path==='dist/vendor/pdfjs/cmaps/LICENSE')return false;
    if(/^dist\/vendor\/pdfjs\/standard_fonts\/LICENSE_(?:FOXIT|LIBERATION)$/.test(path))return false;
    if(/^dist\/vendor\/pdfjs\/wasm\/LICENSE_(?:JBIG2|OPENJPEG|QCMS|QUICKJS|PDFJS_(?:JBIG2|OPENJPEG|QCMS|QUICKJS))$/.test(path))return false;
    return true;
  }
  return !allowedText.has(ext);
};
// Commit message privacy is checked before any outgoing commit can be published.
if(mode==='--commit'){
  const message=str('show','-s','--format=%B',commitSha);
  for(const [label,pattern] of secrets)if(pattern.test(message))errors.push(`コミットメッセージ: ${label}の疑い`);
  if(isPotentialPaymentCard(message))errors.push('コミットメッセージ: クレジットカード番号の疑い');
}
for(const path of names){
  if(['--source','--dist'].includes(mode)&&(!existsSync(path)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())){errors.push(`${path}: 通常ファイルではありません`);continue;}
  if(disallowedFilename(path)||!approvedVendor(path)){
    errors.push(`${path}: 公開禁止または未承認のファイル形式`);
    continue;
  }
  if(path==='public/favicon.ico'||path==='dist/favicon.ico'){
    const data=mode==='--staged'?git('show',`:${path}`)
      :mode==='--commit'?git('show',`${commitSha}:${path}`):readFileSync(path);
    if(createHash('sha256').update(data).digest('hex')!==pinnedFaviconSha256){
      errors.push(`${path}: favicon.icoのSHA-256が承認済みファイルと一致しません`);
    }
    continue;
  }
  const bytes=mode==='--staged'?git('show',`:${path}`)
    :mode==='--commit'?git('show',`${commitSha}:${path}`):readFileSync(path);
  const ext=extname(path.toLowerCase());
  const binaryVendor=path.startsWith('dist/vendor/pdfjs/')&&['.bcmap','.pfb','.ttf','.wasm'].includes(ext);
  if(binaryVendor){
    // Only approved decoder/font formats can bypass text scanning, not whole directories.
    if(bytes.length>4*1024*1024||!trustedPdfAsset(path,bytes))errors.push(`${path}: ロック済みPDF.jsの正規バイナリと一致しません`);
    continue;
  }
  if(bytes.includes(0)){
    errors.push(`${path}: テキスト内にバイナリデータ`);
    continue;
  }
  if(bytes.length>(path.startsWith('dist/vendor/')?8:2)*1024*1024){errors.push(`${path}: ソースファイルが大きすぎます`);continue;}
  const content=bytes.toString('utf8');
  if(path==='public/index.html'||path==='dist/index.html'){
    for(const issue of validateFinanceCsp(content))errors.push(`${path}: CSP ${issue}`);
  }
  if(path==='public/auth-bridge.html'||path==='dist/auth-bridge.html'){
    for(const issue of validateFinanceAuthCsp(content))errors.push(`${path}: CSP ${issue}`);
  }
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
  const officialPdfWorker=path==='dist/vendor/pdfjs/pdf.worker.mjs'&&trustedPdfAsset(path,bytes);
  for(const [label,pattern] of secrets){
    if(label==='個人メールアドレス' && officialPdfWorker)continue;
    if(pattern.test(content))errors.push(`${path}: ${label}の疑い`);
  }
  if(isPotentialPaymentCard(content))errors.push(`${path}: クレジットカード番号の疑い`);
}
if(errors.length){
  for(const issue of [...new Set(errors)])console.error('BLOCKED:',issue);
  console.error(`[FINANCE] 公開監査に失敗 (${errors.length}件)。コミット・デプロイを中止してください。`);
  process.exit(1);
}
console.log(`[FINANCE] 公開監査OK (${names.length}ファイル、${mode}、作成者・個人情報・秘密情報)`);
