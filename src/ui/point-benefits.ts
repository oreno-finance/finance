/** Consistent point breakdown for Home, monthly summaries, analysis and reports. */
import type { PointBenefits } from '../summary/point-benefits.js';
const fmt=(n:number)=>n.toLocaleString('ja-JP');
export function pointBenefitsSection(title:string,data:PointBenefits):HTMLElement {
  const section=document.createElement('section');section.className='panel points-benefits';
  const heading=document.createElement('div');heading.className='points-benefits-heading';
  const name=document.createElement('h2');name.textContent=title;
  const total=document.createElement('strong');total.textContent=`${fmt(data.total)} pt`;
  heading.append(name,total);section.append(heading);
  const list=document.createElement('div');list.className='points-benefits-list';
  if(!data.cards.length){
    const empty=document.createElement('p');empty.className='points-benefits-empty';empty.textContent='この期間のカード利用はありません。';list.append(empty);
  }
  for(const item of data.cards){
    const row=document.createElement('div');row.className='points-benefits-row';
    const name=document.createElement('span');name.textContent=item.name;
    const detail=document.createElement('small');detail.textContent=`${fmt(item.amount)}円 · ${item.rateLabel??`${item.ratePercent}%`}`;
    const left=document.createElement('div');left.className='points-benefits-card';left.append(name,detail);
    const points=document.createElement('strong');points.textContent=`${fmt(item.points)} pt`;
    row.append(left,points);list.append(row);
  }
  section.append(list);return section;
}
