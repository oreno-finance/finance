/** Exercises the shipped PDF.js engine with a synthetic document, including cleanup. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parsePdfFile} from '../dist/src/importers/pdf-reader.js';

// PDF.js 6.5 expects newer Web APIs than the oldest Node used by this
// project; polyfills are test-only and do not affect the shipped application.
if (typeof Promise.try !== 'function') {
  Promise.try = (callback, ...args) => Promise.resolve().then(() => callback(...args));
}
if (typeof Uint8Array.prototype.toHex !== 'function') {
  Uint8Array.prototype.toHex = function () {return Buffer.from(this).toString('hex');};
}

function syntheticPdf(pages=1, contentForPage=undefined) {
  let content='%PDF-1.4\n';
  const positions=[0];
  const add=(body)=>{
    positions.push(Buffer.byteLength(content,'ascii'));
    content+=`${positions.length-1} 0 obj\n${body}\nendobj\n`;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${3+i*2} 0 R`).join(' ')}] /Count ${pages} >>`);
  for(let i=0;i<pages;i++){
    const page=3+i*2;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3+pages*2} 0 R >> >> /Contents ${page+1} 0 R >>`);
    const text=contentForPage?.(i)??'BT /F1 12 Tf 72 720 Td (SMBC-CARD.COM SYNTHETIC TEST STATEMENT) Tj ET';
    add(`<< /Length ${Buffer.byteLength(text,'ascii')} >>\nstream\n${text}\nendstream`);
  }
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const xref=Buffer.byteLength(content,'ascii');
  content+=`xref\n0 ${positions.length}\n0000000000 65535 f \n`;
  for (let i=1;i<positions.length;i++)content+=`${String(positions[i]).padStart(10,'0')} 00000 n \n`;
  content+=`trailer\n<< /Size ${positions.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(content,'ascii'));
}
const mockFile=(name,bytes)=>({name,size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer});

test('real pinned PDF.js parses synthetic PDFs repeatedly and releases each loading task',async()=>{
  for(const name of ['synthetic-a.pdf','synthetic-b.pdf','synthetic-c.pdf']){
    const result=await parsePdfFile(mockFile(name,syntheticPdf()));
    assert.equal(result.sourceName,name);
    assert.equal(result.sourceKind,'pdf');
    assert.equal(result.provider,'smbc');
    assert.ok(Array.isArray(result.rows));
    assert.ok(Array.isArray(result.warnings));
  }
});

test('real pinned PDF.js rejects an invalid PDF without leaking a loading task',async()=>{
  const bytes=Uint8Array.from(Buffer.from('not-a-pdf','ascii'));
  await assert.rejects(parsePdfFile(mockFile('invalid.pdf',bytes)),error=>{
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message,/destroy is not a function/);
    return true;
  });
});

test('PDF.js cleanup is on loading task and covers both successful and unsuccessful loads',()=>{
  const source=readFileSync(new URL('../src/importers/pdf-reader.ts',import.meta.url),'utf8');
  assert.match(source,/const task\s*=\s*lib\.getDocument\(/);
  assert.match(source,/try\s*\{\s*const pdf\s*=\s*await pdfAbortable\(task\.promise,active\);/);
  assert.match(source,/finally\s*\{\s*active\.removeEventListener\(\x27abort\x27,abort\);\s*const cleanup=destroy\(\);[\s\S]*?await pdfAbortable\(cleanup,active\)/);
  assert.match(source,/destruction\?\?=task\.destroy\(\)/);
  assert.match(source,/active.addEventListener\('abort',abort,\{once:true\}\)/);
  assert.doesNotMatch(source,/pdf\.destroy\(/);
});

test('single-read PDF import retains original bytes after PDF.js worker cleanup',async()=>{
  const pdf=syntheticPdf();
  let reads=0;
  const file={name:'fake-2026.pdf',size:pdf.byteLength,arrayBuffer:async()=>{reads++;return pdf.slice().buffer;}};
  const original=new Uint8Array(await file.arrayBuffer());
  const result=await parsePdfFile(file,original);
  assert.equal(result.sourceName,'fake-2026.pdf');
  assert.equal(reads,1,'the parser must use the supplied original without reading the Blob again');
  assert.deepEqual(original,pdf,'the PDF.js worker must not detach or modify the saved original');
  const editable=original.slice();editable[0]=0;
  assert.equal(original[0],pdf[0]);
  await assert.rejects(parsePdfFile(file,original.subarray(1)),/バイト長/);
  assert.equal(reads,1,'mismatched caller bytes must be rejected without a hidden Blob read');
});

test('Phase 6C: PDF読込の取消後は解析結果を返さない',async()=>{
 const bytes=syntheticPdf(),controller=new AbortController();let entered,release;const started=new Promise(r=>{entered=r;});
 const file={name:'cancelled.pdf',size:bytes.length,arrayBuffer:()=>{entered();return new Promise(r=>{release=r;});}};
 const pending=parsePdfFile(file,undefined,controller.signal);const rejected=assert.rejects(pending,e=>e.name==='AbortError');await started;controller.abort();release(bytes.buffer);await rejected;
});

test('L202: stream limits reject before building an excessive page and cancel the source',async()=>{
 const {readPdfPage,PDF_TEXT_LIMITS}=await import('../dist/src/importers/pdf-reader.js');
 const item={str:'x',transform:[1,0,0,1,0,0]};
 const cases=[
  {items:[{...item,str:'x'.repeat(PDF_TEXT_LIMITS.pageChars+1)}],total:{chars:0,items:0}},
  {items:Array(PDF_TEXT_LIMITS.pageItems+1).fill(item),total:{chars:0,items:0}},
  {items:[item],total:{chars:PDF_TEXT_LIMITS.totalChars,items:0}},
  {items:[item],total:{chars:0,items:PDF_TEXT_LIMITS.totalItems}},
 ];
 for(const {items,total} of cases){let cancelled=0;
  const page={streamTextContent:()=>new ReadableStream({start(c){c.enqueue({items});},cancel(){cancelled++;}})};
  await assert.rejects(readPdfPage(page,total,new AbortController().signal),/上限/);
  assert.equal(cancelled,1);
 }
 const page={streamTextContent:()=>new ReadableStream({start(c){c.enqueue({items:[{...item,str:'SYNTHETIC'}]});c.close();}})};
 assert.equal(await readPdfPage(page,{chars:0,items:0},new AbortController().signal),'SYNTHETIC');
});

test('L202: stalled stream is cancelled on abort; a later document can still be parsed',async()=>{
 const {readPdfPage}=await import('../dist/src/importers/pdf-reader.js');
 const controller=new AbortController();let cancelled=0;
 const page={streamTextContent:()=>new ReadableStream({cancel(){cancelled++;}})};
 const pending=readPdfPage(page,{chars:0,items:0},controller.signal);
 const rejected=assert.rejects(pending,/synthetic deadline/);
 controller.abort(new Error('synthetic deadline'));await rejected;
 assert.equal(cancelled,1);
 assert.equal((await parsePdfFile(mockFile('synthetic-retry.pdf',syntheticPdf()))).provider,'smbc');
});


test('L202: actual PDF.js accepts 80 pages, rejects 81, then parses again',async()=>{
  const allowed=syntheticPdf(80),excess=syntheticPdf(81);
  assert.equal((await parsePdfFile(mockFile('synthetic-80.pdf',allowed))).provider,'smbc');
  await assert.rejects(parsePdfFile(mockFile('synthetic-81.pdf',excess)),/80ページ/);
  assert.equal((await parsePdfFile(mockFile('synthetic-after-limit.pdf',syntheticPdf()))).provider,'smbc');
});

test('L202: real extraction over the page character budget rejects without partial output',async()=>{
  // Text lines fit in the page and have distinct positions, repeated in a single page.
  // PDF.js may merge adjacent tokens, so use a text budget independently of item count.
  const line='X'.repeat(1000);
  const content=Array.from({length:110},(_,i)=>`BT /F1 0.1 Tf 1 ${10+i} Td (${line}) Tj ET`).join('\n');
  const bytes=syntheticPdf(1,()=>content);
  await assert.rejects(parsePdfFile(mockFile('synthetic-large-text.pdf',bytes)),/抽出量/);
  assert.equal((await parsePdfFile(mockFile('synthetic-after-text-limit.pdf',syntheticPdf()))).provider,'smbc');
});

test('L202: parser deadline rejects a stalled file read and ignores its late result',async t=>{
  const originalSetTimeout=globalThis.setTimeout;
  const {PDF_TEXT_LIMITS}=await import('../dist/src/importers/pdf-reader.js');
  t.mock.method(globalThis,'setTimeout',(cb,delay,...args)=>originalSetTimeout(cb,delay===PDF_TEXT_LIMITS.timeoutMs?25:delay,...args));
  const bytes=syntheticPdf();let release;
  const file={name:'synthetic-stalled.pdf',size:bytes.length,arrayBuffer:()=>new Promise(r=>{release=r;})};
  const pending=parsePdfFile(file);
  await assert.rejects(pending,/解析時間/);
  assert.equal(typeof release,'function');release(bytes.buffer);
  t.mock.restoreAll();
  assert.equal((await parsePdfFile(mockFile('synthetic-after-timeout.pdf',syntheticPdf()))).provider,'smbc');
});
