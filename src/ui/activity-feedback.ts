import {bindModalDismiss} from './modal.js';
/** Finance-wide, ephemeral feedback. No financial information is persisted here. */
export type ActivityKind = 'working' | 'good' | 'warn' | 'bad' | 'info';
let dismissal: ReturnType<typeof setTimeout> | undefined;
let previousMessage = '';
let previousKind: ActivityKind | '' = '';
let previousAt = 0;
let dismissBound=false;
type ActivityEntry={message:string;kind:ActivityKind;at:number;unread:boolean};
const history:ActivityEntry[]=[];
let dropped=0;
export function activityHistory():ReadonlyArray<Readonly<ActivityEntry>>{return history.map(entry=>({...entry}));}
function updateHistory():void{
  if(typeof document==='undefined')return;
  const count=history.filter(entry=>entry.unread).length;
  const button=document.getElementById('activity-history-open');
  if(button){button.setAttribute('aria-label',count?`通知履歴（未確認 ${count}件）`:'通知履歴');button.classList.toggle('has-unread',count>0);}
  const badge=document.getElementById('activity-history-count');if(badge)badge.textContent=count?String(count):'';
  const markRead=document.getElementById('activity-history-read') as HTMLButtonElement|null;
  if(markRead)markRead.disabled=count===0;
  const dialog=document.getElementById('activity-history-dialog') as HTMLDialogElement|null;
  const list=document.getElementById('activity-history-list');
  if(!list||!dialog?.open)return;
  list.replaceChildren();
  if(dropped){const p=document.createElement('p');p.textContent=`古い通知 ${dropped}件は保持上限に達したため省略しました。`;list.append(p);}
  if(!history.length){const p=document.createElement('p');p.textContent='通知はありません。';list.append(p);}
  for(const entry of history){
    const row=document.createElement('div');row.className='activity-history-entry';row.dataset.kind=entry.kind;
    const time=document.createElement('small');time.textContent=new Date(entry.at).toLocaleTimeString('ja-JP');
    const message=document.createElement('p');message.textContent=entry.message;
    row.append(time,message);list.append(row);
  }
}
export function initActivityHistory():void{
  const dialog=document.getElementById('activity-history-dialog') as HTMLDialogElement|null;
  const button=document.getElementById('activity-history-open');
  if(!dialog||!button)return;
  button.addEventListener('click',()=>{if(!dialog.open){dialog.showModal();updateHistory();}});
  const close=()=>dialog.close();
  document.getElementById('activity-history-close')?.addEventListener('click',close);
  bindModalDismiss(dialog,close);
  document.getElementById('activity-history-read')?.addEventListener('click',()=>{for(const entry of history)entry.unread=false;updateHistory();});
  updateHistory();
}
function recordActivity(message:string,kind:ActivityKind,at:number):void{
  if(kind==='working'||kind==='info')return;
  const last=history[0];
  if(last?.message===message&&last.kind===kind&&at-last.at<1000)return;
  history.unshift({message,kind,at,unread:kind==='warn'||kind==='bad'});
  if(history.length>200){let ordinary=history.length-1;while(ordinary>=0&&history[ordinary]!.unread)ordinary--;history.splice(ordinary<0?history.length-1:ordinary,1);dropped++;}
  updateHistory();
}
function hideToast():void {
  if(dismissal){clearTimeout(dismissal);dismissal=undefined;}
  if(typeof document!=='undefined')document.getElementById('toast')?.classList.remove('visible');
}
export function clearActivity():void {
  history.splice(0);dropped=0;
  if(typeof document==='undefined')return;
  const historyDialog=document.getElementById('activity-history-dialog') as HTMLDialogElement|null;
  if(historyDialog?.open)historyDialog.close();
  document.getElementById('activity-history-list')?.replaceChildren();updateHistory();
  hideToast();previousMessage='';previousKind='';previousAt=0;
  const panel=document.getElementById('toast');
  const label=panel?.querySelector<HTMLElement>('.activity-message');if(label)label.textContent='';
}
function bindDismiss(panel:HTMLElement):void {
  if(dismissBound)return;
  const button=panel.querySelector<HTMLButtonElement>('.activity-dismiss');
  if(!button)return;
  button.addEventListener('click',hideToast);
  dismissBound=true;
}


export function showActivity(message: string, kind: ActivityKind = 'info'): void {
  const value = message.trim();
  if (!value) return;
  const panel = document.getElementById('toast');
  const label = panel?.querySelector<HTMLElement>('.activity-message');
  if (!panel || !label) return;
  bindDismiss(panel);
  const now = Date.now();
  recordActivity(value,kind,now);
  // Suppress identical notices, never a different completed operation.
  if (panel.classList.contains('visible') && kind === previousKind && now - previousAt < 450 && value === previousMessage) return;
  previousMessage = value; previousKind = kind; previousAt = now;
  if (dismissal) { clearTimeout(dismissal); dismissal = undefined; }
  label.textContent = value;
  panel.dataset.kind = kind;
  const close=panel.querySelector<HTMLButtonElement>('.activity-dismiss');
  if(close)close.disabled=false;
  panel.classList.add('visible');
  panel.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  // Warnings and errors never expire; later notices retain them in history.
  if (kind === 'good' || kind === 'info') {
    dismissal = setTimeout(() => {
      hideToast();
    }, kind === 'good' ? 2700 : 4000);
  }
}

/** Clear only an in-progress notice, never an error/success emitted meanwhile. */
export function finishActivity(expectedPrefix = ''): void {
  const panel = document.getElementById('toast');
  if (panel?.dataset.kind === 'working' && (!expectedPrefix || panel.querySelector('.activity-message')?.textContent?.startsWith(expectedPrefix)))
    panel.classList.remove('visible');
}

export function simpleActivity(message: string, error = false): void {
  if (!message.trim()) return;
  const kind: ActivityKind = error || /失敗|エラー|できません|未取得|未保存|不備|確認できません/.test(message)
    ? 'bad'
    : /保存中|取得中|読込中|読み込み中|同期中|削除中|接続中|保存しています|取得しています|同期しています|検証しています|処理中|変更しています|再暗号化中|更新しています|削除しています/.test(message)
      ? 'working'
      : /注意|警告|二重計上|未設定|確認してください/.test(message)
        ? 'warn' : /保存しました|取得しました|削除しました|更新しました|完了|解除しました|変更しました|登録しました|復号しました/.test(message)
          ? 'good' : 'info';
  showActivity(message, kind);
}
