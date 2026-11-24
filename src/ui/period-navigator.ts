/** Shared month/year navigation, without persistent state or changes to source records. */
import {changePeriod,isValidPeriod} from '../summary/monthly-summary.js';
export interface MonthNavigatorOptions {label:string;max?:string;min?:string;today?:string;all?:()=>void}
export interface MonthNavigatorControls {previous:HTMLButtonElement;picker:HTMLInputElement;next:HTMLButtonElement;current?:HTMLButtonElement;all?:HTMLButtonElement}
export const localMonth=(date=new Date()):string=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
export function monthInRange(value:string,options:MonthNavigatorOptions):boolean {
  return isValidPeriod(value)&&value>=(options.min??'1900-01')&&value<=(options.max??'2199-12');
}
export function adjacentMonth(value:string,delta:-1|1,options:MonthNavigatorOptions):string|null {
  const base=value||options.today||localMonth();
  if(!monthInRange(base,options)||delta===-1&&(base<=(options.min??'1900-01')||base==='1900-01')||delta===1&&(base>=(options.max??'2199-12')||base==='2199-12'))return null;
  const next=changePeriod(base,delta);return monthInRange(next,options)?next:null;
}
/** Bind existing controls once; read live state so redraws never leave stale handlers. */
export function bindMonthNavigator(root:HTMLElement,controls:MonthNavigatorControls,getPeriod:()=>string,onChoose:(value:string)=>void,getOptions:()=>MonthNavigatorOptions):()=>void {
  root.classList.add('finance-period-nav');root.setAttribute('role','group');
  const {previous,picker,next,current,all}=controls;
  picker.type='month';picker.classList.add('finance-period-input');
  previous.setAttribute('aria-label','前月');next.setAttribute('aria-label','翌月');
  current?.setAttribute('aria-label','今月に戻る');
  const sync=()=>{
    const options=getOptions(),period=getPeriod();
    root.setAttribute('aria-label',options.label);picker.setAttribute('aria-label',options.label);
    picker.min=options.min??'1900-01';picker.max=options.max??'2199-12';picker.value=period;
    previous.disabled=adjacentMonth(period,-1,options)===null;next.disabled=adjacentMonth(period,1,options)===null;
    if(current)current.disabled=!options.today||!monthInRange(options.today,options);
    if(all){all.classList.toggle('active',period==='');all.setAttribute('aria-pressed',String(period===''));}
  };
  const choose=(value:string)=>{if(monthInRange(value,getOptions()))onChoose(value);sync();};
  const shift=(delta:-1|1)=>{const value=adjacentMonth(getPeriod(),delta,getOptions());if(value!==null)choose(value);};
  previous.addEventListener('click',()=>shift(-1));next.addEventListener('click',()=>shift(1));
  picker.addEventListener('change',()=>choose(picker.value));
  current?.addEventListener('click',()=>choose(getOptions().today??''));
  all?.addEventListener('click',()=>{getOptions().all?.();sync();});
  sync();return sync;
}
export function monthNavigator(period:string,onChoose:(value:string)=>void,options:MonthNavigatorOptions):HTMLElement{
  const root=document.createElement('div');
  const create=(text:string,aria:string)=>{const button=document.createElement('button');button.type='button';button.textContent=text;button.setAttribute('aria-label',aria);return button;};
  const previous=create('‹','前月'),next=create('›','翌月'),picker=document.createElement('input');
  const current=options.today?create('今月','今月に戻る'):undefined;
  root.append(previous,picker,next);if(current)root.append(current);
  let selected=period;
  bindMonthNavigator(root,{previous,picker,next,current},()=>selected,value=>{selected=value;onChoose(value);},()=>options);
  return root;
}
export function yearNavigator(year:number,onChoose:(year:number)=>void,options:{min:number;max:number}):HTMLElement {
  const root=document.createElement('div');root.className='finance-period-nav';root.setAttribute('role','group');root.setAttribute('aria-label','分析対象年');
  const previous=document.createElement('button');previous.type='button';previous.textContent='‹';previous.setAttribute('aria-label','前年');previous.disabled=year<=options.min;previous.addEventListener('click',()=>onChoose(year-1));
  const picker=document.createElement('select');picker.className='finance-period-input';picker.setAttribute('aria-label','分析対象年');
  for(let y=options.max;y>=options.min;y--){const option=new Option(`${y}年`,String(y));picker.add(option);}picker.value=String(year);
  picker.addEventListener('change',()=>onChoose(Number(picker.value)));
  const next=document.createElement('button');next.type='button';next.textContent='›';next.setAttribute('aria-label','翌年');next.disabled=year>=options.max;next.addEventListener('click',()=>onChoose(year+1));
  const current=document.createElement('button');current.type='button';current.textContent='今年';current.setAttribute('aria-label','今年に戻る');current.addEventListener('click',()=>onChoose(options.max));
  root.append(previous,picker,next,current);return root;
}
