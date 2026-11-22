/** Exact, reviewed Finance CSP policy: fail closed on added directives or origins. */
export const APPROVED_FINANCE_CSP=Object.freeze({
  'default-src': "'self'",
  'base-uri': "'self'",
  'object-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self' 'unsafe-inline'",
  'connect-src': "'self' https://graph.microsoft.com https://login.microsoftonline.com https://*.1drv.com https://*.sharepoint.com https://*.onedrive.com https://my.microsoftpersonalcontent.com",
  'img-src': "'self' data: blob:",
  'font-src': "'self' data:",
  'worker-src': "'self' blob:",
  'frame-src': "'self' https://login.microsoftonline.com",
  'form-action': "'self' https://login.microsoftonline.com",
});

/** The source HTML and shipped HTML must both match exactly this reviewed policy. */
export function validateFinanceCsp(html){
  const issues=[];
  const metas=[...html.matchAll(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi)];
  if(metas.length!==1)return ['CSP metaがちょうど1つではありません'];
  const value=/\bcontent\s*=\s*(["'])(.*?)\1/i.exec(metas[0][0]);
  if(!value)return ['CSP content属性がありません'];
  const directives=new Map();
  for(const fragment of value[2].split(';')){
    const tokens=fragment.trim().split(/\s+/).filter(Boolean);
    if(!tokens.length)continue;
    const name=tokens.shift().toLowerCase();
    if(directives.has(name))issues.push(`重複ディレクティブ ${name}`);
    directives.set(name,tokens.join(' '));
  }
  for(const [name,expected] of Object.entries(APPROVED_FINANCE_CSP)){
    if(directives.get(name)!==expected)issues.push(`${name} が承認済みの設定ではありません`);
  }
  for(const name of directives.keys()){
    if(!Object.hasOwn(APPROVED_FINANCE_CSP,name))issues.push(`未承認ディレクティブ ${name}`);
  }
  return issues;
}
