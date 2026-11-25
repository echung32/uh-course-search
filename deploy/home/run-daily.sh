#!/bin/sh
# Single-flight wrapper for the daily Banner refresh. Used by the crontab AND
# for manual runs (`docker compose exec cron /app/deploy/home/run-daily.sh`), so
# a scheduled 22:00 run and a manual one can never refresh the same terms at
# once. A run started while another holds the lock exits 0 with a message.
#
# The lock lives on the /data volume. flock locks belong to the open file, so
# the lock is released automatically when the run exits or the container stops
# (no stale-lock cleanup). Extra args pass through to `yarn ingest daily`
# (e.g. `--term 202710`).
set -u
LOCK="${DAILY_LOCK_FILE:-/data/.daily.lock}"
cd /app/web || exit 1
flock -n -E 75 "$LOCK" yarn ingest daily "$@"
status=$?
if [ "$status" -eq 75 ]; then
  echo "[run-daily] skipped: another daily refresh holds $LOCK"
  exit 0
fi
exit "$status"
