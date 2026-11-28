/**
 * PDF.js runs entirely in the browser. The dependency is served from our own
 * static files (dist/vendor/pdfjs), never downloaded from a third party at runtime.
 * PDFs are not sent to an API and are not persisted by this prototype.
 */
import { parseStatementText } from './statement-parser.js';
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
export const MAX_PDF_PAGES = 80;
export const PDF_TEXT_LIMITS = Object.freeze({ pageChars: 100_000, totalChars: 1_000_000, pageItems: 30_000, totalItems: 300_000, timeoutMs: 120_000 });
/** Limits protect the device before parsing, and prevent an unbounded page walk. */
export function assertPdfLimits(size, pages) {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PDF_BYTES)
        throw new Error(`PDFは15MB以下のファイルを選択してください。`);
    if (pages !== undefined && (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_PDF_PAGES))
        throw new Error(`PDFは80ページ以下のファイルを選択してください。`);
}
function joinPageItems(items) {
    const tokens = items.filter((it) => 'str' in it && !!it.str?.trim() && Array.isArray(it.transform))
        .map(t => ({ value: t.str, x: t.transform[4] ?? 0, y: t.transform[5] ?? 0, width: t.width ?? 0 }));
    tokens.sort((a, b) => b.y - a.y || a.x - b.x);
    const groups = [];
    for (const item of tokens) {
        const last = groups.at(-1);
        if (last && Math.abs(last[0].y - item.y) < 2.25)
            last.push(item);
        else
            groups.push([item]);
    }
    return groups.map(group => {
        group.sort((a, b) => a.x - b.x);
        let result = '';
        let previousEnd = Number.NEGATIVE_INFINITY;
        for (const item of group) {
            if (result && item.x - previousEnd > 2.5)
                result += ' ';
            result += item.value;
            previousEnd = Math.max(previousEnd, item.x + item.width);
        }
        return result.trim();
    }).filter(Boolean);
}
/** Reject a stalled stage even when PDF.js/Blob does not settle on abort. */
export function pdfAbortable(work, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted)
            abort();
    });
}
export async function readPdfPage(page, total, signal) {
    const reader = page.streamTextContent().getReader();
    const items = [];
    let chars = 0, count = 0, complete = false;
    try {
        while (true) {
            signal.throwIfAborted();
            const { value, done } = await pdfAbortable(reader.read(), signal);
            if (done) {
                complete = true;
                break;
            }
            for (const item of value.items) {
                const length = 'str' in item ? item.str.length : 0;
                chars += length;
                count++;
                total.chars += length;
                total.items++;
                if (chars > PDF_TEXT_LIMITS.pageChars || count > PDF_TEXT_LIMITS.pageItems || total.chars > PDF_TEXT_LIMITS.totalChars || total.items > PDF_TEXT_LIMITS.totalItems)
                    throw new Error('PDFの抽出量が上限を超えています。');
                items.push(item);
            }
        }
        return joinPageItems(items).join('\n');
    }
    finally {
        if (!complete) {
            // PDF.js requires an Error cancellation reason, including budget aborts.
            const reason = signal.reason instanceof Error ? signal.reason : new Error('PDFのテキスト抽出を中止しました。');
            const cancellation = reader.cancel(reason);
            // Let PDF.js acknowledge a text-budget cancellation before destroying its
            // loading task. On abort, do not wait for a stalled worker.
            if (signal.aborted)
                void cancellation.catch(() => { });
            else
                await pdfAbortable(cancellation, signal).catch(() => { });
        }
        reader.releaseLock();
    }
}
/** The optional original is never handed to PDF.js: its worker may transfer/
 * detach the input ArrayBuffer. The caller can safely retain it for encrypted
 * original-PDF storage without reading the File/Blob a second time. */
export async function parsePdfFile(file, originalBytes, signal) {
    signal?.throwIfAborted();
    assertPdfLimits(file.size);
    if (originalBytes && originalBytes.byteLength !== file.size)
        throw new Error('PDF原本のバイト長が一致しません。');
    const controller = new AbortController(), active = controller.signal;
    const forward = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forward, { once: true });
    if (signal?.aborted)
        forward();
    const timeout = () => controller.abort(new Error('PDFの解析時間が上限を超えています。'));
    const deadline = performance.now() + PDF_TEXT_LIMITS.timeoutMs;
    const timer = setTimeout(timeout, PDF_TEXT_LIMITS.timeoutMs);
    const check = () => { if (performance.now() >= deadline)
        timeout(); active.throwIfAborted(); };
    try {
        let lib;
        try {
            const moduleUrl = new URL('../../vendor/pdfjs/pdf.mjs', import.meta.url).href;
            lib = await pdfAbortable(import(moduleUrl), active);
        }
        catch {
            active.throwIfAborted();
            throw new Error('PDF.jsが見つかりません。ターミナルで npm install → npm run build を実行してください。');
        }
        check();
        lib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
        const data = originalBytes ? new Uint8Array(originalBytes) : new Uint8Array(await pdfAbortable(file.arrayBuffer(), active));
        check();
        const task = lib.getDocument({
            data, isEvalSupported: false, useSystemFonts: true,
            cMapUrl: new URL('../../vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
            standardFontDataUrl: new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href,
            wasmUrl: new URL('../../vendor/pdfjs/wasm/', import.meta.url).href,
        });
        let destruction = null;
        const destroy = () => destruction ??= task.destroy();
        const abort = () => { void destroy().catch(() => { }); };
        active.addEventListener('abort', abort, { once: true });
        try {
            const pdf = await pdfAbortable(task.promise, active);
            check();
            assertPdfLimits(file.size, pdf.numPages);
            const pages = [], total = { chars: 0, items: 0 };
            for (let page = 1; page <= pdf.numPages; page++) {
                const pdfPage = await pdfAbortable(pdf.getPage(page), active);
                pages.push(await readPdfPage(pdfPage, total, active));
                check();
            }
            const text = pages.join('\n');
            const result = parseStatementText(text, 'pdf', file.name);
            check();
            if (!result.rows.length && /smbc-card\.com|goldpoint\.co\.jp/i.test(text))
                result.warnings.unshift('印刷PDFには明細テキストが埋め込まれていません。Web明細画面をコピーして「貼り付け」タブから解析してください。');
            return result;
        }
        finally {
            active.removeEventListener('abort', abort);
            const cleanup = destroy();
            if (active.aborted)
                void cleanup.catch(() => { });
            else
                await pdfAbortable(cleanup, active);
        }
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forward);
    }
}
