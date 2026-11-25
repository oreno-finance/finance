import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
export function releaseChangelog(entries,version){
  if(!Array.isArray(entries)||!entries.length||entries[0]?.version!==version)throw new Error('リリース履歴の先頭とpackage.jsonのバージョンを一致させてください。');
  const seen=new Set();
  const lines=['# Finance アップデート履歴','','<!-- Generated from public/release-notes.json. Do not edit directly. -->','','日付は日本時間。公開記録が未確認の情報は省略しています。変更統計は生成物を含むリリース間の差分です。',''];
  for(const [index,e] of entries.entries()){
    const id=e.version??e.period;
    if(!id||seen.has(id)||!e.title||!e.summary||!e.sections)throw new Error('リリース履歴の項目が不正です。');
    seen.add(id);
    const day=e.date?` (${e.date}${e.through?` 〜 ${e.through}`:''} JST)`:'';
    lines.push(`## ${e.version?'v'+e.version:e.period}${day}${index===0?' · 最新版':''}`,'',`**${e.title}**`,'',e.summary,'');
    for(const [title,items] of Object.entries(e.sections)){
      if(!items.length)continue;
      lines.push(`### ${title}`,'',...items.map(item=>`- ${item}`),'');
    }
    if(e.stats)lines.push(`変更: ${e.stats.files} ファイル / +${e.stats.additions} 行 / −${e.stats.deletions} 行`,'');
    if(e.links?.length)lines.push(e.links.map(link=>`[${link.label}](${link.url})`).join(' / '),'');
  }
  return lines.join('\n');
}
export async function buildReleaseNotes(directory=root){
  const version=JSON.parse(await readFile(resolve(directory,'package.json'),'utf8')).version;
  const entries=JSON.parse(await readFile(resolve(directory,'public/release-notes.json'),'utf8'));
  const output=releaseChangelog(entries,version);
  await writeFile(resolve(directory,'CHANGELOG.md'),output);
  return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildReleaseNotes();
