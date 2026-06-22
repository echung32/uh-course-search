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
