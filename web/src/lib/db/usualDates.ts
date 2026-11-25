/**
 * The per-term "usual" meeting date range (see migrations/0015). The results
 * table hides a meeting's dates when they match it, so Fall/Spring rows stay
 * clean while summer sessions and off-range meetings show theirs.
 */
import type { D1Like } from "./types";
import type { DateRange } from "@/lib/sis/types";

/** The top date range must cover at least this share of a term's meetings. */
export const USUAL_RANGE_MIN_SHARE = 0.6;

export interface DateRangeCount {
  begin_date: string | null;
  end_date: string | null;
  n: number;
}

/** The most common range if it covers >= 60% of all meetings (nulls count toward the total). */
export function pickUsualDateRange(rows: DateRangeCount[]): DateRange | null {
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  if (total === 0) return null;
  const top = rows.reduce((best, r) => (r.n > best.n ? r : best));
  if (!top.begin_date || !top.end_date) return null;
  if (top.n / total < USUAL_RANGE_MIN_SHARE) return null;
  return { start: top.begin_date, end: top.end_date };
}

/** Recomputes and stores `term.usual_start_date/usual_end_date` (both NULL when none). */
export async function refreshTermUsualDates(db: D1Like, term: string): Promise<DateRange | null> {
  const { results } = await db
    .prepare(
      "SELECT begin_date, end_date, COUNT(*) AS n FROM section_meeting WHERE term = ? GROUP BY begin_date, end_date"
    )
    .bind(term)
    .all<DateRangeCount>();
  const range = pickUsualDateRange(results);
  await db
    .prepare("UPDATE term SET usual_start_date = ?, usual_end_date = ? WHERE code = ?")
    .bind(range?.start ?? null, range?.end ?? null, term)
    .run();
  return range;
}

/**
 * Recomputes every backfilled term. Dynamic (never-backfilled) terms are
 * skipped: their section_meeting rows are only the page-cache pages users
 * happened to view, so one cached summer session would wrongly pass 60% — and
 * nothing would ever correct it until the term is backfilled (which then runs
 * markTermSynced → refreshTermUsualDates with the full section set).
 */
export async function refreshAllUsualDates(
  db: D1Like
): Promise<{ term: string; range: DateRange | null }[]> {
  const { results } = await db
    .prepare("SELECT code FROM term WHERE last_synced_at IS NOT NULL ORDER BY code")
    .all<{ code: string }>();
  const out: { term: string; range: DateRange | null }[] = [];
  for (const { code } of results) out.push({ term: code, range: await refreshTermUsualDates(db, code) });
  return out;
}
