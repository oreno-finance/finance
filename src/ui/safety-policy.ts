/** Page-level interruption and background-refresh policy. No data is stored here. */
export interface InterruptionSnapshot {readonly busy:readonly string[];readonly unsaved:readonly string[]}
export const FOCUS_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
export function hasInterruptionRisk(state:InterruptionSnapshot):boolean {
  return state.busy.length>0||state.unsaved.length>0;
}
export function shouldRefreshOnFocus(now:number,lastCheckAt:number,unlocked:boolean,hidden:boolean,state:InterruptionSnapshot):boolean {
  return unlocked&&!hidden&&Number.isFinite(now)&&Number.isFinite(lastCheckAt)&&
    now-lastCheckAt>=FOCUS_REFRESH_INTERVAL_MS&&!hasInterruptionRisk(state);
}
