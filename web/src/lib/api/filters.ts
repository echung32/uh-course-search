/** Filter-menu orchestration shared by GET /api/filters and list_filters. */
import { getDb } from "@/lib/db/binding";
import { fetchFilterOptions } from "@/lib/search";
import { ensureTermSubjects } from "@/lib/ingest/dynamicSync";
import type { FilterKind } from "@/lib/db/queries";
import type { AutocompleteItem } from "@/lib/sis/types";

export async function runFilterOptions(
  term: string,
  kind: FilterKind,
  campusDescription?: string
): Promise<AutocompleteItem[]> {
  // Lazily enumerate a dynamic term's subjects so its menu isn't empty (a no-op
  // for backfilled terms / when DYNAMIC_SYNC=0).
  if (kind === "subject") await ensureTermSubjects(getDb(), term);
  return fetchFilterOptions(term, kind, campusDescription);
}
