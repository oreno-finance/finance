/** Finance-wide, ephemeral feedback. No financial information is persisted here. */
export type ActivityKind = 'working' | 'good' | 'warn' | 'bad' | 'info';
let dismissal: ReturnType<typeof setTimeout> | undefined;
let previousMessage = '';
let previousKind: ActivityKind | '' = '';
let previousAt = 0;
let dismissBound=false;
type ActivityEntry={message:string;kind:'good'|'warn'|'bad';at:number};
const activityLabels={good:'完了',warn:'警告',bad:'エラー'} as const;
const history:ActivityEntry[]=[];
let dropped=0;
export function activityHistory():ReadonlyArray<Readonly<ActivityEntry>>{return history.map(entry=>({...entry}));}
function logRow(entry:ActivityEntry):HTMLElement{
  const row=document.createElement('div');row.className='activity-log-entry';row.dataset.kind=entry.kind;
  const meta=document.createElement('div');meta.className='activity-log-meta';
  const time=document.createElement('time');const at=new Date(entry.at);time.dateTime=at.toISOString();time.textContent=at.toLocaleString('ja-JP');
  const kind=document.createElement('span');kind.className='activity-log-kind';kind.textContent=activityLabels[entry.kind];
  meta.append(time,kind);
  const message=document.createElement('p');message.textContent=entry.message;
  row.append(meta,message);return row;
}
function updateHistory(added?:ActivityEntry):void{
  if(typeof document==='undefined')return;
  const list=document.getElementById('activity-log-list');
  if(!list)return;
  const count=document.getElementById('activity-log-count');
  if(count)count.textContent=`${history.length}件`;
  const omitted=document.getElementById('activity-log-omitted');
  if(omitted){omitted.hidden=dropped===0;omitted.textContent=dropped?`保持上限により古いログ ${dropped}件を省略しました。`:'';}
  if(added){
    const previousTop=list.scrollTop;
    const row=logRow(added);
    list.querySelector('.activity-log-empty')?.remove();
    list.prepend(row);
    if(list.childElementCount>200)list.lastElementChild?.remove();
    if(previousTop>0)list.scrollTop=previousTop+row.offsetHeight;
    return;
  }
  const fragment=document.createDocumentFragment();
  if(!history.length){const p=document.createElement('p');p.className='activity-log-empty';p.textContent='操作ログはありません。';fragment.append(p);}
  else for(const entry of history)fragment.append(logRow(entry));
  list.replaceChildren(fragment);list.scrollTop=0;
}
export function initActivityLog():void{updateHistory();}
function recordActivity(message:string,kind:ActivityKind,at:number):void{
  if(kind==='working'||kind==='info')return;
  const last=history[0];
  if(last?.message===message&&last.kind===kind&&at-last.at<1000)return;
  const entry={message,kind,at};
  history.unshift(entry);
  if(history.length>200){history.pop();dropped++;}
  updateHistory(entry);
}
function hideToast():void {
  if(dismissal){clearTimeout(dismissal);dismissal=undefined;}
  if(typeof document!=='undefined')document.getElementById('toast')?.classList.remove('visible');
}
export function clearActivity():void {
  history.splice(0);dropped=0;
  if(typeof document==='undefined')return;
  updateHistory();
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
