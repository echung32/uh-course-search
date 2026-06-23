/** Section-detail orchestration shared by GET /api/section and get_section. */
import { getDb } from "@/lib/db/binding";
import { fetchSectionDetail } from "@/lib/search";
import { ensureSectionDetail } from "@/lib/ingest/sectionLazy";
import { logDb } from "@/lib/log";
import type { SectionDetail } from "@/lib/db/queries";

export async function runSectionDetail(
  term: string,
  crn: string
): Promise<SectionDetail | null> {
  const stored = await fetchSectionDetail(term, crn);
  if (stored) {
    logDb(`section detail ${term}:${crn} (cached)`);
    return stored;
  }
  // Cold section: fetch live + store once (lazy cache-on-miss).
  return ensureSectionDetail(getDb(), term, crn);
}
