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
/**
 * Collapse a high-cardinality facet to its biggest `n` values by total
 * enrollment, folding everything else into a single "Other" series per term.
 * Keeps stacked charts (e.g. the 52-college university trend) readable. Points
 * already within `n` distinct values are returned unchanged.
 */
export function topNByTotal(
  points: FacetTrendPoint[],
  n: number,
  rankBy: FacetTrendPoint[] = points
): FacetTrendPoint[] {
  const present = new Set(points.map((p) => p.facetValue));
  if (present.size <= n) return points;
  // Rank on `rankBy` (the full, unfiltered series) so which values make the
  // top N — and hence the bands and colors — don't shift with the term range.
  const top = new Set(rankKeys(present, rankBy).slice(0, n));
  const out: FacetTrendPoint[] = [];
  const other = new Map<string, { enrollment: number; sections: number }>();
  for (const p of points) {
    if (top.has(p.facetValue)) {
      out.push(p);
    } else {
      const o = other.get(p.term) ?? { enrollment: 0, sections: 0 };
      o.enrollment += p.enrollment;
      o.sections += p.sections;
      other.set(p.term, o);
    }
  }
  for (const [term, o] of other) {
    out.push({ term, facetValue: "Other", enrollment: o.enrollment, sections: o.sections });
  }
  return out;
}

/**
 * Order facet values by total enrollment in `rankBy`, largest first (ties by
 * name); the "Other" catch-all always last. Values missing from `rankBy` rank
 * as 0.
 */
function rankKeys(keys: Iterable<string>, rankBy: FacetTrendPoint[]): string[] {
  const totals = new Map<string, number>();
  for (const p of rankBy) {
    totals.set(p.facetValue, (totals.get(p.facetValue) ?? 0) + p.enrollment);
  }
  return [...keys].sort((a, b) => {
    if (a === "Other" || b === "Other") return a === "Other" ? 1 : -1;
    return (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b);
  });
}

/**
 * `keys` come out largest-first by total in `rankBy` (default: `points`), and
 * Recharts stacks the first series at the bottom — so the biggest band sits on
 * the flat baseline where its trend is easiest to read, smaller ones above, and
 * "Other" on top. Pass the full, unfiltered series as `rankBy` to keep the
 * order (and the index-assigned colors) stable as the term range changes.
 */
export function pivotByTerm(
  points: FacetTrendPoint[],
  rankBy: FacetTrendPoint[] = points
): {
  rows: Array<Record<string, number | string>>;
  keys: string[];
} {
  const keys = rankKeys(new Set(points.map((p) => p.facetValue)), rankBy);
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

/**
 * Normalise each term's row to a 100%-stacked share of `keys`. Rounds to 2
 * decimals so floating-point division never leaves a 0-share series reading as
 * dust like "0.00000000000003%" — it becomes a clean 0.
 */
export function toPercent(
  rows: Array<Record<string, number | string>>,
  keys: string[]
): Array<Record<string, number | string>> {
  return rows.map((row) => {
    const total = keys.reduce((s, k) => s + (Number(row[k]) || 0), 0) || 1;
    const out: Record<string, number | string> = { term: row.term };
    for (const k of keys) {
      out[k] = Math.round(((Number(row[k]) || 0) / total) * 100 * 100) / 100;
    }
    return out;
  });
}
