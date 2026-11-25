// Validated client for UH's public Class Availability JSON API. Plain fetch, no
// session handshake. Every response is shape-checked before being returned so a
// changed/blocked API surfaces as a CrseavailError the caller can fall back on.
import type {
  CaCourseDescRow,
  CaCourseRow,
  CaCrossListRow,
  CaGradingRow,
  CaSubjectRow,
  CaUnit,
} from "./types";

const DEFAULT_BASE = "https://www.sis.hawaii.edu:9350/crseavail/api";
// Duplicated from sis/client.ts on purpose: that module reads SIS_BASE_URL at load.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

let retryDelayMs = 1000;
/** Test hook: base backoff delay (doubles per retry). */
export function __setRetryDelayMs(ms: number): void {
  retryDelayMs = ms;
}

export function crseavailEnabled(): boolean {
  return process.env.CRSEAVAIL === "1";
}

export class CrseavailError extends Error {
  reason: "http" | "not-json" | "shape" | "network";
  status?: number;
  constructor(reason: CrseavailError["reason"], message: string, status?: number) {
    super(message);
    this.name = "CrseavailError";
    this.reason = reason;
    this.status = status;
  }
}

type Kind = "string" | "number" | "nullable-string" | "nullable-number";
type Spec = Record<string, Kind>;

function okKind(v: unknown, k: Kind): boolean {
  switch (k) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "nullable-string":
      return v === null || typeof v === "string";
    case "nullable-number":
      return v === null || (typeof v === "number" && Number.isFinite(v));
  }
}

function validate<T>(path: string, body: unknown, required: Spec, optional: Spec = {}): T[] {
  if (!Array.isArray(body)) throw new CrseavailError("shape", `${path}: expected an array`);
  body.forEach((row, i) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new CrseavailError("shape", `${path}[${i}]: row is not an object`);
    }
    const r = row as Record<string, unknown>;
    for (const [f, k] of Object.entries(required)) {
      if (!okKind(r[f], k)) throw new CrseavailError("shape", `${path}[${i}]: bad or missing "${f}"`);
    }
    for (const [f, k] of Object.entries(optional)) {
      if (r[f] !== undefined && !okKind(r[f], k)) {
        throw new CrseavailError("shape", `${path}[${i}]: bad "${f}"`);
      }
    }
  });
  return body as T[];
}

async function once(url: string): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "X-Recaptcha-Token": "undefined",
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
}

async function getJson(path: string, params?: Record<string, string>): Promise<unknown> {
  const base = (process.env.CRSEAVAIL_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const url = `${base}${path}${qs}`;

  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    let retryable = false;
    let failure: CrseavailError;
    try {
      res = await once(url);
      if (res.status < 500) break;
      failure = new CrseavailError("http", `${path}: HTTP ${res.status}`, res.status);
      retryable = true;
    } catch (e) {
      failure = new CrseavailError("network", `${path}: ${(e as Error).message}`);
      retryable = true;
    }
    if (!retryable || attempt >= MAX_RETRIES) throw failure;
    await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** attempt));
  }

  if (!res.ok) throw new CrseavailError("http", `${path}: HTTP ${res.status}`, res.status);
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new CrseavailError("not-json", `${path}: non-JSON content-type`);
  }
  try {
    return JSON.parse(await res.text());
  } catch {
    throw new CrseavailError("not-json", `${path}: body is not valid JSON`);
  }
}

const unitParams = (u: CaUnit) => ({
  termCode: u.term,
  subjectCode: u.subject,
  campusCode: u.campusCode,
});

export async function caSubjects(): Promise<CaSubjectRow[]> {
  return validate<CaSubjectRow>("/subjects", await getJson("/subjects"), {
    stvtermCode: "string",
    stvtermDesc: "string",
    ssbsectCampCode: "string",
    stvsubjCode: "string",
    stvsubjDesc: "string",
    countStvtermCode: "number",
  });
}

export async function caCrossList(term: string): Promise<CaCrossListRow[]> {
  return validate<CaCrossListRow>("/crosslist", await getJson("/crosslist", { termCode: term }), {
    ssbsectCrn: "string",
    ssbsectCampCode: "string",
    ssrxlstXlstGroup: "string",
  });
}

export async function caCourses(u: CaUnit): Promise<CaCourseRow[]> {
  const num: Kind = "nullable-number";
  return validate<CaCourseRow>(
    "/courses",
    await getJson("/courses", unitParams(u)),
    {
      ssbsectCrn1: "string",
      crseNumb: "string",
      subjCode: "string",
      collCode: "nullable-string",
      deptCode: "nullable-string",
      creditHrLow: num,
    },
    {
      creditHrHigh: num,
      lecHrLow: num,
      labHrLow: num,
      othHrLow: num,
      contHrLow: num,
      billHrLow: num,
      repeatLimit: num,
      maxRptUnits: num,
    }
  );
}

export async function caCourseDesc(u: CaUnit): Promise<CaCourseDescRow[]> {
  return validate<CaCourseDescRow>("/course-desc", await getJson("/course-desc", unitParams(u)), {
    ssbsectCrn1: "string",
    textNarrative: "nullable-string",
  });
}

export async function caCourseGrading(u: CaUnit): Promise<CaGradingRow[]> {
  return validate<CaGradingRow>("/course-grading", await getJson("/course-grading", unitParams(u)), {
    ssbsectCrn1: "string",
    gmodCode: "string",
    desc: "string",
  });
}
