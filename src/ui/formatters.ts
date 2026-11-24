/** Presentation only. Never use formatted values as persisted amounts, dates or input values. */
const missing='—';
const finite=(n:number|null|undefined):n is number=>typeof n==='number'&&Number.isFinite(n);
export function formatNumber(n:number|null|undefined,digits=0,empty=missing):string {
  if(!finite(n))return empty;
  const abs=Math.abs(n).toLocaleString('ja-JP',{maximumFractionDigits:digits});
  return (n<0&&Number(abs.replace(/,/g,''))!==0?'−':'')+abs;
}
export function formatYen(n:number|null|undefined,digits=0,empty=missing):string {
  return finite(n)?`${formatNumber(n,digits)}円`:empty;
}
export function formatSignedYen(n:number|null|undefined,empty=missing):string {
  if(!finite(n))return empty;
  return `${n>=0.5?'+':''}${formatYen(n)}`;
}
export function formatMonth(period:string|null|undefined,empty=missing):string {
  return period&&/^\d{4}-(0[1-9]|1[0-2])$/.test(period)?`${period.slice(0,4)}年${Number(period.slice(5))}月`:empty;
}
function dateParts(day:string|null|undefined):[number,number,number]|null {
  if(!day||!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day))return null;
  const [y,m,d]=day.split('-').map(Number) as [number,number,number];
  const leap=y%4===0&&(y%100!==0||y%400===0);
  const end=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][m-1]!;
  return d<=end?[y,m,d]:null;
}
const pad=(n:number)=>String(n).padStart(2,'0');
export function formatDate(day:string|null|undefined,empty=missing):string {
  return dateParts(day)?day!.replace(/-/g,'/'):empty;
}
export function formatShortDate(day:string|null|undefined,empty=missing):string {
  const p=dateParts(day);return p?`${p[1]}/${p[2]}`:empty;
}
export function formatTime(value:Date,seconds=false):string {
  return Number.isFinite(value.getTime())?`${pad(value.getHours())}:${pad(value.getMinutes())}${seconds?':'+pad(value.getSeconds()):''}`:missing;
}
export function formatDateTime(value:string|number|Date|null|undefined,seconds=false,empty=missing):string {
  if(value==null)return empty;
  const d=value instanceof Date?value:new Date(value);
  return Number.isFinite(d.getTime())?`${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${formatTime(d,seconds)}`:empty;
}
export function formatRate(value:number|null|undefined,empty=missing):string {
  return finite(value)?`${value.toLocaleString('ja-JP',{minimumFractionDigits:1,maximumFractionDigits:2}).replace(/^-/,'−')}%`:empty;
}
export function formatPoints(value:number|null|undefined,empty=missing):string {
  return finite(value)?`${formatNumber(value)} pt`:empty;
}

/** Archived reports carry a display-only rate list; never interpret malformed text as zero. */
export function formatRateList(label:string):string {
  const parts=label.split('/').map(value=>value.trim());
  if(!parts.length||parts.some(value=>!/^\d+(?:\.\d+)?%$/.test(value)||Number(value.slice(0,-1))>100))return missing;
  return parts.map(value=>formatRate(Number(value.slice(0,-1)))).join(' / ');
}
