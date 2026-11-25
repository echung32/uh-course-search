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

async function startGateway(log?: (line: string) => void): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "uhcs-gw-"));
  const files = { search: join(dir, "search.sqlite"), analytics: join(dir, "analytics.sqlite") };
  const s = new DatabaseSync(files.search);
  s.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, ts INTEGER)");
  s.close();
  const a = new DatabaseSync(files.analytics);
  a.exec("CREATE TABLE a (x INTEGER)");
  a.close();
  const server = createGatewayServer({ secret: SECRET, files, log });
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

// ── Free-plan subrequest budget ─────────────────────────────────────────────
// Every gateway call is a Worker fetch (~50/invocation on Free, shared with the
// live Banner calls), so Worker-path DB helpers must cost O(1) — or O(depth) for
// the prereq BFS — requests, not one per chunk/node. These run the real helpers
// against a fully migrated DB through a counting gateway.

async function startMigratedGateway(): Promise<Fixture & { calls: () => number; lines: string[] }> {
  const lines: string[] = [];
  const f = Object.assign(await startGateway((l) => lines.push(l)), { lines });
  const db = openSqliteFile(f.files.search);
  for (const name of readdirSync("migrations").filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join("migrations", name), "utf8"));
  }
  db.close();
  let n = 0;
  f.server.on("request", (req) => {
    if (req.url === "/v1/query") n++;
  });
  return Object.assign(f, { calls: () => n });
}

function realisticSection(i: number) {
  const crn = String(50000 + i);
  const meeting = (begin: string, building: string) => ({
    category: "01",
    courseReferenceNumber: crn,
    faculty: [],
    meetingTime: {
      beginTime: begin, endTime: "1315", startDate: "08/24/2026", endDate: "12/18/2026",
      building, buildingDescription: `${building} Hall`, room: "204", campus: "MAN",
      meetingType: "CLAS", meetingTypeDescription: "Class",
      monday: true, tuesday: false, wednesday: true, thursday: false, friday: false, saturday: false, sunday: false,
    },
    term: "202740",
  });
  return {
    id: i, term: "202740", termDesc: "Summer 2027", courseReferenceNumber: crn, partOfTerm: "1",
    courseNumber: String(100 + i), subject: "BIOL", subjectDescription: "Biology", sequenceNumber: "001",
    campusDescription: "University of Hawaii at Manoa", scheduleTypeDescription: "Lecture",
    courseTitle: `Course ${i}`, creditHours: 3, creditHourLow: 3, creditHourHigh: null,
    maximumEnrollment: 40, enrollment: 30, seatsAvailable: 10, waitCapacity: 0, waitCount: 0, waitAvailable: 0,
    openSection: true, linkIdentifier: null, isSectionLinked: false, subjectCourse: `BIOL${100 + i}`,
    faculty: [
      { bannerId: `${i}a`, category: null, courseReferenceNumber: crn, displayName: "A Prof", emailAddress: "a@x.edu", primaryIndicator: true, term: "202740" },
      { bannerId: `${i}b`, category: null, courseReferenceNumber: crn, displayName: "B Prof", emailAddress: "b@x.edu", primaryIndicator: false, term: "202740" },
    ],
    meetingsFaculty: [meeting("1200", "AGSCI"), meeting("1400", "BIOMED")],
    reservedSeatSummary: null,
    sectionAttributes: [
      { code: "WI", description: "Writing Intensive", courseReferenceNumber: crn, termCode: "202740" },
      { code: "DS", description: "Diversification", courseReferenceNumber: crn, termCode: "202740" },
    ],
  };
}

test.describe("gateway request budget", () => {
  let f: Fixture & { calls: () => number; lines: string[] };
  test.beforeEach(async () => {
    f = await startMigratedGateway();
  });
  test.afterEach(async () => {
    await stopGateway(f);
  });

  test("upsertSections writes a 50-section page-cache window in one gateway request", async () => {
    const { upsertSections } = await import("../src/lib/db/upsert");
    const db = gatewayD1({ url: f.url, secret: SECRET, db: "search" });
    const sections = Array.from({ length: 50 }, (_, i) => realisticSection(i)) as never[];
    const before = f.calls();
    expect(await upsertSections(db, sections, 1764000000000)).toBe(50);
    expect(f.calls() - before).toBe(1);

    const check = openSqliteFile(f.files.search);
    const count = (t: string) => (check.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE term = '202740'`).get() as { n: number }).n;
    expect([count("course_section"), count("section_faculty"), count("section_meeting"), count("section_attribute")]).toEqual([50, 100, 100, 100]);
    check.close();

    // Re-upserting the same window refreshes children in place (no duplicates).
    await upsertSections(db, sections, 1764000000001);
    const again = openSqliteFile(f.files.search);
    expect((again.prepare("SELECT COUNT(*) AS n FROM section_meeting").get() as { n: number }).n).toBe(100);
    again.close();
  });

  test("insertSectionsAndChildren and deleteSectionsAndChildren each take one gateway request", async () => {
    const { insertSectionsAndChildren, deleteSectionsAndChildren } = await import("../src/lib/db/upsert");
    const db = gatewayD1({ url: f.url, secret: SECRET, db: "search" });
    const sections = Array.from({ length: 50 }, (_, i) => realisticSection(i)) as never[];
    let before = f.calls();
    expect(await insertSectionsAndChildren(db, sections, 1)).toBe(50);
    expect(f.calls() - before).toBe(1);
    before = f.calls();
    await deleteSectionsAndChildren(db, "202740", sections.map((s: { courseReferenceNumber: string }) => s.courseReferenceNumber));
    expect(f.calls() - before).toBe(1);
    const check = openSqliteFile(f.files.search);
    expect((check.prepare("SELECT COUNT(*) AS n FROM section_faculty").get() as { n: number }).n).toBe(0);
    check.close();
  });

  test("getPrereqSubgraph needs O(depth) gateway requests on a branching graph", async () => {
    const { getPrereqSubgraph } = await import("../src/lib/db/prereqQueries");
    // ROOT100 needs 5 courses, each needing 3 more (5 + 15 = 20 prereq nodes);
    // ROOT100 also unlocks 4 courses. Every node is offered (has a section).
    const seed = openSqliteFile(f.files.search);
    const campus = "University of Hawaii at Manoa";
    const edge = seed.prepare(
      "INSERT INTO prereq_edge (term, campus, prereq_course_id, course_id, group_index, alt_index, prereq_offered) VALUES ('202740', ?, ?, ?, 0, ?, 1)"
    );
    const section = seed.prepare(
      "INSERT INTO course_section (term, crn, subject, course_number, subject_course, course_title, campus_description, raw_json, synced_at) VALUES ('202740', ?, 'X', ?, ?, ?, ?, '{}', 0)"
    );
    const ids = new Set<string>(["X100"]);
    for (let a = 0; a < 5; a++) {
      const mid = `X2${a}0`;
      ids.add(mid);
      edge.run(campus, mid, "X100", a);
      for (let b = 0; b < 3; b++) {
        const leaf = `X3${a}${b}`;
        ids.add(leaf);
        edge.run(campus, leaf, mid, b);
      }
    }
    for (let u = 0; u < 4; u++) {
      ids.add(`X4${u}0`);
      edge.run(campus, "X100", `X4${u}0`, 0);
    }
    let crn = 1;
    for (const id of ids) section.run(String(crn++), id.slice(1), id, `Title ${id}`, campus);
    seed.close();

    const db = gatewayD1({ url: f.url, secret: SECRET, db: "search" });
    const before = f.calls();
    const g = await getPrereqSubgraph(db, { term: "202740", campus, course: "X100", direction: "both", depth: 3 });
    const calls = f.calls() - before;

    expect(g.nodes).toHaveLength(ids.size); // 1 + 5 + 15 + 4 = 25
    expect(g.edges).toHaveLength(5 + 15 + 4);
    expect(g.nodes.every((n) => n.offered && n.title === `Title ${n.id}`)).toBe(true);
    // ≤ one request per (direction, level) + one node hydration + one AST lookup.
    expect(calls).toBeLessThanOrEqual(2 * 3 + 2);
    // …and each request is set-based (one IN-list statement per ≤90 ids), not one
    // statement per node: the gateway runs SQLite synchronously, so N per-node
    // scans of course_section would stall every other request behind this one.
    const perRequest = f.lines
      .slice(-calls)
      .map((l) => Number(/ n=(\d+) /.exec(l)?.[1] ?? 0));
    expect(Math.max(...perRequest)).toBe(1);
  });
});

test("db:backup rejects a non-numeric --keepDays without deleting anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "uhcs-bak-"));
  const backups = join(dir, "backups");
  mkdirSync(backups);
  const files = { search: join(dir, "search.sqlite"), analytics: join(dir, "analytics.sqlite") };
  try {
    for (const path of Object.values(files)) new DatabaseSync(path).close();
    writeFileSync(join(backups, "search-2000-01-01.sqlite"), "old");
    expect(() =>
      execFileSync("yarn", ["db:backup", "--dir", backups, "--keepDays", "14d"], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, SEARCH_D1_LOCAL_FILE: files.search, ANALYTICS_D1_LOCAL_FILE: files.analytics },
      })
    ).toThrow();
    expect(readdirSync(backups)).toEqual(["search-2000-01-01.sqlite"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.describe("gateway hardening", () => {
  let f: Fixture & { calls: () => number; lines: string[] };
  test.beforeEach(async () => {
    f = await startMigratedGateway();
  });
  test.afterEach(async () => {
    await stopGateway(f);
  });

  test("deleteSectionsAndChildren also removes the section's section_detail row", async () => {
    // D1 enforces FKs, so ON DELETE CASCADE dropped section_detail with its
    // section; the home SQLite runs with FKs off, so the delete must be explicit.
    const { insertSectionsAndChildren, deleteSectionsAndChildren } = await import("../src/lib/db/upsert");
    const db = gatewayD1({ url: f.url, secret: SECRET, db: "search" });
    await insertSectionsAndChildren(db, [realisticSection(1)] as never[], 1);
    const seed = openSqliteFile(f.files.search);
    seed.prepare("INSERT INTO section_detail (term, crn, synced_at) VALUES ('202740', '50001', 1)").run();
    seed.close();
    await deleteSectionsAndChildren(db, "202740", ["50001"]);
    const check = openSqliteFile(f.files.search);
    expect((check.prepare("SELECT COUNT(*) AS n FROM section_detail").get() as { n: number }).n).toBe(0);
    check.close();
  });

  test("gateway refuses ATTACH and VACUUM INTO (no file access beyond its own DBs)", async () => {
    const target = join(f.dir, "exfil.sqlite");
    for (const sql of [`ATTACH DATABASE '${target}' AS x`, `VACUUM INTO '${target}'`]) {
      const { status } = await query(f, one(sql));
      expect(status, sql).toBe(400);
    }
    expect(existsSync(target)).toBe(false);
    // Ordinary statements still work.
    expect((await query(f, one("SELECT COUNT(*) AS n FROM term"))).status).toBe(200);
  });
});

test("db:backup failing mid-run keeps the existing same-day copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "uhcs-bak-"));
  const backups = join(dir, "backups");
  mkdirSync(backups);
  const today = new Date().toLocaleDateString("en-CA");
  const good = join(backups, `search-${today}.sqlite`);
  try {
    const db = new DatabaseSync(good);
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('good')");
    db.close();
    const badSource = join(dir, "not-a-db");
    mkdirSync(badSource); // opening a directory as SQLite fails
    expect(() =>
      execFileSync("yarn", ["db:backup", "--dir", backups], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, SEARCH_D1_LOCAL_FILE: badSource, ANALYTICS_D1_LOCAL_FILE: badSource },
      })
    ).toThrow();
    const copy = new DatabaseSync(good, { readOnly: true });
    expect(copy.prepare("SELECT v FROM t").get()).toEqual({ v: "good" });
    copy.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RefreshWorkflow is disabled while the home gateway is active", async () => {
  const { workflowRefreshDisabled } = await import("../src/workflows/refreshGuard");
  expect(workflowRefreshDisabled({ DB_GATEWAY_URL: "https://db.example" })).toMatch(/home/i);
  expect(workflowRefreshDisabled({ DB_GATEWAY_URL: "" })).toBeNull();
  expect(workflowRefreshDisabled({})).toBeNull();
});
