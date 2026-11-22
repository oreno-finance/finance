/** Stamp the one public sidebar metadata row from package.json on every build.
 * No client-side dependency, network request, or manually maintained version in HTML.
 */
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SIDEBAR_META=/(<div class="sidebar-meta"><span>)Finance v[^<]*(<\/span><time id="app-updated-at" datetime=")[^"]*(">)更新 [^<]*(<\/time><\/div>)/g;

/** Build day in Japan. Use a fixed time zone so CI and Macs agree. */
export function japanBuildDate(now=new Date()) {
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error('ビルド日時が不正です。');
  const parts=Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const get=type=>parts.find(part=>part.type===type)?.value;
  const date=`${get('year')}-${get('month')}-${get('day')}`;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('JSTの日付を取得できませんでした。');
  return date;
}

export function stampHtml(html,version,day) {
  if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)||!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new Error('バージョンまたは日付の形式が不正です。');
  let found=0;
  const result=html.replace(SIDEBAR_META,(_whole,prefix,middle,end,suffix)=>{
    found++;
    return `${prefix}Finance v${version}${middle}${day}${end}更新 ${day.replaceAll('-','/')} JST${suffix}`;
  });
  if(found!==1)throw new Error(`メニューのバージョン表示は1か所必要です（検出${found}件）。`);
  return result;
}

export async function stampAppMeta(root=resolve(fileURLToPath(new URL('..',import.meta.url))),now=new Date()) {
  const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  const path=resolve(root,'public/index.html');
  const before=await readFile(path,'utf8');
  const day=japanBuildDate(now);
  const after=stampHtml(before,pkg.version,day);
  if(before!==after)await writeFile(path,after);
  return {version:pkg.version,day,changed:before!==after};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const meta=await stampAppMeta();
  console.log(`Finance sidebar: v${meta.version} / 更新 ${meta.day} JST${meta.changed?'':' (already current)'}`);
}
