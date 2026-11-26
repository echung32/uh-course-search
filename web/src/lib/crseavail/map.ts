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

export function buildCampusCodeMap(pairs: Array<{ campusDescription: string; code: string }>): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const { campusDescription, code } of pairs) {
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
