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
