/**
 * The term sync-meta read the cached read routes (`/api/search`, `/api/filters`,
 * `/api/coverage`) do BEFORE their own try/catch — it versions the edge-cache key.
 * With the DB on the home server, "unreachable" is a routine state (ISP, power,
 * tunnel), so a failed read must become the routes' usual JSON error instead of
 * escaping as Astro's bare HTML 500.
 */
import { fetchTermSyncMeta } from "@/lib/search";
import type { TermSyncMeta } from "@/lib/db/queries";

export type TermMetaResult =
  | { ok: true; meta: TermSyncMeta | null }
  | { ok: false; response: Response };

export async function readTermMeta(term: string): Promise<TermMetaResult> {
  try {
    return { ok: true, meta: await fetchTermSyncMeta(term) };
  } catch (err) {
    console.error("Term sync-meta read failed (database unavailable?):", err);
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
}
