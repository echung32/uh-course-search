// Node-only unit tests for the home-backend SQL gateway (web/gateway/) and its
// Worker-side client. No browser, no app server: each test builds throwaway
// SQLite files in a temp dir and talks to an in-process gateway over HTTP.
import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createGatewayServer } from "../gateway/server";
import { openSqliteFile } from "../src/lib/db/client";

const SECRET = "s3cret";

interface Fixture {
  dir: string;
  files: { search: string; analytics: string };
  url: string;
  server: Server;
}

async function startGateway(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "uhcs-gw-"));
  const files = { search: join(dir, "search.sqlite"), analytics: join(dir, "analytics.sqlite") };
  const s = new DatabaseSync(files.search);
  s.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, ts INTEGER)");
  s.close();
  const a = new DatabaseSync(files.analytics);
  a.exec("CREATE TABLE a (x INTEGER)");
  a.close();
  const server = createGatewayServer({ secret: SECRET, files });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { dir, files, url: `http://127.0.0.1:${port}`, server };
}

async function stopGateway(f: Fixture): Promise<void> {
  await new Promise<void>((resolve) => f.server.close(() => resolve()));
  rmSync(f.dir, { recursive: true, force: true });
}

async function query(
  f: Fixture,
  body: unknown,
  auth: string | null = `Bearer ${SECRET}`
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== null) headers.Authorization = auth;
  const res = await fetch(`${f.url}/v1/query`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function one(sql: string, params: unknown[] = [], db = "search") {
  return { db, statements: [{ sql, params }], batch: false };
}

test.describe("gateway server", () => {
  let f: Fixture;
  test.beforeEach(async () => {
    f = await startGateway();
  });
  test.afterEach(async () => {
    await stopGateway(f);
  });

  test("executes a single select and returns rows", async () => {
    expect((await query(f, one("INSERT INTO t VALUES (?, ?, ?)", [1, "a", 1764000000000]))).status).toBe(200);
    const { status, json } = await query(f, one("SELECT id, v, ts FROM t"));
    expect(status).toBe(200);
    expect(json.results[0].results).toEqual([{ id: 1, v: "a", ts: 1764000000000 }]);
  });

  test("routes db=analytics to the analytics file", async () => {
    expect((await query(f, one("SELECT x FROM a", [], "analytics"))).status).toBe(200);
    expect((await query(f, one("SELECT x FROM a", [], "search"))).status).toBe(400);
  });

  test("rejects bad auth without executing", async () => {
    const insert = one("INSERT INTO t VALUES (?, ?, ?)", [9, "x", 0]);
    expect((await query(f, insert, "Bearer wrong")).status).toBe(401);
    expect((await query(f, insert, null)).status).toBe(401);
    const { json } = await query(f, one("SELECT COUNT(*) AS n FROM t"));
    expect(json.results[0].results[0].n).toBe(0);
  });

  test("batch rolls back entirely on a failing statement", async () => {
    const { status, json } = await query(f, {
      db: "search",
      batch: true,
      statements: [
        { sql: "INSERT INTO t VALUES (?, ?, ?)", params: [2, "b", 0] },
        { sql: "INSERT INTO t VALUES (?, ?, ?)", params: [2, "dup", 0] },
      ],
    });
    expect(status).toBe(400);
    expect(json.error).toContain("UNIQUE");
    const after = await query(f, one("SELECT COUNT(*) AS n FROM t WHERE id = 2"));
    expect(after.json.results[0].results[0].n).toBe(0);
  });

  test("reads succeed while another connection holds a write transaction", async () => {
    await query(f, one("INSERT INTO t VALUES (?, ?, ?)", [1, "a", 0]));
    const writer = openSqliteFile(f.files.search);
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO t VALUES (?, ?, ?)").run(3, "pending", 0);
      const { status, json } = await query(f, one("SELECT id FROM t ORDER BY id"));
      expect(status).toBe(200);
      expect(json.results[0].results).toEqual([{ id: 1 }]);
      writer.exec("COMMIT");
    } finally {
      writer.close();
    }
  });

  test("healthz needs no auth", async () => {
    const res = await fetch(`${f.url}/healthz`);
    expect(res.status).toBe(200);
  });

  test("rejects malformed bodies", async () => {
    expect((await query(f, "{not json")).status).toBe(400);
    expect((await query(f, { db: "nope", statements: [], batch: false })).status).toBe(400);
    expect((await query(f, { db: "search", statements: "SELECT 1", batch: false })).status).toBe(400);
  });
});
