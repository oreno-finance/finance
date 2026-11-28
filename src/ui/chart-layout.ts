/** Keep SVG geometry responsive without rebuilding the surrounding controls. */
export function observeChartWidth(svg:SVGElement,paint:(width:number)=>void,fallbackWidth:number):()=>void {
  let previous=Math.floor(svg.clientWidth)||fallbackWidth;
  paint(previous);
  const update=()=>{
    // clientWidth is in layout CSS pixels, not transformed screen coordinates.
    const width=Math.floor(svg.clientWidth);
    if(width<=0||width===previous)return;
    previous=width;paint(width);
  };
  if(typeof ResizeObserver==='undefined')return ()=>{};
  const observer=new ResizeObserver(update);
  observer.observe(svg);
  return ()=>observer.disconnect();
}
