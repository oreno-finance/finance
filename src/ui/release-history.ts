import {bindModalDismiss,modalHeader} from './modal.js';

interface ReleaseEntry {
  version?:string;period?:string;date?:string;through?:string;
  title:string;summary:string;sections:Record<string,string[]>;
  stats?:{files:number;additions:number;deletions:number};
  links?:Array<{label:string;url:string}>;
}
const element=<K extends keyof HTMLElementTagNameMap>(tag:K,content='',className=''):HTMLElementTagNameMap[K]=>{
  const node=document.createElement(tag);node.textContent=content;if(className)node.className=className;return node;
};
function releaseArticle(entry:ReleaseEntry,latest:boolean):HTMLElement {
  const article=element('article','','release-history-entry');
  const meta=element('div','','release-history-meta');
  meta.append(element('strong',entry.version?`v${entry.version}`:entry.period??''));
  if(latest)meta.append(element('span','最新版','release-history-latest'));
  if(entry.date){const date=element('time',`${entry.date.replaceAll('-','/')}${entry.through?` 〜 ${entry.through.replaceAll('-','/')}`:''} JST`);date.dateTime=entry.date;meta.append(date);}
  article.append(meta,element('h3',entry.title),element('p',entry.summary));
  for(const [title,items] of Object.entries(entry.sections)){
    if(!items.length)continue;
    const list=element('ul');for(const item of items)list.append(element('li',item));
    article.append(element('h4',title),list);
  }
  if(entry.stats){const {files,additions,deletions}=entry.stats;article.append(element('p',`${files.toLocaleString('ja-JP')}ファイル / +${additions.toLocaleString('ja-JP')}行 / −${deletions.toLocaleString('ja-JP')}行`,'release-history-stats'));}
  const links=element('div','','release-history-links');
  for(const link of entry.links??[]){
    // Static, reviewed repository links only; no HTML injection or arbitrary navigation.
    if(!/^https:\/\/github\.com\/oreno-finance\/finance\/(?:pull\/\d+|commit\/[a-f0-9]{40}|actions\/runs\/\d+|blob\/[a-f0-9]{40}\/README-v\d+\.md)$/.test(link.url))continue;
    const a=element('a',link.label);a.href=link.url;a.target='_blank';a.rel='noopener noreferrer';links.append(a);
  }
  if(links.childElementCount)article.append(links);
  return article;
}
/** Independent read-only UI. Fetch only on demand; failure never gates startup or storage. */
export function initReleaseHistory():void {
  const opener=document.getElementById('release-history-open');if(!opener)return;
  const dialog=element('dialog','','finance-confirm-dialog release-history-dialog finance-modal');
  dialog.id='release-history-dialog';dialog.setAttribute('aria-labelledby','release-history-title');
  const title=element('h2','アップデート履歴');title.id='release-history-title';
  const body=element('div');body.id='release-history-list';
  dialog.append(modalHeader(title,()=>dialog.close()),body);document.body.append(dialog);
  bindModalDismiss(dialog,()=>dialog.close());
  let loading=false,loaded=false;
  opener.addEventListener('click',()=>{
    if(dialog.open)return;
    dialog.showModal();dialog.scrollTop=0;
    if(loaded||loading)return;
    loading=true;body.replaceChildren(element('p','読み込み中…'));
    void (async()=>{
      try{
        const response=await fetch('./release-notes.json',{credentials:'omit'});
        if(!response.ok)throw new Error('release history unavailable');
        const entries:ReleaseEntry[]=await response.json();
        if(!Array.isArray(entries)||!entries.length)throw new Error('release history unavailable');
        const articles=entries.map((entry,index)=>releaseArticle(entry,index===0));
        body.replaceChildren(...articles);loaded=true;
      }catch{body.replaceChildren(element('p','アップデート履歴を取得できませんでした。閉じてから再度お試しください。'));}
      finally{loading=false;}
    })();
  });
}
