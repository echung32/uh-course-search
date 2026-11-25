/**
 * crseavail parity gate (spec rollout step 2): compares what crseavail would
 * write against the course facts / cross-lists already stored from Banner.
 * Read-only. Calls crseavail regardless of the CRSEAVAIL flag — it is the gate
 * run before enabling it.
 */
import type { D1Like } from "@/lib/db/types";
import { caCourseDesc, caCourseGrading, caCourses, caCrossList } from "@/lib/crseavail/client";
import { buildCourseFacts, crossListMap } from "@/lib/crseavail/map";
import { campusCodeMap, loadCrnIndex } from "./courseFacts";

export type ParityField =
  | "gradingModes"
  | "creditHours"
  | "collegeCode"
  | "departmentCode"
  | "description"
  | "crossList";

export interface ParityFieldReport {
  compared: number;
  equal: number;
  rate: number;
  examples: Array<{ key: string; stored: unknown; crseavail: unknown }>;
}

export interface ParityReport {
  term: string;
  fields: Record<ParityField, ParityFieldReport>;
  /** Units whose crseavail fetch failed (or whose campus has no code); skipped. */
  unitsFailed: number;
  pass: boolean;
}

const FIELDS: ParityField[] = ["gradingModes", "creditHours", "collegeCode", "departmentCode", "description", "crossList"];
const MAX_EXAMPLES = 5;
const PASS_RATE = 0.99;

const sortedJson = (a: unknown): string[] => (Array.isArray(a) ? a.map(String).sort() : []);
const parse = (s: string | null): unknown => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export async function crseavailParity(
  db: D1Like,
  term: string,
  opts: { log?: (m: string) => void } = {}
): Promise<ParityReport> {
  const log = opts.log ?? (() => {});
  const fields = Object.fromEntries(
    FIELDS.map((f) => [f, { compared: 0, equal: 0, rate: 1, examples: [] }])
  ) as Record<ParityField, ParityFieldReport>;
  const record = (f: ParityField, key: string, stored: unknown, ca: unknown, same: boolean) => {
    const r = fields[f];
    r.compared += 1;
    if (same) r.equal += 1;
    else if (r.examples.length < MAX_EXAMPLES) r.examples.push({ key, stored, crseavail: ca });
  };

  const [codes, { index, perUnit }] = await Promise.all([campusCodeMap(db), loadCrnIndex(db, term)]);
  const { results } = await db
    .prepare(
      `SELECT campus_description AS campus, subject, course_number AS cn, grading_modes, credit_breakdown,
              college_code, department_code, description
         FROM course WHERE term = ?`
    )
    .bind(term)
    .all<{
      campus: string;
      subject: string;
      cn: string;
      grading_modes: string | null;
      credit_breakdown: string | null;
      college_code: string | null;
      department_code: string | null;
      description: string | null;
    }>();
  const stored = new Map(results.map((r) => [`${r.campus}|${r.subject}|${r.cn}`, r]));

  let unitsFailed = 0;
  let unitsOk = 0;
  for (const u of perUnit.keys()) {
    const sep = u.indexOf("|");
    const campus = u.slice(0, sep);
    const subject = u.slice(sep + 1);
    const code = codes.get(campus);
    if (!code) {
      log(`[${term}] parity ${campus} ${subject}: no campus code, skipped`);
      unitsFailed += 1;
      continue;
    }
    const ca = { term, campusCode: code, subject };
    let built;
    try {
      const [courses, descs, grading] = await Promise.all([caCourses(ca), caCourseDesc(ca), caCourseGrading(ca)]);
      built = buildCourseFacts({ courses, descs, grading }, index);
    } catch (err) {
      log(`[${term}] parity ${campus} ${subject}: crseavail failed, skipped: ${(err as Error).message}`);
      unitsFailed += 1;
      continue;
    }
    unitsOk += 1;
    for (const [k, e] of built) {
      const s = stored.get(k);
      if (!s) continue;
      const key = `${k}`;
      const f = e.facts;
      const sg = parse(s.grading_modes);
      if (sg !== null) record("gradingModes", key, sg, f.gradingModes, JSON.stringify(sortedJson(sg)) === JSON.stringify(sortedJson(f.gradingModes)));
      const sc = (parse(s.credit_breakdown) as { creditHours?: number | null } | null)?.creditHours ?? null;
      if (sc !== null) record("creditHours", key, sc, f.creditBreakdown.creditHours, sc === f.creditBreakdown.creditHours);
      if (s.college_code !== null) record("collegeCode", key, s.college_code, f.collegeCode, s.college_code === f.collegeCode);
      if (s.department_code !== null) record("departmentCode", key, s.department_code, f.departmentCode, s.department_code === f.departmentCode);
      if (s.description !== null) {
        record("description", key, s.description, f.description, s.description.trimEnd() === (f.description ?? "").trimEnd());
      }
    }
  }

  // Cross-lists are term-wide: one fetch, every stored section_detail row compared.
  try {
    const rows = await caCrossList(term);
    const { results: det } = await db
      .prepare("SELECT crn, cross_list_crns FROM section_detail WHERE term = ?")
      .bind(term)
      .all<{ crn: string; cross_list_crns: string | null }>();
    const map = crossListMap(rows, [...index.keys()]);
    for (const d of det) {
      if (!index.has(d.crn)) continue;
      const s = sortedJson(parse(d.cross_list_crns));
      const c = (map.get(d.crn) ?? []).slice().sort();
      record("crossList", d.crn, s, c, JSON.stringify(s) === JSON.stringify(c));
    }
  } catch (err) {
    log(`[${term}] parity cross-list: crseavail failed, skipped: ${(err as Error).message}`);
  }

  for (const f of FIELDS) fields[f].rate = fields[f].compared ? fields[f].equal / fields[f].compared : 1;
  const pass = unitsOk > 0 && FIELDS.every((f) => fields[f].compared === 0 || fields[f].rate >= PASS_RATE);
  return { term, fields, unitsFailed, pass };
}
