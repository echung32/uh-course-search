/**
 * POST /api/admin/backfill  (x-admin-secret required)
 *
 * Gap-driven capture (docs/superpowers/specs/2026-11-25-crseavail-hybrid-ingest-
 * design.md §6.1): fills the missing details of synced terms, active first,
 * time-boxed. The CLI `yarn ingest backfill` is the real driver; this route
 * exists so the e2e suite (and ad-hoc ops) can exercise the same path. Disabled
 * in production (INGEST_ON_WORKER unset → 501), like the other admin ingestion
 * routes.
 *
 * Query params:
 *   - dryRun=1        report gap counts per term only; no network call.
 *   - term=<code>     capture this term only instead of auto-selecting.
 *   - delayMs=<n>     per-fetch throttle (default 250).
 *   - maxMinutes=<n>  time budget (default 180; never past 21:45 HST).
 *
 * Response: { ok, term, done, remaining, terms? (dryRun), capture?, captures? }.
 *
 * Callers must send Content-Type: application/json (Astro CSRF; see sync.ts).
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/binding";
import { backfillNextTerm } from "@/lib/ingest/backfill";
import { checkAdmin, ingestDisabledOnWorker, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const off = ingestDisabledOnWorker();
  if (off) return off;
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const term = url.searchParams.get("term") ?? undefined;
  const delayMs = Number(url.searchParams.get("delayMs") ?? "250");
  const maxRaw = url.searchParams.get("maxMinutes");
  const maxMinutes = maxRaw === null ? undefined : Number(maxRaw);
  if (maxMinutes !== undefined && !(Number.isFinite(maxMinutes) && maxMinutes > 0)) {
    return json({ ok: false, error: "maxMinutes must be a positive number" }, 400);
  }

  try {
    const result = await backfillNextTerm(getDb(), { dryRun, term, delayMs, maxMinutes });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("Backfill failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
