"use client";

import * as React from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { EnrollmentOverTime, type CourseTrendPoint } from "./EnrollmentOverTime";
import { UniversityTrend, type FacetTrendPoint } from "./UniversityTrend";
import { DeliveryModeShift } from "./DeliveryModeShift";
import { FillRateLeaderboard, type LeaderboardRow } from "./FillRateLeaderboard";
import { SubjectGrowth } from "./SubjectGrowth";
import { MeetingHeatmap, type MeetingHeatCell } from "./MeetingHeatmap";
import { classifyTerm, defaultSnapshotTerm, stripViewOnly, type Semester } from "./termFilter";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { NuqsAdapter } from "nuqs/adapters/react";
import {
  useQueryStates,
  parseAsString,
  parseAsStringLiteral,
  parseAsBoolean,
} from "nuqs";

interface TermItem { code: string; description: string }
interface CourseOption { subject: string; subjectCourse: string }

interface AnalyticsAppProps {
  terms: TermItem[];
  courses: CourseOption[];
  campuses: string[];
  /** Term codes that actually have rollup data, for the range selector. */
  rollupTerms: string[];
}

/** One chart card. */
function Section({ title, description, children }: {
  title: string; description: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mb-3 text-sm text-muted-foreground">{description}</p>
      {children}
    </section>
  );
}

/**
 * A group of charts that share one filter bar. The bar sits in the group's
 * tinted header and its subtitle states it applies to every chart below, so a
 * reader can tell group-wide filters from a chart's own ("This chart") controls.
 */
function ControlGroup({ id, title, subtitle, controls, children }: {
  id: string; title: string; subtitle: string;
  controls: React.ReactNode; children: React.ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="overflow-hidden rounded-lg border">
      <div className="border-b bg-muted/50 p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 id={headingId} className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {controls}
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

/** A chart's own controls, visibly marked as affecting only that chart. */
function LocalControls({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-dashed px-2 py-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        This chart
      </span>
      {children}
    </div>
  );
}

function AnalyticsAppInner({
  terms,
  courses,
  campuses,
  rollupTerms,
}: AnalyticsAppProps) {
  const termLabelMap = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const t of terms) m.set(t.code, t.description);
    return m;
  }, [terms]);
  const termLabel = React.useCallback(
    (code: string) => termLabelMap.get(code) ?? code,
    [termLabelMap]
  );
  // Charts drop the "(View Only)" marker for less axis clutter; the dropdowns
  // keep the full description so view-only terms are still identifiable there.
  const chartTermLabel = React.useCallback(
    (code: string) => stripViewOnly(termLabel(code)),
    [termLabel]
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
  // Term range + filters live in the URL (nuqs) so a view is shareable. The
  // range is a preset ("3y"/"5y"/"all") or "custom" with explicit from/to terms.
  const [q, setQ] = useQueryStates(
    {
      range: parseAsStringLiteral(["3y", "5y", "all", "custom"] as const).withDefault("5y"),
      from: parseAsString.withDefault(""),
      to: parseAsString.withDefault(""),
      fall: parseAsBoolean.withDefault(true),
      spring: parseAsBoolean.withDefault(true),
      summer: parseAsBoolean.withDefault(false),
      special: parseAsBoolean.withDefault(false),
      // "Term snapshot" group: drives both single-term charts (Course demand +
      // When classes meet). Empty term = the default (see snapshotTerm below).
      term: parseAsString.withDefault(""),
      campus: parseAsString.withDefault(""),
    },
    { history: "replace" }
  );

  // Resolve the active range to concrete [rangeLo, rangeHi] bounds.
  const presetStart = (r: typeof q.range) =>
    r === "3y" ? firstTermWithinYears(3) : firstTermWithinYears(5);
  const effFrom =
    q.range === "custom" ? q.from || oldest : q.range === "all" ? oldest : presetStart(q.range);
  const effTo = q.range === "custom" ? q.to || newest : newest;
  const rangeLo = effFrom <= effTo ? effFrom : effTo;
  const rangeHi = effFrom <= effTo ? effTo : effFrom;
  const inRange = React.useCallback(
    (code: string) =>
      (!rangeLo || code >= rangeLo) && (!rangeHi || code <= rangeHi),
    [rangeLo, rangeHi]
  );

  // Semester + special-session filters (apply to the trend charts alongside the
  // range). Default: Fall + Spring on; Summer off (its much smaller enrollment
  // makes every trend line sawtooth) and special sub-terms (Extension /
  // Apprenticeship) hidden.
  type BaseSemester = Exclude<Semester, "Other">;
  const semesters: Record<BaseSemester, boolean> = React.useMemo(
    () => ({ Fall: q.fall, Spring: q.spring, Summer: q.summer }),
    [q.fall, q.spring, q.summer]
  );
  const showSpecial = q.special;
  const toggleSemester = (s: BaseSemester) => {
    const key = s.toLowerCase() as "fall" | "spring" | "summer";
    setQ({ [key]: !semesters[s] });
  };
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
  // Range presets.
  function setLastYears(years: number) {
    setQ({ range: years === 3 ? "3y" : "5y", from: "", to: "" });
  }
  function resetRange() {
    setQ({ range: "all", from: "", to: "" });
  }
  const isFullRange = q.range === "all";
  const isLastYears = (years: number) => q.range === (years === 3 ? "3y" : "5y");
  // The range comboboxes show the resolved bounds; picking a term switches to
  // custom mode (To stays empty in preset mode so it reads as "Latest").
  const setFromTerm = (v: string) =>
    setQ({ range: "custom", from: v, to: q.range === "custom" ? q.to : "" });
  const setToTerm = (v: string) =>
    setQ({ range: "custom", to: v, from: q.range === "custom" ? q.from : rangeLo });
  const fromValue = effFrom;
  const toValue = q.range === "custom" ? q.to : "";

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
  // Default to ICS 101 (normalised match) when present, else the first course.
  const defaultCourseKey = React.useMemo(() => {
    const ics101 = courseOptions.find(
      (o) => o.value.replace(/\s+/g, "").toUpperCase() === "ICS101"
    );
    return ics101?.value ?? courseOptions[0]?.value ?? "";
  }, [courseOptions]);
  const [courseKey, setCourseKey] = React.useState(defaultCourseKey);
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
  const campusOptions: ComboboxOption[] = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const p of trend) {
      totals.set(p.campus, (totals.get(p.campus) ?? 0) + p.enrollment);
    }
    const dataSorted = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const withData = new Set(dataSorted);
    const noData = campuses.filter((c) => !withData.has(c));
    return [
      ...dataSorted.map((name) => ({ value: name, label: name })),
      ...noData.map((name) => ({ value: name, label: name, disabled: true })),
    ];
  }, [trend, campuses]);
  // Reset to "All campuses" (summed) when the course changes — the default view.
  React.useEffect(() => {
    setCampus("");
  }, [courseKey]);
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
  // The "Term snapshot" group's effective term: the URL's, else the newest base
  // rollup term (skipping Extension/Apprenticeship/Accelerated sub-terms, which
  // sort after their semester but cover few courses). Computed from the page's
  // own rollupTerms, so both charts request one concrete term from their first
  // fetch — no term-less fetch whose late response could clobber a user's pick.
  const snapshotTerm = React.useMemo(
    () => q.term || defaultSnapshotTerm(sortedTerms, termLabel),
    [q.term, sortedTerms, termLabel]
  );
  const [rows, setRows] = React.useState<LeaderboardRow[]>([]);
  React.useEffect(() => {
    let stale = false; // drop a superseded response (fast term/campus switches)
    const params = new URLSearchParams({ limit: "20" });
    if (snapshotTerm) params.set("term", snapshotTerm);
    if (q.campus) params.set("campus", q.campus);
    fetch(`/api/analytics/fill-rate?${params}`)
      .then((r) => r.json())
      .then((d) => { if (!stale) setRows(d.rows ?? []); })
      .catch(() => { if (!stale) setRows([]); });
    return () => { stale = true; };
  }, [snapshotTerm, q.campus]);

  // ── Chart #6: subject growth ranking ──
  // Shares the dashboard term-range + semester filters: growth is measured
  // between the earliest and latest term that survive `passesTerm`.
  const [subjectTrend, setSubjectTrend] = React.useState<FacetTrendPoint[]>([]);
  React.useEffect(() => {
    fetch(`/api/analytics/subject-trend`)
      .then((r) => r.json())
      .then((d) => setSubjectTrend(d.points ?? []))
      .catch(() => setSubjectTrend([]));
  }, []);
  const subjectInRange = React.useMemo(
    () => subjectTrend.filter((p) => passesTerm(p.term)),
    [subjectTrend, passesTerm]
  );

  // ── Chart #7: meeting-time heatmap ──
  // Shares the "Term snapshot" group's term + campus.
  const [heat, setHeat] = React.useState<MeetingHeatCell[]>([]);
  React.useEffect(() => {
    if (!snapshotTerm) return;
    let stale = false;
    const params = new URLSearchParams({ term: snapshotTerm });
    if (q.campus) params.set("campus", q.campus);
    fetch(`/api/analytics/meeting-heatmap?${params}`)
      .then((r) => r.json())
      .then((d) => { if (!stale) setHeat(d.cells ?? []); })
      .catch(() => { if (!stale) setHeat([]); });
    return () => { stale = true; };
  }, [snapshotTerm, q.campus]);

  return (
    <div className="space-y-8">
      <ControlGroup
        id="trends"
        title="Trends over time"
        subtitle="These filters apply to all 4 charts in this group"
        controls={
          <>
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
              <div>
                <p className="mb-1 text-sm font-medium">Term range</p>
                <div className="flex items-center gap-2">
                  <div className="w-40">
                    <Combobox
                      options={termRangeOptions}
                      value={fromValue}
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
                      value={toValue}
                      onChange={setToTerm}
                      clearLabel={newest ? `Latest (${termLabel(newest)})` : "Latest"}
                      placeholder="Latest"
                      searchPlaceholder="Search terms"
                    />
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant={isLastYears(3) ? "default" : "outline"} aria-pressed={isLastYears(3)} onClick={() => setLastYears(3)}>Last 3 yrs</Button>
                <Button type="button" size="sm" variant={isLastYears(5) ? "default" : "outline"} aria-pressed={isLastYears(5)} onClick={() => setLastYears(5)}>Last 5 yrs</Button>
                <Button type="button" size="sm" variant={isFullRange ? "default" : "outline"} aria-pressed={isFullRange} onClick={resetRange}>All time</Button>
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
                onClick={() => setQ({ special: !showSpecial })}
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
                    Off-cycle sub-terms — Extension, Apprenticeship, and Accelerated
                    sessions.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </>
        }
      >
        <Section title="Course enrollment over time" description="Enrollment and capacity per term for one course, for one campus or summed across all.">
          <LocalControls>
            <div className="min-w-48 max-w-xs flex-1">
              <Combobox
                options={courseOptions}
                value={courseKey}
                onChange={setCourseKey}
                placeholder="Select a course"
                searchPlaceholder="Search courses"
              />
            </div>
            <div className="min-w-48 max-w-xs flex-1">
              <Combobox
                options={campusOptions}
                value={campus}
                onChange={setCampus}
                clearLabel="All campuses"
                placeholder="All campuses"
                searchPlaceholder="Search campuses"
              />
            </div>
          </LocalControls>
          <EnrollmentOverTime points={shownPoints} termLabel={chartTermLabel} />
        </Section>

        <Section title="University enrollment trend" description="Total enrollment per term, stacked by campus or college.">
          <LocalControls>
            <Button type="button" size="sm" variant={facet === "campus" ? "default" : "outline"} aria-pressed={facet === "campus"} onClick={() => setFacet("campus")}>By campus</Button>
            <Button type="button" size="sm" variant={facet === "college" ? "default" : "outline"} aria-pressed={facet === "college"} onClick={() => setFacet("college")}>By college</Button>
          </LocalControls>
          <UniversityTrend points={uniInRange} rankPoints={uni} termLabel={chartTermLabel} />
        </Section>

        <Section title="Delivery-mode shift" description="Share of sections by schedule type over time.">
          <DeliveryModeShift points={deliveryInRange} rankPoints={delivery} termLabel={chartTermLabel} />
        </Section>

        <Section title="Subject growth" description="Subjects with the largest enrollment increase and decrease between the first and last term in the selected range.">
          <SubjectGrowth points={subjectInRange} termLabel={chartTermLabel} />
        </Section>
      </ControlGroup>

      <ControlGroup
        id="term-snapshot"
        title="Term snapshot"
        subtitle="These filters apply to both charts in this group"
        controls={
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <div className="w-full max-w-xs">
              <p className="mb-1 text-sm font-medium">Term</p>
              <Combobox
                options={termOptions}
                value={snapshotTerm}
                onChange={(v) => setQ({ term: v })}
                placeholder="Select a term"
                searchPlaceholder="Search terms"
              />
            </div>
            <div className="w-full max-w-xs">
              <p className="mb-1 text-sm font-medium">Campus</p>
              <Combobox
                options={campusFilterOptions}
                value={q.campus}
                onChange={(v) => setQ({ campus: v })}
                clearLabel="All campuses"
                placeholder="All campuses"
                searchPlaceholder="Search campuses"
              />
            </div>
          </div>
        }
      >
        <Section title="Course demand" description="Courses ranked by fill rate (enrollment ÷ capacity) for the selected term.">
          <FillRateLeaderboard rows={rows} />
        </Section>

        <Section title="When classes meet" description="Number of class meetings by day of week and start time for the selected term.">
          <MeetingHeatmap cells={heat} />
        </Section>
      </ControlGroup>
    </div>
  );
}

export function AnalyticsApp(props: AnalyticsAppProps) {
  return (
    <NuqsAdapter>
      <AnalyticsAppInner {...props} />
    </NuqsAdapter>
  );
}
