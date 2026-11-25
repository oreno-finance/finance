/** Filtering is view-only: indices always refer to the original statement array. */
export interface BillableStatement { billingMonth: string | null; confirmation?:string }

export function availableYears(statements: readonly BillableStatement[]): string[] {
  return [...new Set(statements.flatMap(s => /^\d{4}-\d{2}$/.test(s.billingMonth ?? '') ? [s.billingMonth!.slice(0, 4)] : []))]
    .sort((a, b) => b.localeCompare(a));
}

export function availableMonths(statements: readonly BillableStatement[], year: string): string[] {
  return [...new Set(statements.flatMap(s => {
    const month = s.billingMonth;
    return month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && (year === 'all' || month.slice(0, 4) === year)
      ? [month.slice(5)] : [];
  }))].sort((a, b) => b.localeCompare(a));
}

export function filteredStatementIndices(
  statements: readonly BillableStatement[], year: string, month: string, provisionalOnly=false,
): number[] {
  return statements.map((s, index) => ({ billingMonth: s.billingMonth, confirmation:s.confirmation,index }))
    .filter(({ billingMonth,confirmation }) => {
      if(provisionalOnly&&confirmation!=='provisional')return false;
      if (year === 'all' && month === 'all') return true; // Includes statements without a known billing month.
      if (!billingMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(billingMonth)) return false;
      return (year === 'all' || billingMonth.slice(0, 4) === year)
        && (month === 'all' || billingMonth.slice(5) === month);
    })
    .sort((a, b) => {
      const descending = (b.billingMonth ?? '').localeCompare(a.billingMonth ?? '');
      return descending || a.index - b.index;
    })
    .map(item => item.index);
}

/** Calendar defaults use the viewer's local date, including when that month has no statements. */
export function calendarBillingPeriod(today: Date = new Date()): { year: string; month: string } {
  return { year: String(today.getFullYear()), month: String(today.getMonth() + 1).padStart(2, '0') };
}
