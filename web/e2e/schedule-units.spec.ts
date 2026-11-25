// Node-only unit tests for the results table's Schedule column: the meeting
// formatters (src/lib/meetingTime.ts) and the per-term usual date range
// (src/lib/db/usualDates.ts). No browser, no app server.
import { test, expect } from "@playwright/test";
import {
  formatDateRange,
  formatMeetingLocation,
  formatTimeRange,
  shouldShowMeetingDates,
} from "../src/lib/meetingTime";
import type { MeetingTime } from "../src/lib/sis/types";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { localSqliteD1, openSqliteFile } from "../src/lib/db/client";
import { pickUsualDateRange, refreshTermUsualDates } from "../src/lib/db/usualDates";
import { termCacheProfile } from "../src/lib/edgeCache";

function mt(overrides: Partial<MeetingTime> = {}): MeetingTime {
  return {
    beginTime: null,
    endTime: null,
    startDate: null,
    endDate: null,
    building: null,
    buildingDescription: null,
    campus: null,
    campusDescription: null,
    room: null,
    creditHourSession: null,
    hoursWeek: null,
    meetingScheduleType: null,
    meetingType: null,
    meetingTypeDescription: null,
    monday: false,
    tuesday: false,
    wednesday: false,
    thursday: false,
    friday: false,
    saturday: false,
    sunday: false,
    ...overrides,
  };
}

test("formatTimeRange shares the meridiem", () => {
  expect(formatTimeRange("0900", "1015")).toBe("9:00–10:15 AM");
  expect(formatTimeRange("1600", "1945")).toBe("4:00–7:45 PM");
  expect(formatTimeRange("1130", "1245")).toBe("11:30 AM–12:45 PM");
  expect(formatTimeRange("0900", null)).toBe("9:00 AM–—");
  expect(formatTimeRange(null, null)).toBeNull();
});

test("formatMeetingLocation labels online rooms", () => {
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "ASYNC" }))).toBe("Online Async");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "SYNC" }))).toBe("Online Sync");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "TBA" }))).toBe("Online TBA");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: "WWW" }))).toBe("Online WWW");
  expect(formatMeetingLocation(mt({ building: "ONLINE", room: null }))).toBe("Online");
  expect(formatMeetingLocation(mt({ building: "LCCW", room: "ONLINE" }))).toBe("LCCW ONLINE");
  expect(formatMeetingLocation(mt({ building: "POST", room: "318A" }))).toBe("POST 318A");
  expect(formatMeetingLocation(mt({ building: null, room: null }))).toBe("—");
});

test("formatDateRange", () => {
  expect(formatDateRange("07/06/2026", "08/14/2026")).toBe("Jul 6 – Aug 14");
  expect(formatDateRange("07/06/2026", "07/06/2026")).toBe("Jul 6 – Jul 6");
});

test("shouldShowMeetingDates", () => {
  const usual = { start: "01/11/2027", end: "05/14/2027" };
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "05/14/2027" }), usual)).toBe(false);
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "03/05/2027" }), usual)).toBe(true);
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "05/14/2027" }), null)).toBe(true);
  expect(shouldShowMeetingDates(mt({ startDate: "01/11/2027", endDate: "05/14/2027" }), undefined)).toBe(true);
  expect(shouldShowMeetingDates(mt({ startDate: null, endDate: "05/14/2027" }), null)).toBe(false);
});

// ── usual date range ─────────────────────────────────────────────────────────

const A = "08/24/2026";
const B = "12/18/2026";

test("pickUsualDateRange needs a >= 60% majority", () => {
  expect(pickUsualDateRange([
    { begin_date: A, end_date: B, n: 82 },
    { begin_date: "08/24/2026", end_date: "10/16/2026", n: 18 },
  ])).toEqual({ start: A, end: B });
  expect(pickUsualDateRange([
    { begin_date: "05/26/2026", end_date: "07/02/2026", n: 38 },
    { begin_date: "07/06/2026", end_date: "08/14/2026", n: 35 },
    { begin_date: "05/26/2026", end_date: "08/14/2026", n: 27 },
  ])).toBeNull();
  expect(pickUsualDateRange([
    { begin_date: A, end_date: B, n: 60 },
    { begin_date: "08/24/2026", end_date: "10/16/2026", n: 40 },
  ])).toEqual({ start: A, end: B });
  expect(pickUsualDateRange([
    { begin_date: null, end_date: B, n: 70 },
    { begin_date: A, end_date: B, n: 30 },
  ])).toBeNull();
  expect(pickUsualDateRange([])).toBeNull();
});

// Playwright runs from web/ (its config dir), so a cwd-relative path is stable.
const MIGRATIONS = join(process.cwd(), "migrations");

/** A temp search DB with every migration before `stopBefore` applied. */
function tempSearchDb(stopBefore?: string): { dir: string; file: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "uhcs-usual-"));
  const file = join(dir, "search.sqlite");
  const db = openSqliteFile(file);
  applyMigrations(db, (name) => !stopBefore || name < stopBefore);
  return { dir, file, db };
}

function applyMigrations(db: DatabaseSync, include: (name: string) => boolean): void {
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (include(name)) db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  }
}

function insertMeetings(db: DatabaseSync, term: string, ranges: [string, string][]): void {
  db.exec(`DELETE FROM section_meeting WHERE term = '${term}'`);
  const stmt = db.prepare(
    "INSERT INTO section_meeting (term, crn, meeting_index, begin_date, end_date) VALUES (?, ?, 0, ?, ?)"
  );
  ranges.forEach(([s, e], i) => stmt.run(term, String(10000 + i), s, e));
}

test("refreshTermUsualDates stores the majority range, or clears it", async () => {
  const { dir, db } = tempSearchDb();
  try {
    db.prepare("INSERT INTO term (code, description) VALUES ('202710', 'Fall 2026')").run();
    const d1 = localSqliteD1(db);
    const short: [string, string] = ["08/24/2026", "10/16/2026"];

    insertMeetings(db, "202710", [[A, B], [A, B], [A, B], [A, B], short]);
    expect(await refreshTermUsualDates(d1, "202710")).toEqual({ start: A, end: B });
    expect(db.prepare("SELECT usual_start_date, usual_end_date FROM term").get())
      .toEqual({ usual_start_date: A, usual_end_date: B });

    insertMeetings(db, "202710", [[A, B], [A, B], short, short, ["10/19/2026", B]]);
    expect(await refreshTermUsualDates(d1, "202710")).toBeNull();
    expect(db.prepare("SELECT usual_start_date, usual_end_date FROM term").get())
      .toEqual({ usual_start_date: null, usual_end_date: null });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration 0015 refills NULL section_meeting.begin_date from raw_json", () => {
  const { dir, db } = tempSearchDb("0015");
  try {
    const raw = JSON.stringify({
      meetingsFaculty: [
        { meetingTime: { startDate: "07/06/2026", endDate: "07/06/2026" } },
        { meetingTime: { startDate: "07/07/2026", endDate: "08/14/2026" } },
      ],
    });
    db.prepare(
      `INSERT INTO course_section (term, crn, subject, course_number, course_title, raw_json, synced_at)
       VALUES ('202640', '98366', 'ICS', '100', 'Computing Literacy', ?, 0)`
    ).run(raw);
    db.prepare(
      `INSERT INTO section_meeting (term, crn, meeting_index, begin_date, end_date)
       VALUES ('202640', '98366', 1, NULL, '08/14/2026')`
    ).run();

    applyMigrations(db, (name) => name >= "0015");

    expect(db.prepare("SELECT begin_date FROM section_meeting").get())
      .toEqual({ begin_date: "07/07/2026" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("termCacheProfile re-keys when the usual date range changes", () => {
  const base = { lastSyncedAt: 1_700_000_000_000, isViewOnly: true };
  const before = termCacheProfile({ ...base, usualDateRange: null });
  const after = termCacheProfile({ ...base, usualDateRange: { start: "01/11/2027", end: "05/14/2027" } });
  expect(before?.version).not.toBe(after?.version);
});
