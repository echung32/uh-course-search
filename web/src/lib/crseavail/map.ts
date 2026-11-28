// Pure mapping from crseavail rows onto our course facts / cross-lists / campus codes.
import type { CourseFacts, CourseKey } from "../db/upsert";
import type { CaCourseDescRow, CaCourseRow, CaCrossListRow, CaGradingRow } from "./types";

export type CrnIndex = Map<string, CourseKey>;

interface RawSection {
  campusDescription?: string | null;
  scheduleTypeDescription?: string | null;
  meetingsFaculty?: Array<{ meetingTime?: { campus?: string | null; meetingScheduleType?: string | null } | null }>;
}

export function extractCampusPairs(rawJson: string): Array<{ campusDescription: string; code: string }> {
  const raw = JSON.parse(rawJson) as RawSection;
  if (!raw.campusDescription) return [];
  const out: Array<{ campusDescription: string; code: string }> = [];
  for (const mf of raw.meetingsFaculty ?? []) {
    const code = mf?.meetingTime?.campus;
    if (code) out.push({ campusDescription: raw.campusDescription, code });
  }
  return out;
}

/** Meeting-location codes that are never a section's campus (online classes meet at "WWW"). */
const VIRTUAL_CAMPUS_CODES = new Set(["WWW"]);

/**
 * Campus description → the majority meeting-campus code among its sections.
 * A meeting's `campus` is where the class meets, not the section's campus, so
 * online meetings ("WWW") and other campuses' rooms are noise: with `valid`
 * (crseavail's own campus codes, from `subjects`) only those codes count;
 * without it, only the virtual codes are dropped.
 */
export function buildCampusCodeMap(
  pairs: Array<{ campusDescription: string; code: string }>,
  valid?: Set<string>
): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const { campusDescription, code } of pairs) {
    if (valid ? !valid.has(code) : VIRTUAL_CAMPUS_CODES.has(code)) continue;
    const m = counts.get(campusDescription) ?? new Map<string, number>();
    m.set(code, (m.get(code) ?? 0) + 1);
    counts.set(campusDescription, m);
  }
  const out = new Map<string, string>();
  for (const [desc, m] of counts) {
    let best = "";
    let bestN = -1;
    for (const [code, n] of m) if (n > bestN) [best, bestN] = [code, n];
    out.set(desc, best);
  }
  return out;
}

/**
 * Keeps, for each code, only the campus that owns it: the description with the
 * most sections across **all terms** (`totals`), mapped only when it has
 * sections this term (`perUnit` keys are `${campus}|${subject}`). Satellite
 * campuses whose rooms share a code (e.g. "Waianae Educational Center-LEE" →
 * LEE) have their own Banner campus that crseavail doesn't list, so querying
 * the owner's code for them would return the owner's sections (or nothing).
 * They are left unmapped and go to Banner.
 *
 * Ownership is judged across all terms, not this one, because a satellite can
 * outnumber its owner in a single term: in summer terms "Outreach College-UHM"
 * (701 sections in 201840) dwarfs "University of Hawaii at Manoa" (1), and
 * "General Funds" (90) beats "Windward Community College" (26). Handing them
 * MAN/WIN queried crseavail for sections it doesn't list under those codes, so
 * the first unit failed the count check and tripped the run's breaker.
 */
export function ownCampusCodes(
  codes: Map<string, string>,
  perUnit: Map<string, number>,
  totals: Map<string, number>
): Map<string, string> {
  const present = new Set<string>();
  for (const [u, n] of perUnit) if (n > 0) present.add(u.slice(0, u.lastIndexOf("|")));
  const owner = new Map<string, { campus: string; n: number }>();
  for (const [campus, code] of codes) {
    const n = totals.get(campus) ?? 0;
    const cur = owner.get(code);
    if (!cur || n > cur.n) owner.set(code, { campus, n });
  }
  const out = new Map<string, string>();
  for (const [code, o] of owner) if (present.has(o.campus)) out.set(o.campus, code);
  return out;
}

type Facts = Omit<CourseFacts, "collegeName" | "department" | "scheduleTypes">;

export function buildCourseFacts(
  rows: { courses: CaCourseRow[]; descs: CaCourseDescRow[]; grading: CaGradingRow[] },
  index: CrnIndex
): Map<string, { key: CourseKey; facts: Facts; crns: string[] }> {
  const out = new Map<string, { key: CourseKey; facts: Facts; crns: string[] }>();
  const descByCrn = new Map<string, CaCourseDescRow>();
  for (const d of rows.descs) if (!descByCrn.has(d.ssbsectCrn1)) descByCrn.set(d.ssbsectCrn1, d);
  const gradingByCrn = new Map<string, Set<string>>();
  for (const g of rows.grading) {
    const s = gradingByCrn.get(g.ssbsectCrn1) ?? new Set<string>();
    s.add(`${g.desc}  ${g.gmodCode}`);
    gradingByCrn.set(g.ssbsectCrn1, s);
  }
  const gradingSets = new Map<string, Set<string>>();

  for (const c of rows.courses) {
    const key = index.get(c.ssbsectCrn1);
    if (!key) continue;
    const mk = `${key.campus}|${key.subject}|${key.courseNumber}`;
    let e = out.get(mk);
    if (!e) {
      const text = descByCrn.get(c.ssbsectCrn1)?.textNarrative?.trimEnd();
      e = {
        key,
        facts: {
          collegeCode: c.collCode ?? null,
          departmentCode: c.deptCode ?? null,
          gradingModes: [],
          creditBreakdown: {
            creditHours: c.creditHrLow ?? null,
            creditHrLow: c.creditHrLow ?? null,
            creditHrHigh: c.creditHrHigh ?? null,
            lecHrLow: c.lecHrLow ?? null,
            labHrLow: c.labHrLow ?? null,
            othHrLow: c.othHrLow ?? null,
            contHrLow: c.contHrLow ?? null,
            billHrLow: c.billHrLow ?? null,
            repeatLimit: c.repeatLimit ?? null,
            maxRptUnits: c.maxRptUnits ?? null,
          },
          description: text ? text : null,
        },
        crns: [],
      };
      out.set(mk, e);
      gradingSets.set(mk, new Set());
    }
    if (!e.crns.includes(c.ssbsectCrn1)) {
      e.crns.push(c.ssbsectCrn1);
      for (const g of gradingByCrn.get(c.ssbsectCrn1) ?? []) gradingSets.get(mk)!.add(g);
    }
  }
  for (const [mk, e] of out) e.facts.gradingModes = [...gradingSets.get(mk)!].sort();
  return out;
}

export function crossListMap(rows: CaCrossListRow[], termCrns: string[]): Map<string, string[] | null> {
  const groups = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = groups.get(r.ssrxlstXlstGroup) ?? new Set<string>();
    s.add(r.ssbsectCrn);
    groups.set(r.ssrxlstXlstGroup, s);
  }
  const groupOf = new Map<string, string>();
  for (const [g, s] of groups) for (const c of s) if (!groupOf.has(c)) groupOf.set(c, g);
  const out = new Map<string, string[] | null>();
  for (const crn of termCrns) {
    const g = groupOf.get(crn);
    const others = g ? [...groups.get(g)!].filter((c) => c !== crn).sort((a, b) => Number(a) - Number(b)) : [];
    out.set(crn, others.length ? others : null);
  }
  return out;
}

export function deriveScheduleTypes(rawJsons: string[]): string[] {
  const set = new Set<string>();
  for (const rj of rawJsons) {
    const raw = JSON.parse(rj) as RawSection;
    const code = (raw.meetingsFaculty ?? []).map((m) => m?.meetingTime?.meetingScheduleType).find((x) => !!x);
    if (code && raw.scheduleTypeDescription) set.add(`${raw.scheduleTypeDescription}  ${code}`);
  }
  return [...set].sort();
}
