/**
 * Worker-side D1 access: the native `env.DB` binding.
 *
 * This is the read path's only D1 entry point. `import { env }` from
 * `cloudflare:workers` gives global access to bindings (works in `astro dev` via
 * platformProxy, in `wrangler dev`, and on the deployed Worker). The binding stub
 * is safe to read at module top-level — no I/O happens until a statement runs
 * inside a request.
 *
 * Node ingestion uses a different entry point (`client.ts`'s `getDb`) so that the
 * `node:sqlite` backend never reaches the Worker bundle.
 */
import { env } from "cloudflare:workers";
import type { D1Like } from "./types";
import type { RateLimiter } from "@/lib/mcp/gate";

export function getDb(): D1Like {
  const db = (env as { DB?: unknown }).DB;
  if (!db) throw new Error("D1 binding `DB` is not available on env");
  // The native D1Database implements prepare/bind/first/all/run/batch.
  return db as D1Like;
}

/** The analytics rollup database (uh-analytics-db). Read path only. */
export function getAnalyticsDb(): D1Like {
  const db = (env as { ANALYTICS_DB?: unknown }).ANALYTICS_DB;
  if (!db) throw new Error("D1 binding `ANALYTICS_DB` is not available on env");
  return db as D1Like;
}

/**
 * The MCP rate-limit binding (Cloudflare native `ratelimit`). Returns null when
 * the binding isn't present (e.g. a local runtime without ratelimit support) —
 * checkRateLimit() then fails open. Read path / MCP only.
 */
export function getRateLimiter(): RateLimiter | null {
  const rl = (env as { MCP_RATE_LIMITER?: unknown }).MCP_RATE_LIMITER;
  return rl ? (rl as RateLimiter) : null;
}
