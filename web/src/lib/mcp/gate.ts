/**
 * MCP rate-limit gate. Pure (no `cloudflare:workers` import) so it is
 * unit-testable in plain Node. The Cloudflare `ratelimit` binding satisfies
 * `RateLimiter`; the route reads it via getRateLimiter() and passes it here.
 */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/**
 * True if the request may proceed. Fails OPEN: a missing binding (Node preview /
 * a local runtime without the ratelimit binding) or a binding that throws never
 * blocks a read — the limiter is abuse-prevention, not correctness.
 */
export async function checkRateLimit(
  limiter: RateLimiter | null,
  key: string
): Promise<boolean> {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}
