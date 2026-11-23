const samples = new Map();
const requests = { 'graph.get': 0, 'graph.write': 0, 'graph.download': 0, 'graph.upload-chunk': 0 };
const origin = typeof performance === 'undefined' ? 0 : performance.now();
const ms = () => typeof performance === 'undefined' ? Date.now() : performance.now();
export async function measureFinancePhase(phase, run) {
    const started = ms();
    let ok = false;
    try {
        const value = await run();
        ok = true;
        return value;
    }
    finally {
        const duration = Math.max(0, ms() - started);
        const prior = samples.get(phase) ?? { count: 0, failures: 0, totalMs: 0, minMs: Infinity, maxMs: 0 };
        prior.count++;
        if (!ok)
            prior.failures++;
        prior.totalMs += duration;
        prior.minMs = Math.min(prior.minMs, duration);
        prior.maxMs = Math.max(prior.maxMs, duration);
        samples.set(phase, prior);
    }
}
/** Measure synchronous read-only calculations without persisting financial data. */
export function measureFinanceSync(phase, run) {
    const started = ms();
    let ok = false;
    try {
        const result = run();
        ok = true;
        return result;
    }
    finally {
        const duration = Math.max(0, ms() - started);
        const prior = samples.get(phase) ?? { count: 0, failures: 0, totalMs: 0, minMs: Infinity, maxMs: 0 };
        prior.count++;
        if (!ok)
            prior.failures++;
        prior.totalMs += duration;
        prior.minMs = Math.min(prior.minMs, duration);
        prior.maxMs = Math.max(prior.maxMs, duration);
        samples.set(phase, prior);
    }
}
export function countFinanceRequest(kind) { requests[kind]++; }
/** Aggregated totals only, with a fixed vocabulary. Nothing is persisted or transmitted. */
export function financePerformanceReport() {
    const round = (n) => Math.round(n * 10) / 10;
    const phases = {};
    for (const [name, s] of samples)
        phases[name] = { count: s.count, failures: s.failures, totalMs: round(s.totalMs), averageMs: round(s.totalMs / s.count), minMs: round(s.minMs), maxMs: round(s.maxMs) };
    return { elapsedMs: round(ms() - origin), requests: { ...requests }, phases };
}
export function clearFinancePerformance() { samples.clear(); for (const key of Object.keys(requests))
    requests[key] = 0; }
// Local, read-only diagnostics from browser DevTools: financePerformanceReport()
// No data or source identifiers are exposed. The method cannot mutate the vault.
if (typeof window !== 'undefined' && !Object.prototype.hasOwnProperty.call(window, 'financePerformanceReport')) {
    Object.defineProperty(window, 'financePerformanceReport', { value: financePerformanceReport, configurable: false, writable: false });
}
