import {changeFixedCostState,validatePricing,type PriceKind} from './contracts.js';
import {appendPaymentChange,reviseFuturePaymentChange,originalPaymentTerms,validatePaymentTerms,type ContractOrigin,type PaymentTerms} from './payment-history.js';

/** A single reviewed edit. Applied routing, identity and historical dates are not editable. */
export interface ContractEdit {
  name:string;categoryId:string|null;priceKind:PriceKind;note:string;
  price?:{amount:number;effectiveOn:string;replaceDate?:string}|{cancelDate:string};
  payment?:{terms:PaymentTerms;effectiveOn:string;replaceDate?:string}|{cancelDate:string};
  state?:{action:'active'|'paused'|'ended';effectiveOn:string};
}
/** Correct the original terms only before the contract starts and before any
 * later routing has been scheduled. Never manufacture a same-day history. */
export function correctInitialPayment(origin:ContractOrigin,terms:PaymentTerms,today:string):ContractOrigin {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(today)||!Number.isFinite(Date.parse(today))||new Date(today).toISOString().slice(0,10)!==today||today>=origin.startOn||origin.paymentHistory)
    throw new Error('開始前で後続の支払条件変更がない契約だけ初期条件を訂正できます。');
  const t=validatePaymentTerms(terms);
  if(t.accountId==='nisa'||(t.merchantKey!==null&&!t.merchantKey.startsWith(`${t.cardId}|`)))throw new Error('支払条件が不正です。');
  if(JSON.stringify(t)===JSON.stringify(originalPaymentTerms(origin)))throw new Error('支払条件に変更がありません。');
  const schedule={frequency:t.frequency,dayOfMonth:t.dayOfMonth,monthOfYear:t.monthOfYear,weekday:t.weekday};
  if(t.payment==='bank'){
    if('kind' in origin)return {...origin,...schedule,fromAccountId:t.accountId};
    const {payment,cardId,merchantKey,updatedAt,...shared}=origin;
    return {...shared,...schedule,kind:'expense',fromAccountId:t.accountId,toAccountId:null,enabled:true};
  }
  if(!('kind' in origin))return {...origin,...schedule,payment:t.payment,cardId:t.cardId,merchantKey:t.merchantKey};
  if(!origin.enabled)throw new Error('停止中の旧形式契約は先に再開してください。');
  const {kind,fromAccountId,toAccountId,enabled,...shared}=origin;
  return {...shared,...schedule,payment:t.payment,cardId:t.cardId,merchantKey:t.merchantKey,
    pricing:origin.pricing??[{effectiveOn:origin.startOn,amount:origin.amount}],pauses:origin.pauses??[],
    priceKind:origin.priceKind??'fixed',note:origin.note??'',updatedAt:new Date().toISOString()};
}
export function applyContractEdit(origin:ContractOrigin,edit:ContractEdit,today:string):ContractOrigin {
  let next:ContractOrigin={...origin,name:edit.name,categoryId:edit.categoryId,priceKind:edit.priceKind,note:edit.note};
  if(edit.price){
    const change=edit.price;
    const history=origin.pricing?.length?origin.pricing.map(p=>({...p})):[{effectiveOn:origin.startOn,amount:origin.amount}];
    const latest=history.at(-1)!;
    const revised='cancelDate' in change?change.cancelDate:change.replaceDate;
    if(revised){
      if(history.length<2||latest.effectiveOn!==revised||revised<=today)throw new Error('適用前の最新の料金変更予定だけを修正・取り消しできます。');
      history.pop();
    }
    if(!('cancelDate' in change)){
      const {amount,effectiveOn}=change,last=history.at(-1)!;
      if(effectiveOn<today||effectiveOn<origin.startOn||effectiveOn<last.effectiveOn||amount===last.amount||
        (revised!==undefined&&(effectiveOn<=today||effectiveOn<=last.effectiveOn))||
        (!revised&&latest.effectiveOn>today&&history.length>1&&effectiveOn<=latest.effectiveOn))
        throw new Error('料金の適用日と変更後の金額を確認してください。');
      if(effectiveOn===last.effectiveOn)history[history.length-1]={effectiveOn,amount};
      else history.push({effectiveOn,amount});
    }
    next={...next,amount:history.at(-1)!.amount,pricing:validatePricing(history,origin.startOn)};
  }
  // Resume before validating a new route on an ended/disabled contract.
  if(edit.state){
    if(edit.state.effectiveOn<today)throw new Error('契約状態の適用日は今日以降にしてください。');
    next={...next,...changeFixedCostState(next,edit.state.action,edit.state.effectiveOn)};
  }
  if(edit.payment){
    const payment=edit.payment;
    if(!('cancelDate' in payment)&&!payment.replaceDate&&payment.effectiveOn===origin.startOn&&today<origin.startOn&&!origin.paymentHistory){
      next=correctInitialPayment(next,payment.terms,today);
    }else{
      const history='cancelDate' in payment?reviseFuturePaymentChange(next,payment.cancelDate,today):
        payment.replaceDate?reviseFuturePaymentChange(next,payment.replaceDate,today,{terms:payment.terms,effectiveOn:payment.effectiveOn}):
        appendPaymentChange(next,payment.terms,payment.effectiveOn,today);
      next={...next,paymentHistory:history};
      if(!history)delete next.paymentHistory;
    }
  }
  if(edit.price&&!('cancelDate' in edit.price)&&next.endOn!==null&&edit.price.effectiveOn>next.endOn)throw new Error('料金適用日は契約終了日以前にしてください。');
  return next;
}
