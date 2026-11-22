/**
 * PDF.js runs entirely in the browser. The dependency is served from our own
 * static files (dist/vendor/pdfjs), never downloaded from a third party at runtime.
 * PDFs are not sent to an API and are not persisted by this prototype.
 */
import { parseStatementText } from './statement-parser.js';
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
export const MAX_PDF_PAGES = 80;
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
export async function parsePdfFile(file) {
    assertPdfLimits(file.size);
    let lib;
    try {
        // Keep PDF.js and its worker the same pinned version, hosted in this project.
        const moduleUrl = new URL('../../vendor/pdfjs/pdf.mjs', import.meta.url).href;
        lib = await import(moduleUrl);
    }
    catch {
        throw new Error('PDF.jsが見つかりません。ターミナルで npm install → npm run build を実行してください。');
    }
    lib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
    const task = lib.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        isEvalSupported: false,
        useSystemFonts: true,
        cMapUrl: new URL('../../vendor/pdfjs/cmaps/', import.meta.url).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href,
        wasmUrl: new URL('../../vendor/pdfjs/wasm/', import.meta.url).href,
    });
    const pdf = await task.promise;
    try {
        assertPdfLimits(file.size, pdf.numPages);
        const pages = [];
        for (let page = 1; page <= pdf.numPages; page++) {
            const text = await (await pdf.getPage(page)).getTextContent();
            pages.push(joinPageItems(text.items).join('\n'));
        }
        const result = parseStatementText(pages.join('\n'), 'pdf', file.name);
        if (!result.rows.length && /smbc-card\.com|goldpoint\.co\.jp/i.test(pages.join('\n'))) {
            result.warnings.unshift('印刷PDFには明細テキストが埋め込まれていません。Web明細画面をコピーして「貼り付け」タブから解析してください。');
        }
        return result;
    }
    finally {
        await pdf.destroy();
    }
}
