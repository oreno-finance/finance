/* Small independent fallback, intentionally free of cloud/auth imports. */
(()=>{
  'use strict';
  const ready=()=>document.documentElement.dataset.financeReady==='true';
  let failureKind='unknown';
  window.addEventListener('error',event=>{
    if(!ready())failureKind=event.error?.name||'script-load-error';
  },true);
  window.addEventListener('unhandledrejection',event=>{
    if(!ready())failureKind=event.reason?.name||'unhandled-promise';
  });
  function showSettings(){
    // A normal Settings click is handled by main.js. This is only for broken startup.
    if(ready())return;
    for(const id of ['import-view','manage-view','rules-view','assets-page','future-view','summary-view']){
      document.getElementById(id)?.classList.add('hidden');
    }
    document.getElementById('settings-view')?.classList.remove('hidden');
    document.getElementById('cloud-live-bar')?.classList.add('hidden');
    document.getElementById('nav-settings')?.setAttribute('aria-current','page');
    const panel=document.getElementById('startup-recovery');
    if(panel)panel.querySelector('.startup-recovery-note').textContent='';
  }
  document.addEventListener('click',event=>{
    if(!ready()&&event.target instanceof Element&&event.target.closest('#nav-settings'))showSettings();
  },true);
  document.addEventListener('DOMContentLoaded',()=>{
    setTimeout(()=>{
      if(ready()||document.getElementById('startup-recovery'))return;
      const panel=document.createElement('section');
      panel.id='startup-recovery';panel.setAttribute('role','alert');
      const header=document.createElement('div');header.className='startup-recovery-header';
      const symbol=document.createElement('span');symbol.className='startup-recovery-symbol';
      symbol.setAttribute('aria-hidden','true');symbol.textContent='!';
      const headingGroup=document.createElement('div');headingGroup.className='startup-recovery-heading';
      const heading=document.createElement('strong');heading.textContent='Financeを起動できませんでした';
      const description=document.createElement('p');description.className='startup-recovery-description';
      description.textContent='再読み込みして復旧を試してください。';
      headingGroup.append(heading,description);header.append(symbol,headingGroup);
      const note=document.createElement('p');note.className='startup-recovery-note';
      note.textContent='';
      const actions=document.createElement('div');actions.className='startup-recovery-actions';
      const reload=document.createElement('button');reload.type='button';reload.className='startup-recovery-reload';reload.textContent='再読み込み';reload.addEventListener('click',()=>location.reload());
      const settings=document.createElement('button');settings.type='button';settings.textContent='設定を表示';settings.addEventListener('click',showSettings);
      const copy=document.createElement('button');copy.type='button';copy.textContent='起動診断をコピー';
      copy.addEventListener('click',async()=>{
        // No account names, client IDs, authentication responses or vault data.
        const report=['Finance 起動診断','version: 1.6.13','appReady: false',`errorType: ${failureKind}`,`online: ${navigator.onLine}`].join('\n');
        try{await navigator.clipboard.writeText(report);copy.textContent='コピーしました';}
        catch{note.textContent=report;}
      });
      actions.append(reload,settings,copy);panel.append(header,note,actions);document.body.append(panel);
    },9000);
  });
})();
