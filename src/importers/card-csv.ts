import type { ParsedStatement, ImportRow } from '../models/types.js';
import { isoDate, normalize, parseYen, rowId } from './utils.js';

export interface CardCsvMeta { cardId:'smbc-nl'|'amazon'|'goldpoint'; billingMonth:string }
/** Vpass/card issuer downloads use Japanese Windows CP932; never upload raw CSV. */
export function decodeCardCsv(bytes: ArrayBuffer): string {
  if(bytes.byteLength===0||bytes.byteLength>2_000_000)throw new Error('CSVのサイズが不正です（上限2MB）。');
  const utf8=new TextDecoder('utf-8',{fatal:true});
  try{return utf8.decode(bytes);}catch{
    try{return new TextDecoder('shift_jis',{fatal:true}).decode(bytes);}
    catch{throw new Error('CSVの文字コードを読み取れません。');}
  }
}
/** RFC4180-compatible, including quoted commas, doubled quotes and embedded newlines. */
export function csvCells(text:string): string[][] {
  const rows:string[][]=[];let cells:string[]=[],field='',quoted=false,closed=false,begin=true;
  const source=text.replace(/^\uFEFF/,'');
  function pushCell(){cells.push(field);field='';closed=false;begin=true;}
  function pushRow(){pushCell();if(cells.length>1||cells[0]!.trim())rows.push(cells);cells=[];}
  for(let i=0;i<source.length;i++){
    const c=source[i]!;
    if(quoted){
      if(c==='"'){
        if(source[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}
      }else field+=c;
      continue;
    }
    if(c==='"'&&begin){quoted=true;begin=false;continue;}
    if(c===','){pushCell();continue;}
    if(c==='\n'||c==='\r'){
      pushRow();if(c==='\r'&&source[i+1]==='\n')i++;continue;
    }
    if(closed||c==='"')throw new Error('CSVの引用符の形式が不正です。');
    field+=c;begin=false;
  }
  if(quoted)throw new Error('CSVの引用符が閉じていません。');
  if(field||cells.length||closed)pushRow();
  if(rows.length>10002)throw new Error('CSVの明細件数が上限を超えています。');
  return rows;
}
function paymentMonthFromFilename(filename:string):string {
  const m=/^(20\d{2})(0[1-9]|1[0-2])(?:[a-z])?(?:\s*\(\d+\))?\.csv$/i.exec(filename.trim());
  if(!m)throw new Error('CSVファイル名から請求月を判定できません。標準のYYYYMM.csv形式でダウンロードしてください。');
  return `${m[1]}-${m[2]}`;
}
function issuerCard(name:string):CardCsvMeta['cardId'] {
  const n=normalize(name).replace(/[\s　]/g,'').replace(/^(?:カード名称?|カード名|CARDNAME)[:：]/i,'').toUpperCase();
  if(/^三井住友カード(?:(?:VISA|マスター|MASTERCARD))?\(?NL\)?$/.test(n)&&n.includes('NL'))return 'smbc-nl';
  if(/^AMAZON(?:マスター(?:カード)?|MASTERCARD)$/.test(n))return 'amazon';
  if(['ゴールドポイントカードプラス','ゴールドポイントカード+','ヨドバシゴールドポイントカードプラス','GOLDPOINTCARD+','GOLDPOINTCARDPLUS'].includes(n))return 'goldpoint';
  throw new Error('対応していないカードのCSVです。カード名は自動識別できませんでした。');
}
export function identifyCardCsv(text:string,filename:string):CardCsvMeta {
  const records=csvCells(text);
  // CSV headers vary by download date/card: some have only 3 columns, some
  // include extra account labels, and some prepend a title/blank line.
  // Never interpret a transaction merchant as the card issuer.
  const firstTransaction=records.findIndex(row=>/^20\d{2}\/\d{1,2}\/\d{1,2}$/.test((row[0]??'').trim()));
  if(firstTransaction<1||firstTransaction>12)
    throw new Error('CSVの利用明細行またはカード情報が見つかりません。');
  const found=new Set<CardCsvMeta['cardId']>();
  for(const record of records.slice(0,firstTransaction)){
    for(const cell of record){
      if(!cell.trim())continue;
      try{found.add(issuerCard(cell));}catch{/* This header cell is not an issuer label. */}
    }
  }
  if(found.size!==1)throw new Error(found.size>1?'CSVに複数のカード名が含まれています。':'対応していないカードのCSVです。カード名を識別できません。');
  return {cardId:[...found][0]!,billingMonth:paymentMonthFromFilename(filename)};
}
/** Vpass can insert a cardholder/card-device detail row directly after a charge.
 * This is not a transaction. Accept only its masked-card shape, never arbitrary
 * unrecognized rows, and do not persist cardholder names or card numbers. */
function isMaskedCardDetail(record:string[]):boolean {
  if(record.length<6||record.slice(6).some(value=>value.trim()))return false;
  const [holder,masked,channel,...rest]=record.map(value=>normalize(value).trim());
  return !!holder && (holder.endsWith('様')||holder==='本人'||holder==='ご本人') &&
    !!masked && /^[0-9*Xx\- ]{8,32}$/.test(masked) && /(?:[*Xx].*){4}/.test(masked) &&
    !!channel && rest.every(value=>!value);
}
export function parseCardCsv(text:string,filename:string,paymentDate:string|null):ParsedStatement {
  const records=csvCells(text);
  const meta=identifyCardCsv(text,filename);
  if(paymentDate!==null&&(!/^20\d{2}-\d{2}-\d{2}$/.test(paymentDate)||!isoDate(...paymentDate.split('-').map(Number) as [number,number,number])||
    isoDate(...paymentDate.split('-').map(Number) as [number,number,number])!==paymentDate))
    throw new Error('CSVに適用する引落日が不正です。');
  const transactionStart=records.findIndex(row=>/^20\d{2}\/\d{1,2}\/\d{1,2}$/.test((row[0]??'').trim()));
  // Never assume the physical last CSV row is the invoice total. Some
  // downloads append blank columns/lines or issuer notes after the summary.
  // Recognize a uniquely structured total row, then independently reconcile
  // its value with every transaction. Unknown trailing rows are rejected.
  const isTransaction=(row:string[])=>/^20\d{2}\/\d{1,2}\/\d{1,2}$/.test((row[0]??'').trim());
  const totalLabels=/^(?:合計|請求合計|請求金額合計|ご請求金額(?:合計)?|お支払い金額(?:合計)?|今回(?:の)?(?:お支払|ご請求)金額(?:合計)?|ご利用金額合計)[:：]?$/;
  const summaryCandidates:{index:number;total:number}[]=[];
  for(let i=transactionStart+1;i<records.length;i++){
    const normalized=records[i]!.map(cell=>normalize(cell).trim());
    if(isTransaction(normalized))continue;
    const filled=normalized.map((value,index)=>({value,index})).filter(cell=>cell.value!=='');
    if(filled.length===0)continue;
    const numeric=filled.filter(cell=>parseYen(cell.value)!==null);
    const labels=filled.filter(cell=>totalLabels.test(cell.value));
    if(numeric.length===1 && (filled.length===1 || (filled.length===2 && labels.length===1))) {
      const value=parseYen(numeric[0]!.value)!;
      if(Number.isSafeInteger(value))summaryCandidates.push({index:i,total:value});
    }
  }
  let lastTransaction=transactionStart;
  for(let i=transactionStart+1;i<records.length;i++)if(isTransaction(records[i]!))lastTransaction=i;
  // The total must follow every transaction and must be unique.
  const candidate=summaryCandidates.filter(c=>c.index>lastTransaction);
  if(transactionStart<1||candidate.length!==1)
    throw new Error('CSVの請求合計行を特定できません。CSVの末尾を確認してください。');
  const {index:totalIndex,total}=candidate[0]!;
  // Extra blank rows are harmless, but unknown footers could hide charges.
  for(const record of records.slice(totalIndex+1)){
    const remaining=record.map(x=>normalize(x).trim()).filter(Boolean);
    if(remaining.length && !(remaining.length===1&&/^(?:※|注[:：]|備考[:：])/.test(remaining[0]!)))
      throw new Error('CSVの請求合計より後ろに未対応の行があります。');
  }
  const rows:ImportRow[]=[],warnings:string[]=[];
  let hasInstallmentOrNonSinglePayment=false;
  for(const [index,record] of records.slice(transactionStart,totalIndex).entries()){
    // Vpass column 7 is an optional remarks field (store detail, refund, FX or installment info).
    // Columns after it must be empty: silently accepting unknown monetary columns is unsafe.
    if(record.length<6||record.slice(7).some(cell=>cell.trim()))throw new Error(`CSV ${transactionStart+index+1}行目の列数が不正です。`);
    // A masked-card metadata line may follow a cashback or another charge.
    // It carries no billing amount; do not create an extra transaction or store PII.
    if(isMaskedCardDetail(record)&&rows.length>0)continue;
    const dm=/^(20\d{2})\/(\d{1,2})\/(\d{1,2})$/.exec(record[0]!.trim());
    const usedOn=dm?isoDate(+dm[1]!, +dm[2]!, +dm[3]!):null;
    const merchant=normalize(record[1]!).trim();
    const amount=parseYen(record[5]);
    const original=parseYen(record[2]);
    const paymentKind=normalize(record[3]!).trim();
    const paymentCount=normalize(record[4]!).trim();
    const note=normalize(record[6]??'').trim();
    if(note.length>500)throw new Error(`CSV ${transactionStart+index+1}行目の備考が長すぎます（500文字以内）。`);
    // Point redemption/cashback is recorded as a negative billed amount with
    // the original amount, payment kind and count all blank.
    const adjustment=amount!==null&&amount<0&&record[2]!.trim()===''&&paymentKind===''&&paymentCount==='';
    if(!usedOn||!merchant||merchant.length>250||amount===null||
      !Number.isSafeInteger(amount)||(!adjustment&&(
        original===null||!Number.isSafeInteger(original)||
        !/^\d{1,3}$/.test(paymentKind)||!/^\d{1,3}$/.test(paymentCount))))
      throw new Error(`CSV ${transactionStart+index+1}行目の利用日・利用先・金額・支払区分が不正です。`);
    if(usedOn.slice(0,4)!==meta.billingMonth.slice(0,4)&&
      Math.abs((Number(usedOn.slice(0,4))-Number(meta.billingMonth.slice(0,4))))>1)
      throw new Error(`CSV ${transactionStart+index+1}行目の利用年が請求月から大きく離れています。`);
    const paymentDescription=(adjustment||(paymentKind==='1'&&paymentCount==='1'))?undefined:
      `支払区分 ${paymentKind} / 今回回数 ${paymentCount}（利用額 ${original!.toLocaleString('ja-JP')}円）`;
    if(paymentDescription)hasInstallmentOrNonSinglePayment=true;
    const description=[paymentDescription,note].filter(Boolean).join(' / ');
    rows.push({id:rowId(rows.length),usedOn,merchant,amount,...(description?{description}:{}),sourceLine:transactionStart+index+1});
  }
  if(!rows.length)throw new Error('CSVに取引行がありません。');
  const sum=rows.reduce((acc,row)=>acc+row.amount,0);
  if(!Number.isSafeInteger(sum)||sum!==total)throw new Error(`請求合計と明細合計が一致しません（CSV ${total.toLocaleString('ja-JP')}円／明細 ${sum.toLocaleString('ja-JP')}円）。`);
  if(hasInstallmentOrNonSinglePayment)warnings.push('一部の取引は通常の1回払い以外です。支払区分と請求金額を確認してください。');
  const provider=meta.cardId==='goldpoint'?'goldpoint':'smbc';
  return {provider,cardId:meta.cardId,sourceKind:'csv',sourceName:filename,billingMonth:meta.billingMonth,
    paymentDate,statedTotal:total,confirmation:'confirmed',rows,warnings};
}
