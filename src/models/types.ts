export type Provider = 'rakuten' | 'jcb' | 'view' | 'smbc' | 'goldpoint' | 'unknown';
export type SourceKind = 'pdf' | 'paste' | 'csv';
export type ConfirmationState = 'confirmed' | 'provisional' | 'unknown';

export interface CardDefinition {
  id: string;
  name: string;
  provider: Exclude<Provider, 'unknown'>;
}

export const CARDS: readonly CardDefinition[] = [
  { id: 'rakuten-mizuho', name: 'みずほ楽天カード', provider: 'rakuten' },
  { id: 'rakuten-etc', name: '楽天カード', provider: 'rakuten' },
  { id: 'recruit-jcb', name: 'リクルートカード（JCB）', provider: 'jcb' },
  { id: 'bic-suica', name: 'ビックカメラSuicaカード', provider: 'view' },
  { id: 'smbc-nl', name: '三井住友カード NL', provider: 'smbc' },
  { id: 'amazon', name: 'Amazonカード', provider: 'smbc' },
  { id: 'goldpoint', name: 'GOLD POINT CARD+', provider: 'goldpoint' },
] as const;

export interface ImportRow {
  id: string;
  usedOn: string;  // YYYY-MM-DD
  merchant: string; // Card issuer's original name; never modified by display rules.
  merchantOverride?: string; // Optional display name for this row only.
  amount: number;  // Charged amount for this billing month, signed JPY.
  description?: string;
  sourceLine?: number;
}

export interface ParsedStatement {
  provider: Provider;
  cardId: string | null;
  sourceKind: SourceKind;
  sourceName: string;
  billingMonth: string | null; // YYYY-MM
  paymentDate: string | null;  // YYYY-MM-DD
  statedTotal: number | null;
  confirmation: ConfirmationState;
  /** Explicit issuer evidence of no charges; no debit date or dummy rows. */
  zeroUsage?: true;
  rows: ImportRow[];
  warnings: string[];
}

export function getCard(id: string | null): CardDefinition | undefined {
  return CARDS.find(card => card.id === id);
}

export function calculatedTotal(statement: ParsedStatement): number {
  return statement.rows.reduce((sum, row) => sum + row.amount, 0);
}

/** Only the strict issuer-verified empty PDF shape represents a zero-usage statement. */
export function isZeroUsage(s:ParsedStatement):boolean {
  return s.zeroUsage===true&&Array.isArray(s.rows)&&s.provider==='rakuten'&&s.sourceKind==='pdf'&&s.confirmation==='confirmed'&&
    s.statedTotal===0&&s.paymentDate===null&&!!s.billingMonth&&/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(s.billingMonth)&&s.rows.length===0;
}
/** Payment month for real debits; explicit empty statements use their billed month. */
export function statementPeriod(s:ParsedStatement):string|null {
  if(isZeroUsage(s))return s.billingMonth;
  if(!s.paymentDate||!/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(s.paymentDate))return null;
  const d=new Date(`${s.paymentDate}T00:00:00Z`);
  return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s.paymentDate?s.paymentDate.slice(0,7):null;
}
