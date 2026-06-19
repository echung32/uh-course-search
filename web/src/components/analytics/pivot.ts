/**
 * Pure transform for the stacked facet charts (university trend, delivery mode).
 * Kept React/recharts-free so it can be unit-tested directly.
 */

export interface FacetTrendPoint {
  term: string;
  facetValue: string;
  enrollment: number;
  sections: number;
}

/**
 * Pivots [{term, facetValue, enrollment}] into stacked rows keyed by term.
 *
 * Every row carries every key: a facet value absent from a given term is filled
 * with 0, not left undefined. Recharts stacked `<Area>`s break their path at any
 * x-position where a series is undefined, so an un-filled gap makes the whole
 * stack render empty for terms that don't list all facet values (e.g. extension
 * sub-terms with only one campus). Filling 0 keeps the stack continuous.
 */
export function pivotByTerm(points: FacetTrendPoint[]): {
  rows: Array<Record<string, number | string>>;
  keys: string[];
} {
  const keys = [...new Set(points.map((p) => p.facetValue))].sort();
  const byTerm = new Map<string, Record<string, number | string>>();
  for (const p of points) {
    const row = byTerm.get(p.term) ?? { term: p.term };
    row[p.facetValue] = (Number(row[p.facetValue]) || 0) + p.enrollment;
    byTerm.set(p.term, row);
  }
  for (const row of byTerm.values()) {
    for (const k of keys) if (!(k in row)) row[k] = 0;
  }
  const rows = [...byTerm.values()].sort((a, b) =>
    String(a.term).localeCompare(String(b.term))
  );
  return { rows, keys };
}
