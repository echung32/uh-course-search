/**
 * Per-isolate rate limit for on-view live Banner fetches (sectionLazy /
 * courseTextLazy). A fixed one-minute bucket: at most `LAZY_FETCH_PER_MINUTE`
 * (default 30, read at call time) slots per bucket. Only a live fetch takes a
 * slot — a stored, complete row is always served without one.
 */
let bucket = -1;
let used = 0;

export function tryTakeLazySlot(now: number = Date.now()): boolean {
  const cap = Number(process.env.LAZY_FETCH_PER_MINUTE) || 30;
  const b = Math.floor(now / 60_000);
  if (b !== bucket) {
    bucket = b;
    used = 0;
  }
  if (used >= cap) return false;
  used += 1;
  return true;
}

/** Test hook. */
export function __resetLazySlots(): void {
  bucket = -1;
  used = 0;
}
