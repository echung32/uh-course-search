#!/bin/sh
# Single-flight wrapper for the gap-driven term capture (`yarn ingest backfill`,
# spec docs/superpowers/specs/2026-11-25-crseavail-hybrid-ingest-design.md §6.1).
# Used by the crontab AND for manual runs
# (`docker compose exec cron /app/deploy/home/run-capture.sh`).
#
# Shares run-daily.sh's lock file, so a capture and the daily refresh never
# overlap: whichever starts second logs "skipped" and exits 0. The capture is
# time-boxed (CAPTURE_MAX_MINUTES, default 180) and never runs past 21:45 HST
# when started before it, so it finishes ahead of the 22:00 daily job. Extra
# args pass through (e.g. `--term 202700`, `--dryRun`).
#
# CAPTURE_ENABLED=0 pauses it: every run logs "paused" and exits 0 without
# touching the lock or Banner (e.g. while crseavail is off, so the one-time
# backfill doesn't run Banner-only). Override for one manual run with
# `docker compose exec -e CAPTURE_ENABLED=1 cron /app/deploy/home/run-capture.sh`.
set -u
if [ "${CAPTURE_ENABLED:-1}" = "0" ]; then
  echo "[run-capture] paused: CAPTURE_ENABLED=0"
  exit 0
fi
LOCK="${DAILY_LOCK_FILE:-/data/.daily.lock}"
cd /app/web || exit 1
flock -n -E 75 "$LOCK" yarn ingest backfill --maxMinutes "${CAPTURE_MAX_MINUTES:-180}" "$@"
status=$?
if [ "$status" -eq 75 ]; then
  echo "[run-capture] skipped: another ingest run holds $LOCK"
  exit 0
fi
exit "$status"
