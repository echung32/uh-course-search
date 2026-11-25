/**
 * Home-backend SQL gateway: executes D1-style statements against local SQLite
 * files on behalf of the Cloudflare Worker (see
 * docs/superpowers/specs/2026-11-24-home-backend-design.md).
 *
 *   POST /v1/query  { db: "search" | "analytics",
 *                     statements: [{ sql, params }], batch: boolean }
 *               →   { results: D1Result[] }        (errors: { error })
 *   GET  /healthz   → 200 "ok" (no auth, no SQL)
 *
 * `batch: true` runs every statement in one transaction (D1-native atomicity);
 * `batch: false` runs each statement on its own. Auth is a bearer secret; the
 * gateway is additionally only reachable through Cloudflare Tunnel + Access.
 *
 * Node-only (node:sqlite / node:http) — never imported by the Worker bundle.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { constants as sqlite } from "node:sqlite";
import { localSqliteD1, openSqliteFile } from "../src/lib/db/client";
import type { D1Like, D1Result } from "../src/lib/db/types";

export type GatewayDbName = "search" | "analytics";

export interface GatewayOptions {
  secret: string;
  /** Paths, or resolvers called lazily on the first query to that db. */
  files: Record<GatewayDbName, string | (() => string)>;
  log?: (line: string) => void;
}

interface Statement {
  sql: string;
  params: unknown[];
}

const MAX_BODY_BYTES = 50 * 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function authorized(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequest(raw: string): { db: GatewayDbName; statements: Statement[]; batch: boolean } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
  const b = body as { db?: unknown; statements?: unknown; batch?: unknown };
  if (b.db !== "search" && b.db !== "analytics") {
    throw new HttpError(400, "db must be 'search' or 'analytics'");
  }
  if (!Array.isArray(b.statements)) throw new HttpError(400, "statements must be an array");
  const statements = b.statements.map((s: unknown, i: number) => {
    const st = s as { sql?: unknown; params?: unknown };
    if (typeof st?.sql !== "string") throw new HttpError(400, `statements[${i}].sql must be a string`);
    if (st.params !== undefined && !Array.isArray(st.params)) {
      throw new HttpError(400, `statements[${i}].params must be an array`);
    }
    return { sql: st.sql, params: (st.params as unknown[] | undefined) ?? [] };
  });
  return { db: b.db, statements, batch: b.batch === true };
}

/** node:sqlite raises ERR_SQLITE_ERROR for SQL-level failures (syntax, constraints, missing tables). */
function isSqlError(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "ERR_SQLITE_ERROR";
}

export function createGatewayServer(opts: GatewayOptions): Server {
  const log = opts.log ?? (() => {});
  const dbs = new Map<GatewayDbName, D1Like>();
  const getDb = (name: GatewayDbName): D1Like => {
    let db = dbs.get(name);
    if (!db) {
      const f = opts.files[name];
      const conn = openSqliteFile(typeof f === "function" ? f() : f);
      // Callers get SQL, not the filesystem: refuse ATTACH/DETACH (which is also
      // how VACUUM INTO writes its target), so a leaked credential can't read or
      // write files beyond this connection's own database.
      conn.setAuthorizer((action) =>
        action === sqlite.SQLITE_ATTACH || action === sqlite.SQLITE_DETACH
          ? sqlite.SQLITE_DENY
          : sqlite.SQLITE_OK
      );
      db = localSqliteD1(conn);
      dbs.set(name, db);
    }
    return db;
  };

  async function execute(db: D1Like, statements: Statement[], batch: boolean): Promise<D1Result[]> {
    const prepared = statements.map((s) => db.prepare(s.sql).bind(...s.params));
    if (batch) return db.batch(prepared);
    const out: D1Result[] = [];
    for (const p of prepared) out.push(await p.all());
    return out;
  }

  return createServer(async (req, res) => {
    const started = Date.now();
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/query") throw new HttpError(404, "not found");
      if (!authorized(req.headers.authorization, opts.secret)) throw new HttpError(401, "unauthorized");

      const { db, statements, batch } = parseRequest(await readBody(req));
      const results = await execute(getDb(db), statements, batch);
      send(res, 200, { results });
      log(`[gateway] ${db} ${batch ? "batch" : "single"} n=${statements.length} ${Date.now() - started}ms`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : isSqlError(err) ? 400 : 500;
      const message = err instanceof Error ? err.message : String(err);
      send(res, status, { error: message });
      log(`[gateway] error ${status} ${Date.now() - started}ms: ${message}`);
    }
  });
}
