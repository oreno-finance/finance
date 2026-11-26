import {recurringOccursOn,recurringEffectiveAmount} from './recurring-schedule.js';
import { CARDS, type CardDefinition } from '../models/types.js';
import {validatePaymentHistory,validateHistoricalMerchantRoutes,type PaymentChange} from '../fixed-costs/payment-history.js';
import { validateFixedCosts, validatePricing, validatePauses, type PriceChange, type PausePeriod, type FixedCostEntry } from '../fixed-costs/contracts.js';
/** Finance assets settings are independent from statements and merchant rules.
 * Snapshots are confirmed balances, not reconstructed transactions. */
export const ASSET_ACCOUNTS = [
  {id:'rakuten-bank', name:'楽天銀行', detail:'生活費・カード引落など', icon:'🏦'},
  {id:'mizuho-bank', name:'みずほ銀行', detail:'みずほ楽天カードの引落', icon:'🏛️'},
  {id:'cash-savings', name:'現金貯金専用口座', detail:'楽天銀行から定期送金', icon:'🐖'},
  {id:'nisa', name:'NISA口座', detail:'積立投資の評価額', icon:'🌱'},
] as const;
export type AssetAccountId = typeof ASSET_ACCOUNTS[number]['id'];
export const BALANCE_WARNING_ACCOUNTS = ['rakuten-bank','mizuho-bank'] as const;
export type BalanceWarningAccountId = typeof BALANCE_WARNING_ACCOUNTS[number];
export type BalanceWarningLimits = Partial<Record<BalanceWarningAccountId,number>>;
export function validateBalanceWarningLimits(value:unknown):BalanceWarningLimits {
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('残高警告の設定が不正です。');
  const result:BalanceWarningLimits={};
  for(const [id,amount] of Object.entries(value)){
    if(!BALANCE_WARNING_ACCOUNTS.some(account=>account===id)||typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<0)
      throw new Error('残高警告の下限額は0円以上の整数で指定してください。');
    if(amount>0)result[id as BalanceWarningAccountId]=amount;
  }
  return result;
}
export type RecurringKind = 'expense' | 'income' | 'transfer';
export type RecurringFrequency = 'monthly' | 'yearly' | 'weekly';
/** Explicit opt-in; only positive card rows with this card/merchant are treated as NISA contributions. */
export interface NisaCardRule {cardId:string;merchantContains:string;enabled:boolean}
/** Historical NISA identification is immutable across later setting changes.
 * Each cutoff records the rule that was active BEFORE that day. A new rule
 * starts on the following local calendar day; changes on the same day replace
 * only the pending rule, not the preserved historical rule. */
export interface NisaRuleHistoryEntry {effectiveOn:string;previous:NisaCardRule|null}
export interface NisaRuleSettings {
  nisaCardRule:NisaCardRule|null;
  nisaCardRuleHistory?:NisaRuleHistoryEntry[];
}
/** For legacy assets (without history), the existing rule applies to all dates. */
export function nisaRuleOnDay(settings:NisaRuleSettings,day:string):NisaCardRule|null {
  for(const entry of settings.nisaCardRuleHistory??[]){
    if(day<entry.effectiveOn)return entry.previous;
  }
  return settings.nisaCardRule;
}

export interface BalanceSnapshot {
  id: string;
  accountId: AssetAccountId;
  balance: number; // JPY, integer. NISA values are manually confirmed valuations.
  observedAt: string; // ISO timestamp with time zone, captured at confirmation.
}
export interface RecurringEntry {
  id: string;
  name: string;
  amount: number;
  kind: RecurringKind;
  fromAccountId: AssetAccountId | null;
  toAccountId: AssetAccountId | null;
  frequency: RecurringFrequency;
  dayOfMonth: number | null; // 0 = end of month; 1-31 = day (clamped to month end in future projections).
  monthOfYear: number | null; // 1-12, yearly only.
  weekday: number | null; // 0 Sun - 6 Sat, weekly only.
  startOn: string;
  endOn: string | null;
  categoryId: string | null; // Display metadata only; not used for projection in v1.2.4.
  enabled: boolean;
  /** Optional historic pricing and suspension data; older vaults do not contain these fields. */
  paymentHistory?: PaymentChange[];
  pricing?: PriceChange[];
  pauses?: PausePeriod[];
  priceKind?: 'fixed'|'variable';
  note?: string;
}
/** One-off bank movement. Confirmed and planned records share the forecast engine,
 * but only expense/income change household cashflow; ATM withdrawals and transfers
 * are movements of funds, not consumption. */
export type OneTimeKind = 'expense' | 'income' | 'transfer' | 'withdrawal';
export type OneTimeStatus = 'done' | 'planned';
export interface OneTimeEntry {
  id:string;
  date:string;
  name:string;
  amount:number;
  kind:OneTimeKind;
  status:OneTimeStatus;
  /** Optional for older encrypted records; missing category is unclassified. */
  categoryId?:string|null;
  fromAccountId:AssetAccountId|null;
  toAccountId:AssetAccountId|null;
  /** Mark a Rakuten -> Mizuho transfer as funding the Mizuho Rakuten card. */
  cardFunding?:boolean;
}
export function oneTimeAccountDelta(entry:OneTimeEntry,accountId:AssetAccountId):number {
  return (entry.toAccountId===accountId?entry.amount:0)-(entry.fromAccountId===accountId?entry.amount:0);
}
/** Match only a unique one-off to a unique scheduled occurrence. Ambiguity
 * never silently deletes another payment. Cash contracts have no bank route. */
export function recurringOneTimeMatch(occurrence:RecurringEntry,day:string,entries:readonly OneTimeEntry[]=[],status?:OneTimeStatus,peers:readonly RecurringEntry[]=[occurrence]):'none'|'unique'|'ambiguous' {
  const normalize=(name:string)=>name.normalize('NFKC').trim().toLocaleLowerCase();
  const name=normalize(occurrence.name);
  const sameRoute=(entry:Pick<RecurringEntry,'kind'|'fromAccountId'|'toAccountId'|'name'>|OneTimeEntry)=>entry.kind===occurrence.kind&&entry.fromAccountId===occurrence.fromAccountId&&entry.toAccountId===occurrence.toAccountId&&normalize(entry.name)===name;
  const count=entries.filter(entry=>(status===undefined||entry.status===status)&&entry.date===day&&entry.amount===occurrence.amount&&sameRoute(entry)).length;
  if(!count)return 'none';
  const candidates=peers.filter(entry=>sameRoute(entry)&&recurringOccursOn(entry,day)&&recurringEffectiveAmount(entry,day)===occurrence.amount);
  return count===1&&candidates.length===1?'unique':'ambiguous';
}
export function recurringCoveredByOneTime(occurrence:RecurringEntry,day:string,entries:readonly OneTimeEntry[]=[],status?:OneTimeStatus,peers?:readonly RecurringEntry[]):boolean {
  return recurringOneTimeMatch(occurrence,day,entries,status,peers)==='unique';
}
export interface AssetsConflict {itemId:string;field:string;discarded:unknown;chosen:unknown;at:string}
/** Explicit per-payment-month acknowledgement, not a real bank transfer. */
export interface MizuhoFundingCheck {done:boolean;updatedAt:string;
  /** Snapshot of the exact confirmed invoice acknowledged by the user. */
  billAmount?:number;paymentDate?:string;transferAmount?:number;billId?:string;
}
export interface MizuhoBillSnapshot {billAmount:number;paymentDate:string;transferAmount:number;billId:string}

/** Each month is independently merged between devices. */
export function validateMizuhoFundingChecks(raw:unknown):Record<string,MizuhoFundingCheck>|undefined {
  if(raw===undefined)return undefined;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>240)
    throw new Error('みずほ送金確認の設定が不正です。');
  const result:Record<string,MizuhoFundingCheck>=Object.create(null);
  for(const [month,item] of Object.entries(raw)){
    if(!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month)||!item||typeof item!=='object'||Array.isArray(item))
      throw new Error('みずほ送金確認の年月が不正です。');
    const v=item as MizuhoFundingCheck;
    if(typeof v.done!=='boolean'||typeof v.updatedAt!=='string'||v.updatedAt.length>35||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.updatedAt)||
      !Number.isFinite(Date.parse(v.updatedAt))||new Date(v.updatedAt).toISOString()!==v.updatedAt)
      throw new Error('みずほ送金確認の記録が不正です。');
    const keys=['billAmount','paymentDate','transferAmount','billId'] as const;
    const hasSnapshot=keys.some(key=>v[key]!==undefined);
    if(hasSnapshot && (!Number.isSafeInteger(v.billAmount)||v.billAmount!<=0||
      !Number.isSafeInteger(v.transferAmount)||v.transferAmount!<=0||
      typeof v.paymentDate!=='string'||!validateDate(v.paymentDate)||
      typeof v.billId!=='string'||!idPattern.test(v.billId)||v.billId.length>80))
      throw new Error('みずほ送金の請求確認情報が不正です。');
    result[month]={done:v.done,updatedAt:v.updatedAt,
      ...(hasSnapshot?{billAmount:v.billAmount,paymentDate:v.paymentDate,transferAmount:v.transferAmount,billId:v.billId}:{})};
  }
  return result;
}
export interface MizuhoTransferPlan { enabled:boolean; leadDays:number; extraForSmallBills:boolean }
export const DEFAULT_MIZUHO_PLAN:MizuhoTransferPlan = {enabled:false,leadDays:3,extraForSmallBills:true};
export function validateMizuhoPlan(value:unknown):MizuhoTransferPlan|undefined {
  if(value===undefined||value===null)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('みずほ送金予測の設定が不正です。');
  const v=value as MizuhoTransferPlan;
  if(typeof v.enabled!=='boolean'||!Number.isSafeInteger(v.leadDays)||v.leadDays<0||v.leadDays>20||typeof v.extraForSmallBills!=='boolean')
    throw new Error('みずほ送金予測の設定が不正です。');
  return {enabled:v.enabled,leadDays:v.leadDays,extraForSmallBills:v.extraForSmallBills};
}
/** Optional display and notification preferences. Card parsing stays bound to the card ID. */
export type CardIssuer=CardDefinition['provider'];
export interface CardReviewTiming {monthOffset:-1|0; day:number}
import type { CardPaymentTiming } from '../importers/payment-date.js';
export interface PointRateChange { effectiveOn:string; ratePercent:number }
export interface CardPreference {name?:string;issuer?:CardIssuer;review?:CardReviewTiming|null;payment?:CardPaymentTiming;pointRatePercent?:number;pointRateHistory?:PointRateChange[]}
export function validateCardPreferences(raw:unknown):Record<string,CardPreference>|undefined {
  if(raw===undefined||raw===null)return undefined;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('カード設定が不正です。');
  const validIds=new Set(CARDS.map(c=>c.id));const result:Record<string,CardPreference>={};
  for(const [id,value] of Object.entries(raw)){
    if(!validIds.has(id)||!value||typeof value!=='object'||Array.isArray(value))throw new Error('カード設定が不正です。');
    const item=value as CardPreference;const entry:CardPreference={};
    if(item.name!==undefined){
      if(typeof item.name!=='string'||!item.name.trim()||item.name.trim().length>60)throw new Error('カード名を確認してください。');
      entry.name=item.name.trim();
    }
    if(item.issuer!==undefined){
      if(!(['rakuten','jcb','view','smbc','goldpoint'] as unknown[]).includes(item.issuer))throw new Error('カード会社を確認してください。');
      entry.issuer=item.issuer;
    }
    if(item.review!==undefined){
      if(item.review!==null&&(!item.review||!Number.isInteger(item.review.day)||item.review.day<1||item.review.day>31||
        (item.review.monthOffset!==0&&item.review.monthOffset!==-1)))throw new Error('確定目安日を確認してください。');
      entry.review=item.review===null?null:{day:item.review.day,monthOffset:item.review.monthOffset};
    }
    if(item.payment!==undefined){
      if(!['smbc-nl','amazon','goldpoint'].includes(id)||!item.payment||
        !Number.isInteger(item.payment.day)||item.payment.day<1||item.payment.day>31||
        (item.payment.monthOffset!==0&&item.payment.monthOffset!==1))
        throw new Error('引落日設定が不正です。');
      entry.payment={monthOffset:item.payment.monthOffset,day:item.payment.day};
    }
    if(item.pointRatePercent!==undefined){
      if(typeof item.pointRatePercent!=='number'||!Number.isFinite(item.pointRatePercent)||
        item.pointRatePercent<0||item.pointRatePercent>100||Math.abs(Math.round(item.pointRatePercent*100)-item.pointRatePercent*100)>1e-8)
        throw new Error('ポイント概算還元率は0〜100%、小数第2位までで入力してください。');
      entry.pointRatePercent=item.pointRatePercent;
    }
    if(item.pointRateHistory!==undefined){
      if(!Array.isArray(item.pointRateHistory)||item.pointRateHistory.length<1||item.pointRateHistory.length>256)
        throw new Error('ポイント還元率の履歴が不正です。');
      let previous='';
      entry.pointRateHistory=item.pointRateHistory.map(change=>{
        if(!change||typeof change!=='object'||typeof change.effectiveOn!=='string'||
          !/^\d{4}-\d{2}-\d{2}$/.test(change.effectiveOn)||
          Number.isNaN(Date.parse(`${change.effectiveOn}T00:00:00Z`))||
          new Date(`${change.effectiveOn}T00:00:00Z`).toISOString().slice(0,10)!==change.effectiveOn||
          change.effectiveOn<=previous||typeof change.ratePercent!=='number'||
          !Number.isFinite(change.ratePercent)||change.ratePercent<0||change.ratePercent>100||
          Math.abs(Math.round(change.ratePercent*100)-change.ratePercent*100)>1e-8)
          throw new Error('ポイント還元率の履歴が不正です。');
        previous=change.effectiveOn;
        return {effectiveOn:change.effectiveOn,ratePercent:change.ratePercent};
      });
    }
    if(Object.keys(entry).length)result[id]=entry;
  }
  return result;
}
/** User decisions for card-paid subscriptions. These NEVER enter recurring bank forecasts. */
export interface CardRecurringDecision {
  cardId:string;
  merchant:string; // normalized stable original merchant (legacy: display alias); paired with card ID
  label:string;
  amount:number;
  frequency:'monthly'|'yearly';
  state:'registered'|'ignored';
  updatedAt:string;
}
export function cardRecurringKey(cardId:string,merchant:string):string {
  return `${cardId}|${merchant.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim()}`;
}
export function validateCardRecurringDecisions(raw:unknown):Record<string,CardRecurringDecision>|undefined {
  if(raw===undefined||raw===null)return undefined;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>1000)
    throw new Error('カード定期支出の設定が不正です。');
  const allowed=new Set(CARDS.map(c=>c.id));
  const result:Record<string,CardRecurringDecision>=Object.create(null);
  for(const [key,entry] of Object.entries(raw)){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error('カード定期支出の設定が不正です。');
    const v=entry as CardRecurringDecision;
    if(!allowed.has(v.cardId)||typeof v.merchant!=='string'||!v.merchant||v.merchant.length>160||
      cardRecurringKey(v.cardId,v.merchant)!==key||typeof v.label!=='string'||!v.label.trim()||v.label.length>100||
      !Number.isSafeInteger(v.amount)||v.amount<=0||!(['monthly','yearly'] as unknown[]).includes(v.frequency)||
      !(['registered','ignored'] as unknown[]).includes(v.state)||typeof v.updatedAt!=='string'||
      v.updatedAt.length>40||!Number.isFinite(Date.parse(v.updatedAt))||!/(Z|[+-]\d{2}:\d{2})$/.test(v.updatedAt))
      throw new Error('カード定期支出の設定が不正です。');
    result[key]={cardId:v.cardId,merchant:v.merchant,label:v.label.trim(),amount:v.amount,
      frequency:v.frequency,state:v.state,updatedAt:new Date(v.updatedAt).toISOString()};
  }
  return result;
}
export interface AssetsDocument {
  /** Optional for compatibility with older finance-assets-v1 files. */
  oneTime?:OneTimeEntry[];
  /** User's explicit attestation of no card usage (not inferred from missing PDFs). */
  cardNoUseMonths?:string[];
  deletedOneTime?:string[];
  mizuhoTransferPlan?:MizuhoTransferPlan;
  /** Optional bank-specific warning floors; zero/absent means warn below zero. */
  balanceWarningLimits?:BalanceWarningLimits;
  /** Private manual funding checklist by payment month, NOT balance movements. */
  mizuhoFundingChecks?:Record<string,MizuhoFundingCheck>;
  /** Calendar month only. Stored inside the encrypted assets document. */
  birthMonth?:string;
  /** Explicit card withdrawal account per card ID. Unset entries are never guessed. */
  cardDebitAccounts?:Record<string,AssetAccountId>;
  /** Encrypted per-card presentation and statement-review settings. */
  cardPreferences?:Record<string,CardPreference>;
  /** Card-paid repeating items for analysis only; excluded from bank schedules. */
  cardRecurringDecisions?:Record<string,CardRecurringDecision>;
  /** Manual card/cash fixed costs; bank standing orders live in recurring. */
  fixedCosts?:FixedCostEntry[];
  /** Explicit tombstones prevent deleted contracts reappearing after cloud merge. */
  deletedFixedCosts?:string[];
  format: 'finance-assets-v1'|'finance-assets-v2';
  snapshots: BalanceSnapshot[];
  recurring: RecurringEntry[];
  deletedSnapshots: string[];
  deletedRecurring: string[];
  conflicts: AssetsConflict[];
  nisaCardRule: NisaCardRule | null;
  /** Historical rules are preserved inside the encrypted assets document. */
  nisaCardRuleHistory?:NisaRuleHistoryEntry[];
  payrollDepositAccount: AssetAccountId | null;
  /** Opt-in only. Stored exclusively inside AES-GCM encrypted finance/settings/assets.enc. */
  payrollAutoPassphrase: string | null;
}
export function emptyAssets(): AssetsDocument {
  return {format:'finance-assets-v1',snapshots:[],recurring:[],deletedSnapshots:[],deletedRecurring:[],conflicts:[],nisaCardRule:null,payrollDepositAccount:null,payrollAutoPassphrase:null};
}
const accountIds = new Set<string>(ASSET_ACCOUNTS.map(a=>a.id));
const idPattern = /^[a-zA-Z0-9-]{6,80}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const clone = <T>(value:T):T => structuredClone(value);
const same = (left:unknown,right:unknown):boolean => JSON.stringify(left)===JSON.stringify(right);
function validateDate(value:unknown): value is string {
  if(typeof value!=='string'||!datePattern.test(value))return false;
  const date=new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function checkAccount(value:unknown):value is AssetAccountId{return typeof value==='string'&&accountIds.has(value);}
export function validateSnapshot(raw:BalanceSnapshot):BalanceSnapshot {
  if(!raw||typeof raw!=='object'||typeof raw.id!=='string'||!idPattern.test(raw.id)||
     !checkAccount(raw.accountId)||!Number.isSafeInteger(raw.balance)||raw.balance<0||
     typeof raw.observedAt!=='string'||raw.observedAt.length>40||
     !/^\d{4}-\d{2}-\d{2}T/.test(raw.observedAt)||
     !Number.isFinite(Date.parse(raw.observedAt))|| !/(Z|[+-]\d{2}:\d{2})$/.test(raw.observedAt))
    throw new Error('口座残高の記録が不正です。金額と確認日時を確認してください。');
  return {id:raw.id,accountId:raw.accountId,balance:raw.balance,observedAt:new Date(raw.observedAt).toISOString()};
}
export function validateOneTime(raw:OneTimeEntry):OneTimeEntry {
  if(!raw||typeof raw!=='object'||(typeof raw.id!=='string'||!idPattern.test(raw.id))||!validateDate(raw.date)||
    typeof raw.name!=='string'||!raw.name.trim()||raw.name.trim().length>80||
    !Number.isSafeInteger(raw.amount)||raw.amount<=0||
    !(['expense','income','transfer','withdrawal'] as unknown[]).includes(raw.kind)||
    !(['done','planned'] as unknown[]).includes(raw.status)||
    (raw.fromAccountId!==null&&!checkAccount(raw.fromAccountId))||
    (raw.toAccountId!==null&&!checkAccount(raw.toAccountId)))throw new Error('単発の入出金を確認してください。');
  if(raw.kind==='income'&&(!checkAccount(raw.toAccountId)||raw.fromAccountId!==null))throw new Error('入金先口座を指定してください。');
  if((raw.kind==='expense'||raw.kind==='withdrawal')&&(!checkAccount(raw.fromAccountId)||raw.toAccountId!==null))throw new Error('出金元口座を指定してください。');
  if(raw.kind==='transfer'&&(!checkAccount(raw.fromAccountId)||!checkAccount(raw.toAccountId)||raw.fromAccountId===raw.toAccountId))
    throw new Error('振替元と振替先を別々に指定してください。');
  if(raw.categoryId!==undefined&&raw.categoryId!==null&&
    (typeof raw.categoryId!=='string'||!/^[-a-z0-9]{1,90}$/.test(raw.categoryId)))throw new Error('単発支出のカテゴリーが不正です。');
  if(raw.cardFunding!==undefined&&typeof raw.cardFunding!=='boolean')throw new Error('カード送金の区別が不正です。');
  if(raw.cardFunding && !(raw.kind==='transfer'&&raw.fromAccountId==='rakuten-bank'&&raw.toAccountId==='mizuho-bank'))
    throw new Error('カード代金送金は楽天銀行からみずほ銀行への振替だけ指定できます。');
  return {...raw,name:raw.name.trim()};
}
export function validateRecurring(raw:RecurringEntry):RecurringEntry {
  if(!raw||typeof raw!=='object'||typeof raw.id!=='string'||!idPattern.test(raw.id)||
    typeof raw.name!=='string'||!raw.name.trim()||raw.name.trim().length>80||
    !Number.isSafeInteger(raw.amount)||raw.amount<=0||
    !(['expense','income','transfer'] as unknown[]).includes(raw.kind)||
    (raw.fromAccountId!==null&&!checkAccount(raw.fromAccountId))||
    (raw.toAccountId!==null&&!checkAccount(raw.toAccountId))||
    !(['monthly','yearly','weekly'] as unknown[]).includes(raw.frequency)||
    !validateDate(raw.startOn)||(raw.endOn!==null&&!validateDate(raw.endOn))||
    (raw.endOn!==null&&raw.endOn<raw.startOn)||
    (raw.categoryId!==null && (typeof raw.categoryId!=='string'||raw.categoryId.length>90||!/^[a-z0-9-]+$/.test(raw.categoryId)))||
    typeof raw.enabled!=='boolean')throw new Error('定期入出金の登録内容が不正です。');
  if(raw.kind==='expense' && (!checkAccount(raw.fromAccountId)||raw.toAccountId!==null))throw new Error('支出の引落元口座を指定してください。');
  if(raw.kind==='income' && (!checkAccount(raw.toAccountId)||raw.fromAccountId!==null))throw new Error('収入の入金先口座を指定してください。');
  if(raw.kind==='transfer' && (!checkAccount(raw.fromAccountId)||!checkAccount(raw.toAccountId)||raw.fromAccountId===raw.toAccountId))throw new Error('振替元と振替先は別の口座を指定してください。');
  if(raw.frequency==='weekly'){
    if(!Number.isInteger(raw.weekday)||raw.weekday===null||raw.weekday<0||raw.weekday>6||raw.dayOfMonth!==null||raw.monthOfYear!==null)throw new Error('毎週の曜日設定が不正です。');
  }else{
    if(!Number.isInteger(raw.dayOfMonth)||raw.dayOfMonth===null||raw.dayOfMonth<0||raw.dayOfMonth>31||raw.weekday!==null||
       (raw.frequency==='monthly' ? raw.monthOfYear!==null : !Number.isInteger(raw.monthOfYear)||raw.monthOfYear===null||raw.monthOfYear<1||raw.monthOfYear>12))
      throw new Error('定期入出金の日付設定が不正です。');
  }
  if(raw.priceKind!==undefined&&!['fixed','variable'].includes(raw.priceKind))throw new Error('定期支出の金額種類が不正です。');
  if(raw.note!==undefined&&(typeof raw.note!=='string'||raw.note.length>500))throw new Error('定期支出のメモが不正です。');
  const pricing=raw.pricing===undefined?undefined:validatePricing(raw.pricing,raw.startOn);
  const pauses=raw.pauses===undefined?undefined:validatePauses(raw.pauses,raw.startOn,raw.endOn);
  if(pricing&&pricing.at(-1)!.amount!==raw.amount)throw new Error('定期支出の料金履歴と最新金額が一致しません。');
  const paymentHistory=validatePaymentHistory(raw.paymentHistory,raw);
  return {...raw,name:raw.name.trim(),...(pricing?{pricing}:{}),...(pauses?{pauses}:{}),...(paymentHistory?{paymentHistory}:{})};
}
export function validateNisaCardRule(raw:unknown):NisaCardRule|null {
  if(raw==null)return null; // Existing finance-assets-v1 documents remain readable.
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('NISAのカード積立連携設定が不正です。');
  const rule=raw as NisaCardRule;
  if(typeof rule.cardId!=='string'||!rule.cardId||rule.cardId.length>80||
    typeof rule.merchantContains!=='string'||rule.merchantContains.trim().length<3||rule.merchantContains.trim().length>90||
    typeof rule.enabled!=='boolean')throw new Error('NISAのカード積立連携設定が不正です。');
  return {cardId:rule.cardId,merchantContains:rule.merchantContains.trim(),enabled:rule.enabled};
}
/** Preserve old rule applicability by date. Strictly ascending cutoffs prevent
 * ambiguous historic reconstructions and protect against malformed backups. */
export function validateNisaRuleHistory(raw:unknown):NisaRuleHistoryEntry[]|undefined {
  if(raw===undefined)return undefined;
  if(!Array.isArray(raw)||raw.length>512)throw new Error('NISA積立判定履歴の形式が不正です。');
  let previousDate='';
  return raw.map((value:unknown)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('NISA積立判定履歴が不正です。');
    const entry=value as NisaRuleHistoryEntry;
    if(!validateDate(entry.effectiveOn)||entry.effectiveOn<=previousDate)throw new Error('NISA積立判定履歴の日付が不正です。');
    previousDate=entry.effectiveOn;
    return {effectiveOn:entry.effectiveOn,previous:validateNisaCardRule(entry.previous)};
  });
}
/** Returns a new assets document without mutating the original. Changes apply
 * only from tomorrow; today and every prior transaction keep their old classification.
 * An initial configuration on legacy data retains the old backfill behavior. */
export function withUpdatedNisaCardRule(doc:AssetsDocument,newRule:NisaCardRule|null,today:string):AssetsDocument {
  if(!validateDate(today))throw new Error('NISA積立設定の更新日が不正です。');
  const clean=validateNisaCardRule(newRule);
  if(same(doc.nisaCardRule,clean))return clone(doc);
  const next=clone(doc);
  const history=[...(next.nisaCardRuleHistory??[])];
  // Initial registration historically classified imported transactions too.
  // Preserve that behavior when there has never been an active rule.
  if(next.nisaCardRule!==null||history.length){
    const cutoff=new Date(Date.parse(`${today}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    const last=history.at(-1);
    if(last&&cutoff<last.effectiveOn)throw new Error('NISAの設定日が保存済みの変更履歴より前です。端末の日付をご確認ください。');
    if(!last||last.effectiveOn!==cutoff)history.push({effectiveOn:cutoff,previous:next.nisaCardRule});
    next.nisaCardRuleHistory=validateNisaRuleHistory(history);
  }
  next.nisaCardRule=clean;
  return next;
}
export function validatePayrollDepositAccount(raw:unknown):AssetAccountId|null {
  if(raw===undefined||raw===null)return null;
  if(!checkAccount(raw)||raw==='nisa')throw new Error('給与の受取口座の設定が不正です。');
  return raw;
}
/** Preserve the exact secret, including whitespace, for the Payroll PBKDF2 derivation. */
export function validatePayrollAutoPassphrase(raw:unknown):string|null {
  if(raw===null||raw===undefined)return null;
  if(typeof raw!=='string'||[...raw].length<12||[...raw].length>1024)
    throw new Error('Payrollの自動連携用パスフレーズの形式が不正です。');
  return raw;
}
export function validateBirthMonth(value:unknown):string|undefined {
  if(value===undefined||value===null||value==='')return undefined;
  if(typeof value!=='string'||!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value))
    throw new Error('生年月を確認してください。');
  return value;
}
export function validateCardDebitAccounts(value:unknown):Record<string,AssetAccountId>|undefined {
  if(value===undefined||value===null)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('カード引落口座の設定が不正です。');
  const allowed=new Set(CARDS.map(c=>c.id));const result:Record<string,AssetAccountId>={};
  for(const [id,account] of Object.entries(value)){
    if(!allowed.has(id)||!checkAccount(account)||account==='nisa')throw new Error('カード引落口座の設定が不正です。');
    result[id]=account;
  }
  return result;
}
export function validateAssets(raw:unknown):AssetsDocument {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('資産設定の暗号データが不正です。');
  const doc=raw as AssetsDocument;
  if(!['finance-assets-v1','finance-assets-v2'].includes(doc.format)||!Array.isArray(doc.snapshots)||!Array.isArray(doc.recurring)||
    !Array.isArray(doc.deletedSnapshots)||!Array.isArray(doc.deletedRecurring)||!Array.isArray(doc.conflicts)||
    doc.snapshots.length>1000||doc.recurring.length>300||doc.deletedSnapshots.length>2500||doc.deletedRecurring.length>2500||doc.conflicts.length>300)
    throw new Error('資産設定の形式または件数が不正です。');
  const snapshots=doc.snapshots.map(validateSnapshot),recurring=doc.recurring.map(validateRecurring);
  const fixedCosts=validateFixedCosts(doc.fixedCosts,doc.format==='finance-assets-v2');
  const historyCount=[...recurring,...(fixedCosts??[])].reduce((n,x)=>n+(x.paymentHistory?.length??0),0);
  if(historyCount>2048||(historyCount>0&&doc.format!=='finance-assets-v2'))throw new Error('固定費履歴の保存形式または件数が不正です。');
  // A unified contract is still stored in exactly one original collection.
  if(doc.format==='finance-assets-v2'&&recurring.some(x=>fixedCosts?.some(f=>f.id===x.id)))throw new Error('固定費の契約IDが重複しています。');
  if(doc.format==='finance-assets-v2')validateHistoricalMerchantRoutes({recurring,fixedCosts});
  if(doc.cardNoUseMonths!==undefined&&(!Array.isArray(doc.cardNoUseMonths)||doc.cardNoUseMonths.length>240||
    doc.cardNoUseMonths.some(month=>typeof month!=='string'||!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month))))
    throw new Error('カード利用なし確認の形式が不正です。');
  if(doc.deletedFixedCosts!==undefined&&(!Array.isArray(doc.deletedFixedCosts)||doc.deletedFixedCosts.length>1500))throw new Error('削除済み固定費の形式が不正です。');
  if(doc.oneTime!==undefined&&(!Array.isArray(doc.oneTime)||doc.oneTime.length>3000))throw new Error('単発の入出金件数が不正です。');
  if(doc.deletedOneTime!==undefined&&(!Array.isArray(doc.deletedOneTime)||doc.deletedOneTime.length>5000))throw new Error('単発の削除履歴が不正です。');
  const oneTime=(doc.oneTime??[]).map(validateOneTime);
  for(const list of [snapshots,recurring,oneTime]){
    const ids=new Set<string>();for(const item of list){if(ids.has(item.id))throw new Error('資産設定の識別子が重複しています。');ids.add(item.id);}
  }
  const checkDeleted=(ids:string[])=>{
    if(ids.some(x=>typeof x!=='string'||!idPattern.test(x)))throw new Error('削除済み設定の形式が不正です。');
    return [...new Set(ids)];
  };
  const deletedSnapshots=checkDeleted(doc.deletedSnapshots),deletedRecurring=checkDeleted(doc.deletedRecurring);
  const deletedOneTime=checkDeleted(doc.deletedOneTime??[]);
  const deletedFixedCosts=checkDeleted(doc.deletedFixedCosts??[]);
  if(snapshots.some(s=>deletedSnapshots.includes(s.id))||recurring.some(s=>deletedRecurring.includes(s.id))||oneTime.some(s=>deletedOneTime.includes(s.id))||
    doc.fixedCosts?.some(s=>deletedFixedCosts.includes(s.id)))throw new Error('削除済み設定と有効な設定が重複しています。');
  if(doc.conflicts.some(c=>!c||typeof c.itemId!=='string'||!idPattern.test(c.itemId)||typeof c.field!=='string'||c.field.length>50||typeof c.at!=='string'||!Number.isFinite(Date.parse(c.at))))
    throw new Error('資産設定の競合履歴が不正です。');
  return {format:doc.format,snapshots,recurring,deletedSnapshots,deletedRecurring,conflicts:clone(doc.conflicts),nisaCardRule:validateNisaCardRule(doc.nisaCardRule),
    ...(doc.nisaCardRuleHistory!==undefined?{nisaCardRuleHistory:validateNisaRuleHistory(doc.nisaCardRuleHistory)}:{}),payrollDepositAccount:validatePayrollDepositAccount(doc.payrollDepositAccount),
    ...(doc.balanceWarningLimits!==undefined?{balanceWarningLimits:validateBalanceWarningLimits(doc.balanceWarningLimits)}:{}),
    ...(validateMizuhoPlan(doc.mizuhoTransferPlan)?{mizuhoTransferPlan:validateMizuhoPlan(doc.mizuhoTransferPlan)}:{}),
    ...(doc.mizuhoFundingChecks!==undefined?{mizuhoFundingChecks:validateMizuhoFundingChecks(doc.mizuhoFundingChecks)}:{}),
    ...(doc.cardNoUseMonths!==undefined?{cardNoUseMonths:[...new Set(doc.cardNoUseMonths)].sort()}:{}),
    payrollAutoPassphrase:validatePayrollAutoPassphrase(doc.payrollAutoPassphrase),
    ...(validateBirthMonth(doc.birthMonth)?{birthMonth:validateBirthMonth(doc.birthMonth)}:{}),
    ...(doc.cardDebitAccounts!==undefined?{cardDebitAccounts:validateCardDebitAccounts(doc.cardDebitAccounts)}:{}),
    ...(doc.cardPreferences!==undefined?{cardPreferences:validateCardPreferences(doc.cardPreferences)}:{}),
    ...(doc.cardRecurringDecisions!==undefined?{cardRecurringDecisions:validateCardRecurringDecisions(doc.cardRecurringDecisions)}:{}),
    ...(doc.fixedCosts!==undefined?{fixedCosts}:{}),
    ...(doc.deletedFixedCosts!==undefined?{deletedFixedCosts}:{}),
    ...(doc.oneTime!==undefined?{oneTime}:{}),...(doc.deletedOneTime!==undefined?{deletedOneTime}:{})};
}
export function latestBalance(doc:AssetsDocument,account:AssetAccountId,asOf?:string):BalanceSnapshot|null {
  const found=doc.snapshots.filter(s=>s.accountId===account&&(!asOf||s.observedAt<=asOf));
  return found.sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||b.id.localeCompare(a.id))[0]??null;
}
/** Describe collisions without exposing financial amounts or encrypted credentials in UI. */
export interface AssetsEditCollision { itemId:string; field:string }
/** Finds only same-field changes (and delete-vs-edit collisions). Disjoint edits
 * are safe to merge without interrupting the user. */
/** NISA current rule and its history are one atomic merge unit. */
function nisaSettings(doc:AssetsDocument):NisaRuleSettings {
  return {nisaCardRule:doc.nisaCardRule??null,...(doc.nisaCardRuleHistory?.length?{nisaCardRuleHistory:doc.nisaCardRuleHistory}:{})};
}
/** A pre-start correction can move a contract between the two storage
 * collections. The inactive collection retains a tombstone. Merge this logical
 * identity as one unit, including after a move back or a subsequent deletion. */
function relocatedContractIds(...docs:AssetsDocument[]):Set<string>{
  const ids=new Set<string>();
  for(const doc of docs){
    const fixedDeleted=new Set(doc.deletedFixedCosts??[]),bankDeleted=new Set(doc.deletedRecurring);
    for(const x of doc.recurring)if(x.kind==='expense'&&fixedDeleted.has(x.id))ids.add(x.id);
    for(const x of doc.fixedCosts??[])if(bankDeleted.has(x.id))ids.add(x.id);
    for(const id of bankDeleted)if(fixedDeleted.has(id))ids.add(id);
  }
  return ids;
}
function contractPlacement(doc:AssetsDocument,id:string){
  return {bank:doc.recurring.find(x=>x.id===id),fixed:doc.fixedCosts?.find(x=>x.id===id),
    bankDeleted:doc.deletedRecurring.includes(id),fixedDeleted:!!doc.deletedFixedCosts?.includes(id)};
}
function samePlacement(a:ReturnType<typeof contractPlacement>,b:ReturnType<typeof contractPlacement>):boolean{
  const canonical=(value:unknown)=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
  return canonical(a)===canonical(b);
}
export function detectAssetsEditCollisions(base:AssetsDocument,local:AssetsDocument,remote:AssetsDocument):AssetsEditCollision[] {
  const collisions:AssetsEditCollision[]=[];
  const relocated=relocatedContractIds(base,local,remote);
  const mark=(itemId:string,field:string)=>{
    if(!collisions.some(c=>c.itemId===itemId&&c.field===field))collisions.push({itemId,field});
  };
  const sameEdit=(itemId:string,field:string,baseline:unknown,left:unknown,right:unknown)=>{
    if(!same(left,baseline)&&!same(right,baseline)&&!same(left,right))mark(itemId,field);
  };
  const collection=<T extends {id:string}>(b:T[],l:T[],r:T[],bDeleted:string[],lDeleted:string[],rDeleted:string[],fields:(keyof T)[],contract=false)=>{
    const bm=new Map(b.map(x=>[x.id,x])),lm=new Map(l.map(x=>[x.id,x])),rm=new Map(r.map(x=>[x.id,x]));
    for(const id of new Set([...bm.keys(),...lm.keys(),...rm.keys(),...bDeleted,...lDeleted,...rDeleted])){
      if(contract&&relocated.has(id))continue; // Atomic relocation conflicts fail closed in mergeAssets.
      const bv=bm.get(id),lv=lm.get(id),rv=rm.get(id);
      if(lDeleted.includes(id)&&rv&&!same(rv,bv))mark(id,'delete');
      if(rDeleted.includes(id)&&lv&&!same(lv,bv))mark(id,'delete');
      if(!lv||!rv||lDeleted.includes(id)||rDeleted.includes(id))continue;
      for(const field of fields)sameEdit(id,String(field),bv?.[field],lv[field],rv[field]);
    }
  };
  collection(base.snapshots,local.snapshots,remote.snapshots,base.deletedSnapshots,local.deletedSnapshots,remote.deletedSnapshots,
    ['accountId','balance','observedAt']);
  collection(base.recurring,local.recurring,remote.recurring,base.deletedRecurring,local.deletedRecurring,remote.deletedRecurring,
    ['name','amount','kind','fromAccountId','toAccountId','frequency','dayOfMonth','monthOfYear','weekday','startOn','endOn','categoryId','enabled','pricing','pauses','priceKind','note','paymentHistory'],true);
  collection(base.oneTime??[],local.oneTime??[],remote.oneTime??[],base.deletedOneTime??[],local.deletedOneTime??[],remote.deletedOneTime??[],
    ['date','name','amount','kind','status','categoryId','fromAccountId','toAccountId','cardFunding']);
  collection(base.fixedCosts??[],local.fixedCosts??[],remote.fixedCosts??[],base.deletedFixedCosts??[],local.deletedFixedCosts??[],remote.deletedFixedCosts??[],
    ['name','payment','cardId','merchantKey','categoryId','frequency','dayOfMonth','monthOfYear','weekday','startOn','endOn','amount','priceKind','pricing','pauses','note','updatedAt','paymentHistory'],true);
  sameEdit('nisa-card-rule','nisaCardRule',nisaSettings(base),nisaSettings(local),nisaSettings(remote));
  sameEdit('payroll-deposit-account','payrollDepositAccount',base.payrollDepositAccount??null,local.payrollDepositAccount??null,remote.payrollDepositAccount??null);
  sameEdit('payroll-auto-credential','payrollAutoPassphrase',base.payrollAutoPassphrase??null,local.payrollAutoPassphrase??null,remote.payrollAutoPassphrase??null);
  sameEdit('birth-month','birthMonth',base.birthMonth,local.birthMonth,remote.birthMonth);
  for(const id of new Set([...Object.keys(base.cardDebitAccounts??{}),...Object.keys(local.cardDebitAccounts??{}),...Object.keys(remote.cardDebitAccounts??{})]))
    sameEdit('card-debit-accounts',id,base.cardDebitAccounts?.[id],local.cardDebitAccounts?.[id],remote.cardDebitAccounts?.[id]);
  for(const id of new Set([...Object.keys(base.cardPreferences??{}),...Object.keys(local.cardPreferences??{}),...Object.keys(remote.cardPreferences??{})]))
    sameEdit('card-preferences',id,base.cardPreferences?.[id],local.cardPreferences?.[id],remote.cardPreferences?.[id]);
  for(const id of new Set([...Object.keys(base.cardRecurringDecisions??{}),...Object.keys(local.cardRecurringDecisions??{}),...Object.keys(remote.cardRecurringDecisions??{})]))
    sameEdit('card-recurring-decisions',id,base.cardRecurringDecisions?.[id],local.cardRecurringDecisions?.[id],remote.cardRecurringDecisions?.[id]);
  for(const month of new Set([...Object.keys(base.mizuhoFundingChecks??{}),...Object.keys(local.mizuhoFundingChecks??{}),...Object.keys(remote.mizuhoFundingChecks??{})]))
    sameEdit('mizuho-funding',month,base.mizuhoFundingChecks?.[month],local.mizuhoFundingChecks?.[month],remote.mizuhoFundingChecks?.[month]);
  for(const id of BALANCE_WARNING_ACCOUNTS)
    sameEdit('balance-warning-limits',id,base.balanceWarningLimits?.[id]??0,local.balanceWarningLimits?.[id]??0,remote.balanceWarningLimits?.[id]??0);
  sameEdit('mizuho-transfer-plan','mizuhoTransferPlan' ,base.mizuhoTransferPlan,local.mizuhoTransferPlan,remote.mizuhoTransferPlan);
  return collisions;
}
/** Merge independent additions, removals and field edits from two devices. Concurrent
 * same-field edits prefer the saving device ONLY after explicit user approval in LiveVault.
 * This pure function retains old merge behavior for compatibility with existing audit data. */
export function mergeAssets(base:AssetsDocument,local:AssetsDocument,remote:AssetsDocument,now=new Date().toISOString(),preferLocalDeletes=false):AssetsDocument {
  const conflicts=[...remote.conflicts];
  for(const c of local.conflicts)if(!conflicts.some(x=>same(x,c)))conflicts.push(clone(c));
  const mergeGroup=<T extends {id:string}>(b:T[],l:T[],r:T[],bDeleted:string[],lDeleted:string[],rDeleted:string[],fields:(keyof T)[])=>{
    const bm=new Map(b.map(x=>[x.id,x])),lm=new Map(l.map(x=>[x.id,x])),rm=new Map(r.map(x=>[x.id,x]));
    const deleted=new Set([...bDeleted,...lDeleted,...rDeleted]);const entries:T[]=[];
    for(const id of new Set([...bm.keys(),...lm.keys(),...rm.keys(),...deleted])){
      const bv=bm.get(id),lv=lm.get(id),rv=rm.get(id);
      if(lDeleted.includes(id)&&(!rv||same(bv,rv))){deleted.add(id);continue;}
      if(rDeleted.includes(id)&&(!lv||same(bv,lv))){deleted.add(id);continue;}
      if(lDeleted.includes(id)&&rv&&!same(rv,bv)){
        if(preferLocalDeletes){
          conflicts.push({itemId:id,field:'delete',discarded:clone(rv),chosen:'削除',at:now});deleted.add(id);continue;
        }
        conflicts.push({itemId:id,field:'delete',discarded:'削除',chosen:clone(rv),at:now});entries.push(clone(rv));deleted.delete(id);continue;
      }
      if(rDeleted.includes(id)&&lv&&!same(lv,bv)){
        conflicts.push({itemId:id,field:'delete',discarded:'削除',chosen:clone(lv),at:now});entries.push(clone(lv));deleted.delete(id);continue;
      }
      if(!lv&&!rv)continue;
      if(!lv&&rv){entries.push(clone(rv));deleted.delete(id);continue;}
      if(!rv&&lv){entries.push(clone(lv));deleted.delete(id);continue;}
      if(!lv||!rv)continue;
      const merged={id} as Record<string,unknown>;
      for(const k of fields){
        if(k==='id')continue;
        const key=String(k),baseline=bv?.[k],left=lv[k],right=rv[k];
        if(same(left,baseline))merged[key]=clone(right);
        else if(same(right,baseline)||same(left,right))merged[key]=clone(left);
        else{
          if(key==='paymentHistory')throw new Error('支払条件履歴が同時に変更されました。最新情報を取得して変更し直してください。');
          merged[key]=clone(left);conflicts.push({itemId:id,field:key,discarded:clone(right),chosen:clone(left),at:now});
        }
      }
      entries.push(merged as T);deleted.delete(id);
    }
    return {entries,deleted:[...deleted]};
  };
  const snapshots=mergeGroup(base.snapshots,local.snapshots,remote.snapshots,base.deletedSnapshots,local.deletedSnapshots,remote.deletedSnapshots,
    ['accountId','balance','observedAt']);
  const relocated=relocatedContractIds(base,local,remote);
  const ordinary=<T extends {id:string}>(items:T[])=>items.filter(x=>!relocated.has(x.id));
  const ordinaryDeleted=(ids:string[])=>ids.filter(id=>!relocated.has(id));
  const recurring=mergeGroup(ordinary(base.recurring),ordinary(local.recurring),ordinary(remote.recurring),ordinaryDeleted(base.deletedRecurring),ordinaryDeleted(local.deletedRecurring),ordinaryDeleted(remote.deletedRecurring),
    ['name','amount','kind','fromAccountId','toAccountId','frequency','dayOfMonth','monthOfYear','weekday','startOn','endOn','categoryId','enabled','pricing','pauses','priceKind','note','paymentHistory']);
  const oneTimes=mergeGroup(base.oneTime??[],local.oneTime??[],remote.oneTime??[],base.deletedOneTime??[],local.deletedOneTime??[],remote.deletedOneTime??[],
    ['date','name','amount','kind','status','categoryId','fromAccountId','toAccountId','cardFunding']);
  const fixedCosts=mergeGroup(ordinary(base.fixedCosts??[]),ordinary(local.fixedCosts??[]),ordinary(remote.fixedCosts??[]),ordinaryDeleted(base.deletedFixedCosts??[]),ordinaryDeleted(local.deletedFixedCosts??[]),ordinaryDeleted(remote.deletedFixedCosts??[]),
    ['name','payment','cardId','merchantKey','categoryId','frequency','dayOfMonth','monthOfYear','weekday','startOn','endOn','amount','priceKind','pricing','pauses','note','updatedAt','paymentHistory']);
  for(const id of relocated){
    const b=contractPlacement(base,id),l=contractPlacement(local,id),r=contractPlacement(remote,id);
    const chosen=samePlacement(l,b)?r:samePlacement(r,b)||samePlacement(l,r)?l:null;
    if(!chosen)throw new Error('固定費の支払方法または契約内容が同時に変更・削除されました。最新情報を取得してください。');
    if(chosen.bank)recurring.entries.push(clone(chosen.bank));
    if(chosen.fixed)fixedCosts.entries.push(clone(chosen.fixed));
    if(chosen.bankDeleted)recurring.deleted.push(id);
    if(chosen.fixedDeleted)fixedCosts.deleted.push(id);
  }
  const baseline=nisaSettings(base),left=nisaSettings(local),right=nisaSettings(remote);
  let nisa:NisaRuleSettings;
  if(same(left,baseline))nisa=clone(right);
  else if(same(right,baseline)||same(left,right))nisa=clone(left);
  else{
    nisa=clone(left);
    conflicts.push({itemId:'nisa-card-rule',field:'nisaCardRule',discarded:clone(right),chosen:clone(left),at:now});
  }
  const nisaCardRule=nisa.nisaCardRule;
  const oldAccount=base.payrollDepositAccount??null,localAccount=local.payrollDepositAccount??null,remoteAccount=remote.payrollDepositAccount??null;
  let payrollDepositAccount:AssetAccountId|null;
  if(same(localAccount,oldAccount))payrollDepositAccount=remoteAccount;
  else if(same(remoteAccount,oldAccount)||same(localAccount,remoteAccount))payrollDepositAccount=localAccount;
  else {
    payrollDepositAccount=localAccount;
    conflicts.push({itemId:'payroll-deposit-account',field:'payrollDepositAccount',discarded:remoteAccount,chosen:localAccount,at:now});
  }
  const previousSecret=base.payrollAutoPassphrase??null;
  const localSecret=local.payrollAutoPassphrase??null;
  const remoteSecret=remote.payrollAutoPassphrase??null;
  let payrollAutoPassphrase:string|null;
  if(same(localSecret,previousSecret))payrollAutoPassphrase=remoteSecret;
  else if(same(remoteSecret,previousSecret)||same(localSecret,remoteSecret))payrollAutoPassphrase=localSecret;
  else {
    payrollAutoPassphrase=localSecret;
    // Never put either old or new credential into the permanent conflict log.
    conflicts.push({itemId:'payroll-auto-credential',field:'payrollAutoPassphrase',discarded:'競合',chosen:'保存端末側を優先',at:now});
  }
  const bBirth=base.birthMonth, lBirth=local.birthMonth, rBirth=remote.birthMonth;
  const birthMonth= same(lBirth,bBirth)?rBirth:lBirth;
  if(!same(lBirth,bBirth)&&!same(rBirth,bBirth)&&!same(lBirth,rBirth))conflicts.push({itemId:'birth-month',field:'birthMonth',discarded:rBirth??null,chosen:lBirth??null,at:now});
  const accounts:Record<string,AssetAccountId>={};
  for(const id of new Set([...Object.keys(base.cardDebitAccounts??{}),...Object.keys(local.cardDebitAccounts??{}),...Object.keys(remote.cardDebitAccounts??{})])){
    const original=base.cardDebitAccounts?.[id],left=local.cardDebitAccounts?.[id],right=remote.cardDebitAccounts?.[id];
    const next=same(left,original)?right:left;
    if(next)accounts[id]=next;
    if(!same(left,original)&&!same(right,original)&&!same(left,right))conflicts.push({itemId:'card-debit-accounts',field:id,discarded:right??null,chosen:left??null,at:now});
  }
  const cardPreferences:Record<string,CardPreference>={};
  for(const id of new Set([...Object.keys(base.cardPreferences??{}),...Object.keys(local.cardPreferences??{}),...Object.keys(remote.cardPreferences??{})])){
    const original=base.cardPreferences?.[id],left=local.cardPreferences?.[id],right=remote.cardPreferences?.[id];
    const next=same(left,original)?right:left;
    if(next)cardPreferences[id]=clone(next);
    if(!same(left,original)&&!same(right,original)&&!same(left,right))
      conflicts.push({itemId:'card-preferences',field:id,discarded:right??null,chosen:left??null,at:now});
  }
  const cardRecurringDecisions:Record<string,CardRecurringDecision>={};
  for(const id of new Set([...Object.keys(base.cardRecurringDecisions??{}),...Object.keys(local.cardRecurringDecisions??{}),...Object.keys(remote.cardRecurringDecisions??{})])){
    const original=base.cardRecurringDecisions?.[id],left=local.cardRecurringDecisions?.[id],right=remote.cardRecurringDecisions?.[id];
    const next=same(left,original)?right:left;
    if(next)cardRecurringDecisions[id]=clone(next);
    if(!same(left,original)&&!same(right,original)&&!same(left,right))
      conflicts.push({itemId:'card-recurring-decisions',field:id,discarded:right??null,chosen:left??null,at:now});
  }
  const baseNoUse=new Set(base.cardNoUseMonths??[]),localNoUse=new Set(local.cardNoUseMonths??[]),remoteNoUse=new Set(remote.cardNoUseMonths??[]);
  const cardNoUseMonths:string[]=[];
  for(const month of new Set([...baseNoUse,...localNoUse,...remoteNoUse])){
    const original=baseNoUse.has(month),left=localNoUse.has(month),right=remoteNoUse.has(month);
    const value=left===original?right:left;
    if(value)cardNoUseMonths.push(month);
    if(left!==original&&right!==original&&left!==right)
      conflicts.push({itemId:'card-no-use',field:month,discarded:right,chosen:left,at:now});
  }
  const mizuhoFundingChecks:Record<string,MizuhoFundingCheck>={};
  for(const month of new Set([...Object.keys(base.mizuhoFundingChecks??{}),...Object.keys(local.mizuhoFundingChecks??{}),...Object.keys(remote.mizuhoFundingChecks??{})])){
    const original=base.mizuhoFundingChecks?.[month],left=local.mizuhoFundingChecks?.[month],right=remote.mizuhoFundingChecks?.[month];
    const value=same(left,original)?right:left;
    if(value)mizuhoFundingChecks[month]=clone(value);
    if(!same(left,original)&&!same(right,original)&&!same(left,right))
      conflicts.push({itemId:'mizuho-funding',field:month,discarded:right??null,chosen:left??null,at:now});
  }
  const balanceWarningLimits:BalanceWarningLimits={};
  for(const id of BALANCE_WARNING_ACCOUNTS){
    const original=base.balanceWarningLimits?.[id]??0,left=local.balanceWarningLimits?.[id]??0,right=remote.balanceWarningLimits?.[id]??0;
    const next=left===original?right:left;
    if(next>0)balanceWarningLimits[id]=next;
    if(left!==original&&right!==original&&left!==right)
      conflicts.push({itemId:'balance-warning-limits',field:id,discarded:right,chosen:left,at:now});
  }
  const bPlan=base.mizuhoTransferPlan,lPlan=local.mizuhoTransferPlan,rPlan=remote.mizuhoTransferPlan;
  const plan=same(lPlan,bPlan)?rPlan:lPlan;
  if(!same(lPlan,bPlan)&&!same(rPlan,bPlan)&&!same(lPlan,rPlan))
    conflicts.push({itemId:'mizuho-transfer-plan',field:'mizuhoTransferPlan',discarded:rPlan??null,chosen:lPlan??null,at:now});
  return validateAssets({format:[base,local,remote].some(x=>x.format==='finance-assets-v2')?'finance-assets-v2':'finance-assets-v1',snapshots:snapshots.entries,recurring:recurring.entries,
    deletedSnapshots:snapshots.deleted,deletedRecurring:recurring.deleted,conflicts:conflicts.slice(-200),nisaCardRule,...(nisa.nisaCardRuleHistory?{nisaCardRuleHistory:nisa.nisaCardRuleHistory}:{}),payrollDepositAccount,payrollAutoPassphrase,
    ...(birthMonth?{birthMonth}:{}),...(Object.keys(accounts).length?{cardDebitAccounts:accounts}:{}),
    ...(Object.keys(cardPreferences).length?{cardPreferences}:{}),
    ...(Object.keys(cardRecurringDecisions).length?{cardRecurringDecisions}:{}),
    ...(base.fixedCosts!==undefined||local.fixedCosts!==undefined||remote.fixedCosts!==undefined?{fixedCosts:fixedCosts.entries}:{}),
    ...(base.deletedFixedCosts!==undefined||local.deletedFixedCosts!==undefined||remote.deletedFixedCosts!==undefined?{deletedFixedCosts:fixedCosts.deleted}:{}),
    ...(plan?{mizuhoTransferPlan:plan}:{}),
    ...(Object.keys(balanceWarningLimits).length?{balanceWarningLimits}:{}),
    ...(base.mizuhoFundingChecks!==undefined||local.mizuhoFundingChecks!==undefined||remote.mizuhoFundingChecks!==undefined?{mizuhoFundingChecks}:{}),
    ...(base.cardNoUseMonths!==undefined||local.cardNoUseMonths!==undefined||remote.cardNoUseMonths!==undefined?{cardNoUseMonths:cardNoUseMonths.sort()}:{}),...(base.oneTime!==undefined||local.oneTime!==undefined||remote.oneTime!==undefined?{oneTime:oneTimes.entries}:{}),
    ...(base.deletedOneTime!==undefined||local.deletedOneTime!==undefined||remote.deletedOneTime!==undefined?{deletedOneTime:oneTimes.deleted}:{})});
}

/** Human-readable, tab-local conflict comparison. Never expose stored credentials. */
export interface AssetsEditDetail { itemId:string; field:string; label:string; localValue:string; remoteValue:string }
export function describeAssetsEditCollisions(base:AssetsDocument,local:AssetsDocument,remote:AssetsDocument,collisions:readonly AssetsEditCollision[]):AssetsEditDetail[] {
  const format=(field:string,value:unknown):string=>{
    if(field==='payrollAutoPassphrase')return '（セキュリティ保護のため非表示）';
    if(value===undefined||value===null||value==='')return '未設定';
    if(value===true)return '有効';if(value===false)return '無効';
    if(typeof value==='number')return Number.isFinite(value)?`${value.toLocaleString('ja-JP')}${['amount','balance'].includes(field)?'円':''}`:'不明';
    if(typeof value==='string')return value.slice(0,65);
    if(typeof value==='object')return JSON.stringify(value).slice(0,90);
    return String(value).slice(0,65);
  };
  const find=(doc:AssetsDocument,id:string):BalanceSnapshot|RecurringEntry|OneTimeEntry|FixedCostEntry|undefined=>
    [...doc.snapshots,...doc.recurring,...(doc.oneTime??[]),...(doc.fixedCosts??[])].find(entry=>entry.id===id);
  return collisions.map(item=>{
    const present=find(local,item.itemId)??find(remote,item.itemId)??find(base,item.itemId);
    let label=item.itemId;
    if(present){
      if('accountId' in present)label=`${ASSET_ACCOUNTS.find(a=>a.id===present.accountId)?.name??present.accountId}・${present.observedAt.slice(0,10)}の残高`;
      else if('date' in present)label=`${present.date}・${present.name}`;
      else label=`${'payment' in present?'固定費':'定期入出金'}「${present.name}」`;
    }else if(item.itemId==='mizuho-transfer-plan')label='みずほ送金予測';
    else if(item.itemId==='balance-warning-limits')label=`残高警告（${ASSET_ACCOUNTS.find(a=>a.id===item.field)?.name??'銀行口座'}）`;
    else if(item.itemId==='mizuho-funding')label=`みずほ銀行への${item.field}分送金確認`;
    else if(item.itemId==='card-preferences')label=`カード設定（${CARDS.find(c=>c.id===item.field)?.name??item.field}）`;
    else if(item.itemId==='card-recurring-decisions')label='カード定期支出';
    else if(item.itemId==='card-debit-accounts')label=`カード引落口座（${CARDS.find(c=>c.id===item.field)?.name??item.field}）`;
    else if(item.itemId==='nisa-card-rule')label='NISAのカード積立';
    else if(item.itemId==='payroll-deposit-account')label='給与入金先';
    else if(item.itemId==='payroll-auto-credential')label='給与自動取得の認証';
    else if(item.itemId==='birth-month')label='生年月';
    const entryFor=(doc:AssetsDocument)=>find(doc,item.itemId);
    let left:unknown,right:unknown;
    if(present){
      if(item.field==='delete'){
        left=entryFor(local)??'削除';right=entryFor(remote)??'削除';
      }else{
        left=(entryFor(local) as unknown as Record<string,unknown>|undefined)?.[item.field];
        right=(entryFor(remote) as unknown as Record<string,unknown>|undefined)?.[item.field];
      }
    }else if(item.itemId==='card-preferences'){
      left=local.cardPreferences?.[item.field];right=remote.cardPreferences?.[item.field];
    }else if(item.itemId==='card-recurring-decisions'){
      left=local.cardRecurringDecisions?.[item.field];right=remote.cardRecurringDecisions?.[item.field];
    }else if(item.itemId==='card-debit-accounts'){
      left=local.cardDebitAccounts?.[item.field];right=remote.cardDebitAccounts?.[item.field];
    }else if(item.itemId==='balance-warning-limits'){
      const id=item.field as BalanceWarningAccountId;
      left=local.balanceWarningLimits?.[id]??0;right=remote.balanceWarningLimits?.[id]??0;
    }else if(item.itemId==='mizuho-funding'){
      left=local.mizuhoFundingChecks?.[item.field];right=remote.mizuhoFundingChecks?.[item.field];
    }else{
      const name=item.field as keyof AssetsDocument;
      left=local[name];right=remote[name];
    }
    return {itemId:item.itemId,field:item.field,label,localValue:format(item.field,left),remoteValue:format(item.field,right)};
  });
}
