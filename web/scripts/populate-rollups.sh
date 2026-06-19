#!/usr/bin/env bash
# One-off resilient remote rollup population (Plan 1, Task 7).
# Runs `yarn ingest rollups --term <code>` per term, newest-first, with retries,
# so a transient ECONNRESET on one term doesn't abort the whole run (the bulk
# `yarn ingest rollups` has no per-statement retry). Idempotent: each term is a
# delete-and-replace, so re-running is safe / resumable. NOT part of the app.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env; set +a
# This script populates the REMOTE analytics DB. .env usually pins D1_MODE=local
# (for dev), which would make `yarn ingest` write the LOCAL sqlite file instead —
# the run reports "ok" per term but remote stays empty. Force remote here so the
# ingest writes hit the same database the wrangler --remote resume check reads.
export D1_MODE=remote

codes=$(yarn wrangler d1 execute uh-course-search-db --remote \
  --command "SELECT code FROM term ORDER BY code DESC;" 2>/dev/null \
  | grep -oE '20[0-9]{4}' | awk '!seen[$0]++')

# Resume support: skip terms that already have rollups (recompute is safe but the
# big terms are slow over REST — don't redo finished work after a restart).
# Key the "done" check on the subject facet specifically: it's only written by
# the current rollup code, so terms rolled up by an OLDER version (which had
# campus/college/schedule_type facets but no subject facet or meeting stats) are
# correctly treated as not-done and get recomputed once. Every term with course
# rows gets a subject facet row, so this never false-skips.
already=$(yarn wrangler d1 execute uh-analytics-db --remote \
  --command "SELECT DISTINCT term FROM term_facet_stats WHERE facet='subject';" 2>/dev/null \
  | grep -oE '20[0-9]{4}' | awk '!seen[$0]++')
echo "resume: $(echo "$already" | grep -c .) terms already done, will skip"

total=$(echo "$codes" | wc -l | tr -d ' ')
echo "populate-rollups: $total terms, newest-first"
done=0; failed=""
for code in $codes; do
  if echo "$already" | grep -qx "$code"; then
    done=$((done + 1)); echo "[$done/$total] skip $code"; continue
  fi
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
