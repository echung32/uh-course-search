#!/usr/bin/env bash
# One-off resilient remote rollup population (Plan 1, Task 7).
# Runs `yarn ingest rollups --term <code>` per term, newest-first, with retries,
# so a transient ECONNRESET on one term doesn't abort the whole run (the bulk
# `yarn ingest rollups` has no per-statement retry). Idempotent: each term is a
# delete-and-replace, so re-running is safe / resumable. NOT part of the app.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env; set +a

codes=$(yarn wrangler d1 execute uh-course-search-db --remote \
  --command "SELECT code FROM term ORDER BY code DESC;" 2>/dev/null \
  | grep -oE '20[0-9]{4}' | awk '!seen[$0]++')

total=$(echo "$codes" | wc -l | tr -d ' ')
echo "populate-rollups: $total terms, newest-first"
done=0; failed=""
for code in $codes; do
  ok=0
  for attempt in 1 2 3 4 5; do
    if yarn ingest rollups --term "$code" >/dev/null 2>&1; then
      ok=1; break
    fi
    sleep $((attempt * 3))
  done
  done=$((done + 1))
  if [ "$ok" = 1 ]; then
    echo "[$done/$total] ok   $code"
  else
    echo "[$done/$total] FAIL $code (5 attempts)"
    failed="$failed $code"
  fi
done

if [ -n "$failed" ]; then
  echo "POPULATION DONE WITH FAILURES:$failed"
  exit 1
fi
echo "POPULATION DONE: all $total terms"
