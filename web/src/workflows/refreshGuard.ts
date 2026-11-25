/**
 * Whether the Cloudflare `RefreshWorkflow` must stand down. While the Worker
 * runs on the home SQL gateway (DB_GATEWAY_URL set), the daily refresh belongs
 * to the home server's cron (`yarn ingest daily`). Cloudflare may keep a cron
 * schedule from an earlier deploy, because omitting `schedules` may not clear
 * it and an empty array is rejected. If it fires, it must not refresh the same
 * terms through the gateway alongside the home run.
 *
 * Returns the reason to skip, or null to run. No `cloudflare:*` imports, so
 * Node can unit-test it.
 */
export function workflowRefreshDisabled(env: Record<string, unknown>): string | null {
  const url = env.DB_GATEWAY_URL;
  if (typeof url === "string" && url !== "") {
    return "DB_GATEWAY_URL is set: the daily refresh runs on the home server (yarn ingest daily)";
  }
  return null;
}
