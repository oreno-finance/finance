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
 * Inspect the original HTML as tokens. Removing comments / raw-text with string
 * replacement can create brand-new markup at a concatenation boundary.
 * This auditor therefore never rewrites or sanitizes the source document.
 * Ambiguous or unsupported head markup fails closed.
 */
function readTag(source, offset){
  const start=/^<(\/)?([A-Za-z][A-Za-z0-9:-]*)/.exec(source.slice(offset));
  if(!start)return null;
  const name=start[2].toLowerCase();
  const boundary=source[offset+start[0].length];
  if(boundary!=='>' && boundary!=='/' && !/^[\t\n\f\r ]$/.test(boundary??''))return null;
  let cursor=offset+start[0].length,quote=null;
  // Browser attribute values may contain '>' but an unquoted '>' ends a tag.
  while(cursor<source.length){
    const char=source[cursor];
    if(quote){if(char===quote)quote=null;}
    else if(char==='"'||char==="'")quote=char;
    else if(char==='>'){
      return {name,closing:Boolean(start[1]),attrs:source.slice(offset+start[0].length,cursor),end:cursor+1};
    }
    else if(char==='<')return null;
    cursor++;
  }
  return null;
}

function readMetaAttributes(text){
  const attrs=new Map(),duplicates=new Set();
  let offset=0;
  while(offset<text.length){
    if(/^\s*\/?\s*$/.test(text.slice(offset)))break;
    const match=/^\s+([^\s"'`=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/.exec(text.slice(offset));
    if(!match)return {attrs,duplicates,malformed:true};
    offset+=match[0].length;
    const name=match[1].toLowerCase();
    if(attrs.has(name))duplicates.add(name);
    else attrs.set(name,match[2]??match[3]??match[4]??null);
  }
  return {attrs,duplicates,malformed:false};
}

/** Find the actual closing tag of a raw-text head element on the original text. */
function skipRawElement(source,offset,name){
  const closing=new RegExp(`</${name}(?=[\\s/>])`,'gi');
  closing.lastIndex=offset;
  let match;
  while((match=closing.exec(source))!==null){
    const token=readTag(source,match.index);
    if(token?.closing && token.name===name && /^\s*$/.test(token.attrs))return token.end;
  }
  return null;
}

/**
 * The audited pages have a simple, reviewed <head> grammar. Be deliberately
 * conservative: surprising markup must be reviewed, not guessed to be safe.
 * A comment's or script's text is skipped by moving an offset, never removing it.
 */
function readCspMeta(html){
  const issues=[],policies=[];
  let cursor=0,inHead=false,sawHead=false,scriptBeforePolicy=false;
  while(cursor<html.length){
    const next=html.indexOf('<',cursor);
    if(next<0){
      if(!sawHead)issues.push('HTML head要素がありません');
      else issues.push('HTML headの閉じタグがありません');
      return {issues,value:null};
    }
    // Text before or within a head may implicitly close it in the browser.
    if(html.slice(cursor,next).trim()){
      issues.push('HTML headの外側または内部に未承認のテキストがあります');
      return {issues,value:null};
    }
    if(html.startsWith('<!--',next)){
      const end=html.indexOf('-->',next+4);
      if(end<0){issues.push('HTMLコメントが閉じられていません');return {issues,value:null};}
      cursor=end+3;
      continue;
    }
    if(!inHead && /^<!doctype\s+html\s*>/i.test(html.slice(next,next+40))){
      cursor=next+html.slice(next).match(/^<!doctype\s+html\s*>/i)[0].length;
      continue;
    }
    const tag=readTag(html,next);
    if(!tag){issues.push('HTML headのタグ構文が不正です');return {issues,value:null};}
    cursor=tag.end;
    if(!inHead){
      if(tag.name==='html' && !tag.closing)continue;
      if(tag.name==='head' && !tag.closing){inHead=true;sawHead=true;continue;}
      issues.push('HTML head要素がありません');
      return {issues,value:null};
    }
    if(tag.name==='head' && tag.closing){
      if(policies.length!==1)issues.push('CSP metaがちょうど1つではありません');
      if(policies.length!==1 || policies[0]==null)issues.push('有効なCSP content属性がありません');
      if(scriptBeforePolicy)issues.push('CSP適用前にscript要素が存在します');
      return {issues,value:policies.length===1?(policies[0]??null):null};
    }
    if(tag.closing){issues.push('HTML headの未承認の閉じタグがあります');return {issues,value:null};}
    if(tag.name==='meta'){
      const {attrs,duplicates,malformed}=readMetaAttributes(tag.attrs);
      if(malformed){issues.push('HTML metaの属性構文が不正です');return {issues,value:null};}
      if(attrs.get('http-equiv')?.trim().toLowerCase()!=='content-security-policy')continue;
      if(duplicates.size)issues.push('CSP metaに重複属性があります');
      policies.push(attrs.get('content'));
      continue;
    }
    if(tag.name==='link'||tag.name==='base')continue;
    if(['script','style','title','textarea'].includes(tag.name)){
      if(tag.name==='script' && policies.length===0)scriptBeforePolicy=true;
      const end=skipRawElement(html,cursor,tag.name);
      if(end===null){issues.push(`${tag.name}要素が閉じられていません`);return {issues,value:null};}
      cursor=end;
      continue;
    }
    // template/noscript/SVG/etc. have special browser parsing modes. The
    // deployment HTML does not need them inside <head>: fail closed instead.
    issues.push(`HTML headに未承認の${tag.name}要素があります`);
    return {issues,value:null};
  }
  issues.push('HTML headの閉じタグがありません');
  return {issues,value:null};
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
