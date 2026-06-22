# Persistent, device-saved rows-per-page (max 250)

**Date:** 2026-06-22
**Status:** Design approved, pending spec review

## Problem

The search results table lets you pick rows-per-page (`[10, 20, 50, 100]`), but the
choice does not persist: every fresh visit resets to the default (20). A user who
prefers 100 rows must re-set it on each visit. We also want to offer a larger page
(up to 250) for users who would rather scroll one long page than paginate.

## Goals

1. **Persist the rows-per-page choice on the user's device** so it becomes their
   personal default, without re-setting it each visit.
2. **Raise the maximum page size to 250.**
3. **Keep native browser Ctrl+F working** across all rendered rows (no virtualization).
4. **Design the persistence layer so additional device-level preferences can be added
   later** (e.g. default campus/term) without new storage plumbing — but ship *only*
   page size now.

## Non-goals

- No `react-window`/virtualization. A 250-row table of this row weight renders fine in
  modern browsers, and virtualization would break native Ctrl+F (it only mounts visible
  rows). We measure in practice and revisit only if it actually janks.
- No server-side / cross-device persistence. Device-local (localStorage) only.
- No other device preferences in this change (campus, term, etc.) — only page size.

## Decisions (from brainstorming)

- **Virtualization:** skip it, measure first. Preserves native Ctrl+F.
- **Persistence vs URL:** *device default seeds, URL wins.* A bare URL (no `size`) uses
  the saved preference; an explicit `?size=` in the URL overrides it for whoever opens
  that link. Changing rows-per-page updates both the URL and the saved preference.
- **Dropdown options:** `[25, 50, 100, 250]` (10 and 20 removed — rarely used; 20 was the
  old default).

## Design

### 1. Device-preferences module (`web/src/lib/devicePrefs.ts`)

A small, client-only helper that stores **all** device preferences as a single
namespaced JSON object under one localStorage key (`uh.prefs`). This keeps storage
atomic and avoids key sprawl as preferences are added.

```ts
// Generic core (not exported beyond the module):
//   readPrefs(): Record<string, unknown>            // parse uh.prefs, {} on miss/error
//   getPref<T>(key, validate, fallback): T          // validate stored value or fall back
//   setPref<T>(key, value): void                    // merge into uh.prefs, write back

const KEY = "uh.prefs";

// Per-preference typed accessor. Adding a future pref = one more of these.
export const pageSizePref = {
  load: (): number => getPref("pageSize", isAllowedPageSize, DEFAULT_PAGE_SIZE),
  save: (n: number): void => setPref("pageSize", n),
};
```

Properties:

- **Safe on the server / first render:** every accessor is guarded by `typeof window`;
  on the server `load()` returns the fallback. No throwing if localStorage is
  unavailable (private mode, disabled) — `getPref`/`setPref` wrap access in try/catch and
  degrade to the fallback / no-op.
- **Validated:** `pageSizePref.load()` only returns a value in the allowed options list
  (`isAllowedPageSize`); a stale or garbage stored value falls back to `DEFAULT_PAGE_SIZE`.
- **Decoupled:** `SearchApp` imports only `pageSizePref` — it never sees the storage key
  or JSON shape. Future prefs add another accessor without touching consumers.

Allowed options and the default live in **one pure, server-safe module**
(`web/src/lib/pageSize.ts`) so they can be shared by the client components *and* the
server API route without dragging localStorage into the server:

```ts
// web/src/lib/pageSize.ts — no browser APIs; importable from server + client.
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;
export const DEFAULT_PAGE_SIZE = 25; // smallest option; first-visit fallback
export const MAX_PAGE_SIZE = 250;    // server clamp ceiling
export const isAllowedPageSize = (n: unknown): n is number =>
  typeof n === "number" && PAGE_SIZE_OPTIONS.includes(n as never);
```

`devicePrefs.ts`, `ResultsTable.tsx`, and `search.ts` all import from here.
`ResultsTable`'s local `PAGE_SIZE_OPTIONS` is removed.

### 2. Seeding the nuqs `size` default (`web/src/components/SearchApp.tsx`)

The component already injects a **dynamic nuqs default** for `term`
(`pickDefaultTerm(terms)` via a `useMemo`, lines ~70–73). Page size uses the identical
pattern: the saved device preference becomes the `size` parser's default.

```ts
// Lazy, stable, client-only read; server → DEFAULT_PAGE_SIZE.
const [savedSize] = useState(() => pageSizePref.load());

const parsers = useMemo(
  () => ({
    ...searchParsers,
    term: parseAsString.withDefault(defaultTerm),
    size: parseAsInteger.withDefault(savedSize),
  }),
  [defaultTerm, savedSize],
);
```

Because the saved preference is the parser **default**, nuqs **omits `size` from the URL
when it equals the saved value**. Consequences, matching "device default seeds, URL wins":

- **Bare site (no `?size`):** `q.size` resolves to the saved preference (e.g. 100); the
  URL stays clean (no `size` param); the mount-time auto-search runs once with the saved
  size — **no double-fetch, no flash.**
- **Explicit `?size=50` in the URL:** that value wins for whoever opens the link.
- The `DEFAULT_PAGE_SIZE` constant in `searchParsers` is just the SSR/no-window fallback;
  the memo override is what applies on the client.

**No hydration mismatch:** the size-dependent UI (`ResultsTable`, including the
rows-per-page selector) only renders after the client-side fetch populates `results`
(`results` starts `null`; the search runs in a `useEffect`). So `q.size` never affects the
server-rendered DOM, and the server/client difference in the default is invisible to
hydration.

### 3. Saving on change (`handlePageSizeChange`)

```ts
function handlePageSizeChange(pageMaxSize: number) {
  pageSizePref.save(pageMaxSize); // persist as the new device default
  setQ({ size: pageMaxSize, page: 1 });
}
```

Writing to localStorage on every change means: open a shared `?size=25` link, bump to
100, and 100 becomes your device default going forward. Intended.

### 4. Raise the cap to 250

- `web/src/components/ResultsTable.tsx` — import `PAGE_SIZE_OPTIONS`/`DEFAULT_PAGE_SIZE`
  from the shared module (remove the local `[10, 20, 50, 100]`). The fallback
  `results?.pageMaxSize ?? 20` becomes `?? DEFAULT_PAGE_SIZE`.
- `web/src/pages/api/search.ts` — the server clamp `Math.min(parseInt(...), 100)`
  (lines ~68–70) becomes `Math.min(..., 250)`. The `isNaN` fallback (`?? 10` at line ~91)
  becomes `DEFAULT_PAGE_SIZE`.
- **Page cache:** no change. `CHUNK_SIZE = 50` and `getSearchPageFromChunks` already
  reassemble arbitrary `(offset, size)`; a 250-row page spans 5 windows.

## Files touched

| File | Change |
| --- | --- |
| `web/src/lib/pageSize.ts` | **New, pure (server-safe).** `PAGE_SIZE_OPTIONS`, `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `isAllowedPageSize`. |
| `web/src/lib/devicePrefs.ts` | **New, client-only.** Generic `uh.prefs` JSON store + `pageSizePref` accessor (imports `pageSize.ts`). |
| `web/src/components/SearchApp.tsx` | Seed `size` default from `pageSizePref.load()`; save on change. |
| `web/src/components/ResultsTable.tsx` | Use shared options/default; drop local list. |
| `web/src/pages/api/search.ts` | Clamp 100 → `MAX_PAGE_SIZE`; isNaN fallback → `DEFAULT_PAGE_SIZE`. |

## Error / edge handling

- localStorage unavailable or throws → `getPref` returns fallback, `setPref` is a no-op;
  feature degrades to "non-persistent" with no crash.
- Stale/garbage stored `pageSize` (e.g. old `20`, or non-numeric) → fails
  `isAllowedPageSize`, falls back to `DEFAULT_PAGE_SIZE`.
- Server-clamped: a hand-crafted `?size=9999` is clamped to 250 server-side; the
  selector shows the clamped/echoed `pageMaxSize` from the response.

## Testing (`web/e2e/search.spec.ts`, read-path fixture term)

1. **Persistence across reload:** change rows-per-page to 100 → reload the bare URL →
   the table shows 100 rows-per-page and the URL has no `size` param (it became the
   saved default).
2. **URL overrides saved preference:** with 100 saved, open `?size=50` → table shows 50.
3. **Cap:** the dropdown offers 250 and selecting it requests/echoes `pageMaxSize=250`.

## Future extension (designed-for, not built)

Adding another device preference later (e.g. default campus) is one new accessor in
`devicePrefs.ts` (`campusPref = { load, save }`) plus its `validate`/`fallback`; the
single `uh.prefs` blob and generic core are reused unchanged.
