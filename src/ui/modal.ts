/** Shared native-dialog presentation. Business operations remain in their owners. */
export interface ConfirmationOptions {
  title:string;
  message:string;
  acceptLabel:string;
  cancelLabel?:string;
  destructive?:boolean;
  requiredText?:string;
  owner:object;
  parent?:HTMLDialogElement;
}
let active:{owner:object;finish:(accepted:boolean)=>void}|null=null;
export function confirmationPending(owner?:object):boolean{return active!==null&&(owner===undefined||active.owner===owner);}
export function cancelConfirmation(owner:object):void{if(active?.owner===owner)active.finish(false);}
/** A vault lock invalidates every pending approval, regardless of its owner. */
export function cancelAllConfirmations():void{active?.finish(false);}

function outside(dialog:HTMLDialogElement,event:MouseEvent):boolean {
  const rect=dialog.getBoundingClientRect();
  return event.target===dialog&&(event.clientX<rect.left||event.clientX>=rect.right||event.clientY<rect.top||event.clientY>=rect.bottom);
}
/** A drag starting inside the form must not be mistaken for a backdrop dismissal. */
export function bindModalDismiss(dialog:HTMLDialogElement,requestClose:()=>void):()=>void {
  let startedOutside=false;
  const cancel=(event:Event)=>{event.preventDefault();requestClose();};
  const down=(event:PointerEvent)=>{startedOutside=outside(dialog,event);};
  const pointerCancel=()=>{startedOutside=false;};
  const click=(event:MouseEvent)=>{
    const dismiss=startedOutside&&outside(dialog,event);startedOutside=false;
    if(dismiss)requestClose();
  };
  dialog.addEventListener('cancel',cancel);dialog.addEventListener('pointerdown',down);
  dialog.addEventListener('pointercancel',pointerCancel);dialog.addEventListener('click',click);
  return ()=>{dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('pointerdown',down);
    dialog.removeEventListener('pointercancel',pointerCancel);dialog.removeEventListener('click',click);};
}
export function modalHeader(title:HTMLElement,requestClose:()=>void):HTMLElement {
  const head=document.createElement('div');head.className='finance-modal-head';
  const close=document.createElement('button');close.type='button';close.className='finance-modal-x';
  close.textContent='×';close.setAttribute('aria-label','閉じる');close.addEventListener('click',requestClose);
  head.append(title,close);return head;
}
/** Never queue confirmations: a second request must fail closed. No HTML injection. */
export function requestConfirmation(options:ConfirmationOptions):Promise<boolean> {
  if(active||options.parent&&!options.parent.open)return Promise.resolve(false);
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='finance-confirm-dialog';
    dialog.setAttribute('aria-label',options.title);dialog.setAttribute('role','alertdialog');
    const title=document.createElement('h2');title.textContent=options.title;
    const message=document.createElement('p');message.className='finance-confirm-message';message.id='finance-confirm-message';message.textContent=options.message;
    dialog.setAttribute('aria-describedby',message.id);
    const actions=document.createElement('div');actions.className='finance-modal-actions';
    const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary-action';cancel.textContent=options.cancelLabel??'キャンセル';
    const accept=document.createElement('button');accept.type='button';accept.className=options.destructive?'danger-action':'save-action';accept.textContent=options.acceptLabel;
    let typed:HTMLInputElement|undefined;
    if(options.requiredText!==undefined){
      const label=document.createElement('label');label.className='finance-confirm-typed';
      label.textContent=`実行するには「${options.requiredText}」と入力してください。`;
      typed=document.createElement('input');typed.type='text';typed.autocomplete='off';typed.spellcheck=false;
      typed.setAttribute('aria-label','確認用の文字列');label.append(typed);dialog.append(label);
      accept.disabled=true;typed.addEventListener('input',()=>{accept.disabled=typed!.value!==options.requiredText;});
    }
    const opener=document.activeElement;
    let settled=false;
    const finish=(accepted:boolean)=>{
      if(settled)return;settled=true;
      accepted=accepted&&dialog.open&&(!options.parent||options.parent.open)&&(!typed||typed.value===options.requiredText);
      if(typed)typed.value='';
      options.parent?.removeEventListener('close',parentClosed);
      active=null;
      if(dialog.open)dialog.close();dialog.remove();
      if(opener instanceof HTMLElement&&opener.isConnected)opener.focus({preventScroll:true});
      resolve(accepted);
    };
    const parentClosed=()=>finish(false);
    active={owner:options.owner,finish};
    options.parent?.addEventListener('close',parentClosed,{once:true});
    actions.append(cancel,accept);dialog.prepend(modalHeader(title,()=>finish(false)),message);dialog.append(actions);
    cancel.addEventListener('click',()=>finish(false));accept.addEventListener('click',()=>finish(true));
    dialog.addEventListener('close',()=>finish(false));
    bindModalDismiss(dialog,()=>finish(false));
    try{document.body.append(dialog);dialog.showModal();cancel.focus();}catch{finish(false);}
  });
}
