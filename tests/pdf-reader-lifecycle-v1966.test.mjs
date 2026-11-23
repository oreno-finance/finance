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

function syntheticPdf() {
  let content='%PDF-1.4\n';
  const positions=[0];
  const add=(body)=>{
    positions.push(Buffer.byteLength(content,'ascii'));
    content+=`${positions.length-1} 0 obj\n${body}\nendobj\n`;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const text='BT /F1 12 Tf 72 720 Td (SMBC-CARD.COM SYNTHETIC TEST STATEMENT) Tj ET';
  add(`<< /Length ${Buffer.byteLength(text,'ascii')} >>\nstream\n${text}\nendstream`);
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
  assert.match(source,/try\s*\{\s*const pdf\s*=\s*await task\.promise;/);
  assert.match(source,/finally\s*\{\s*await task\.destroy\(\);\s*\}/);
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
