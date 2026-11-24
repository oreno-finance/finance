import {formatRate,formatDate} from './formatters.js';
import {requestConfirmation,cancelConfirmation,confirmationPending} from './modal.js';
/** Flat card settings: select one card, edit only its actual properties.
 * Card preference writes remain a single encrypted OneDrive assets update. */
import {CARDS} from '../models/types.js';
import {DEFAULT_POINT_RATES,editPointRate,type PointRateEditMode} from '../summary/point-benefits.js';
import {validateCardPreferences,type CardPreference,type AssetAccountId} from '../cloud/assets.js';
import {CloudWriteUncertainError,type LiveVault} from '../cloud/live-vault.js';
import { showActivity, simpleActivity } from './activity-feedback.js';

export interface CardSettingsUi {render():void;reset():void;isDirty():boolean;isBusy():boolean}
const CSV_CARDS=new Set(['smbc-nl','amazon','goldpoint']);
function make<K extends keyof HTMLElementTagNameMap>(tag:K,cls='',text?:string):HTMLElementTagNameMap[K]{
  const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;
}
function field(text:string,input:HTMLInputElement|HTMLSelectElement):HTMLLabelElement{
  const label=make('label','card-setting-field');label.append(make('span','',text),input);return label;
}
function select(options:readonly [string,string][],value:string):HTMLSelectElement {
  const el=document.createElement('select');for(const [key,label] of options)el.add(new Option(label,key));el.value=value;return el;
}
function dayInput(value:string):HTMLInputElement{
  const el=document.createElement('input');el.type='number';el.min='1';el.max='31';el.step='1';el.inputMode='numeric';el.value=value;return el;
}
interface Controls {name:HTMLInputElement;mode:HTMLSelectElement;month:HTMLSelectElement;day:HTMLInputElement;
 paymentMonth?:HTMLSelectElement;paymentDay?:HTMLInputElement;rate:HTMLInputElement;effectiveOn:HTMLInputElement;debit:HTMLSelectElement;panel:HTMLElement;rateMode?:HTMLSelectElement;expectedFuture?:string;initialRate:string;initialDay:string}
export function initCardSettings(getVault:()=>LiveVault|null,onSaved:()=>void):CardSettingsUi{
  const form=document.getElementById('settings-card-form') as HTMLFormElement;
  const list=document.getElementById('settings-card-list')!;
  const save=document.getElementById('settings-card-save') as HTMLButtonElement;
  const status=document.getElementById('settings-card-status')!;
  if(!form||!list||!save||!status)throw new Error('カード設定画面を表示できません。');
  let owner:LiveVault|null=null,busy=false,dirty=false,selectedCardId=CARDS[0]!.id;
  let configurationBaseline='',epoch=0;
  const confirmationOwner={};
  const discard=make('button','secondary-action','編集内容を破棄');discard.type='button';discard.hidden=true;save.after(discard);
  const fingerprint=()=>JSON.stringify([...rows.values()].map(row=>Array.from(row.panel.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select'),field=>field.value)));
  discard.addEventListener('click',async()=>{
    const vault=getVault(),revision=epoch,draft=fingerprint();
    if(!vault?.unlocked||busy||!dirty||confirmationPending())return;
    if(!await requestConfirmation({owner:confirmationOwner,title:'カード設定の編集を破棄しますか？',message:'未保存のカード設定を破棄し、最新の設定を表示します。',acceptLabel:'破棄する',cancelLabel:'編集を続ける',destructive:true}))return;
    if(revision!==epoch||getVault()!==vault||!vault.unlocked||busy||!dirty||fingerprint()!==draft)return;
    dirty=false;status.textContent='';render();
  });
  const rows=new Map<string,Controls>();
  function render():void {
    const vault=getVault();if(owner===vault&&dirty)return;
    owner=vault;dirty=false;discard.hidden=true;
    const prefs=vault?.unlocked?vault.assetSettings().cardPreferences??{}:{};
    const debitAccounts=vault?.unlocked?vault.assetSettings().cardDebitAccounts??{}:{};
    configurationBaseline=JSON.stringify([prefs,debitAccounts]);
    list.replaceChildren();rows.clear();
    const picker=make('div','settings-card-picker');picker.setAttribute('role','radiogroup');picker.setAttribute('aria-label','設定するカード');
    const panels=make('div','settings-card-panels');const tabs=new Map<string,HTMLInputElement>();
    const activate=(id:string)=>{selectedCardId=id;for(const [key,row] of rows)row.panel.hidden=key!==id;
      for(const [key,radio] of tabs)radio.checked=key===id;};
    for(const card of CARDS){
      const pref=prefs[card.id];
      const option=make('label','card-setting-choice');const radio=document.createElement('input');
      radio.type='radio';radio.name='card-setting-selected';radio.value=card.id;radio.checked=card.id===selectedCardId;
      const optionLabel=make('span','card-setting-choice-name',pref?.name??card.name);
      option.append(radio,optionLabel);picker.append(option);tabs.set(card.id,radio);
      radio.addEventListener('change',()=>{if(radio.checked)activate(card.id);});

      const panel=make('section','card-setting-item');panel.hidden=card.id!==selectedCardId;
      panel.setAttribute('aria-label',`${card.name}の設定`);
      const general=make('div','card-setting-flat-section');
      general.append(make('h3','card-setting-section-heading','基本設定'));
      const basicFields=make('div','card-setting-basic-fields');
      const name=document.createElement('input');name.type='text';name.maxLength=60;name.autocomplete='off';
      name.value=pref?.name??'';name.placeholder=card.name;
      name.addEventListener('input',()=>{optionLabel.textContent=name.value.trim()||card.name;});
      const debit=select([['','未設定'],['rakuten-bank','楽天銀行'],['mizuho-bank','みずほ銀行'],['cash-savings','現金貯金専用口座']],debitAccounts[card.id]??'');
      basicFields.append(field('表示名',name),field('引落口座',debit));
      general.append(basicFields);
      panel.append(general);

      if(CSV_CARDS.has(card.id)){
        const payment=make('div','card-setting-flat-section');
        payment.append(make('h3','card-setting-section-heading','CSV明細の引落日'));
        const fields=make('div','card-setting-payment-fields');
        const paymentMonth=select([['0','請求月'],['1','請求翌月']],String(pref?.payment?.monthOffset??0));
        const paymentDay=dayInput(pref?.payment?.day?String(pref.payment.day):'');paymentDay.placeholder='27';
        fields.append(field('引落月',paymentMonth),field('毎月の引落日',paymentDay));payment.append(fields);
        panel.append(payment);
        (panel as HTMLElement & {paymentControls?:[HTMLSelectElement,HTMLInputElement]}).paymentControls=[paymentMonth,paymentDay];
      }

      // Both optional settings share a single compact two-column row.
      const extras=make('div','card-setting-secondary-fields');
      const points=make('div','card-setting-extra card-setting-points');
      const rate=document.createElement('input');rate.type='number';rate.min='0';rate.max='100';rate.step='0.01';rate.inputMode='decimal';rate.placeholder=String(DEFAULT_POINT_RATES[card.id]??0);rate.value=pref?.pointRatePercent===undefined?'':String(pref.pointRatePercent);
      const rateEdit=make('div','card-setting-rate-edit');
      rateEdit.append(field('還元率（%）',rate));
      const effectiveOn=document.createElement('input');effectiveOn.type='date';
      const today=new Date();effectiveOn.value=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      effectiveOn.setAttribute('aria-label',`${card.name}の還元率の適用開始日`);
      effectiveOn.min=effectiveOn.value;
      rateEdit.append(field('変更の適用開始日',effectiveOn));
      let rateMode:HTMLSelectElement|undefined,expectedFuture:string|undefined;
      if(vault?.unlocked){
        const day=effectiveOn.value,history=pref?.pointRateHistory??[];
        const disclosure=make('details','card-setting-rate-history-list');disclosure.append(make('summary','','還元率の変更履歴'));
        const active=history.length?Math.max(0,history.reduce((last,x,i)=>x.effectiveOn<=day?i:last,-1)):-1;
        for(const [index,entry] of [...history.entries()].reverse()){
          const line=make('div','card-setting-rate-history-line');
          const label=make('div','');label.append(make('span','',entry.effectiveOn==='1900-01-01'?'従来の還元率':`${formatDate(entry.effectiveOn)}から`),make('small','',index===active?'現在適用中':index>active?'適用予定':'過去の還元率'));
          line.append(label,make('b','',formatRate(entry.ratePercent)));disclosure.append(line);
        }
        const latest=history.at(-1);
        if(latest&&latest.effectiveOn>day&&history.length>1){
          expectedFuture=latest.effectiveOn;effectiveOn.value=latest.effectiveOn;rate.value=String(latest.ratePercent);
          rateEdit.querySelector('.card-setting-field>span')!.textContent='変更予定の還元率（%）';
          rateMode=select([['replace','最新の変更予定を修正'],['cancel','最新の変更予定を取り消す'],['append','次の変更予定を追加']],'replace');
          const operation=rateMode;
          const adjustRate=()=>{
            const cancel=operation.value==='cancel';rate.disabled=cancel;effectiveOn.disabled=cancel;
            const append=operation.value==='append';
            if(append){const next=new Date(`${latest.effectiveOn}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);effectiveOn.min=next.toISOString().slice(0,10);effectiveOn.value=effectiveOn.min;}
            else{effectiveOn.min=day;effectiveOn.value=latest.effectiveOn;rate.value=String(latest.ratePercent);}
          };
          operation.addEventListener('change',adjustRate);
          rateEdit.append(field('変更予定の操作',operation));
        }else if(latest&&latest.effectiveOn>=day)effectiveOn.min=latest.effectiveOn;
        points.append(rateEdit);if(history.length>1||history.some(x=>x.effectiveOn>day))points.append(disclosure);
      }else points.append(rateEdit);

      const reminder=make('div','card-setting-extra card-setting-reminder');
      const mode=select([['auto','自動で案内'],['custom','案内日を指定'],['none','案内しない']],pref?.review===null?'none':pref?.review?'custom':'auto');
      reminder.append(field('ホームの明細確定案内',mode));
      const dates=make('div','card-setting-review');
      const month=select([['0','引落月'],['-1','引落前月']],String(pref?.review?.monthOffset??0));
      const day=dayInput(String(pref?.review?.day??11));dates.append(field('案内する月',month),field('案内する日',day));
      const adjust=()=>{const custom=mode.value==='custom';dates.hidden=!custom;month.disabled=!custom;day.disabled=!custom;};
      mode.addEventListener('change',adjust);adjust();reminder.append(dates);
      extras.append(points,reminder);panel.append(extras);
      panels.append(panel);
      const pc=(panel as HTMLElement & {paymentControls?:[HTMLSelectElement,HTMLInputElement]}).paymentControls;
      rows.set(card.id,{name,mode,month,day,paymentMonth:pc?.[0],paymentDay:pc?.[1],rate,effectiveOn,debit,panel,rateMode,expectedFuture,initialRate:rate.value,initialDay:effectiveOn.value});
    }
    list.append(picker,panels);if(!CARDS.some(c=>c.id===selectedCardId))selectedCardId=CARDS[0]!.id;
    activate(selectedCardId);
    for(const control of panels.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select')){
      if(!vault?.unlocked)control.disabled=true;
    }
    save.disabled=!vault?.unlocked||busy;
  }
  const markDirty=(event:Event)=>{
    if(event.target instanceof HTMLInputElement&&event.target.matches('.card-setting-choice input[type="radio"]'))return;
    dirty=true;discard.hidden=false;status.textContent='';
  };
  form.addEventListener('input',markDirty);form.addEventListener('change',markDirty);
  form.addEventListener('submit',event=>{
    event.preventDefault();if(busy||confirmationPending())return;
    void(async()=>{
      const vault=getVault(),revision=epoch;if(!vault?.unlocked){simpleActivity('保管庫を解除してください。',true);return;}
      try{
        const settings=vault.assetSettings(),prior=settings.cardPreferences??{};
        if(JSON.stringify([prior,settings.cardDebitAccounts??{}])!==configurationBaseline)throw new Error('カード設定が更新されました。最新情報を確認して編集し直してください。');
        const next:Record<string,CardPreference>={};
        const nextDebit:Record<string,AssetAccountId>={};
        for(const card of CARDS){
          const row=rows.get(card.id)!;const name=row.name.value.trim();
          if(row.debit.value)nextDebit[card.id]=row.debit.value as AssetAccountId;
          const pref:CardPreference={};if(name&&name!==card.name)pref.name=name;
          if(prior[card.id]?.issuer)pref.issuer=prior[card.id]!.issuer;
          if(row.mode.value==='none')pref.review=null;
          else if(row.mode.value==='custom'){
            const n=Number(row.day.value);
            if(!/^\d{1,2}$/.test(row.day.value)||n<1||n>31)throw new Error(`${card.name}の案内日を確認してください。`);
            pref.review={monthOffset:Number(row.month.value) as -1|0,day:n};
          }
          if(row.paymentMonth&&row.paymentDay&&row.paymentDay.value.trim()){
            const n=Number(row.paymentDay.value);
            if(!/^\d{1,2}$/.test(row.paymentDay.value)||n<1||n>31)throw new Error(`${card.name}の引落日を1〜31日で入力してください。`);
            pref.payment={monthOffset:Number(row.paymentMonth.value) as 0|1,day:n};
          }
          const old=prior[card.id];
          const mode=(row.rateMode?.value??'change') as PointRateEditMode;
          const rateChanged=row.rate.value!==row.initialRate||row.effectiveOn.value!==row.initialDay||mode==='cancel'||mode==='append';
          if(rateChanged){
            const rate=row.rate.value.trim()?Number(row.rate.value):(DEFAULT_POINT_RATES[card.id]??0);
            Object.assign(pref,editPointRate(card.id,old,mode,rate,row.effectiveOn.value,new Date().toLocaleDateString('sv-SE'),row.expectedFuture));
          }else{
            if(old?.pointRateHistory)pref.pointRateHistory=structuredClone(old.pointRateHistory);
            if(old?.pointRatePercent!==undefined)pref.pointRatePercent=old.pointRatePercent;
          }
          if(Object.keys(pref).length)next[card.id]=pref;
        }
        validateCardPreferences(next);
        busy=true;save.disabled=true;status.textContent='';showActivity('カード設定を保存中…','working');
        await vault.setCardConfiguration(next,nextDebit);
        if(revision!==epoch||getVault()!==vault||!vault.unlocked)return;
        dirty=false;status.textContent='';showActivity('カード設定を保存しました。','good');render();onSaved();
      }catch(error){if(revision!==epoch||getVault()!==vault||!vault.unlocked)return;status.textContent='';simpleActivity(error instanceof CloudWriteUncertainError?'保存結果を確認できません。最新データを取得してください。':error instanceof Error?error.message:'保存できませんでした。',true);}
      finally{busy=false;save.disabled=!getVault()?.unlocked;}
    })();
  });
  render();return{render,reset:()=>{epoch++;cancelConfirmation(confirmationOwner);dirty=false;status.textContent='';render();},isDirty:()=>dirty,isBusy:()=>busy||confirmationPending(confirmationOwner)};
}
