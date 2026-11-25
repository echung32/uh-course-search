import { useState, useEffect, useRef } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { MultiCombobox } from "@/components/ui/multi-combobox";
import type { AutocompleteItem, TermListItem } from "@/lib/sis/types";
import {
  UH_CAMPUSES,
  DEFAULT_CAMPUS,
  ALL_CAMPUSES,
  campusDescriptionForCode,
} from "@/lib/campuses";
import { attributeFamily, FAMILY_LABEL } from "@/lib/attributes";

export interface SearchFormValues {
  term: string;
  subject: string;
  courseNumber: string;
  campus: string;
  college: string;
  department: string;
  openOnly: boolean;
  /** CRN search: when set, identifies one section and overrides every other filter. */
  crn: string;
  /** Attribute codes to filter by (e.g. ["WI","ETH"]); a section must carry all of them. */
  attributes: string[];
}

interface SearchFormProps {
  terms: TermListItem[];
  /** Draft seed, derived from the shareable URL state. */
  initialValues: SearchFormValues;
  onSearch: (params: SearchFormValues) => void;
  isLoading: boolean;
}

/**
 * The most recent "regular" term to preselect — skipping Extension /
 * Apprenticeship / View-Only variants so the default lands on the main semester
 * (e.g. "Fall 2026", not "Fall 2026 Extension"). Terms arrive most-recent-first.
 */
export function pickDefaultTerm(terms: AutocompleteItem[]): string {
  const isRegular = (desc: string) =>
    !/extension|apprenticeship|\(view only\)/i.test(desc);
  const regular = terms.find((t) => isRegular(t.description));
  return (regular ?? terms[0])?.code ?? "";
}

// Banner descriptions arrive HTML-encoded (e.g. "Auto Body Repair &amp; …");
// decode the handful of common entities so labels read naturally.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const toOptions = (items: AutocompleteItem[]): ComboboxOption[] =>
  items.map((i) => ({ value: i.code, label: decodeEntities(i.description) }));

// ── auto-search ──────────────────────────────────────────────────────────────
//
// The form commits a search on its own once the draft settles, so the Search
// button is a "now" shortcut rather than a requirement. Typed fields and the
// attribute multi-select wait out a debounce (with a visible countdown); the
// single-choice controls commit almost at once — their short delay only
// coalesces the cascading resets (term → clears subject, campus → clears
// college) into one search.

/** Debounce for course number, CRN, and attributes before an auto-search fires. */
export const TYPING_DEBOUNCE_MS = 400;
/** Coalescing delay for single-choice controls (comboboxes, switch). */
const DISCRETE_DELAY_MS = 120;

// Both are exact-match filters, so a partial value ("1", "11") can only ever
// return nothing — and on a dynamic term would cost a live Banner call — so
// auto-search waits until the value looks complete. Manual Search still sends
// whatever was typed.
const COURSE_NUMBER_RE = /^\d{3,4}[A-Z]{0,2}$/i;
const CRN_RE = /^\d{5}$/;

/** Whether the draft is complete enough to search without an explicit submit. */
export function isAutoSearchable(v: SearchFormValues): boolean {
  if (!v.term) return false;
  if (v.crn) return CRN_RE.test(v.crn);
  return !v.courseNumber || COURSE_NUMBER_RE.test(v.courseNumber);
}

/**
 * Identity of a filter set (everything but paging). The form and SearchApp both
 * key on it, so the app can tell the form's own commit apart from a Back/Forward
 * navigation (only the latter re-seeds the form).
 */
export function formValuesKey(v: SearchFormValues): string {
  return [
    v.term,
    v.subject,
    v.courseNumber,
    v.campus,
    v.college,
    v.department,
    v.openOnly,
    v.crn,
    v.attributes.join(","),
  ].join("|");
}

/** The Search icon's countdown state: a ring that empties over `durationMs`. */
function CountdownRing({ durationMs }: { durationMs: number }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="8" cy="8" r="6" opacity={0.3} />
      <circle
        cx="8"
        cy="8"
        r="6"
        className="search-countdown-arc"
        style={{ animationDuration: `${durationMs}ms` }}
      />
    </svg>
  );
}

export function SearchForm({
  terms,
  initialValues,
  onSearch,
  isLoading,
}: SearchFormProps) {
  // Seed the draft from the URL-derived values; fall back to the most recent
  // regular term when the link carries none.
  const [term, setTerm] = useState(
    () => initialValues.term || pickDefaultTerm(terms),
  );
  const [subject, setSubject] = useState(initialValues.subject);
  const [courseNumber, setCourseNumber] = useState(initialValues.courseNumber);
  const [campus, setCampus] = useState(initialValues.campus || DEFAULT_CAMPUS);
  const [college, setCollege] = useState(initialValues.college);
  const [department, setDepartment] = useState(initialValues.department);
  const [openOnly, setOpenOnly] = useState(initialValues.openOnly);
  const [crn, setCrn] = useState(initialValues.crn);
  const [attributes, setAttributes] = useState<string[]>(initialValues.attributes);
  const [attributeOptions, setAttributeOptions] = useState<AutocompleteItem[]>([]);
  const [attributesLoading, setAttributesLoading] = useState(false);

  const [subjectOptions, setSubjectOptions] = useState<AutocompleteItem[]>([]);
  const [collegeOptions, setCollegeOptions] = useState<AutocompleteItem[]>([]);
  const [departmentOptions, setDepartmentOptions] = useState<AutocompleteItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Subjects depend only on the term (derived from the sections present).
  // Changing term also clears the term-specific selections (subject + course
  // number) — otherwise a stale value lingers in state (the combobox shows its
  // placeholder because the old subject isn't in the new term's list, but the
  // old value is still submitted on the next search). The first run only seeds
  // options for the (possibly URL-supplied) term — it must NOT clear the
  // shared subject/course number.
  const subjectSeeded = useRef(false);
  useEffect(() => {
    if (!term) return;
    if (subjectSeeded.current) {
      setSubject("");
      setCourseNumber("");
    }
    subjectSeeded.current = true;
    let cancelled = false;
    fetch(`/api/filters?term=${encodeURIComponent(term)}&kind=subject`)
      .then((r) => (r.ok ? r.json() : { options: [] }))
      .then((d) => {
        if (!cancelled) setSubjectOptions((d.options ?? []) as AutocompleteItem[]);
      })
      .catch(() => {
        if (!cancelled) setSubjectOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [term]);

  // Attribute menu depends only on the term (sourced from section_attribute).
  const attributesSeeded = useRef(false);
  useEffect(() => {
    if (!term) return;
    if (attributesSeeded.current) {
      setAttributes([]);
    }
    attributesSeeded.current = true;
    let cancelled = false;
    setAttributesLoading(true);
    fetch(`/api/filters?term=${encodeURIComponent(term)}&kind=attribute`)
      .then((r) => (r.ok ? r.json() : { options: [] }))
      .then((d) => {
        if (!cancelled) setAttributeOptions((d.options ?? []) as AutocompleteItem[]);
      })
      .catch(() => {
        if (!cancelled) setAttributeOptions([]);
      })
      .finally(() => {
        if (!cancelled) setAttributesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [term]);

  // College/Department options are catalog-derived and campus-specific, so
  // refetch whenever the term or campus changes (and reset the selections).
  const catalogSeeded = useRef(false);
  useEffect(() => {
    if (!term) return;
    const campusDesc =
      campus !== ALL_CAMPUSES ? campusDescriptionForCode(campus) : null;
    const qs = (kind: string) => {
      const p = new URLSearchParams({ term, kind });
      if (campusDesc) p.set("campus", campusDesc);
      return p.toString();
    };
    let cancelled = false;
    const load = (kind: string) =>
      fetch(`/api/filters?${qs(kind)}`)
        .then((r) => (r.ok ? r.json() : { options: [] }))
        .then((d) => (d.options ?? []) as AutocompleteItem[])
        .catch(() => []);
    setCatalogLoading(true);
    Promise.all([load("college"), load("department")]).then(([col, dep]) => {
      if (cancelled) return;
      setCollegeOptions(col);
      setDepartmentOptions(dep);
      setCatalogLoading(false);
    });
    // Skip clearing on the first run so a shared college/department survives.
    if (catalogSeeded.current) {
      setCollege("");
      setDepartment("");
    }
    catalogSeeded.current = true;
    return () => {
      cancelled = true;
    };
  }, [term, campus]);

  // Whether the selected term has been backfilled (full catalog) vs. dynamic
  // (page-cache only, no catalog facets). Drives honest "not backfilled"
  // messaging — an empty facet alone doesn't mean the term isn't synced.
  const termBackfilled = terms.find((t) => t.code === term)?.backfilled ?? true;

  // College/Department are catalog-derived and campus-scoped, so they're empty
  // (unusable) in two distinct cases that must be messaged differently:
  //   1. the term isn't backfilled (dynamic) — no catalog exists at all; or
  //   2. the term IS backfilled but the selected campus has no catalog rows
  //      (e.g. Outreach/Extension terms, whose campus descriptions never match
  //      the campus menu, default Manoa). Saying "not backfilled" there is a lie.
  // Either way the field is disabled (nothing to pick); only the note differs.
  const collegeUnavailable = !catalogLoading && collegeOptions.length === 0;
  const departmentUnavailable = !catalogLoading && departmentOptions.length === 0;
  const campusSelected = campus !== ALL_CAMPUSES;
  // Attributes (like college/department) are only filterable for backfilled terms
  // whose section_attribute rows exist; the menu is empty otherwise.
  const attributesUnavailable = !attributesLoading && attributeOptions.length === 0;

  // A CRN identifies exactly one section, so a CRN search ignores every other
  // filter — disable them to make that exclusivity obvious.
  const crnMode = crn.trim().length > 0;

  // The normalized draft — exactly what a commit sends.
  const draft: SearchFormValues = {
    term,
    subject: subject.trim().toUpperCase(),
    courseNumber: courseNumber.trim(),
    campus,
    college,
    department,
    openOnly,
    crn: crn.trim(),
    attributes,
  };
  const draftKey = formValuesKey(draft);

  // The filter set last sent to onSearch. Seeded with the mount-time draft (which
  // mirrors the URL), so mounting never auto-commits.
  const committedKey = useRef<string | null>(null);
  if (committedKey.current === null) committedKey.current = draftKey;

  // Delay for the next scheduled commit: change handlers set it before updating
  // state, and cascading resets inherit whichever change caused them. Attributes
  // are debounced like typed fields — a multi-select is usually several picks in
  // a row, which should cost one search, not one per pick.
  const nextDelay = useRef(DISCRETE_DELAY_MS);
  const debounced = <T,>(set: (v: T) => void) => (v: T) => {
    nextDelay.current = TYPING_DEBOUNCE_MS;
    set(v);
  };
  const immediate = <T,>(set: (v: T) => void) => (v: T) => {
    nextDelay.current = DISCRETE_DELAY_MS;
    set(v);
  };

  // `waiting` drives the countdown visuals (debounced fields only — an immediate
  // change commits too fast to be worth showing). `waitTick` remounts them so
  // their CSS animation restarts on every keystroke.
  const [waiting, setWaiting] = useState(false);
  const [waitTick, setWaitTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function commit(values: SearchFormValues) {
    clearTimeout(timer.current);
    timer.current = undefined;
    setWaiting(false);
    committedKey.current = formValuesKey(values);
    onSearch(values);
  }

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (draftKey === committedKey.current || !isAutoSearchable(draft)) {
      setWaiting(false);
      return;
    }
    const delay = nextDelay.current;
    if (delay === TYPING_DEBOUNCE_MS) {
      setWaiting(true);
      setWaitTick((t) => t + 1);
    } else {
      setWaiting(false);
    }
    const values = draft;
    timer.current = setTimeout(() => commit(values), delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  useEffect(() => () => clearTimeout(timer.current), []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term) return;
    commit(draft);
  }

  const campusOptions: ComboboxOption[] = [
    { value: ALL_CAMPUSES, label: "All Campuses" },
    ...UH_CAMPUSES.map((c) => ({ value: c.code, label: c.description })),
  ];

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="term">Term</Label>
          <Combobox
            id="term"
            options={toOptions(terms)}
            value={term}
            onChange={immediate(setTerm)}
            placeholder="Select a term"
            searchPlaceholder="Search terms…"
            emptyText="No terms."
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="subject">Subject</Label>
          <Combobox
            id="subject"
            options={subjectOptions.map((s) => ({
              value: s.code,
              label: `${s.code} — ${decodeEntities(s.description)}`,
              keywords: s.description,
            }))}
            value={subject}
            onChange={immediate(setSubject)}
            placeholder="All Subjects"
            searchPlaceholder="Search subjects…"
            emptyText="No subjects for this term."
            clearLabel="All Subjects"
            disabled={crnMode}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="courseNumber">Course Number</Label>
          <Input
            id="courseNumber"
            placeholder="e.g. 111"
            value={courseNumber}
            onChange={(e) => debounced(setCourseNumber)(e.target.value)}
            maxLength={10}
            disabled={crnMode}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="crn">CRN</Label>
          <Input
            id="crn"
            inputMode="numeric"
            placeholder="e.g. 71843"
            value={crn}
            onChange={(e) => debounced(setCrn)(e.target.value)}
            maxLength={10}
          />
          {crnMode && (
            <p className="text-xs text-muted-foreground">
              Looks up one section in the selected term; other filters are ignored.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="campus">Campus</Label>
          <Combobox
            id="campus"
            options={campusOptions}
            value={campus}
            onChange={immediate(setCampus)}
            placeholder="Select a campus"
            searchPlaceholder="Search campuses…"
            emptyText="No campuses."
            disabled={crnMode}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="college">College</Label>
          <Combobox
            id="college"
            options={toOptions(collegeOptions)}
            value={college}
            onChange={immediate(setCollege)}
            placeholder="All Colleges"
            searchPlaceholder="Search colleges…"
            emptyText="No colleges."
            clearLabel="All Colleges"
            disabled={collegeUnavailable || crnMode}
          />
          {collegeUnavailable &&
            (termBackfilled ? (
              campusSelected && (
                <p className="text-xs text-muted-foreground">
                  No colleges at the selected campus.
                </p>
              )
            ) : (
              <p className="text-xs text-muted-foreground">
                Not available until this term is backfilled.
              </p>
            ))}
        </div>

        <div className="space-y-2">
          <Label htmlFor="department">Department</Label>
          <Combobox
            id="department"
            options={toOptions(departmentOptions)}
            value={department}
            onChange={immediate(setDepartment)}
            placeholder="All Departments"
            searchPlaceholder="Search departments…"
            emptyText="No departments."
            clearLabel="All Departments"
            disabled={departmentUnavailable || crnMode}
          />
          {departmentUnavailable &&
            (termBackfilled ? (
              campusSelected && (
                <p className="text-xs text-muted-foreground">
                  No departments at the selected campus.
                </p>
              )
            ) : (
              <p className="text-xs text-muted-foreground">
                Not available until this term is backfilled.
              </p>
            ))}
        </div>

        <div className="space-y-2">
          <Label htmlFor="attributes">Attributes</Label>
          <MultiCombobox
            id="attributes"
            options={attributeOptions.map((a) => ({
              value: a.code,
              label: `${a.code} — ${decodeEntities(a.description)} (${FAMILY_LABEL[attributeFamily(a.code)]})`,
              keywords: a.description,
            }))}
            value={attributes}
            onChange={debounced(setAttributes)}
            placeholder="All Attributes"
            searchPlaceholder="Search attributes…"
            emptyText="No attributes for this term."
            disabled={attributesUnavailable || crnMode}
          />
          {attributesUnavailable && !termBackfilled ? (
            <p className="text-xs text-muted-foreground">
              Not available until this term is backfilled.
            </p>
          ) : (
            attributes.length > 1 && (
              <p className="text-xs text-muted-foreground">
                Shows sections carrying all selected attributes.
              </p>
            )
          )}
        </div>

      </div>

      <div className="relative flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Progress line over the divider: fills during the debounce, then a
            bar slides along it while the request is in flight. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-px h-0.5 overflow-hidden"
        >
          {isLoading ? (
            <span className="search-progress-slide absolute inset-y-0 w-1/3 bg-primary" />
          ) : waiting ? (
            <span
              key={waitTick}
              className="search-progress-fill absolute inset-0 bg-primary"
              style={{ animationDuration: `${TYPING_DEBOUNCE_MS}ms` }}
            />
          ) : null}
        </div>
        <div className="flex items-center space-x-2">
          <Switch
            id="openOnly"
            checked={openOnly}
            onCheckedChange={immediate(setOpenOnly)}
            disabled={crnMode}
          />
          <Label htmlFor="openOnly">Open sections only</Label>
        </div>

        <Button
          type="submit"
          size="lg"
          disabled={isLoading || !term}
          className="w-full sm:w-auto sm:min-w-48"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : waiting ? (
            <CountdownRing key={waitTick} durationMs={TYPING_DEBOUNCE_MS} />
          ) : (
            <Search className="h-4 w-4" />
          )}
          {isLoading ? "Searching…" : "Search"}
        </Button>
      </div>
    </form>
  );
}
