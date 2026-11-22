/** Exact, reviewed Finance CSP policies: reject altered attributes or allowlists. */
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

export const APPROVED_FINANCE_AUTH_CSP=Object.freeze({
  'default-src': "'none'",
  'script-src': "'self'",
  'connect-src': "'self'",
  'base-uri': "'none'",
  'object-src': "'none'",
});

/**
 * Read real HTML attribute tokens rather than substring-matching names.
 * In particular, data-http-equiv and data-content are NEVER real CSP attributes.
 * A CSP meta must be in <head>, with one unambiguous http-equiv and content.
 */
function readCspMeta(html){
  // Do not mistake commented-out markup for a real document head.
  const withoutComments=html.replace(/<!--[\s\S]*?-->/g,'');
  const head=/<head(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>([\s\S]*?)<\/head\s*>/i.exec(withoutComments);
  if(!head)return {issues:['HTML head要素がありません'],value:null};
  // Raw-text elements and templates do not activate CSP meta tags inside them.
  const headHtml=head[1].replace(/<(script|style|title|textarea|template)(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi,'');
  const tags=[...headHtml.matchAll(/<meta(?=[\s/>])((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)];
  const issues=[];
  const policies=[];
  for(const tag of tags){
    let remaining=tag[1],malformed=false;
    const attrs=new Map(),duplicates=new Set();
    while(remaining.length){
      if(/^\s*\/?\s*$/.test(remaining))break;
      const match=/^\s+([^\s"'`=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/.exec(remaining);
      if(!match){malformed=true;break;}
      remaining=remaining.slice(match[0].length);
      const name=match[1].toLowerCase();
      const value=match[2]??match[3]??match[4]??null;
      if(attrs.has(name))duplicates.add(name);
      else attrs.set(name,value);
    }
    if(attrs.get('http-equiv')?.trim().toLowerCase()!=='content-security-policy')continue;
    policies.push(attrs.get('content'));
    if(malformed)issues.push('CSP metaの属性構文が不正です');
    if(duplicates.size)issues.push('CSP metaに重複属性があります');
  }
  if(policies.length!==1)issues.push('CSP metaがちょうど1つではありません');
  if(policies.length!==1 || policies[0]==null)issues.push('有効なCSP content属性がありません');
  return {issues,value:policies.length===1?(policies[0]??null):null};
}

function validateCsp(html,approved){
  const {issues,value}=readCspMeta(html);
  if(value===null)return issues;
  const directives=new Map();
  for(const fragment of value.split(';')){
    const tokens=fragment.trim().split(/\s+/).filter(Boolean);
    if(!tokens.length)continue;
    const name=tokens.shift().toLowerCase();
    if(directives.has(name))issues.push(`重複ディレクティブ ${name}`);
    directives.set(name,tokens.join(' '));
  }
  for(const [name,expected] of Object.entries(approved)){
    if(directives.get(name)!==expected)issues.push(`${name} が承認済みの設定ではありません`);
  }
  for(const name of directives.keys()){
    if(!Object.hasOwn(approved,name))issues.push(`未承認ディレクティブ ${name}`);
  }
  return issues;
}

export const validateFinanceCsp=(html)=>validateCsp(html,APPROVED_FINANCE_CSP);
export const validateFinanceAuthCsp=(html)=>validateCsp(html,APPROVED_FINANCE_AUTH_CSP);
