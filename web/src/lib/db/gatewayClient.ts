/**
 * Worker-side `D1Like` backed by the home SQL gateway (web/gateway/server.ts),
 * reached over Cloudflare Tunnel + Access. Same shape as `client.ts`'s
 * `remoteD1` (which targets the D1 REST API), but:
 *   - `batch()` is one request and atomic (the gateway runs it in a transaction);
 *   - every call has a hard timeout so a down/hung home server fails the
 *     request fast instead of hanging it;
 *   - no retries: a timed-out write may still have committed.
 *
 * Ships in the Worker bundle — must not import any `node:*` module.
 */
import type { D1Like, D1PreparedStatement, D1Result } from "./types";

export interface GatewayConfig {
  url: string;
  secret: string;
  db: "search" | "analytics";
  accessClientId?: string;
  accessClientSecret?: string;
  timeoutMs?: number;
}

interface RawStatement {
  sql: string;
  params: unknown[];
}

interface BoundStatement extends D1PreparedStatement {
  readonly raw: RawStatement;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function post(cfg: GatewayConfig, statements: RawStatement[], batch: boolean): Promise<D1Result[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.secret}`,
  };
  if (cfg.accessClientId && cfg.accessClientSecret) {
    headers["CF-Access-Client-Id"] = cfg.accessClientId;
    headers["CF-Access-Client-Secret"] = cfg.accessClientSecret;
  }
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/v1/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ db: cfg.db, statements, batch }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: { results?: D1Result[]; error?: string } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON (e.g. an Access login page or a tunnel error) — reported below.
  }
  if (!res.ok || !json?.results) {
    const detail = json?.error ?? text.slice(0, 200);
    throw new Error(`DB gateway ${res.status}: ${detail}`);
  }
  return json.results;
}

function statement(cfg: GatewayConfig, sql: string, params: unknown[]): BoundStatement {
  const raw = { sql, params };
  const one = async () => (await post(cfg, [raw], false))[0];
  return {
    raw,
    bind(...values: unknown[]) {
      return statement(cfg, sql, values);
    },
    async first<T>(colName?: string): Promise<T | null> {
      const row = (await one()).results[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return (colName ? (row[colName] as T) : (row as T)) ?? null;
    },
    async all<T>(): Promise<D1Result<T>> {
      return (await one()) as D1Result<T>;
    },
    async run(): Promise<D1Result> {
      return one();
    },
  };
}

export function gatewayD1(cfg: GatewayConfig): D1Like {
  return {
    prepare(query: string) {
      return statement(cfg, query, []);
    },
    async batch(statements: D1PreparedStatement[]) {
      if (statements.length === 0) return [];
      return post(cfg, statements.map((s) => (s as BoundStatement).raw), true);
    },
  };
}
