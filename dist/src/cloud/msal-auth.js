/** A persisted explicit choice wins. Never take an arbitrary first account from a multi-account cache. */
export function selectMicrosoftAccount(accounts, redirected, preferredId, active) {
    if (redirected) {
        return accounts.find(a => a.homeAccountId === redirected.homeAccountId) ?? redirected;
    }
    if (preferredId)
        return accounts.find(a => a.homeAccountId === preferredId) ?? null;
    if (active)
        return accounts.find(a => a.homeAccountId === active.homeAccountId) ?? null;
    return accounts.length === 1 ? (accounts[0] ?? null) : null;
}
export function classifyMicrosoftAuthError(error) {
    const value = error && typeof error === 'object' ? error : {};
    const code = [value.errorCode, value.subError, value.name].filter(v => typeof v === 'string').join(' ').toLowerCase();
    const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';
    if (/interaction_required|login_required|consent_required|no_tokens_found|no_account_error|no_account_in_silent_request|no_account_found|invalid_grant|user_login_required|interactionrequiredautherror|silent_sso_error/.test(code))
        return 'interaction';
    if (/network|connection|failed_to_fetch|fetch_failed|offline|no_network/.test(code) ||
        /networkerror|failed to fetch|network request failed/.test(message))
        return 'network';
    if (/timeout|timed_out|monitor_window|iframe_bridge/.test(code) || /timeout|timed out/.test(message))
        return 'timeout';
    if (/server_error|temporarily_unavailable|service_unavailable|5\d\d/.test(code))
        return 'server';
    return 'unknown';
}
/** Share a pending MSAL refresh without retaining tokens after completion. */
export function coalesceSilentToken(jobs, id, run) {
    const existing = jobs.get(id);
    if (existing)
        return existing;
    const task = Promise.resolve().then(run).finally(() => {
        if (jobs.get(id) === task)
            jobs.delete(id);
    });
    jobs.set(id, task);
    return task;
}
/** Retry token acquisition only, never the Graph operation. A changed account
 * must abort both attempts, and interaction/network failures are not replayed. */
export async function retrySilentTimeout(run, guard) {
    guard();
    try {
        const result = await run();
        guard();
        return result;
    }
    catch (error) {
        guard();
        if (classifyMicrosoftAuthError(error) !== 'timeout')
            throw error;
    }
    const result = await run();
    guard();
    return result;
}
