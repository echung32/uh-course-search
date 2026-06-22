# Persistent Device-Saved Page Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user save their preferred rows-per-page on their device (so it persists across visits), and raise the maximum page size to 250.

**Architecture:** A new pure constants module (`pageSize.ts`) is shared by the search UI and the API route. A new client-only `devicePrefs.ts` stores preferences in a single `uh.prefs` localStorage JSON blob behind a typed `pageSizePref` accessor. `SearchApp` seeds the nuqs `size` parser *default* from the saved preference — exactly mirroring the existing dynamic `term` default — so a bare URL shows the saved size with a clean querystring and no double-fetch, while an explicit `?size=` in the URL still wins.

**Tech Stack:** Astro SSR + React islands, nuqs (URL state), Tailwind/shadcn `Select`, Playwright e2e (the only test runner — there is no unit-test runner; pure modules are verified by `yarn build` typecheck and exercised through e2e).

## Global Constraints

- Run all `web/` commands from `web/` (Yarn 4 PnP). Install via `yarn` from root or `web/`.
- **`yarn build` is the real typecheck** (`astro check`'s binary doesn't resolve under PnP). Use it to verify compilation/types.
- **`yarn test` is Playwright e2e** over the full SSR build (`build` + `preview`) — never the live SIS. Single test: `yarn test --project=chromium -g "<title>"`.
- **e2e port-reuse footgun:** Playwright `reuseExistingServer` will silently test a stray dev server on `:4321`. Before running e2e, ensure no `yarn dev` is running on 4321.
- Allowed page-size options are exactly `[25, 50, 100, 250]`; first-visit default (no saved pref) is `25`; server clamp ceiling is `250`.
- Keep the plain (non-virtualized) table — native Ctrl+F must keep working. Do NOT add react-window.
- Device persistence is localStorage-only; degrade silently (no throw, fall back) when localStorage is unavailable.
- Scope is page size ONLY. `devicePrefs.ts` must be structured so a future preference is one more accessor, but add no other preference now.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `web/src/lib/pageSize.ts` | **New, pure (server+client safe).** Page-size constants + `isAllowedPageSize` guard. No browser APIs. |
| `web/src/lib/devicePrefs.ts` | **New, client-only.** Generic `uh.prefs` JSON read/write + typed `pageSizePref` accessor. Imports `pageSize.ts`. |
| `web/src/components/ResultsTable.tsx` | Use shared options/default; drop the local `PAGE_SIZE_OPTIONS`. |
| `web/src/pages/api/search.ts` | Clamp `pageMaxSize` to `MAX_PAGE_SIZE` (250); isNaN fallback → `DEFAULT_PAGE_SIZE`. |
| `web/src/components/SearchApp.tsx` | Seed `size` parser default from `pageSizePref.load()`; persist on change. |
| `web/e2e/search.spec.ts` | New e2e: 250 option present; persistence across reload; URL overrides saved pref. |

---

## Task 1: Raise the page-size cap to 250 (shared constants + UI + API)

**Files:**
- Create: `web/src/lib/pageSize.ts`
- Modify: `web/src/components/ResultsTable.tsx` (line 46 local list; line 256 fallback)
- Modify: `web/src/pages/api/search.ts` (lines 68–71 clamp; line 91 fallback)
- Test: `web/e2e/search.spec.ts` (new test)

**Interfaces:**
- Produces:
  - `web/src/lib/pageSize.ts` exports: `PAGE_SIZE_OPTIONS: readonly [25,50,100,250]`, `DEFAULT_PAGE_SIZE: number` (= 25), `MAX_PAGE_SIZE: number` (= 250), `isAllowedPageSize(n: unknown): n is number`.

- [ ] **Step 1: Write the failing e2e test**

Add to the end of `web/src/../e2e/search.spec.ts` (path `web/e2e/search.spec.ts`):

```ts
test("rows-per-page offers 250 and applies it to the search", async ({ page }) => {
  await page.goto("/?term=202710&subject=ICS");
  // Wait for results so the rows-per-page Select is mounted.
  await expect(page.getByText(/of \d+ sections/)).toBeVisible();

  await page.getByLabel("Rows per page").click();
  await page.getByRole("option", { name: "250", exact: true }).click();

  // The choice is reflected in the shareable URL (250 ≠ the 25 default).
  await expect(page).toHaveURL(/[?&]size=250\b/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `web/`): `yarn test --project=chromium -g "rows-per-page offers 250"`
Expected: FAIL — no `option` named "250" exists yet (the dropdown only has 10/20/50/100), so the click times out.

- [ ] **Step 3: Create the shared constants module**

Create `web/src/lib/pageSize.ts`:

```ts
// Pure, server-safe page-size constants shared by the search UI and the
// /api/search route. No browser APIs here — the API route imports it too.
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

// Smallest option; the fallback when a user has no saved preference.
export const DEFAULT_PAGE_SIZE = 25;

// Server clamp ceiling for a hand-crafted ?pageMaxSize=.
export const MAX_PAGE_SIZE = 250;

export function isAllowedPageSize(n: unknown): n is number {
  return (
    typeof n === "number" &&
    (PAGE_SIZE_OPTIONS as readonly number[]).includes(n)
  );
}
```

- [ ] **Step 4: Use the shared options/default in `ResultsTable.tsx`**

Remove the local list at line 46 (`const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];`) and import the shared one. Add to the import block (near the other `@/lib` imports, e.g. after line 37 `import { cn } from "@/lib/utils";`):

```ts
import { PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE } from "@/lib/pageSize";
```

Then change the pageMaxSize fallback (currently line ~256):

```ts
// before: const pageMaxSize = results?.pageMaxSize ?? 20;
const pageMaxSize = results?.pageMaxSize ?? DEFAULT_PAGE_SIZE;
```

(The `PAGE_SIZE_OPTIONS.map(...)` render at lines ~290–293 is unchanged — it now iterates `[25,50,100,250]`.)

- [ ] **Step 5: Raise the server clamp in `search.ts`**

Add to the import block (after line 16):

```ts
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/lib/pageSize";
```

Change the clamp (lines 68–71):

```ts
const pageMaxSize = Math.min(
  parseInt(url.searchParams.get("pageMaxSize") ?? String(DEFAULT_PAGE_SIZE), 10),
  MAX_PAGE_SIZE
);
```

Change the isNaN fallback (line 91):

```ts
// before: pageMaxSize: isNaN(pageMaxSize) ? 10 : pageMaxSize,
pageMaxSize: isNaN(pageMaxSize) ? DEFAULT_PAGE_SIZE : pageMaxSize,
```

- [ ] **Step 6: Typecheck**

Run (from `web/`): `yarn build`
Expected: build succeeds, no type errors.

- [ ] **Step 7: Run the new test (and the existing suite) to verify pass**

Run (from `web/`): `yarn test --project=chromium -g "rows-per-page offers 250"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/pageSize.ts web/src/components/ResultsTable.tsx web/src/pages/api/search.ts web/e2e/search.spec.ts
git commit -m "feat(results): raise page-size cap to 250 with shared options module"
```

---

## Task 2: Persist page size on device (devicePrefs + SearchApp seeding)

**Files:**
- Create: `web/src/lib/devicePrefs.ts`
- Modify: `web/src/components/SearchApp.tsx` (line 21 const; lines 70–73 parsers memo; line 37 searchParsers.size; lines 194–196 handler; imports)
- Test: `web/e2e/search.spec.ts` (two new tests)

**Interfaces:**
- Consumes: `web/src/lib/pageSize.ts` (`DEFAULT_PAGE_SIZE`, `isAllowedPageSize`) from Task 1.
- Produces: `web/src/lib/devicePrefs.ts` exports `pageSizePref: { load(): number; save(n: number): void }`.

- [ ] **Step 1: Write the failing e2e tests**

Add to `web/e2e/search.spec.ts`:

```ts
test("rows-per-page persists on device across a reload", async ({ page }) => {
  await page.goto("/?term=202710&subject=ICS");
  await expect(page.getByText(/of \d+ sections/)).toBeVisible();

  // Pick 100; it lands in the URL (100 ≠ the 25 default-at-load).
  await page.getByLabel("Rows per page").click();
  await page.getByRole("option", { name: "100", exact: true }).click();
  await expect(page).toHaveURL(/[?&]size=100\b/);

  // Reload the BARE site: the saved pref is now the default, so the size is
  // applied but omitted from the URL, and the selector shows 100.
  await page.goto("/?term=202710&subject=ICS");
  await expect(page.getByText(/of \d+ sections/)).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]size=/);
  await expect(page.getByLabel("Rows per page")).toContainText("100");
});

test("an explicit ?size in the URL overrides the saved preference", async ({ page }) => {
  // Save 100 as the device preference first.
  await page.goto("/?term=202710&subject=ICS");
  await expect(page.getByText(/of \d+ sections/)).toBeVisible();
  await page.getByLabel("Rows per page").click();
  await page.getByRole("option", { name: "100", exact: true }).click();
  await expect(page).toHaveURL(/[?&]size=100\b/);

  // A link with an explicit size wins for whoever opens it.
  await page.goto("/?term=202710&subject=ICS&size=50");
  await expect(page.getByText(/of \d+ sections/)).toBeVisible();
  await expect(page.getByLabel("Rows per page")).toContainText("50");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `web/`): `yarn test --project=chromium -g "persists on device|overrides the saved"`
Expected: FAIL — persistence isn't implemented, so after reload the selector falls back to the default (25) and the URL has no `size`; `toContainText("100")` fails.

- [ ] **Step 3: Create `devicePrefs.ts`**

Create `web/src/lib/devicePrefs.ts`:

```ts
// Client-only device preferences, stored as a single namespaced JSON blob
// under one localStorage key. Server / no-localStorage environments degrade
// to fallbacks (never throw). Add a future preference by exporting another
// typed accessor like `pageSizePref` below — no new storage plumbing.
import { DEFAULT_PAGE_SIZE, isAllowedPageSize } from "./pageSize";

const KEY = "uh.prefs";

function readPrefs(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getPref<T>(
  key: string,
  validate: (v: unknown) => v is T,
  fallback: T,
): T {
  const value = readPrefs()[key];
  return validate(value) ? value : fallback;
}

function setPref<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    const next = { ...readPrefs(), [key]: value };
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable (private mode, quota) — degrade silently.
  }
}

export const pageSizePref = {
  load: (): number => getPref("pageSize", isAllowedPageSize, DEFAULT_PAGE_SIZE),
  save: (n: number): void => setPref("pageSize", n),
};
```

- [ ] **Step 4: Seed the `size` default from the saved preference in `SearchApp.tsx`**

(a) Replace the local default const at line 21:

```ts
// before: const DEFAULT_PAGE_SIZE = 20;
import { DEFAULT_PAGE_SIZE } from "@/lib/pageSize";
import { pageSizePref } from "@/lib/devicePrefs";
```

Put these with the other imports at the top (near lines 10–15), and delete the standalone `const DEFAULT_PAGE_SIZE = 20;` line. The existing `searchParsers.size` at line 37 (`size: parseAsInteger.withDefault(DEFAULT_PAGE_SIZE)`) now references the imported constant (25) — no edit to that line needed beyond removing the local const.

(b) Inside `SearchAppInner`, add a stable, client-only read of the saved size and inject it as the `size` parser default in the existing `parsers` memo. Change lines ~70–73 from:

```ts
const parsers = useMemo(
  () => ({ ...searchParsers, term: parseAsString.withDefault(defaultTerm) }),
  [defaultTerm],
);
```

to:

```ts
// Saved device preference seeds the size default; an explicit ?size in the
// URL still wins (nuqs only omits a value equal to its default). Lazy + stable
// so it's read once on the client; the server reads DEFAULT_PAGE_SIZE.
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

(`useState` and `parseAsInteger` are already imported — see lines 1 and 6.)

- [ ] **Step 5: Persist on change in `handlePageSizeChange`**

Change lines ~194–196:

```ts
// Changing rows-per-page resets to the first page and saves the choice as the
// device default for future visits.
function handlePageSizeChange(pageMaxSize: number) {
  pageSizePref.save(pageMaxSize);
  setQ({ size: pageMaxSize, page: 1 });
}
```

- [ ] **Step 6: Typecheck**

Run (from `web/`): `yarn build`
Expected: build succeeds, no type errors.

- [ ] **Step 7: Run the new tests to verify pass**

Run (from `web/`): `yarn test --project=chromium -g "persists on device|overrides the saved"`
Expected: PASS (both).

- [ ] **Step 8: Run the full read-path suite to guard against regressions**

Ensure no dev server is on `:4321`, then run (from `web/`): `yarn test --project=chromium -g "search|rows-per-page|size"`
Expected: PASS. (A full `yarn test` across all browsers is the final gate before merge.)

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/devicePrefs.ts web/src/components/SearchApp.tsx web/e2e/search.spec.ts
git commit -m "feat(search): persist rows-per-page on device, URL-wins seeding"
```

---

## Self-Review

**Spec coverage:**
- Persist page size on device → Task 2 (`devicePrefs.ts` + `SearchApp` seeding/saving). ✓
- Device default seeds, URL wins → Task 2 Step 4 (nuqs default = saved pref) + "overrides the saved" e2e. ✓
- Raise max to 250 → Task 1 (options `[25,50,100,250]`, server clamp `MAX_PAGE_SIZE`). ✓
- First-visit default 25 → Task 1 `DEFAULT_PAGE_SIZE`; ResultsTable + searchParsers + search.ts fallbacks all use it. ✓
- No virtualization / Ctrl+F preserved → no react-window introduced anywhere. ✓
- Extensible prefs module → `getPref/setPref` generic core + `pageSizePref` accessor; future pref = one accessor. ✓
- localStorage degrade-safe → `readPrefs/setPref` try/catch + `typeof window` guards. ✓
- Validation of stale/garbage values → `isAllowedPageSize` gate in `pageSizePref.load`. ✓
- Server clamp of hand-crafted size → Task 1 Step 5. ✓
- Tests (persistence, URL-override, 250 cap) → Task 1 Step 1 + Task 2 Step 1. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓

**Type consistency:** `pageSizePref.load(): number` / `.save(n: number): void` used identically in `SearchApp` (`pageSizePref.load()`, `pageSizePref.save(pageMaxSize)`). `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE`/`isAllowedPageSize`/`PAGE_SIZE_OPTIONS` names match across `pageSize.ts`, `devicePrefs.ts`, `ResultsTable.tsx`, `search.ts`, `SearchApp.tsx`. ✓
