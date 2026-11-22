export const FOCUS_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
export function hasInterruptionRisk(state) {
    return state.busy.length > 0 || state.unsaved.length > 0;
}
export function shouldRefreshOnFocus(now, lastCheckAt, unlocked, hidden, state) {
    return unlocked && !hidden && Number.isFinite(now) && Number.isFinite(lastCheckAt) &&
        now - lastCheckAt >= FOCUS_REFRESH_INTERVAL_MS && !hasInterruptionRisk(state);
}
