/**
 * PDF.js runs entirely in the browser. The dependency is served from our own
 * static files (dist/vendor/pdfjs), never downloaded from a third party at runtime.
 * PDFs are not sent to an API and are not persisted by this prototype.
 */
import { parseStatementText } from './statement-parser.js';
import type { ParsedStatement } from '../models/types.js';

export const MAX_PDF_BYTES = 15 * 1024 * 1024;
export const MAX_PDF_PAGES = 80;
/** Limits protect the device before parsing, and prevent an unbounded page walk. */
export function assertPdfLimits(size:number,pages?:number):void {
  if(!Number.isSafeInteger(size)||size<1||size>MAX_PDF_BYTES)
    throw new Error(`PDFは15MB以下のファイルを選択してください。`);
  if(pages!==undefined&&(!Number.isSafeInteger(pages)||pages<1||pages>MAX_PDF_PAGES))
    throw new Error(`PDFは80ページ以下のファイルを選択してください。`);
}


interface PdfTextItem {
  str: string;
  width?: number;
  transform: number[];
}
interface PdfTextContent { items: Array<PdfTextItem | { type: string }> }
interface PdfPage { getTextContent(options?: Record<string, unknown>): Promise<PdfTextContent> }
interface PdfDocument { numPages: number; getPage(pageNumber: number): Promise<PdfPage> }
interface PdfLibrary {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(params: { data: Uint8Array; isEvalSupported?: boolean; useSystemFonts?: boolean; cMapUrl?: string; cMapPacked?: boolean; standardFontDataUrl?: string; wasmUrl?: string }): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}

function joinPageItems(items: PdfTextContent['items']): string[] {
  const tokens = items.filter((it): it is PdfTextItem => 'str' in it && !!it.str?.trim() && Array.isArray(it.transform))
    .map(t => ({ value: t.str, x: t.transform[4] ?? 0, y: t.transform[5] ?? 0, width: t.width ?? 0 }));
  tokens.sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: Array<typeof tokens> = [];
  for (const item of tokens) {
    const last = groups.at(-1);
    if (last && Math.abs(last[0]!.y - item.y) < 2.25) last.push(item);
    else groups.push([item]);
  }
  return groups.map(group => {
    group.sort((a, b) => a.x - b.x);
    let result = '';
    let previousEnd = Number.NEGATIVE_INFINITY;
    for (const item of group) {
      if (result && item.x - previousEnd > 2.5) result += ' ';
      result += item.value;
      previousEnd = Math.max(previousEnd, item.x + item.width);
    }
    return result.trim();
  }).filter(Boolean);
}

/** The optional original is never handed to PDF.js: its worker may transfer/
 * detach the input ArrayBuffer. The caller can safely retain it for encrypted
 * original-PDF storage without reading the File/Blob a second time. */
export async function parsePdfFile(file: File, originalBytes?:Uint8Array, signal?:AbortSignal): Promise<ParsedStatement> {
  signal?.throwIfAborted();
  assertPdfLimits(file.size);
  if(originalBytes && originalBytes.byteLength!==file.size)
    throw new Error('PDF原本のバイト長が一致しません。');
  let lib: PdfLibrary;
  try {
    // Keep PDF.js and its worker the same pinned version, hosted in this project.
    const moduleUrl = new URL('../../vendor/pdfjs/pdf.mjs', import.meta.url).href;
    lib = await import(moduleUrl) as PdfLibrary;
  } catch {
    throw new Error('PDF.jsが見つかりません。ターミナルで npm install → npm run build を実行してください。');
  }
  signal?.throwIfAborted();
  lib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
  const data=originalBytes ? new Uint8Array(originalBytes) : new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  const task = lib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    cMapUrl: new URL('../../vendor/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    wasmUrl: new URL('../../vendor/pdfjs/wasm/', import.meta.url).href,
  });
  let destruction:Promise<void>|null=null;
  const destroy=()=>destruction??=task.destroy();
  const abort=()=>{void destroy().catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  try {
    const pdf = await task.promise;
    signal?.throwIfAborted();
    assertPdfLimits(file.size,pdf.numPages);
    const pages: string[] = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const text = await (await pdf.getPage(page)).getTextContent();
      signal?.throwIfAborted();
      pages.push(joinPageItems(text.items).join('\n'));
    }
    const result = parseStatementText(pages.join('\n'), 'pdf', file.name);
    if (!result.rows.length && /smbc-card\.com|goldpoint\.co\.jp/i.test(pages.join('\n'))) {
      result.warnings.unshift('印刷PDFには明細テキストが埋め込まれていません。Web明細画面をコピーして「貼り付け」タブから解析してください。');
    }
    return result;
  } finally { signal?.removeEventListener('abort',abort);await destroy(); }
}
