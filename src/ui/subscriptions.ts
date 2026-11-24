import type {ContractEdit} from '../fixed-costs/contract-edit.js';
import {bindModalDismiss,modalHeader,requestConfirmation,confirmationPending,cancelConfirmation} from './modal.js';
import {formatYen as sharedYen,formatDate,formatMonth} from './formatters.js';
/** One management screen for card subscriptions, bank standing orders, and cash commitments. */
import {CARDS} from '../models/types.js';
import {ASSET_ACCOUNTS, cardRecurringKey, type RecurringEntry, type AssetAccountId, type CardRecurringDecision} from '../cloud/assets.js';
import {CloudWriteUncertainError, type LiveVault} from '../cloud/live-vault.js';
import type {MonthlySource} from '../summary/monthly-summary.js';
import {detectCardSubscriptions, latestRegisteredCardCharges, contractCardEvidence, latestContractCardCharge, matchedCardRecurringDecision, subscriptionDecision, type SubscriptionCandidate} from '../subscriptions/detect.js';
import {contractMerchantKeys, contractPaymentHistory, nextContractPayment, paymentTermsOn, validatePaymentTerms, type PaymentTerms} from '../fixed-costs/payment-history.js';
import {fixedCostState, monthlyEquivalent, priceOnDay, type FixedCostEntry, type CostFrequency} from '../fixed-costs/contracts.js';
import {showActivity} from './activity-feedback.js';

export interface SubscriptionsUi {render():void;reset():void;isBusy():boolean;isDirty():boolean;openFixedCost(id:string):void}
interface Deps {source():MonthlySource|null;vault():LiveVault|null;onSaved():void;openAccountSettings():void}
type Tab='registered'|'candidate'|'ended'|'ignored';
type Item={kind:'card'|'cash'|'bank';id:string;name:string;amount:number;currentAmount?:number;frequency:CostFrequency;payment:string;
  status:'active'|'paused'|'ended'|'scheduled';priceKind:'fixed'|'variable';contract?:FixedCostEntry;bank?:RecurringEntry;
  decision?:CardRecurringDecision;decisionKey?:string;candidate?:SubscriptionCandidate;lastAmount?:number;lastMonth?:string};
const nextPayment=(item:Item,day:string,source?:MonthlySource|null):string=>{
  const contract=item.contract??item.bank;
  const next=contract?nextContractPayment(contract,day):null;
  if(!contract||!next)return contract?'予定なし':'未設定';
  const amount=priceOnDay(contract.pricing??[],next,contract.amount),terms=paymentTermsOn(contract,next);
  const current=paymentTermsOn(contract,day);
  const changedRoute=terms.payment!==current.payment||terms.cardId!==current.cardId||terms.accountId!==current.accountId;
  const changedSchedule=scheduleLabel(terms)!==scheduleLabel(current);
  const changes=[amount!==(item.currentAmount??item.amount)?yen(amount):'',source&&changedRoute?paymentLabel(terms,source):'',changedSchedule?scheduleLabel(terms):''].filter(Boolean);
  return `${formatDate(next)}${changes.length?`
変更予定：${changes.join(' · ')}`:''}`;
};
const priceLabel=(item:Item)=>item.decision&&!item.contract?'登録済みの推定額':item.status==='scheduled'?'開始時の契約額':item.priceKind==='variable'?'現在の登録予算':'現在の契約額';
const yen=(value:number|null)=>sharedYen(value,0,'—');
const localDate=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
function el<K extends keyof HTMLElementTagNameMap>(name:K,cls='',text?:string):HTMLElementTagNameMap[K]{const node=document.createElement(name);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
function btn(text:string,click:()=>void,cls='secondary-action'):HTMLButtonElement {const x=el('button',cls,text);x.type='button';x.addEventListener('click',click);return x;}
function stateName(state:Item['status']):string{return state==='active'?'利用中':state==='paused'?'一時停止':state==='scheduled'?'開始予定':'終了済み';}
function freqName(freq:CostFrequency):string{return freq==='yearly'?'毎年':freq==='weekly'?'毎週':'毎月';}
function paymentLabel(terms:PaymentTerms,source:MonthlySource):string {
  return terms.payment==='cash'?'現金':terms.payment==='bank'?(ASSET_ACCOUNTS.find(x=>x.id===terms.accountId)?.name??'銀行口座'):
    source.assets.cardPreferences?.[terms.cardId??'']?.name??CARDS.find(x=>x.id===terms.cardId)?.name??'クレジットカード';
}
function scheduleLabel(terms:PaymentTerms):string {
  return terms.frequency==='weekly'?`毎週${['日','月','火','水','木','金','土'][terms.weekday??0]}曜日`:
    `${terms.frequency==='yearly'?`毎年${terms.monthOfYear}月`:'毎月'}${terms.dayOfMonth===0?'末日':`${terms.dayOfMonth}日`}`;
}
export function initSubscriptions(deps:Deps):SubscriptionsUi {
  const root=document.getElementById('subscriptions-content');if(!root)throw new Error('固定費管理画面が見つかりません。');
  let tab:Tab='registered',busy=false,notice='';let editing:Item|null=null;
  let baseline='',initialAmount='',initialTerms:PaymentTerms|null=null;
  let futurePaymentDate:string|null=null,futurePriceDate:string|null=null;
  const confirmationOwner={};let epoch=0;
  const confirming=()=>confirmationPending(confirmationOwner);
  const dialog=el('dialog','fixed-cost-dialog');dialog.setAttribute('aria-label','固定支出の登録と編集');
  const form=el('form','fixed-cost-form');form.noValidate=true;
  const title=el('h2','','固定支出を追加');const header=modalHeader(title,()=>{void closeDialog();});form.append(header);
  const field=(name:string,label:string,kind:'text'|'number'|'date'|'select'|'textarea',options?:readonly [string,string][]):HTMLElement=>{
    const box=el('label','fixed-cost-field');box.append(el('span','',label));
    let input:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement;
    if(kind==='select'){const x=el('select','card-select');for(const [value,name] of options??[])x.add(new Option(name,value));input=x;}
    else if(kind==='textarea'){const x=el('textarea');x.rows=2;x.maxLength=500;input=x;}
    else {const x=el('input');x.type=kind;if(kind==='number'){x.min='1';x.step='1';x.inputMode='numeric';}input=x;}
    input.name=name;box.append(input);form.append(box);return box;
  };
  field('name','名称','text');
  field('category','カテゴリー','select');
  field('amount','契約額・予算','number');
  field('method','支払方法','select',[['card','カード払い'],['bank','銀行口座'],['cash','現金']]);
  field('cardId','支払カード','select');
  field('merchant','明細の利用先（任意）','text');
  field('accountId','引落口座','select',ASSET_ACCOUNTS.filter(a=>a.id!=='nisa').map(a=>[a.id,a.name] as [string,string]));
  const priceKindField=field('priceKind','金額の種類','select',[['fixed','固定額'],['variable','変動額（登録額は予算）']]);
  const priceChoices=el('fieldset','fixed-cost-price-choices');priceChoices.append(el('legend','','金額の種類'));
  for(const [value,label] of [['fixed','固定額'],['variable','変動額']] as const){
    const option=el('label','fixed-cost-price-choice');const radio=el('input');radio.type='radio';radio.name='priceKindChoice';radio.value=value;
    radio.addEventListener('change',()=>{if(radio.checked){set('priceKind',value);updateConditional();}});option.append(radio,el('span','',label));priceChoices.append(option);
  }
  form.append(priceChoices);
  field('frequency','支払周期','select',[['monthly','毎月'],['yearly','毎年'],['weekly','毎週']]);
  field('startOn','契約開始日','date');
  field('paymentDate','変更の適用開始日','date');
  field('priceAction','将来の料金変更予定','select',[['append','新しい変更を追加'],['revise','最新の変更予定を修正'],['cancel','最新の変更予定を取り消す']]);
  field('paymentAction','将来の支払条件の変更予定','select',[['append','新しい変更を追加'],['revise','最新の変更予定を修正'],['cancel','最新の変更予定を取り消す']]);
  field('month','支払月（毎年の場合）','select',Array.from({length:12},(_,i)=>[String(i+1),`${i+1}月`] as [string,string]));
  field('day','支払日','select',[['0','末日'],...Array.from({length:31},(_,i)=>[String(i+1),`${i+1}日`] as [string,string])]);
  field('weekday','支払曜日','select',[['0','日曜日'],['1','月曜日'],['2','火曜日'],['3','水曜日'],['4','木曜日'],['5','金曜日'],['6','土曜日']]);
  field('status','契約状態の変更','select',[['','変更しない'],['active','再開'],['paused','一時停止'],['ended','契約終了']]);
  field('statusDate','停止・終了・再開の適用日','date');
  field('note','メモ','textarea');
  const context=el('p','fixed-cost-equivalent');header.after(context);
  const equivalent=el('p','fixed-cost-equivalent');form.append(equivalent);
  const error=el('p','fixed-cost-form-error');error.setAttribute('role','alert');form.append(error);
  const histories=el('div','fixed-cost-histories');form.append(histories);
  const buttons=el('div','fixed-cost-form-actions');
  const remove=btn('削除',()=>{void deleteCurrent();},'danger-action');
  const clear=btn('変更をクリア',()=>{void clearDraft();});
  const cancel=btn('キャンセル',()=>closeDialog());const save=el('button','save-action','保存');save.type='submit';buttons.append(remove,clear,cancel,save);form.append(buttons);
  dialog.append(form);document.body.append(dialog);
  function openDetails(item:Item):void {startEdit(item);}
  const editorOpen=()=>dialog.open;
  function renderHistories(item:Item|null):void{
    histories.replaceChildren();histories.hidden=!item;
    if(!item)return;
    const origin=item.contract??item.bank,source=deps.source(),today=localDate();
    const section=(label:string)=>{const d=el('details','fixed-cost-history');d.append(el('summary','',label));histories.append(d);return d;};
    const line=(parent:HTMLElement,left:string,right:string,cls='')=>{const row=el('div',`fixed-cost-detail-line ${cls}`);row.append(el('span','',left),el('strong','',right));parent.append(row);};
    if(origin){
      const prices=origin.pricing??[];
      if(prices.length>1){const d=section('料金変更履歴');for(const p of [...prices].reverse())line(d,`${formatDate(p.effectiveOn)}${p.effectiveOn>today?'（適用予定）':''}`,yen(p.amount));}
      const routes=contractPaymentHistory(origin);
      if(source&&routes.length>1){const d=section('支払条件の変更履歴');const active=routes.reduce((last,x,i)=>x.effectiveOn<=today?i:last,-1);
        for(const [i,t] of [...routes.entries()].reverse())line(d,`${formatDate(t.effectiveOn)} · ${i===active?'現在適用中':i>active?'適用予定':'過去の条件'}`,`${paymentLabel(t,source)} · ${scheduleLabel(t)}${t.merchantKey?' · '+t.merchantKey.slice(t.merchantKey.indexOf('|')+1):''}`,'fixed-cost-payment-history');}
      if(origin.endOn||origin.pauses?.length){const d=section('契約状態の履歴');d.classList.add('fixed-cost-status-history');if(origin.endOn)line(d,'契約終了日',formatDate(origin.endOn));for(const pause of [...(origin.pauses??[])].reverse())line(d,'停止期間',`${formatDate(pause.startOn)} ～ ${formatDate(pause.endOn,'再開日未設定')}`);}
      if(source){const charges=contractCardEvidence(source,today)(origin).slice(0,12);if(charges.length){const d=section('確認済み明細の請求履歴');for(const charge of charges)line(d,`${formatDate(charge.paymentDate)} · ${source.assets.cardPreferences?.[charge.cardId]?.name??CARDS.find(c=>c.id===charge.cardId)?.name??'カード'}`,yen(charge.amount));}}
    }else if(source&&item.kind==='card'){
      const key=item.candidate?.key??item.decisionKey;
      const charges=source.records.flatMap(({statement})=>statement.confirmation==='confirmed'&&statement.paymentDate&&statement.cardId===(item.decision?.cardId??item.candidate?.cardId)?statement.rows.filter(row=>cardRecurringKey(statement.cardId!,row.merchant)===key).map(row=>({date:statement.paymentDate!,amount:row.amount})):[]).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,12);
      if(charges.length){const d=section('確認済み明細の請求履歴');for(const charge of charges)line(d,formatDate(charge.date),yen(charge.amount));}
    }
  }
  async function deleteCurrent():Promise<void>{
    const item=editing,vault=deps.vault();if(!item||!vault?.unlocked||busy||confirming()||!dialog.open)return;
    const expected=item.bank??item.contract;if(!expected)return;
    const current=()=>{const doc=vault.assetSettings();return item.bank?doc.recurring.find(x=>x.id===item.id):doc.fixedCosts?.find(x=>x.id===item.id);};
    const revision=epoch,snapshot=formSnapshot();
    if(JSON.stringify(current())!==JSON.stringify(expected)){error.textContent='契約が更新されました。閉じて最新情報から編集してください。';render();return;}
    if(!await requestConfirmation({owner:confirmationOwner,parent:dialog,title:'固定費を削除しますか？',message:`「${item.name}」の固定費登録と料金・支払条件の履歴を削除します。カードの請求明細は削除されません。`,acceptLabel:'削除する',destructive:true}))return;
    if(revision!==epoch||busy||!dialog.open||deps.vault()!==vault||!vault.unlocked||editing!==item||formSnapshot()!==snapshot)return;
    if(JSON.stringify(current())!==JSON.stringify(expected)){error.textContent='契約が更新されました。閉じて最新情報から編集してください。';render();return;}
    busy=true;form.inert=true;showActivity('固定費の削除をOneDriveに保存中…','working');
    try{if(item.contract)await vault.deleteFixedCost(item.contract.id);else if(item.bank)await vault.deleteRecurring(item.bank.id);
      if(revision!==epoch||deps.vault()!==vault||!vault.unlocked)return;
      busy=false;form.inert=false;void closeDialog(true);deps.onSaved();render();showActivity('固定費を削除しました。','good');
    }catch(e){if(revision===epoch&&deps.vault()===vault&&vault.unlocked){busy=false;form.inert=false;updateConditional();error.textContent=e instanceof Error?e.message:'削除できませんでした。';showActivity(error.textContent,'bad');}}
  }
  const input=<T extends HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement=HTMLInputElement>(name:string):T=>form.elements.namedItem(name) as T;
  const set=(name:string,value:string)=>{input(name).value=value;};
  const get=(name:string)=>input(name).value;
  const formSnapshot=()=>JSON.stringify([...form.elements].filter(e=>(e instanceof HTMLInputElement||e instanceof HTMLSelectElement||e instanceof HTMLTextAreaElement)&&e.name!=='priceKindChoice').map(e=>[(e as HTMLInputElement).name,(e as HTMLInputElement).value]));
  const isDirty=()=>editorOpen()&&formSnapshot()!==baseline;
  const resetDirty=()=>{baseline=formSnapshot();};
  const origin=()=>editing?.contract??editing?.bank;
  const readTerms=():PaymentTerms=>({payment:get('method') as PaymentTerms['payment'],cardId:get('method')==='card'?get('cardId'):null,
    merchantKey:get('method')==='card'&&get('merchant').trim()?cardRecurringKey(get('cardId'),get('merchant').trim()):null,
    accountId:get('method')==='bank'?get('accountId') as AssetAccountId:null,frequency:get('frequency') as CostFrequency,
    dayOfMonth:get('frequency')==='weekly'?null:Number(get('day')),monthOfYear:get('frequency')==='yearly'?Number(get('month')):null,weekday:get('frequency')==='weekly'?Number(get('weekday')):null});
  const termsChanged=()=>!!initialTerms&&JSON.stringify(readTerms())!==JSON.stringify(initialTerms);
  const amountChanged=()=>!!origin()&&Number(get('amount'))!==Number(initialAmount);
  const nextDay=(d:string)=>new Date(Date.parse(`${d}T00:00:00Z`)+86400000).toISOString().slice(0,10);
  function updateConditional():void {
    const method=get('method'),frequency=get('frequency'),existing=origin(),creating=!existing;
    form.dataset.method=method;form.dataset.frequency=frequency;
    const shown=new Set(['name','category','method','priceKind','amount','frequency','startOn','note']);
    if(method==='card'){shown.add('cardId');shown.add('merchant');}if(method==='bank')shown.add('accountId');
    if(frequency==='yearly')shown.add('month');shown.add(frequency==='weekly'?'weekday':'day');
    if(existing){
      shown.add('status');if(get('status'))shown.add('statusDate');
      if(futurePaymentDate)shown.add('paymentAction');if(futurePriceDate)shown.add('priceAction');
      const route=get('paymentAction'),price=get('priceAction');
      const editPrice=price!=='cancel'&&(amountChanged()||price==='revise');
      if(editPrice||(route!=='cancel'&&(termsChanged()||route==='revise')))shown.add('paymentDate');
      if(shown.has('paymentDate')){
        const today=localDate(),dates=[today,existing.startOn];
        if(editPrice){const prices=existing.pricing??[];dates.push(price==='revise'?nextDay(today):futurePriceDate?nextDay(futurePriceDate):prices.at(-1)?.effectiveOn??existing.startOn);if(price==='revise')dates.push(nextDay(prices.at(-2)!.effectiveOn));}
        if(route!=='cancel'&&(termsChanged()||route==='revise')){
          const history=contractPaymentHistory(existing);
          dates.push(route==='revise'?nextDay(today):history.length===1&&today<existing.startOn?existing.startOn:nextDay(history.at(-1)!.effectiveOn));
          if(route==='revise')dates.push(nextDay(history.at(-2)!.effectiveOn));
        }
        const min=dates.sort().at(-1)!,previousMin=input('paymentDate').min;input('paymentDate').min=min;
        if(!get('paymentDate')||(get('paymentDate')===previousMin&&min!==previousMin))set('paymentDate',min);
      }else set('paymentDate','');
    }
    for(const box of form.querySelectorAll<HTMLLabelElement>('.fixed-cost-field')){
      const control=box.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('[name]')!;
      box.hidden=!shown.has(control.name);control.disabled=box.hidden;
    }
    priceKindField.hidden=true;priceChoices.hidden=false;
    for(const radio of priceChoices.querySelectorAll('input'))radio.checked=radio.value===get('priceKind');
    if(creating&&(editing?.candidate||editing?.decision)){input('method').disabled=true;input('cardId').disabled=true;}
    // Cancellation affects only the last future route; no hidden edits may be submitted.
    if(existing&&get('paymentAction')==='cancel'&&!termsChanged())for(const n of ['method','cardId','merchant','accountId','frequency','month','day','weekday'])input(n).disabled=true;
    if(existing&&get('priceAction')==='cancel'&&!amountChanged())input('amount').disabled=true;
    equivalent.hidden=false;const amount=get('priceAction')==='cancel'&&futurePriceDate&&!amountChanged()?existing!.pricing!.at(-2)!.amount:Number(get('amount'));
    const effectiveFrequency=existing&&get('paymentAction')==='cancel'&&futurePaymentDate&&!termsChanged()?contractPaymentHistory(existing).at(-2)!.frequency:frequency as CostFrequency;
    equivalent.textContent=Number.isSafeInteger(amount)&&amount>0?`月額換算：${yen(monthlyEquivalent({amount,frequency:effectiveFrequency}))}`:'';
    clear.hidden=creating;remove.hidden=creating;clear.disabled=!isDirty();save.disabled=busy||(!creating&&!isDirty());
  }
  input('priceAction').addEventListener('change',()=>{if(get('priceAction')==='revise'&&futurePriceDate)set('paymentDate',futurePriceDate);});
  input('paymentAction').addEventListener('change',()=>{if(get('paymentAction')==='revise'&&futurePaymentDate)set('paymentDate',futurePaymentDate);});
  form.addEventListener('input',event=>{const target=event.target;if(target instanceof HTMLInputElement&&target.name==='priceKindChoice'&&target.checked)set('priceKind',target.value);updateConditional();});form.addEventListener('change',updateConditional);
  async function closeDialog(force=false):Promise<void> {
    if(busy||confirming()||!editorOpen())return;
    const revision=epoch,draft=editing;
    if(!force&&isDirty()){
      const snapshot=formSnapshot();
      if(!await requestConfirmation({owner:confirmationOwner,parent:dialog,title:'未保存の変更を破棄しますか？',message:'入力した内容は保存されません。',acceptLabel:'破棄する',cancelLabel:'編集を続ける',destructive:true}))return;
      if(revision!==epoch||busy||!editorOpen()||editing!==draft||formSnapshot()!==snapshot)return;
    }
    dialog.close();editing=null;initialTerms=null;initialAmount='';futurePaymentDate=null;futurePriceDate=null;baseline='';error.textContent='';form.reset();context.textContent='';equivalent.textContent='';histories.replaceChildren();
  }
  bindModalDismiss(dialog,()=>{void closeDialog();});
  async function clearDraft():Promise<void>{
    if(busy||confirming()||!editing||!dialog.open||!isDirty())return;
    const item=editing,revision=epoch,snapshot=formSnapshot(),vault=deps.vault();
    if(!await requestConfirmation({owner:confirmationOwner,parent:dialog,title:'変更をクリアしますか？',message:'未保存の変更をすべて元に戻します。',acceptLabel:'クリアする',destructive:true}))return;
    if(revision!==epoch||editing!==item||!dialog.open||busy||deps.vault()!==vault||!vault?.unlocked||formSnapshot()!==snapshot)return;
    for(const [name,value] of JSON.parse(baseline) as [string,string][])set(name,value);
    error.textContent='';updateConditional();
  }
  function startEdit(item:Item|null):void {
    const source=deps.source();if(busy||confirming()||!source||editorOpen())return;
    epoch++;editing=item;error.textContent='';const existing=origin(),today=localDate();
    form.classList.add('fixed-cost-create-mode');
    const order=['name','amount','method','cardId','accountId','merchant','choices','category','priceKind','frequency','startOn','month','day','weekday','priceAction','paymentAction','paymentDate','status','statusDate','note'];
    for(const name of order)form.insertBefore(name==='choices'?priceChoices:input(name).closest('.fixed-cost-field')!,equivalent);
    title.textContent=existing?'固定費を編集':item?.candidate?'検出候補の内容を確認して登録':'固定費を登録';
    context.hidden=!existing;
    const last=existing?contractPaymentHistory(existing).at(-1)!:null;
    futurePaymentDate=existing&&last&&last.effectiveOn>today&&contractPaymentHistory(existing).length>1?last.effectiveOn:null;
    const lastPrice=existing?.pricing?.at(-1);futurePriceDate=existing&&lastPrice&&lastPrice.effectiveOn>today&&(existing.pricing?.length??0)>1?lastPrice.effectiveOn:null;
    context.textContent=existing&&item?`${stateName(item.status)} · ${priceLabel(item)} ${yen(item.currentAmount??item.amount)} · ${item.payment}\n次回支払予定：${nextPayment(item,today,source)}${futurePaymentDate||(existing.pricing?.at(-1)?.effectiveOn??'')>today?`\n編集欄は登録済みの最新条件（適用予定を含む）です。${(existing.pricing?.at(-1)?.effectiveOn??'')>today?'\n料金：'+formatDate(existing.pricing!.at(-1)!.effectiveOn)+'から '+yen(existing.amount):''}${futurePaymentDate?'\n支払条件：'+formatDate(futurePaymentDate)+'から '+paymentLabel(last!,source)+' · '+scheduleLabel(last!):''}`:''}`:'';
    if(existing&&today<existing.startOn&&!existing.paymentHistory)context.textContent+='\n開始日前は、契約開始日を適用日に指定すると初期の支払条件を訂正できます。';
    const terms=last?validatePaymentTerms(last):null;
    const legacy=item?.decision,originalCard=item?.candidate?.cardId??legacy?.cardId??null;
    const cards=CARDS.map(c=>[c.id,source.assets.cardPreferences?.[c.id]?.name??c.name] as [string,string]);
    const c=input<HTMLSelectElement>('cardId');c.replaceChildren();for(const [id,name] of cards)c.add(new Option(name,id));
    const cats=input<HTMLSelectElement>('category');cats.replaceChildren();cats.add(new Option('未分類',''));
    for(const category of source.categories)cats.add(new Option(category.name,category.id));
    const categoryId=existing?.categoryId??'';
    if(categoryId&&!Array.from(cats.options).some(o=>o.value===categoryId))cats.add(new Option('未登録のカテゴリー',categoryId));
    set('name',item?.name??'');set('category',categoryId);
    set('method',terms?.payment??item?.kind??'card');set('cardId',terms?.cardId??originalCard??cards[0]?.[0]??'');
    const knownKey=terms?terms.merchantKey:item?.candidate?.key??item?.decisionKey??null;
    set('merchant',knownKey?knownKey.slice(knownKey.indexOf('|')+1):'');
    set('accountId',terms?.accountId??'rakuten-bank');set('priceKind',existing?.priceKind??'fixed');
    set('amount',item?String(item.amount):'');set('paymentDate','');set('paymentAction','append');set('priceAction','append');
    set('frequency',terms?.frequency??item?.frequency??'monthly');set('startOn',existing?.startOn??(legacy&&item?.candidate?.months[0]?`${item.candidate.months[0]}-01`:today));
    set('month',String(terms?.monthOfYear??new Date().getMonth()+1));set('day',String(terms?.dayOfMonth??new Date().getDate()));set('weekday',String(terms?.weekday??new Date().getDay()));
    set('status','');set('statusDate',today<(existing?.startOn??today)?existing!.startOn:today);input('statusDate').min=get('statusDate');set('note',existing?.note??'');
    input('startOn').readOnly=!!existing||!!legacy;input('merchant').readOnly=!existing&&!!knownKey;
    initialAmount=get('amount');initialTerms=existing?readTerms():null;
    updateConditional();resetDirty();renderHistories(item);dialog.showModal();updateConditional();input('name').focus();
  }
  function itemsFromSource(source:MonthlySource,candidates=detectCardSubscriptions(source),latest=latestRegisteredCardCharges(source)):Item[] {
    const today=localDate();const contracts=source.assets.fixedCosts??[];
    const list:Item[]=[];
    const registeredKeys=contractMerchantKeys(source.assets);
    const historyEvidence=contractCardEvidence(source,today);
    for(const bank of source.assets.recurring){
      if(bank.kind!=='expense')continue;
      const status=bank.endOn!==null&&bank.endOn<today?'ended':bank.startOn>today?'scheduled':!bank.enabled||
        (bank.pauses??[]).some(p=>today>=p.startOn&&(p.endOn===null||today<=p.endOn))?'paused':'active';
      const terms=paymentTermsOn(bank,today),last=latestContractCardCharge(historyEvidence(bank));
      list.push({kind:terms.payment,id:bank.id,name:bank.name,amount:bank.amount,currentAmount:priceOnDay(bank.pricing??[],today,bank.amount),frequency:terms.frequency,payment:paymentLabel(terms,source),
        status,priceKind:bank.priceKind??'fixed',bank,lastAmount:last?.amount,lastMonth:last?.month});
    }
    const decisions=source.assets.cardRecurringDecisions??{};
    for(const contract of contracts){
      const terms=paymentTermsOn(contract,today);
      const found=terms.merchantKey?candidates.find(c=>c.key===terms.merchantKey):undefined;
      const last=latestContractCardCharge(historyEvidence(contract));
      list.push({kind:terms.payment,id:contract.id,name:contract.name,amount:contract.amount,currentAmount:priceOnDay(contract.pricing,today,contract.amount),frequency:terms.frequency,
        payment:paymentLabel(terms,source),
        status:fixedCostState(contract,today),priceKind:contract.priceKind,contract,candidate:found,lastAmount:last?.amount,lastMonth:last?.month});
    }
    for(const [key,decision] of Object.entries(decisions)){
      if(decision.state!=='registered'||registeredKeys.has(key)||candidates.some(c=>matchedCardRecurringDecision(decisions,c)===key&&registeredKeys.has(c.key)))continue;
      const found=candidates.find(c=>matchedCardRecurringDecision(decisions,c)===key);
      const last=latest.get(found?.key??key);
      list.push({kind:'card',id:`legacy:${key}`,name:decision.label,amount:decision.amount,frequency:decision.frequency,
        payment:source.assets.cardPreferences?.[decision.cardId]?.name??CARDS.find(c=>c.id===decision.cardId)?.name??'クレジットカード',
        status:'active',priceKind:'fixed',decision,decisionKey:key,candidate:found,lastAmount:last?.amount,lastMonth:last?.month});
    }
    return list.sort((a,b)=>a.status.localeCompare(b.status)||a.name.localeCompare(b.name,'ja'));
  }
  const legacyContract=(item:Item):FixedCostEntry|null=>{
    if(!item.decision)return null;
    const d=item.decision;
    const startOn=get('startOn');
    const match=item.decisionKey??cardRecurringKey(d.cardId,d.merchant);
    return {id:crypto.randomUUID(),name:d.label,payment:'card',cardId:d.cardId,merchantKey:match,categoryId:null,
      frequency:d.frequency,dayOfMonth:1,monthOfYear:d.frequency==='yearly'?Number(startOn.slice(5,7)):null,weekday:null,
      startOn,endOn:null,amount:d.amount,priceKind:'fixed',pricing:[{effectiveOn:startOn,amount:d.amount}],pauses:[],note:'',updatedAt:new Date().toISOString()};
  };
  async function persist(event:SubmitEvent):Promise<void>{
    event.preventDefault();if(busy||confirming()||!editorOpen())return;
    const vault=deps.vault();if(!vault?.unlocked){error.textContent='保管庫の解除が必要です。';return;}
    const revision=epoch;
    try {
      const amount=Number(get('amount')),name=get('name').trim(),startOn=get('startOn');
      const frequency=get('frequency') as CostFrequency,method=get('method');
      const categoryId=get('category')||null,priceKind=get('priceKind') as 'fixed'|'variable',note=get('note').trim();
      const existing=editing?.bank??editing?.contract;
      if(existing){
        const doc=vault.assetSettings(),current=editing?.bank?doc.recurring.find(x=>x.id===editing!.id):doc.fixedCosts?.find(x=>x.id===editing!.id);
        if(JSON.stringify(current)!==JSON.stringify(existing))throw new Error('契約が更新されました。閉じて最新情報から編集してください。');
      }
      if(!name||name.length>80)throw new Error('名称を正しく入力してください。');
      if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('金額を正しく入力してください。');
      if(existing&&(get('paymentAction')==='cancel'||get('priceAction')==='cancel')){
        const snapshot=formSnapshot();
        if(!await requestConfirmation({owner:confirmationOwner,parent:dialog,title:'変更予定を取り消しますか？',message:'選択した最新の変更予定を取り消し、それ以前の設定を維持します。その他の未保存の変更もまとめて保存します。',acceptLabel:'保存する',destructive:true}))return;
        if(revision!==epoch||!dialog.open||busy||deps.vault()!==vault||!vault.unlocked||formSnapshot()!==snapshot)return;
      }
      busy=true;form.inert=true;save.disabled=true;showActivity('固定費の設定をOneDriveに保存中…','working');
      if(existing){
        const edit:ContractEdit={name,categoryId,priceKind,note};
        const priceAction=get('priceAction');
        if(priceAction==='cancel'&&futurePriceDate){if(amountChanged())throw new Error('金額を元に戻してから料金変更予定を取り消してください。');edit.price={cancelDate:futurePriceDate};}
        else if(amountChanged()||priceAction==='revise')edit.price={amount,effectiveOn:get('paymentDate'),...(priceAction==='revise'&&futurePriceDate?{replaceDate:futurePriceDate}:{})};
        const action=get('paymentAction');
        if(action==='cancel'&&futurePaymentDate){
          if(termsChanged())throw new Error('支払条件を元に戻してから変更予定を取り消してください。');
          edit.payment={cancelDate:futurePaymentDate};
        }else if(termsChanged()||action==='revise'){
          const terms=validatePaymentTerms(readTerms());
          if(terms.payment==='bank'&&terms.accountId==='nisa')throw new Error('銀行引落の口座を指定してください。');
          edit.payment={terms,effectiveOn:get('paymentDate'),...(action==='revise'&&futurePaymentDate?{replaceDate:futurePaymentDate}:{})};
        }
        if(get('status'))edit.state={action:get('status') as 'active'|'paused'|'ended',effectiveOn:get('statusDate')};
        if(!edit.price&&!edit.payment&&!edit.state&&name===existing.name&&categoryId===existing.categoryId&&priceKind===(existing.priceKind??'fixed')&&note===(existing.note??''))throw new Error('保存する変更がありません。');
        await vault.editContract(existing,edit);
      }else{
        if(!startOn)throw new Error('契約開始日を入力してください。');
        if(editing&&editing.kind!==method)throw new Error('候補の支払方法を変更できません。');
        const schedule={frequency,dayOfMonth:frequency==='weekly'?null:Number(get('day')),
          monthOfYear:frequency==='yearly'?Number(get('month')):null,weekday:frequency==='weekly'?Number(get('weekday')):null};
        const shared={name,categoryId,amount,priceKind,note,...schedule,startOn,endOn:null,
          pricing:[{effectiveOn:startOn,amount}],pauses:[]};
        if(method==='bank'){
          const entry:RecurringEntry={...shared,id:crypto.randomUUID(),kind:'expense',fromAccountId:get('accountId') as AssetAccountId,toAccountId:null,enabled:true};
          await vault.upsertRecurring(entry);
        }else if(method==='card'||method==='cash'){
          const original=editing?.decision?legacyContract(editing):null;
          const merchantKey=method==='card'?(editing?.candidate?.key??original?.merchantKey??(get('merchant').trim()?cardRecurringKey(get('cardId'),get('merchant').trim()):null)):null;
          const contract:FixedCostEntry={...shared,id:original?.id??crypto.randomUUID(),payment:method,cardId:method==='card'?get('cardId'):null,
            merchantKey,updatedAt:new Date().toISOString()};
          const decision=contract.payment==='card'&&contract.merchantKey&&editing?.candidate?subscriptionDecision(editing.candidate,'registered'):undefined;
          await vault.upsertFixedCost(contract,decision);
        }else throw new Error('支払方法が不正です。');
      }
      if(revision!==epoch||deps.vault()!==vault||!vault.unlocked)return;
      busy=false;form.inert=false;save.disabled=false;void closeDialog(true);notice='';deps.onSaved();render();showActivity('固定費の設定を保存しました。','good');
    } catch(e){if(revision!==epoch||deps.vault()!==vault||!vault.unlocked)return;busy=false;form.inert=false;updateConditional();const msg=e instanceof Error?e.message:'保存できませんでした。';
      error.textContent=e instanceof CloudWriteUncertainError?'保存結果未確認です。最新データを取得してから再編集してください。':msg;
      showActivity(error.textContent,'bad');}
  }
  form.addEventListener('submit',event=>{void persist(event as SubmitEvent);});
  async function markCandidate(candidate:SubscriptionCandidate,ignore:boolean):Promise<void>{
    const vault=deps.vault();if(!vault?.unlocked||busy)return;
    if(!ignore){
      // A detection hint is not a registered contract. Review the estimated
      // amount, recurrence and start date before an encrypted cloud write.
      startEdit({kind:'card',id:`candidate:${candidate.key}`,name:candidate.merchant,amount:candidate.amount,
        frequency:candidate.frequency,payment:candidate.cardName,status:'active',priceKind:'fixed',candidate});
      return;
    }
    busy=true;try{await vault.setCardRecurringDecision(candidate.key,subscriptionDecision(candidate,'ignored'));deps.onSaved();render();showActivity('候補から除外しました。','good');}
    catch(e){notice=e instanceof Error?e.message:'保存に失敗しました。';showActivity(notice,'bad');}
    finally{busy=false;render();}
  }
  function render():void {
    root!.replaceChildren();const source=deps.source();if(!source||!deps.vault()?.unlocked){root!.append(el('p','subscriptions-muted','OneDriveに接続してください。'));return;}
    const candidates=detectCardSubscriptions(source);
    const latest=latestRegisteredCardCharges(source);
    const items=itemsFromSource(source,candidates,latest),today=localDate(),active=items.filter(x=>x.status!=='ended');
    const total=active.filter(x=>x.status==='active').reduce((sum,x)=>sum+monthlyEquivalent({...x,amount:x.currentAmount??x.amount}),0);
    const metrics=el('div','fixed-cost-metrics');
    for(const [name,value] of [['月額換算',yen(total)],['年間換算',yen(total*12)],['登録件数',`${active.length}件`]] as const){
      const box=el('div','fixed-cost-metric');box.append(el('span','',name),el('strong','',value));metrics.append(box);
    }root!.append(metrics);
    const toolbar=el('div','fixed-cost-toolbar');const tabs=el('div','subscriptions-tabs');
    const decisions=source.assets.cardRecurringDecisions??{};
    const registeredKeys=contractMerchantKeys(source.assets);
    const pending=candidates.filter(c=>!matchedCardRecurringDecision(decisions,c)&&!registeredKeys.has(c.key));
    const ignored=Object.entries(decisions).filter(([,d])=>d.state==='ignored');
    for(const [value,label,count] of [['registered','登録済み',items.filter(x=>x.status!=='ended').length],['candidate','検出候補',pending.length],['ended','終了済み',items.filter(x=>x.status==='ended').length],['ignored','対象外',ignored.length]] as const){
      const button=btn(`${label} ${count}`,()=>{tab=value;render();},'subscriptions-tab'+(tab===value?' selected':''));
      button.setAttribute('aria-pressed',String(tab===value));tabs.append(button);
    }
    toolbar.append(tabs,btn('＋ 新規登録',()=>startEdit(null),'secondary-action'));root!.append(toolbar);
    if(notice)root!.append(el('p','subscriptions-notice error',notice));
    const list=el('div','subscriptions-list');
    if(tab==='candidate'){
      for(const candidate of pending){
        const card=el('article','panel fixed-cost-item');const left=el('div','fixed-cost-item-info');
        left.append(el('strong','',candidate.merchant),el('small','',`${candidate.cardName} · ${freqName(candidate.frequency)}の候補 · ${candidate.months.length}回の請求`));
        const right=el('div','fixed-cost-item-price');right.append(el('strong','',yen(candidate.amount)));
        const actions=el('div','fixed-cost-item-actions');actions.append(btn('内容を確認して登録',()=>{void markCandidate(candidate,false);},'save-action'),btn('候補から除外',()=>{void markCandidate(candidate,true);}));
        card.append(left,right,actions);list.append(card);
      }
      if(!pending.length)list.append(el('p','subscriptions-empty','未確認の候補はありません。'));
    }else if(tab==='ignored'){
      for(const [key,decision] of ignored){
        const card=el('article','panel fixed-cost-item');const info=el('div','fixed-cost-item-info');info.append(el('strong','',decision.label),el('small','',`${source.assets.cardPreferences?.[decision.cardId]?.name??CARDS.find(c=>c.id===decision.cardId)?.name??'カード'} · ${freqName(decision.frequency)}`));const actions=el('div','fixed-cost-item-actions');actions.append(btn('候補に戻す',()=>{void (async()=>{const vault=deps.vault();if(!vault||busy)return;busy=true;try{await vault.setCardRecurringDecision(key,null);deps.onSaved();}catch(e){notice=e instanceof Error?e.message:'保存できませんでした。';}finally{busy=false;render();}})();}));card.append(info,actions);list.append(card);
      }
      if(!ignored.length)list.append(el('p','subscriptions-empty','対象外にした候補はありません。'));
    }else {
      const selected=items.filter(x=>tab==='ended'?x.status==='ended':x.status!=='ended');
      for(const item of selected){
        const card=el('article','panel fixed-cost-item fixed-cost-registered-item');
        const info=el('div','fixed-cost-item-info');info.append(el('strong','',item.name),el('small','',`${freqName(item.frequency)} · ${item.payment} · ${stateName(item.status)}`));
        const price=el('div','fixed-cost-item-price');price.append(el('strong','',`${yen(item.currentAmount??item.amount)}／${item.frequency==='yearly'?'年':item.frequency==='weekly'?'週':'月'}`),el('small','',priceLabel(item)));
        info.append(el('small','fixed-cost-next',`次回支払予定：${nextPayment(item,today,source)}`),el('small','',`月額換算：${yen(monthlyEquivalent({...item,amount:item.currentAmount??item.amount}))}`));
        const actions=el('div','fixed-cost-item-actions');
        const edit=btn('',()=>openDetails(item),'fixed-cost-edit-icon');
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','18');svg.setAttribute('height','18');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.8');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');
        const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M13.5 6.5l4 4M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12L4 20z');svg.append(path);edit.append(svg);edit.setAttribute('aria-label','詳細・編集');edit.title='詳細・編集';actions.append(edit);
        if(item.lastAmount!==undefined){
          const delta=item.lastAmount-(item.currentAmount??item.amount);
          info.append(el('small','',`最新の請求実績：${yen(item.lastAmount)}（${formatMonth(item.lastMonth,'年月不明')}）${delta!==0?` · 現在の契約額との差額 ${delta>0?'+':''}${yen(delta)}`:''}`));
        }
        if(item.decision&&!item.contract)info.append(el('small','','旧形式の簡易登録です。詳細・編集から正式な契約情報を保存してください。'));
        if(item.bank&&!item.bank.enabled)info.append(el('small','',`旧形式で停止中の予定です。再開は契約状態の変更から行えます。`));
        card.append(info,price,actions);list.append(card);
      }
      if(!selected.length)list.append(el('p','subscriptions-empty','この状態の固定支出はありません。'));
    }
    root!.append(list);
  }
  function reset():void{epoch++;cancelConfirmation(confirmationOwner);tab='registered';busy=false;form.inert=false;notice='';if(dialog.open)dialog.close();editing=null;initialTerms=null;initialAmount='';futurePaymentDate=null;futurePriceDate=null;baseline='';save.disabled=false;form.reset();input<HTMLSelectElement>('category').replaceChildren();input<HTMLSelectElement>('cardId').replaceChildren();input('paymentDate').removeAttribute('min');input('statusDate').removeAttribute('min');context.textContent='';equivalent.textContent='';error.textContent='';histories.replaceChildren();root!.replaceChildren();}
  const openFixedCost=(id:string)=>{const source=deps.source();const item=source?itemsFromSource(source).find(x=>x.id===id):undefined;if(item)openDetails(item);};
  return {render,reset,isBusy:()=>busy||confirming(),isDirty,openFixedCost};
}
