/** Parse actual CSP directives, not substrings, to prevent permissive regressions. */
export function validateFinanceCsp(html){
  const issues=[];
  const metas=[...html.matchAll(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi)];
  if(metas.length!==1)return ['metaが1つではありません'];
  const value=/\bcontent\s*=\s*(["'])(.*?)\1/i.exec(metas[0][0]);
  if(!value)return ['content属性がありません'];
  const directives=new Map();
  for(const fragment of value[2].split(';')){
    const tokens=fragment.trim().split(/\s+/).filter(Boolean);
    if(!tokens.length)continue;
    const name=tokens.shift().toLowerCase();
    if(directives.has(name))issues.push(`重複ディレクティブ ${name}`);
    directives.set(name,tokens);
  }
  const exact=(name,expected)=>{
    const tokens=directives.get(name);
    if(!tokens||tokens.join(' ')!==expected)issues.push(`${name} が承認済みの設定ではありません`);
  };
  exact('default-src',"'self'");
  exact('base-uri',"'self'");
  exact('object-src',"'none'");
  exact('script-src',"'self'");
  for(const name of ['script-src-elem','script-src-attr']){
    if(!directives.has(name))continue;
    exact(name,name==='script-src-attr'?"'none'":"'self'");
  }
  if(directives.has('report-only'))issues.push('report-onlyでの保護は許可しません');
  if(/<script\b[^>]*\b(?:nonce|integrity)=[^>]*>/i.test(html) && /'nonce-|sha256-/i.test(value[2])){
    issues.push('CSP例外キーの追加は個別審査が必要です');
  }
  return issues;
}
