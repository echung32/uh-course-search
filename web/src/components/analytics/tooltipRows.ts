/**
 * Row shaping for ChartTooltip, kept pure so it's unit-testable. Stacked charts
 * opt into largest-first ordering and zero-row hiding (a 15-campus tooltip is
 * mostly noise otherwise); line charts keep their series order.
 */
export interface TooltipPayloadItem {
  name?: string | number;
  value?: number | string;
  color?: string;
}

export interface TooltipRowOptions {
  /** Order rows by value, largest first (default: series order). */
  sortByValue?: boolean;
  /** Drop rows whose value is 0. */
  hideZero?: boolean;
}

export function tooltipRows(
  payload: TooltipPayloadItem[],
  { sortByValue = false, hideZero = false }: TooltipRowOptions = {}
): TooltipPayloadItem[] {
  let rows = hideZero ? payload.filter((p) => Number(p.value) !== 0) : [...payload];
  if (sortByValue) rows = rows.sort((a, b) => Number(b.value) - Number(a.value));
  return rows;
}

/** Sum of the payload values (the stacked total). */
export function tooltipTotal(payload: TooltipPayloadItem[]): number {
  return payload.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
}
