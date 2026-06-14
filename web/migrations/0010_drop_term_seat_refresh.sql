-- 0010_drop_term_seat_refresh.sql
-- Drops term.last_seat_refresh_at: the standalone seat-only refresh path
-- (seatRefresh.ts + POST /api/admin/refresh-seats) is removed. The daily Tier A
-- full sync already re-pulls every section's seats, so seat freshness == the
-- "verified against Banner" time (term.last_synced_at) — a separate seat-refresh
-- anchor was redundant and, in the scheduled (sync-only) model, always "never".
ALTER TABLE term DROP COLUMN last_seat_refresh_at;
