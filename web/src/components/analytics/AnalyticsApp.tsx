"use client";

import * as React from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { EnrollmentOverTime, type CourseTrendPoint } from "./EnrollmentOverTime";
import { UniversityTrend, type FacetTrendPoint } from "./UniversityTrend";
import { DeliveryModeShift } from "./DeliveryModeShift";
import { FillRateLeaderboard, type LeaderboardRow } from "./FillRateLeaderboard";
import { classifyTerm, type Semester } from "./termFilter";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface TermItem { code: string; description: string }
interface CourseOption { subject: string; subjectCourse: string }

function Section({ title, description, children }: {
  title: string; description: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{description}</p>
      {children}
    </section>
  );
}

export function AnalyticsApp({
  terms,
  courses,
  campuses,
  rollupTerms,
}: {
  terms: TermItem[];
  courses: CourseOption[];
  campuses: string[];
  /** Term codes that actually have rollup data, for the range selector. */
  rollupTerms: string[];
}) {
  const termLabelMap = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const t of terms) m.set(t.code, t.description);
    return m;
  }, [terms]);
  const termLabel = React.useCallback(
    (code: string) => termLabelMap.get(code) ?? code,
    [termLabelMap]
  );

  // ── Term range (applies to the three time-series charts) ──
  // Codes are zero-padded (e.g. "202610"), so lexical sort == chronological.
  const sortedTerms = React.useMemo(
    () => [...rollupTerms].sort(),
    [rollupTerms]
  );
  const oldest = sortedTerms[0] ?? "";
  const newest = sortedTerms[sortedTerms.length - 1] ?? "";
  // First term whose year is within `years` of the newest (the "Last N yrs" presets).
  function firstTermWithinYears(years: number): string {
    if (!newest) return "";
    const cutoff = Number(newest.slice(0, 4)) - years;
    return sortedTerms.find((c) => Number(c.slice(0, 4)) >= cutoff) ?? oldest;
  }
  // "" = open end. Default the range to the last 5 years; "" toTerm means "latest".
  const [fromTerm, setFromTerm] = React.useState(() => firstTermWithinYears(5));
  const [toTerm, setToTerm] = React.useState("");
  const lo = fromTerm || oldest;
  const hi = toTerm || newest;
  // Tolerate a reversed pick by ordering the bounds.
  const rangeLo = lo <= hi ? lo : hi;
  const rangeHi = lo <= hi ? hi : lo;
  const inRange = React.useCallback(
    (code: string) =>
      (!rangeLo || code >= rangeLo) && (!rangeHi || code <= rangeHi),
    [rangeLo, rangeHi]
  );
  // Semester + special-session filters (apply to the trend charts alongside the
  // range). Default: all semesters on, special sub-terms (Extension /
  // Apprenticeship) hidden.
  type BaseSemester = Exclude<Semester, "Other">;
  const [semesters, setSemesters] = React.useState<Record<BaseSemester, boolean>>({
    Fall: true,
    Spring: true,
    Summer: true,
  });
  const [showSpecial, setShowSpecial] = React.useState(false);
  const toggleSemester = (s: BaseSemester) =>
    setSemesters((prev) => ({ ...prev, [s]: !prev[s] }));
  // A term shows on the trend charts iff it's in range, its semester is enabled,
  // and (unless special sessions are shown) it's a base term.
  const passesTerm = React.useCallback(
    (code: string) => {
      if (!inRange(code)) return false;
      const { semester, special } = classifyTerm(termLabel(code));
      if (special && !showSpecial) return false;
      if (semester !== "Other" && !semesters[semester]) return false;
      return true;
    },
    [inRange, termLabel, semesters, showSpecial]
  );
  const termRangeOptions: ComboboxOption[] = React.useMemo(
    () => sortedTerms.map((c) => ({ value: c, label: termLabel(c) })),
    [sortedTerms, termLabel]
  );
  // The "To" picker reads newest-first — the latest term is the usual choice.
  const termRangeOptionsDesc = React.useMemo(
    () => [...termRangeOptions].reverse(),
    [termRangeOptions]
  );
  // "Last N years" preset.
  function setLastYears(years: number) {
    setFromTerm(firstTermWithinYears(years));
    setToTerm("");
  }
  function resetRange() {
    setFromTerm("");
    setToTerm("");
  }
  const isFullRange = fromTerm === "" && toTerm === "";

  // ── Chart #1: enrollment over time ──
  // Keyed on the common-course id: a course offered at several campuses is one
  // option, and selecting it loads every campus's series (the campus selector
  // below then filters or sums them).
  const courseOptions: ComboboxOption[] = React.useMemo(
    () =>
      courses.map((c) => ({
        value: c.subjectCourse,
        label: c.subjectCourse,
        keywords: c.subject,
      })),
    [courses]
  );
  const [courseKey, setCourseKey] = React.useState(courseOptions[0]?.value ?? "");
  const [trend, setTrend] = React.useState<CourseTrendPoint[]>([]);
  React.useEffect(() => {
    if (!courseKey) return;
    fetch(`/api/analytics/enrollment-trend?subjectCourse=${encodeURIComponent(courseKey)}`)
      .then((r) => r.json())
      .then((d) => setTrend(d.points ?? []))
      .catch(() => setTrend([]));
  }, [courseKey]);

  // Per-campus selector for the enrollment chart. "" = All campuses (summed).
  // Shows every campus: those with data for this course on top (by enrollment),
  // the rest greyed-out/disabled below so you can see what's missing.
  const [campus, setCampus] = React.useState("");
  const { campusOptions, biggestCampus } = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const p of trend) {
      totals.set(p.campus, (totals.get(p.campus) ?? 0) + p.enrollment);
    }
    const dataSorted = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const withData = new Set(dataSorted);
    const noData = campuses.filter((c) => !withData.has(c));
    const options: ComboboxOption[] = [
      ...dataSorted.map((name) => ({ value: name, label: name })),
      ...noData.map((name) => ({ value: name, label: name, disabled: true })),
    ];
    return { campusOptions: options, biggestCampus: dataSorted[0] ?? "" };
  }, [trend, campuses]);
  // A new course was loaded → default the selector to its biggest campus.
  React.useEffect(() => {
    setCampus(biggestCampus);
  }, [biggestCampus]);
  const shownPoints = React.useMemo(
    () =>
      trend.filter(
        (p) => passesTerm(p.term) && (!campus || p.campus === campus)
      ),
    [campus, trend, passesTerm]
  );

  // ── Chart #4: university trend ──
  const [facet, setFacet] = React.useState<"campus" | "college">("campus");
  const [uni, setUni] = React.useState<FacetTrendPoint[]>([]);
  React.useEffect(() => {
    fetch(`/api/analytics/university-trend?facet=${facet}`)
      .then((r) => r.json())
      .then((d) => setUni(d.points ?? []))
      .catch(() => setUni([]));
  }, [facet]);
  const uniInRange = React.useMemo(
    () => uni.filter((p) => passesTerm(p.term)),
    [uni, passesTerm]
  );

  // ── Chart #5: delivery mode ──
  const [delivery, setDelivery] = React.useState<FacetTrendPoint[]>([]);
  React.useEffect(() => {
    fetch(`/api/analytics/delivery-mode`)
      .then((r) => r.json())
      .then((d) => setDelivery(d.points ?? []))
      .catch(() => setDelivery([]));
  }, []);
  const deliveryInRange = React.useMemo(
    () => delivery.filter((p) => passesTerm(p.term)),
    [delivery, passesTerm]
  );

  // ── Chart #2: fill-rate leaderboard ──
  const termOptions: ComboboxOption[] = React.useMemo(
    () => terms.map((t) => ({ value: t.code, label: t.description })),
    [terms]
  );
  const campusFilterOptions: ComboboxOption[] = React.useMemo(
    () => campuses.map((c) => ({ value: c, label: c })),
    [campuses]
  );
  const [lbTerm, setLbTerm] = React.useState("");
  const [lbCampus, setLbCampus] = React.useState("");
  const [rows, setRows] = React.useState<LeaderboardRow[]>([]);
  React.useEffect(() => {
    const params = new URLSearchParams({ limit: "20" });
    if (lbTerm) params.set("term", lbTerm);
    if (lbCampus) params.set("campus", lbCampus);
    fetch(`/api/analytics/fill-rate?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setRows(d.rows ?? []);
        // On the initial empty-term load, sync the picker to the term the API chose.
        if (!lbTerm && d.term) setLbTerm(d.term);
      })
      .catch(() => setRows([]));
  }, [lbTerm, lbCampus]);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div>
            <p className="mb-1 text-sm font-medium">Term range</p>
            <div className="flex items-center gap-2">
              <div className="w-40">
                <Combobox
                  options={termRangeOptions}
                  value={fromTerm}
                  onChange={setFromTerm}
                  clearLabel={oldest ? `Earliest (${termLabel(oldest)})` : "Earliest"}
                  placeholder="Earliest"
                  searchPlaceholder="Search terms"
                />
              </div>
              <span className="text-sm text-muted-foreground">to</span>
              <div className="w-40">
                <Combobox
                  options={termRangeOptionsDesc}
                  value={toTerm}
                  onChange={setToTerm}
                  clearLabel={newest ? `Latest (${termLabel(newest)})` : "Latest"}
                  placeholder="Latest"
                  searchPlaceholder="Search terms"
                />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setLastYears(3)}>Last 3 yrs</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setLastYears(5)}>Last 5 yrs</Button>
            <Button type="button" size="sm" variant={isFullRange ? "default" : "outline"} onClick={resetRange}>All time</Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Semesters</span>
          {(["Fall", "Spring", "Summer"] as const).map((s) => (
            <Button
              key={s}
              type="button"
              size="sm"
              variant={semesters[s] ? "default" : "outline"}
              aria-pressed={semesters[s]}
              onClick={() => toggleSemester(s)}
            >
              {s}
            </Button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <Button
            type="button"
            size="sm"
            variant={showSpecial ? "default" : "outline"}
            aria-pressed={showSpecial}
            onClick={() => setShowSpecial((v) => !v)}
          >
            Special sessions
          </Button>
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="What are special sessions?"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Info className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Off-cycle sub-terms — Extension and Apprenticeship sessions — kept
                separate from the standard Fall/Spring/Summer terms.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Applies to the trend charts below.</p>
      </div>

      <Section title="Course enrollment over time" description="Enrollment, capacity, and waitlist per term for one course, for one campus or summed across all.">
        <div className="mb-3 flex flex-wrap gap-2">
          <div className="max-w-xs flex-1">
            <Combobox
              options={courseOptions}
              value={courseKey}
              onChange={setCourseKey}
              placeholder="Select a course"
              searchPlaceholder="Search courses"
            />
          </div>
          <div className="max-w-xs flex-1">
            <Combobox
              options={campusOptions}
              value={campus}
              onChange={setCampus}
              clearLabel="All campuses"
              placeholder="All campuses"
              searchPlaceholder="Search campuses"
            />
          </div>
        </div>
        <EnrollmentOverTime points={shownPoints} termLabel={termLabel} />
      </Section>

      <Section title="University enrollment trend" description="Total enrollment per term, stacked by campus or college.">
        <div className="mb-3 flex gap-2">
          <Button type="button" size="sm" variant={facet === "campus" ? "default" : "outline"} onClick={() => setFacet("campus")}>By campus</Button>
          <Button type="button" size="sm" variant={facet === "college" ? "default" : "outline"} onClick={() => setFacet("college")}>By college</Button>
        </div>
        <UniversityTrend points={uniInRange} termLabel={termLabel} />
      </Section>

      <Section title="Delivery-mode shift" description="Share of sections by schedule type over time.">
        <DeliveryModeShift points={deliveryInRange} termLabel={termLabel} />
      </Section>

      <Section title="Hardest to get into" description="Courses ranked by fill rate (enrollment ÷ capacity) for the selected term, across all campuses or one.">
        <div className="mb-3 flex flex-wrap gap-2">
          <div className="max-w-xs flex-1">
            <Combobox
              options={termOptions}
              value={lbTerm}
              onChange={setLbTerm}
              placeholder="Select a term"
              searchPlaceholder="Search terms"
            />
          </div>
          <div className="max-w-xs flex-1">
            <Combobox
              options={campusFilterOptions}
              value={lbCampus}
              onChange={setLbCampus}
              clearLabel="All campuses"
              placeholder="All campuses"
              searchPlaceholder="Search campuses"
            />
          </div>
        </div>
        <FillRateLeaderboard rows={rows} />
      </Section>
    </div>
  );
}
