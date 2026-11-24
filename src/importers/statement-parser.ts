import type { ImportRow, ParsedStatement, Provider, SourceKind } from '../models/types.js';
import { classifyStatus, findAmountFollowing, isoDate, lineList, matchPaymentDate, normalize, parseYen, paymentMonth, rowId, squish } from './utils.js';

export function detectProvider(raw: string): Provider {
  const n = normalize(raw).toUpperCase();
  if (n.includes('楽天カード株式会社') || n.includes('楽天カード(VISA)')) return 'rakuten';
  if (n.includes('ビックカメラSUICAカード') || n.includes('ビューカード')) return 'view';
  if (n.includes('GOLD POINT CARD') || n.includes('ゴールドポイントマーケティング') || n.includes('ゴールドポイントカードプラス')) return 'goldpoint';
  if (n.includes('SMBC-CARD.COM') || n.includes('三井住友カード') || n.includes('WEB明細書') && n.includes('支払予定月')) return 'smbc';
  if (n.includes('株式会社ジェーシービー') || n.includes('リクルートカード') || n.includes('MYJCB')) return 'jcb';
  return 'unknown';
}

function addRow(rows: ImportRow[], date: string | null, merchant: string, amount: number | null, sourceLine: number, description?: string): void {
  if (!date || amount === null || !merchant.trim()) return;
  rows.push({ id: rowId(rows.length), usedOn: date, merchant: squish(merchant), amount, sourceLine, ...(description ? { description: squish(description) } : {}) });
}

function parseRakuten(text: string, rows: ImportRow[], sourceKind:SourceKind): { cardId: string | null; paymentDate: string | null; statedTotal: number | null; billingMonth: string | null; zeroUsage?:true } {
  const n = normalize(text);
  const lines = lineList(n);
  const billHeaderIndex = lines.findIndex(line => /(20\d{2})年(\d{1,2})月ご請求金額/.test(line));
  const billHeader = billHeaderIndex >= 0 ? lines[billHeaderIndex]! : '';
  const billMatch = /(20\d{2})年(\d{1,2})月ご請求金額/.exec(billHeader);
  const billingMonth = billMatch ? `${billMatch[1]}-${String(Number(billMatch[2])).padStart(2, '0')}` : null;
  const totalLine = billHeaderIndex >= 0 ? lines.slice(billHeaderIndex + 1, billHeaderIndex + 6).find(line => /^([\d,]+)円(?:\s|$)/.test(line)) : undefined;
  const total = parseYen(/^([\d,]+)円/.exec(totalLine ?? '')?.[1]);
  const paymentHeaderIndex = lines.findIndex(line => /お支払日\s+返済方法/.test(line));
  const paymentLine = paymentHeaderIndex >= 0 ? lines[paymentHeaderIndex + 1] ?? '' : '';
  const dateMatch = /^(20\d{2})\/(\d{1,2})\/(\d{1,2})/.exec(paymentLine);
  const date = dateMatch ? isoDate(+dateMatch[1]!, +dateMatch[2]!, +dateMatch[3]!) : matchPaymentDate(n);
  let previous: ImportRow | undefined;
  let inItems = false;
  let amountColumns=0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^利用日\s+利用店名/.test(line)) { inItems = true; amountColumns=/当月請求額\s+翌月繰越残高/.test(line)?(/当月支払額/.test(line)?6:5):0; continue; }
    if (/請求金額確定前の明細|リボのお支払予定|お支払予定表|^※/.test(line) && inItems) { inItems = false; }
    if (!inItems) continue;
    const m = /^(20\d{2})\/(\d{1,2})\/(\d{1,2})\s+(.+?)\s+(本人|ETC)\*?\s+(?:\d+回払い|リボ払い|分割払い|分割\s*\d+回払い\s*\(\s*\d+回目\s*\)|ボーナス払い)\s+(.+)$/.exec(line);
    if (m) {
      // For the newly supported installment format, verify each numeric column.
      if(/分割\s*\d+回払い/.test(line)&&(!amountColumns||!m[6]!.trim().split(/\s+/).every(value=>/^[-−]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value))||m[6]!.trim().split(/\s+/).length!==amountColumns))continue;
      const digits = [...m[6]!.matchAll(/[-−]?\d[\d,]*/g)].map(x => parseYen(x[0])).filter((n): n is number => n !== null);
      // Rakuten's last amount is the carried balance; penultimate is "当月請求額".
      const amount = digits.length >= 2 ? digits[digits.length - 2]! : null;
      addRow(rows, isoDate(+m[1]!, +m[2]!, +m[3]!), m[4]!, amount, i + 1);
      previous = rows.at(-1);
    } else if (previous && /ETCカード売上/.test(previous.merchant) && /^[\p{L}\p{N}\s\/\-ー]{3,}$/u.test(line) && !/利用|残高|請求|金額/.test(line)) {
      previous.description = line; // ETC toll road / segment notes on next line.
    }
  }
  // ETC purchases do not identify which of the two Rakuten cards was used.
  // Require an explicit choice before the new statement can be saved.
  // Explicit no-charge PDF, not an extraction failure. Require the entire empty
  // table, missing debit/confirmation date, zero adjustment/refund and independent
  // second-page totals. Never infer zero merely from rows.length or a missing date.
  const table=lines.findIndex(line=>/^利用日\s+利用店名\s+利用者\s+支払方法\s+利用金額\s+手数料\/利息\s+支払総額\s+(?:当月支払額\s+)?当月請求額\s+翌月繰越残高$/.test(line));
  const emptyTable=table>=0&&/^(?:[-‐‑−]\s+){8,9}[-‐‑−]$/.test(lines[table+1]??'')&&/^※ポイントで支払いサービス/.test(lines[table+2]??'');
  const totals=lines.findIndex(line=>/^リボのお支払金額\s+明細中の(?:利用|お支払)金額合計$/.test(line));
  const jstMonth=new Date(Date.now()+9*60*60*1000).toISOString().slice(0,7);
  const zeroUsage=sourceKind==='pdf'&&total===0&&rows.length===0&&date===null&&!!billingMonth&&billingMonth<jstMonth&&
    /^(20\d{2})-(0[1-9]|1[0-2])$/.test(billingMonth)&&/^ご利用代金請求明細書$/.test(lines[0]??'')&&
    /^0円\s+楽天カード\([^)]*\)\s+\*{4}-\*{4}-\*{4}-\d{4}$/.test(totalLine??'')&&
    /^(?:[-‐‑−]\s+){5}0円\s+0円$/.test(paymentLine)&&emptyTable&&totals>table&&
    /^0\s+0$/.test(lines[totals+1]??'')&&/^内\)キャッシング\s+0$/.test(lines[totals+2]??'')&&
    /^明細中のリボ払い利用金額合計\s+0\s+本カード会員様利用分\s+0$/.test(lines[totals+3]??'')&&
    classifyStatus(n)!=='provisional'&&lines.filter(line=>/^利用日\s+利用店名/.test(line)).length===1&&
    !lines.some(line=>/^20\d{2}\/\d{1,2}\/\d{1,2}\s+/.test(line));
  return { cardId: null, paymentDate: date, statedTotal: total, billingMonth: billingMonth ?? paymentMonth(date), ...(zeroUsage?{zeroUsage:true as const}:{}) };
}

function parseJcb(text: string, rows: ImportRow[]) {
  const n = normalize(text);
  const lines = lineList(n);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(20\d{2})\/(\d{1,2})\/(\d{1,2})\s+(.+?)\s+([-−]?[\d,]+)\s+(?:\d+回|リボ|ボ\d+|C\d+|S\d+)\s+([-−]?[\d,]+)/.exec(lines[i]!);
    if (!m) continue;
    addRow(rows, isoDate(+m[1]!, +m[2]!, +m[3]!), m[4]!, parseYen(m[6]!), i + 1);
  }
  const total = findAmountFollowing(n, /◆今回のお支払金額総合計\s*([\d,]+)/);
  const date = matchPaymentDate(n);
  return { cardId: 'recruit-jcb', paymentDate: date, billingMonth: paymentMonth(date), statedTotal: total };
}

function parseView(text: string, rows: ImportRow[]) {
  const n = normalize(text);
  const lines = lineList(n);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\d{2})\s+(\d{2})\s+(\d{2})\s+[★●■\s]*(.+?)\s+([-−]?[\d,]+)\s+([-−]?[\d,]+)\s+(?:\d+回払|リボ払|ボーナス).*?([-−]?[\d,]+)\s*$/.exec(lines[i]!);
    if (!m) continue;
    addRow(rows, isoDate(+m[1]!, +m[2]!, +m[3]!), m[4]!, parseYen(m[7]!), i + 1);
  }
  const date = matchPaymentDate(n);
  const total = findAmountFollowing(n, /ご請求額合計\s*([\d,]+)/) ?? findAmountFollowing(n, /お支払額\s*([\d,]+)円?/);
  return { cardId: 'bic-suica', paymentDate: date, billingMonth: paymentMonth(date), statedTotal: total };
}

function parseSmbc(text: string, rows: ImportRow[], candidateRows: string[][]) {
  const n = normalize(text);
  const date = matchPaymentDate(n);
  const metadata = n.replace(/\|/g, ' ').replace(/\*\*/g, '');
  const total = findAmountFollowing(metadata, /(?:ご利用明細合計|ご請求金額合計)\s*([\d,]+)円?/)
    ?? findAmountFollowing(metadata, /支払い予定分のご利用明細合計\s*([\d,]+)円?/);
  const rowSources = candidateRows.length ? candidateRows : lineList(n).map(row => splitRow(row));
  for (let i = 0; i < rowSources.length; i++) {
    const cells = rowSources[i]!.map(squish).filter(Boolean);
    const di = cells.findIndex(cell => /^\d{2}\/\d{2}\/\d{2}$/.test(cell));
    if (di !== -1 && cells[di + 1]) {
      const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(cells[di]!);
      const merchant = cells[di + 1]!;
      const monthIdx = cells.findIndex((v, index) => index > di + 1 && /^\d{2}\/\d{2}$/.test(v));
      const amountIdx = monthIdx >= 0 ? monthIdx + 1 : cells.findIndex((v, index) => index > di + 1 && /^-?[\d,]+$/.test(v));
      if (match && amountIdx >= 0) addRow(rows, isoDate(+match[1]!, +match[2]!, +match[3]!), merchant, parseYen(cells[amountIdx]), i + 1);
      continue;
    }
    const flat = cells.join(' ');
    const m = /^(\d{2})\/(\d{2})\/(\d{2})\s+(.+?)\s+(?:ご本人|本人)\s+(?:\d+回払い|リボ払い|分割払い)\s+(?:(?:\d{2}\/\d{2})\s+)?([-−]?[\d,]+)(?:\s|$)/.exec(flat);
    if (m) addRow(rows, isoDate(+m[1]!, +m[2]!, +m[3]!), m[4]!, parseYen(m[5]!), i + 1);
  }
  // Vpass PDFs and pasted statements have no reliable issuer/card identifier.
  // Merchants (including Amazon) must NEVER determine the payment card.
  // CSV imports use their own explicit issuer-based identification path.
  return { cardId: null, paymentDate: date, billingMonth: paymentMonth(date), statedTotal: total };
}

function parseGold(text: string, rows: ImportRow[], candidateRows: string[][]) {
  const n = normalize(text);
  const date = matchPaymentDate(n);
  const metadata = n.replace(/\|/g, ' ').replace(/\*\*/g, '');
  const total = findAmountFollowing(metadata, /お支払い合計額\s*([\d,]+)円?/)
    ?? findAmountFollowing(metadata, /お支払金額総合計[^\d]*([\d,]+)/);
  const rowSources = candidateRows.length ? candidateRows : lineList(n).map(splitRow);
  for (let i = 0; i < rowSources.length; i++) {
    const cells = rowSources[i]!.map(squish).filter(Boolean);
    const di = cells.findIndex(v => /^\d{2}\/\d{2}\/\d{2}$/.test(v));
    if (di >= 0 && cells[di + 1] && cells[di + 2]) {
      const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(cells[di]!);
      if (m) addRow(rows, isoDate(+m[1]!, +m[2]!, +m[3]!), cells[di + 1]!, parseYen(cells[di + 2]), i + 1);
      continue;
    }
    const flat = cells.join(' ');
    const m = /^(\d{2})\/(\d{2})\/(\d{2})\s+(.+?)\s+([\d,]+)\s+(?:1|2|\d+|リボ)/.exec(flat);
    if (m) addRow(rows, isoDate(+m[1]!, +m[2]!, +m[3]!), m[4]!, parseYen(m[5]!), i + 1);
  }
  return { cardId: 'goldpoint', paymentDate: date, billingMonth: paymentMonth(date), statedTotal: total };
}

function splitRow(row: string): string[] {
  // Markdown tables, TSV browser clipboard and PDF.js reconstructed lines.
  if (row.includes('|')) return row.split('|').map(x => x.trim()).filter(Boolean);
  if (row.includes('\t')) return row.split('\t').map(x => x.trim()).filter(Boolean);
  return [squish(row)];
}

/** Extracts table cells from pasted HTML without injecting any HTML into the page. */
export function clipboardRowsFromHtml(html: string): string[][] {
  if (!html || typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('table tr')].map(tr => [...tr.children]
    .filter(cell => cell.matches('td,th'))
    .map(cell => squish(cell.textContent ?? ''))).filter(cells => cells.length > 0);
}

export function parseStatementText(raw: string, sourceKind: SourceKind, sourceName: string, html = ''): ParsedStatement {
  const normalized = normalize(raw);
  const htmlRows = clipboardRowsFromHtml(html);
  const rowsCandidate = htmlRows.length ? htmlRows : lineList(normalized).map(splitRow);
  // Include HTML table text in provider / metadata detection when text/plain is minimal.
  const detectionText = normalized + '\n' + htmlRows.map(row => row.join(' ')).join('\n');
  const provider = detectProvider(detectionText);
  const rows: ImportRow[] = [];
  const warnings: string[] = [];
  let data: { cardId: string | null; paymentDate: string | null; statedTotal: number | null; billingMonth: string | null; zeroUsage?:true };
  switch (provider) {
    case 'rakuten': data = parseRakuten(normalized, rows, sourceKind); break;
    case 'jcb': data = parseJcb(normalized, rows); break;
    case 'view': data = parseView(normalized, rows); break;
    case 'smbc': data = parseSmbc(normalized, rows, rowsCandidate); break;
    case 'goldpoint': data = parseGold(normalized, rows, rowsCandidate); break;
    default: data = { cardId: null, paymentDate: null, statedTotal: null, billingMonth: null };
  }
  if (provider === 'unknown') warnings.push('カード会社の明細形式を特定できませんでした。対応形式か確認してください。');
  // Rakuten/みずほ selection is an ordinary required user action, not a parsing warning.
  if (rows.length === 0 && !data.zeroUsage) warnings.push(sourceKind === 'pdf' ? '明細の行を抽出できませんでした。画像化されたPDFの場合はWeb明細のコピーを貼り付けてください。' : '取引行を抽出できませんでした。Web画面の表全体をコピーして貼り付けてください。');
  if (!data.billingMonth) warnings.push('請求月を特定できませんでした。');
  if (data.statedTotal === null) warnings.push('請求総額を特定できませんでした。');
  const sum = rows.reduce((s, row) => s + row.amount, 0);
  if (rows.length && data.statedTotal !== null && sum !== data.statedTotal) warnings.push(`請求金額と明細合計に差額があります（${(data.statedTotal - sum).toLocaleString('ja-JP')}円）。内容を確認してください。`);
  return { provider, cardId: data.cardId, sourceKind, sourceName, billingMonth: data.billingMonth,
    paymentDate: data.paymentDate, statedTotal: data.statedTotal, confirmation: data.zeroUsage ? 'confirmed' : classifyStatus(normalized), ...(data.zeroUsage?{zeroUsage:true as const}:{}), rows, warnings };
}
