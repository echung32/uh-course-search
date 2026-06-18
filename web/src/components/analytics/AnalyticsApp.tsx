"use client";

import * as React from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { EnrollmentOverTime, type CourseTrendPoint } from "./EnrollmentOverTime";
import { UniversityTrend, type FacetTrendPoint } from "./UniversityTrend";
import { DeliveryModeShift } from "./DeliveryModeShift";
import { FillRateLeaderboard, type LeaderboardRow } from "./FillRateLeaderboard";

interface TermItem { code: string; description: string }
interface CourseOption { subject: string; courseNumber: string; subjectCourse: string | null }

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
}: {
  terms: TermItem[];
  courses: CourseOption[];
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

  // ── Chart #1: enrollment over time ──
  const courseOptions: ComboboxOption[] = React.useMemo(
    () =>
      courses.map((c) => ({
        value: `${c.subject}|${c.courseNumber}`,
        label: c.subjectCourse ?? `${c.subject} ${c.courseNumber}`,
        keywords: c.subject,
      })),
    [courses]
  );
  const [courseKey, setCourseKey] = React.useState(courseOptions[0]?.value ?? "");
  const [trend, setTrend] = React.useState<CourseTrendPoint[]>([]);
  React.useEffect(() => {
    if (!courseKey) return;
    const [subject, courseNumber] = courseKey.split("|");
    fetch(`/api/analytics/enrollment-trend?subject=${encodeURIComponent(subject)}&courseNumber=${encodeURIComponent(courseNumber)}`)
      .then((r) => r.json())
      .then((d) => setTrend(d.points ?? []))
      .catch(() => setTrend([]));
  }, [courseKey]);

  // ── Chart #4: university trend ──
  const [facet, setFacet] = React.useState<"campus" | "college">("campus");
  const [uni, setUni] = React.useState<FacetTrendPoint[]>([]);
  React.useEffect(() => {
    fetch(`/api/analytics/university-trend?facet=${facet}`)
      .then((r) => r.json())
      .then((d) => setUni(d.points ?? []))
      .catch(() => setUni([]));
  }, [facet]);

  // ── Chart #5: delivery mode ──
  const [delivery, setDelivery] = React.useState<FacetTrendPoint[]>([]);
  React.useEffect(() => {
    fetch(`/api/analytics/delivery-mode`)
      .then((r) => r.json())
      .then((d) => setDelivery(d.points ?? []))
      .catch(() => setDelivery([]));
  }, []);

  // ── Chart #2: fill-rate leaderboard ──
  const termOptions: ComboboxOption[] = React.useMemo(
    () => terms.map((t) => ({ value: t.code, label: t.description })),
    [terms]
  );
  const [lbTerm, setLbTerm] = React.useState(terms[0]?.code ?? "");
  const [rows, setRows] = React.useState<LeaderboardRow[]>([]);
  React.useEffect(() => {
    if (!lbTerm) return;
    fetch(`/api/analytics/fill-rate?term=${encodeURIComponent(lbTerm)}&limit=20`)
      .then((r) => r.json())
      .then((d) => setRows(d.rows ?? []))
      .catch(() => setRows([]));
  }, [lbTerm]);

  return (
    <div className="space-y-6">
      <Section title="Course enrollment over time" description="Enrollment, capacity, and waitlist per term for one course (summed across campuses).">
        <div className="mb-3 max-w-xs">
          <Combobox
            options={courseOptions}
            value={courseKey}
            onChange={setCourseKey}
            placeholder="Select a course"
            searchPlaceholder="Search courses"
          />
        </div>
        <EnrollmentOverTime points={trend} termLabel={termLabel} />
      </Section>

      <Section title="University enrollment trend" description="Total enrollment per term, stacked by campus or college.">
        <div className="mb-3 flex gap-2">
          <Button type="button" size="sm" variant={facet === "campus" ? "default" : "outline"} onClick={() => setFacet("campus")}>By campus</Button>
          <Button type="button" size="sm" variant={facet === "college" ? "default" : "outline"} onClick={() => setFacet("college")}>By college</Button>
        </div>
        <UniversityTrend points={uni} termLabel={termLabel} />
      </Section>

      <Section title="Delivery-mode shift" description="Share of sections by schedule type over time.">
        <DeliveryModeShift points={delivery} termLabel={termLabel} />
      </Section>

      <Section title="Hardest to get into" description="Courses ranked by fill rate (enrollment ÷ capacity) for the selected term.">
        <div className="mb-3 max-w-xs">
          <Combobox
            options={termOptions}
            value={lbTerm}
            onChange={setLbTerm}
            placeholder="Select a term"
            searchPlaceholder="Search terms"
          />
        </div>
        <FillRateLeaderboard rows={rows} />
      </Section>
    </div>
  );
}
