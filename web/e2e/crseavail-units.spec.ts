// Node-only unit tests for the crseavail client against an in-process server
// that serves the real (trimmed) samples from docs/crseavail-samples/.
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const SAMPLES = fileURLToPath(new URL("../../docs/crseavail-samples", import.meta.url));
const sample = (f: string) => readFileSync(join(SAMPLES, f), "utf8");

let server: Server;
let seenHeaders: Record<string, string | string[] | undefined> = {};
let flaky = 0;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    seenHeaders = req.headers;
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: string, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
    const m = url.pathname.match(/^\/fail-([\w-]+)\//);
    if (m) {
      const mode = m[1];
      if (mode === "400") return json("{}", 400);
      if (mode === "html") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html>blocked</html>");
      }
      if (mode === "empty-row") return json("[{}]");
      if (mode === "nulls-omitted") {
        return json(url.pathname.endsWith("/course-desc")
          ? '[{"ssbsectCrn1":"1"}]'
          : '[{"ssbsectCrn1":"1","crseNumb":"101","subjCode":"ICS"}]');
      }
      if (mode === "no-crse") return json('[{"ssbsectCrn1":"1","subjCode":"ICS"}]');
      if (mode === "503") {
        if (flaky++ < 1) return json("{}", 503);
        return json("[]");
      }
    }
    if (url.pathname === "/courses") return json(sample("courses.json"));
    return json("[]", 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  process.env.CRSEAVAIL_BASE_URL = `http://127.0.0.1:${port}`;
});
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const unit = { term: "202710", campusCode: "MAN", subject: "ICS" };

test("sends the recaptcha header and parses samples", async () => {
  const { caCourses } = await import("../src/lib/crseavail/client");
  const rows = await caCourses(unit);
  expect(rows.length).toBe(JSON.parse(sample("courses.json")).length);
  expect(rows[0].ssbsectCrn1).toBeTruthy();
  expect(seenHeaders["x-recaptcha-token"]).toBe("undefined");
  expect(String(seenHeaders["user-agent"])).toContain("Chrome");
});

// Base URL prefixed with /fail-<mode>/ makes the server misbehave in that mode.
async function withFail<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const orig = process.env.CRSEAVAIL_BASE_URL!;
  process.env.CRSEAVAIL_BASE_URL = `${orig}/fail-${mode}`;
  try {
    return await fn();
  } finally {
    process.env.CRSEAVAIL_BASE_URL = orig;
  }
}

test("400 -> CrseavailError http", async () => {
  const { caCourses } = await import("../src/lib/crseavail/client");
  const err = await withFail("400", () => caCourses(unit)).catch((e) => e);
  expect(err.name).toBe("CrseavailError");
  expect(err.reason).toBe("http");
  expect(err.status).toBe(400);
});

test("HTML 200 -> not-json", async () => {
  const { caCourses } = await import("../src/lib/crseavail/client");
  const err = await withFail("html", () => caCourses(unit)).catch((e) => e);
  expect(err.reason).toBe("not-json");
});

test("row missing ssbsectCrn1 -> shape", async () => {
  const { caCourses } = await import("../src/lib/crseavail/client");
  const err = await withFail("empty-row", () => caCourses(unit)).catch((e) => e);
  expect(err.reason).toBe("shape");
});

test("omitted nullable fields validate; missing crseNumb is shape", async () => {
  const { caCourses, caCourseDesc } = await import("../src/lib/crseavail/client");
  const rows = await withFail("nulls-omitted", () => caCourses(unit));
  expect(rows).toHaveLength(1);
  const desc = await withFail("nulls-omitted", () => caCourseDesc(unit));
  expect(desc).toHaveLength(1);
  const err = await withFail("no-crse", () => caCourses(unit)).catch((e) => e);
  expect(err.reason).toBe("shape");
});

test("retries a 503 then succeeds", async () => {
  const { caCourses, __setRetryDelayMs } = await import("../src/lib/crseavail/client");
  __setRetryDelayMs(1);
  flaky = 0;
  const rows = await withFail("503", () => caCourses(unit));
  expect(rows).toEqual([]);
  expect(flaky).toBe(2);
});

test("crseavailEnabled reflects CRSEAVAIL", async () => {
  const { crseavailEnabled } = await import("../src/lib/crseavail/client");
  const prev = process.env.CRSEAVAIL;
  try {
    process.env.CRSEAVAIL = "1";
    expect(crseavailEnabled()).toBe(true);
    process.env.CRSEAVAIL = "0";
    expect(crseavailEnabled()).toBe(false);
    delete process.env.CRSEAVAIL;
    expect(crseavailEnabled()).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.CRSEAVAIL;
    else process.env.CRSEAVAIL = prev;
  }
});

test.describe("crseavail map", () => {
  test("buildCourseFacts maps ICS 311 like Banner", async () => {
    const { buildCourseFacts } = await import("../src/lib/crseavail/map");
    const index = new Map([
      ["77062", { term: "202710", campus: "University of Hawaii at Manoa", subject: "ICS", courseNumber: "3110" }],
    ]);
    const out = buildCourseFacts(
      {
        courses: JSON.parse(sample("courses.json")),
        descs: JSON.parse(sample("course-desc.json")),
        grading: JSON.parse(sample("course-grading.json")),
      },
      index
    );
    expect(out.size).toBe(1);
    const e = out.get("University of Hawaii at Manoa|ICS|3110")!;
    expect(e.crns).toEqual(["77062"]);
    expect(e.facts.gradingModes).toEqual(["Audit  A", "Credit/No Credit  C", "Letter Plus + Minus  G"]);
    expect(e.facts.creditBreakdown.creditHours).toBe(4);
    expect(e.facts.collegeCode).toBe("14");
    expect(e.facts.departmentCode).toBe("ICS");
    expect(e.facts.description!.startsWith("(4 1-hr Lec) Design and correctness")).toBe(true);
    expect(e.facts.description!.endsWith("or consent.")).toBe(true);
  });

  test("crossListMap excludes self and nulls ungrouped CRNs", async () => {
    const { crossListMap } = await import("../src/lib/crseavail/map");
    const rows = JSON.parse(sample("crosslist.json")) as Array<{ ssbsectCrn: string; ssrxlstXlstGroup: string }>;
    const g = rows[0].ssrxlstXlstGroup;
    const members = [...new Set(rows.filter((r) => r.ssrxlstXlstGroup === g).map((r) => r.ssbsectCrn))];
    expect(members.length).toBeGreaterThan(1);
    const m = crossListMap(rows as never, [...members, "99999"]);
    for (const c of members) {
      const v = m.get(c)!;
      expect(v).not.toContain(c);
      expect(v).toEqual(members.filter((x) => x !== c).sort((a, b) => Number(a) - Number(b)));
    }
    expect(m.get("99999")).toBeNull();
  });

  test("buildCampusCodeMap ignores null campus and picks the majority", async () => {
    const { extractCampusPairs, buildCampusCodeMap } = await import("../src/lib/crseavail/map");
    const mk = (code: string | null) =>
      JSON.stringify({ campusDescription: "UH Manoa", meetingsFaculty: [{ meetingTime: { campus: code } }] });
    const pairs = [mk("MAN"), mk("MAN"), mk("XXX"), mk(null)].flatMap(extractCampusPairs);
    expect(pairs).toHaveLength(3);
    expect(buildCampusCodeMap(pairs).get("UH Manoa")).toBe("MAN");
  });

  test("deriveScheduleTypes formats Desc  CODE", async () => {
    const { deriveScheduleTypes } = await import("../src/lib/crseavail/map");
    const raw = JSON.stringify({
      scheduleTypeDescription: "Lecture",
      meetingsFaculty: [{ meetingTime: { meetingScheduleType: null } }, { meetingTime: { meetingScheduleType: "LEC" } }],
    });
    const none = JSON.stringify({ scheduleTypeDescription: "Lecture", meetingsFaculty: [] });
    expect(deriveScheduleTypes([raw, raw, none])).toEqual(["Lecture  LEC"]);
  });
});
