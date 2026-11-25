// Node-only unit tests for the home-backend SQL gateway (web/gateway/) and its
// Worker-side client. No browser, no app server: each test builds throwaway
// SQLite files in a temp dir and talks to an in-process gateway over HTTP.
import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createGatewayServer } from "../gateway/server";
import { gatewayD1 } from "../src/lib/db/gatewayClient";
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

test.describe("gatewayD1 client", () => {
  let f: Fixture;
  test.beforeEach(async () => {
    f = await startGateway();
  });
  test.afterEach(async () => {
    await stopGateway(f);
  });

  test("gatewayD1 first/all/run/batch mirror D1", async () => {
    const db = gatewayD1({ url: f.url, secret: SECRET, db: "search" });
    await db.prepare("INSERT INTO t VALUES (?, ?, ?)").bind(1, "a", 1764000000000).run();
    expect(await db.prepare("SELECT id, v FROM t WHERE id = ?").bind(1).first()).toEqual({ id: 1, v: "a" });
    expect(await db.prepare("SELECT v FROM t").first("v")).toBe("a");
    expect(await db.prepare("SELECT id FROM t WHERE id = 42").first()).toBeNull();
    expect((await db.prepare("SELECT ts FROM t").all()).results).toEqual([{ ts: 1764000000000 }]);

    const results = await db.batch([
      db.prepare("INSERT INTO t VALUES (?, ?, ?)").bind(2, "b", 0),
      db.prepare("SELECT COUNT(*) AS n FROM t"),
    ]);
    expect(results).toHaveLength(2);
    expect(results[1].results).toEqual([{ n: 2 }]);

    await expect(
      db.batch([
        db.prepare("INSERT INTO t VALUES (?, ?, ?)").bind(3, "c", 0),
        db.prepare("INSERT INTO t VALUES (?, ?, ?)").bind(3, "dup", 0),
      ])
    ).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM t WHERE id = 3").first("n")).toBe(0);
  });

  test("gatewayD1 surfaces SQL errors as thrown Error", async () => {
    const db = gatewayD1({ url: f.url, secret: SECRET, db: "search" });
    await expect(db.prepare("SELECT * FROM missing_table").all()).rejects.toThrow(/no such table/);
  });

  test("gatewayD1 targets the analytics db", async () => {
    const db = gatewayD1({ url: f.url, secret: SECRET, db: "analytics" });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM a").first("n"))).toBe(0);
  });
});

test("gatewayD1 sends Access headers when configured", async () => {
  let seen: Record<string, string | string[] | undefined> = {};
  const stub = createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [{ results: [], success: true, meta: {} }] }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const { port } = stub.address() as AddressInfo;
  try {
    const db = gatewayD1({
      url: `http://127.0.0.1:${port}`,
      secret: SECRET,
      db: "search",
      accessClientId: "id-123",
      accessClientSecret: "sec-456",
    });
    await db.prepare("SELECT 1").all();
    expect(seen["cf-access-client-id"]).toBe("id-123");
    expect(seen["cf-access-client-secret"]).toBe("sec-456");
    expect(seen.authorization).toBe(`Bearer ${SECRET}`);
  } finally {
    stub.closeAllConnections();
    await new Promise<void>((r) => stub.close(() => r()));
  }
});

test("gatewayD1 rejects within timeout when the gateway is unreachable", async () => {
  // A server that accepts the request and never answers (tunnel up, home hung).
  const stub = createServer(() => {});
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const { port } = stub.address() as AddressInfo;
  try {
    const db = gatewayD1({ url: `http://127.0.0.1:${port}`, secret: SECRET, db: "search", timeoutMs: 500 });
    const started = Date.now();
    await expect(db.prepare("SELECT 1").all()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    stub.closeAllConnections();
    await new Promise<void>((r) => stub.close(() => r()));
  }
});

test("migrate-sqlite applies only unapplied migrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "uhcs-mig-"));
  const file = join(dir, "search.sqlite");
  try {
    // A DB as wrangler leaves it after 0001..0012: schema applied + recorded.
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE d1_migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
    const applied = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort().slice(0, 12);
    for (const name of applied) {
      db.exec(readFileSync(join("migrations", name), "utf8"));
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
    }
    db.close();

    const run = (...extra: string[]) =>
      execFileSync("yarn", ["db:migrate-sqlite", "--db", "search", "--file", file, ...extra], {
        encoding: "utf8",
      });
    run();

    const after = new DatabaseSync(file, { readOnly: true });
    const names = (after.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as Array<{ name: string }>).map(
      (r) => r.name
    );
    expect(names.at(-1)).toBe("0014_prereq_drop_raw_text.sql");
    expect(names).toHaveLength(14);
    const cols = (after.prepare("PRAGMA table_info(course_prereq)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("ast_json");
    expect(cols).not.toContain("raw_text");
    after.close();

    expect(run("--dryRun")).toContain("0 pending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db:backup writes a consistent copy and prunes old ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "uhcs-bak-"));
  const backups = join(dir, "backups");
  mkdirSync(backups);
  const files = { search: join(dir, "search.sqlite"), analytics: join(dir, "analytics.sqlite") };
  try {
    for (const [name, path] of Object.entries(files)) {
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('${name}-row')`);
      db.close();
    }
    writeFileSync(join(backups, "search-2000-01-01.sqlite"), "old");

    execFileSync("yarn", ["db:backup", "--dir", backups, "--keepDays", "14"], {
      encoding: "utf8",
      env: { ...process.env, SEARCH_D1_LOCAL_FILE: files.search, ANALYTICS_D1_LOCAL_FILE: files.analytics },
    });

    const today = new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
    for (const name of ["search", "analytics"]) {
      const copy = new DatabaseSync(join(backups, `${name}-${today}.sqlite`), { readOnly: true });
      expect(copy.prepare("SELECT v FROM t").get()).toEqual({ v: `${name}-row` });
      copy.close();
    }
    expect(existsSync(join(backups, "search-2000-01-01.sqlite"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
