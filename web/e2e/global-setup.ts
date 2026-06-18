// Playwright global setup: seed the wrangler local D1 file with a deterministic
// fixture catalog so the read-path tests run entirely from D1 (no live SIS, no
// mock for reads). Mirrors the ICS catalog the mock serves for term 202710.
//
// Runs before the app server starts, in its own process, so the file handle is
// released before `yarn preview` opens it via node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { E2E_PERSIST, findLocalD1File } from "./d1-helpers";

interface SeedFaculty {
  bannerId: string;
  category: string | null;
  courseReferenceNumber: string;
  displayName: string | null;
  emailAddress: string | null;
  primaryIndicator: boolean;
  term: string;
}

function icsSection(
  crn: string,
  courseNumber: string,
  seq: string,
  title: string,
  campusDescription = "University of Hawaii at Manoa"
) {
  const faculty: SeedFaculty[] = [];
  return {
    id: Number(crn),
    term: "202710",
    termDesc: "Fall 2026",
    courseReferenceNumber: crn,
    partOfTerm: "1",
    courseNumber,
    subject: "ICS",
    subjectDescription: "Information & Computer Sciences",
    sequenceNumber: seq,
    campusDescription,
    scheduleTypeDescription: "Lecture",
    courseTitle: title,
    creditHours: 3,
    creditHourLow: 3,
    creditHourHigh: null,
    maximumEnrollment: 40,
    enrollment: 30,
    seatsAvailable: 10,
    waitCapacity: 0,
    waitCount: 0,
    waitAvailable: 0,
    openSection: true,
    linkIdentifier: null,
    isSectionLinked: false,
    subjectCourse: `ICS ${courseNumber}`,
    faculty,
    meetingsFaculty: [],
    reservedSeatSummary: null,
    sectionAttributes: [],
  };
}

const SECTIONS = [
  icsSection("10001", "111", "001", "Intro to Computer Science I"),
  icsSection("10002", "111", "002", "Intro to Computer Science I"),
  icsSection("10003", "141", "001", "Foundations I"),
  icsSection("10004", "211", "001", "Intro to Computer Science II"),
  icsSection("10005", "311", "001", "Algorithms"),
  icsSection("10006", "311", "002", "Algorithms"),
  // A non-Manoa section so the campus filter has something to exclude: the
  // default UH-Manoa search hides it, "All Campuses" reveals it.
  icsSection("10007", "101", "001", "Tools for the Information World", "University of Hawaii at Hilo"),
];

// Give the first section a faculty member so the details panel's instructor card
// (served from the seeded `instructor` row below) has a bannerId to fetch.
SECTIONS[0].faculty = [
  {
    bannerId: "9001",
    category: "01",
    courseReferenceNumber: "10001",
    displayName: "Jane Instructor",
    emailAddress: "jane@hawaii.edu",
    primaryIndicator: true,
    term: "202710",
  },
];

// CRN 10004 (ICS 211) gets a waitlist + a real meeting (with a location), so the
// detail dialog's waitlist line and dedicated Meetings table have data to render.
// Seats/waitlist live in raw_json (the read path reconstructs CourseSection from
// it); only the indexed columns are inserted separately below.
SECTIONS[3].waitCapacity = 5;
SECTIONS[3].waitCount = 2;
SECTIONS[3].waitAvailable = 3;
SECTIONS[3].meetingsFaculty = [
  {
    bannerId: null,
    category: null,
    courseReferenceNumber: "10004",
    displayName: null,
    emailAddress: null,
    primaryIndicator: false,
    term: "202710",
    meetingTime: {
      beginTime: "0900",
      endTime: "0950",
      startDate: "08/25/2025",
      endDate: "12/12/2025",
      building: "KELLER",
      buildingDescription: "Keller Hall",
      campus: null,
      campusDescription: null,
      room: "101",
      creditHourSession: null,
      hoursWeek: null,
      meetingScheduleType: null,
      meetingType: null,
      meetingTypeDescription: "Lecture",
      monday: true,
      tuesday: false,
      wednesday: true,
      thursday: false,
      friday: true,
      saturday: false,
      sunday: false,
    },
  },
];

export default function globalSetup() {
  // Ensure the local D1 file exists with the current schema (idempotent).
  execSync(
    `yarn wrangler d1 migrations apply uh-course-search-db --local --persist-to ${E2E_PERSIST}`,
    { stdio: "ignore" }
  );
  // Analytics DB (uh-analytics-db) lives in its own local file; apply its
  // migration so wrangler dev exposes a schema-complete ANALYTICS_DB binding and
  // the rollups admin route has somewhere to write.
  execSync(
    `yarn wrangler d1 migrations apply uh-analytics-db --local --persist-to ${E2E_PERSIST}`,
    { stdio: "ignore" }
  );

  const db = new DatabaseSync(findLocalD1File("course_section"), {
    enableForeignKeyConstraints: false,
  });

  // Clean slate (schema is left intact; migrations already applied).
  for (const table of [
    "section_meeting",
    "section_faculty",
    "section_detail",
    "course_section",
    "course",
    "filter_option",
    "instructor",
    "subject",
    "sync_run",
    "term",
  ]) {
    db.exec(`DELETE FROM ${table};`);
  }

  const term = db.prepare(
    "INSERT INTO term (code, description, is_view_only, display_order, last_synced_at) VALUES (?, ?, 0, ?, ?)"
  );
  // 202710 has the higher display_order so it stays first / the default term for
  // the read-path tests. 202730 exists (no sections) so the ingestion test can
  // sync into it and exercise the seat-refresh cooldown. Both are marked
  // backfilled (last_synced_at set) so read-path searches stay on the SQL path —
  // not the demand-driven page cache — even with DYNAMIC_SYNC on. 202740 is left
  // dynamic (last_synced_at NULL) for the page-cache ingestion test.
  //
  // Tier B2 is now a rolling per-run refresh of the stalest detail CRNs (no
  // last_details_synced_at gate), so the scheduled-refresh tests don't need a
  // seeded details-stamp — every refresh-run rolls the term's stale details.
  const SYNCED = 1_700_000_000_000;
  term.run("202710", "Fall 2026", 2, SYNCED);
  term.run("202730", "Spring 2026", 1, SYNCED);
  term.run("202740", "Summer 2026", 0, null);
  // Historical term for the analytics enrollment-trend fixture (202610 rollups).
  // Negative display_order keeps it out of the read-path search tests' dropdown.
  term.run("202610", "Fall 2025", -10, SYNCED);

  const insert = db.prepare(
    `INSERT INTO course_section
       (term, crn, subject, subject_description, course_number, sequence_number,
        subject_course, course_title, campus_description, schedule_type_desc,
        maximum_enrollment, enrollment, seats_available, open_section, raw_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = 1_700_000_000_000;
  for (const s of SECTIONS) {
    insert.run(
      s.term,
      s.courseReferenceNumber,
      s.subject,
      s.subjectDescription,
      s.courseNumber,
      s.sequenceNumber,
      s.subjectCourse,
      s.courseTitle,
      s.campusDescription,
      s.scheduleTypeDescription,
      s.maximumEnrollment,
      s.enrollment,
      s.seatsAvailable,
      s.openSection ? 1 : 0,
      JSON.stringify(s),
      now
    );
  }

  // The subject menu is served from the `subject` table alone (the production
  // sync enumerates subjects before storing sections — mirror that here).
  const subjectStmt = db.prepare(
    "INSERT OR IGNORE INTO subject (term, code, description) VALUES (?, ?, ?)"
  );
  for (const s of SECTIONS) subjectStmt.run(s.term, s.subject, s.subjectDescription);

  // Course catalog rows (what a details sync would produce). College/department
  // are per (campus, course); ICS 311 sits in a different college so the College
  // filter has something to exclude.
  const MANOA = "University of Hawaii at Manoa";
  const NAT_SCI = ["14", "College of Natural Sciences"];
  const ENGR = ["20", "College of Engineering"];
  const COURSES: Array<[string, string, string, string, string]> = [
    [MANOA, "ICS", "111", ...NAT_SCI] as [string, string, string, string, string],
    [MANOA, "ICS", "141", ...NAT_SCI] as [string, string, string, string, string],
    [MANOA, "ICS", "211", ...NAT_SCI] as [string, string, string, string, string],
    [MANOA, "ICS", "311", ...ENGR] as [string, string, string, string, string],
    ["University of Hawaii at Hilo", "ICS", "101", "30", "College of Natural & Health Sciences"] as [string, string, string, string, string],
  ];
  const courseStmt = db.prepare(
    `INSERT INTO course
       (term, campus_description, subject, course_number, college_code, college_name,
        department, department_code, grading_modes, schedule_types, credit_breakdown, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [campus, subject, courseNumber, collegeCode, collegeName] of COURSES) {
    courseStmt.run(
      "202710",
      campus,
      subject,
      courseNumber,
      collegeCode,
      collegeName,
      "Information & Computer Sciences",
      "ICS",
      JSON.stringify(["Letter Plus + Minus  G"]),
      JSON.stringify(["Lecture  LEC"]),
      JSON.stringify({ creditHours: 3 }),
      now
    );
  }

  // Section detail for CRN 10005 (ICS 311) with a cross-listed sibling
  // (CRN 10004 = ICS 211 "Intro to Computer Science II", a real seeded section),
  // so /api/section returns a cross-list CRN the detail dialog can resolve.
  // Seeded here (not for 10001) so the lazy-fetch test above — which needs
  // 10001's detail absent — is unaffected. `synced_at` marks it "fetched".
  db.prepare(
    `INSERT INTO section_detail (term, crn, cross_list_crns, synced_at)
     VALUES (?, ?, ?, ?)`
  ).run("202710", "10005", JSON.stringify(["10004"]), now);

  // Instructor contact card for the faculty seeded on CRN 10001, so the details
  // panel's instructor card renders from D1 (read path; no lazy fetch here).
  db.prepare(
    `INSERT INTO instructor
       (banner_id, display_name, title, department, college, email, raw_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "9001",
    "Jane Instructor",
    "Associate Professor",
    "Information & Computer Sciences",
    "College of Natural Sciences",
    "jane@hawaii.edu",
    "{}",
    now
  );

  // Historical (view-only) fixture terms for the details-backfill selection test
  // (e2e/ingest.spec.ts). Each is_view_only=1 (the read-path terms above are 0)
  // and has a minimal catalog (one course_section) so the EXISTS guard passes.
  // Negative display_order keeps them last in the term dropdown (getTerms orders
  // display_order DESC, code DESC) so the read-path default term (202710) is
  // unaffected. Backfill picks the NEWEST that lacks a completed `details`
  // sync_run:
  //   202700 — done    (details sync_run status 'ok')     → excluded
  //   202695 — failed  (details sync_run status 'error')   → eligible (retry)
  //   202690 — never   (no details sync_run)               → eligible
  //   202680 — no catalog (no course_section)              → excluded (catalog-missing)
  // ⇒ newest eligible = 202695; pending = 2; catalog-missing = 1.
  const voTerm = db.prepare(
    "INSERT INTO term (code, description, is_view_only, display_order, last_synced_at) VALUES (?, ?, 1, ?, ?)"
  );
  voTerm.run("202700", "Spring 2025", -1, SYNCED);
  voTerm.run("202695", "Winter 2025", -2, SYNCED);
  voTerm.run("202690", "Fall 2024", -3, SYNCED);
  voTerm.run("202680", "Summer 2024", -4, SYNCED);

  const voSection = db.prepare(
    `INSERT INTO course_section
       (term, crn, subject, subject_description, course_number, sequence_number,
        subject_course, course_title, campus_description, schedule_type_desc,
        maximum_enrollment, enrollment, seats_available, open_section, raw_json, synced_at)
     VALUES (?, ?, 'ICS', 'Information & Computer Sciences', '111', '001',
             'ICS 111', 'Intro', ?, 'Lecture', 40, 30, 10, 1, '{}', ?)`
  );
  for (const code of ["202700", "202695", "202690"]) {
    voSection.run(code, `${code}-1`, MANOA, now);
  }

  const voRun = db.prepare(
    "INSERT INTO sync_run (term, kind, started_at, finished_at, status) VALUES (?, 'details', ?, ?, ?)"
  );
  voRun.run("202700", now, now, "ok");
  voRun.run("202695", now, now, "error");

  // --- Analytics-rollups fixture (e2e/ingest.spec.ts "rollups" test) ---------
  // A dedicated view-only term (202750) with exactly THREE deterministic
  // sections so computeAllRollups produces known, exact numbers. Negative
  // display_order keeps it out of the read-path tests' term dropdown. No SIS
  // interaction (view-only). Expected rollups for term 202750:
  //   course_term_stats (2 rows):
  //     ICS 1110 Manoa: sections=2, total_enr=50, total_cap=80, capped=2, open=2
  //     ICS 2110 Manoa: sections=1, total_enr=5,  total_cap=0,  capped=0, open=0
  //       (max=0 honest-fill: counted in `sections`, NOT in `capped_sections`)
  //   term_facet_stats facet='all': sections=3, total_enr=55, total_cap=80, capped=2
  //   term_facet_stats facet='schedule_type':
  //     'Lecture' sections=2 total_enr=50 ; 'Online' sections=1 total_enr=5
  voTerm.run("202750", "Analytics Fixture", -5, SYNCED);
  // Mark its details pass complete so the backfill auto-selector (newest
  // view-only term lacking an ok/partial `details` sync_run) skips it — this
  // fixture exists for rollups, not backfill, and 202750 > 202695 would
  // otherwise hijack the backfill-selection test.
  voRun.run("202750", now, now, "ok");
  const aSection = db.prepare(
    `INSERT INTO course_section
       (term, crn, subject, subject_description, course_number, sequence_number,
        subject_course, course_title, campus_description, schedule_type_desc,
        maximum_enrollment, enrollment, seats_available, open_section, wait_count, raw_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const ANALYTICS_ROWS: Array<
    [string, string, string, string, string, string, number, number, number, number]
  > = [
    // crn, subject, course_number, subject_course, campus, schedule_type, max, enr, seats, open
    ["75001", "ICS", "1110", "ICS 1110", MANOA, "Lecture", 40, 30, 10, 1],
    ["75002", "ICS", "1110", "ICS 1110", MANOA, "Lecture", 40, 20, 20, 1],
    ["75003", "ICS", "2110", "ICS 2110", MANOA, "Online", 0, 5, 0, 0],
  ];
  for (const [crn, subject, courseNumber, subjectCourse, campus, schedType, max, enr, seats, open] of ANALYTICS_ROWS) {
    aSection.run(
      "202750",
      crn,
      subject,
      "Information & Computer Sciences",
      courseNumber,
      "001",
      subjectCourse,
      "Analytics Course",
      campus,
      schedType,
      max,
      enr,
      seats,
      open,
      0, // wait_count
      "{}",
      now
    );
  }

  // ── analytics rollup fixture (read-path analytics e2e) ──
  // ICS 1110 across two terms at Manoa, plus facet rows, so the four charts
  // render real lines/areas/bars. Independent of the search fixture.
  const adb = new DatabaseSync(findLocalD1File("course_term_stats"), {
    enableForeignKeyConstraints: false,
  });
  for (const t of ["course_term_stats", "term_facet_stats", "analytics_meta"]) {
    adb.exec(`DELETE FROM ${t};`);
  }
  const cts = adb.prepare(
    `INSERT INTO course_term_stats
       (term, subject, course_number, subject_course, course_title, campus,
        sections, total_enr, total_cap, capped_sections, total_wait, open_sections)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // ICS 1110: 202610 → 50 enrolled, 202710 → 70 enrolled (Manoa).
  cts.run("202610", "ICS", "1110", "ICS 1110", "Intro to CS I", "University of Hawaii at Manoa", 2, 50, 80, 2, 5, 2);
  cts.run("202710", "ICS", "1110", "ICS 1110", "Intro to CS I", "University of Hawaii at Manoa", 2, 70, 80, 2, 8, 1);
  // A second campus (Hilo) so the per-campus selector has something to pick.
  // Manoa stays the bigger campus, so "biggest campus" still defaults to Manoa.
  cts.run("202610", "ICS", "1110", "ICS 1110", "Intro to CS I", "University of Hawaii at Hilo", 1, 20, 30, 1, 0, 1);
  cts.run("202710", "ICS", "1110", "ICS 1110", "Intro to CS I", "University of Hawaii at Hilo", 1, 25, 30, 1, 0, 1);
  // ICS 2110 in 202710 for the leaderboard (higher fill rate: 39/40 vs 70/80).
  cts.run("202710", "ICS", "2110", "ICS 2110", "Intro to CS II", "University of Hawaii at Manoa", 1, 39, 40, 1, 12, 0);

  const tfs = adb.prepare(
    `INSERT INTO term_facet_stats
       (term, facet, facet_value, sections, total_enr, total_cap, capped_sections, total_wait)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  tfs.run("202610", "campus", "University of Hawaii at Manoa", 2, 50, 80, 2, 5);
  tfs.run("202710", "campus", "University of Hawaii at Manoa", 3, 109, 120, 3, 20);
  tfs.run("202610", "schedule_type", "Lecture", 2, 50, 80, 2, 5);
  tfs.run("202710", "schedule_type", "Lecture", 2, 70, 80, 2, 8);
  tfs.run("202710", "schedule_type", "Online", 1, 39, 40, 1, 12);
  adb.prepare(
    `INSERT INTO analytics_meta (key, value) VALUES ('rollups_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run("1700000000000");
  adb.close();

  db.close();
}
