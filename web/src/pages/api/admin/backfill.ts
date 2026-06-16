/**
 * POST /api/admin/backfill  (x-admin-secret required)
 *
 * Backfills the course-details layer for the newest historical (view-only) term
 * that still lacks it — one term per call (docs/superpowers/specs/
 * 2026-06-16-historical-details-backfill-design.md). The CLI `yarn ingest
 * backfill` is the real driver; this route exists so the e2e suite (and ad-hoc
 * ops) can exercise the same path. Disabled in production (INGEST_ON_WORKER
 * unset → 501), like the other admin ingestion routes.
 *
 * Query params:
 *   - dryRun=1     select + report only; no Banner call.
 *   - term=<code>  force a specific term instead of auto-selecting.
 *   - delayMs=<n>  per-fetch throttle (default 250).
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

  try {
    const result = await backfillNextTerm(getDb(), { dryRun, term, delayMs });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("Backfill failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
