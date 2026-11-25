# Home backend (Docker Compose)

The Cloudflare Worker serves the site. Its database lives here: two SQLite
files behind a small authenticated **SQL gateway**, reached through your
host-level `cloudflared` tunnel + Cloudflare Access. A `cron` container runs the
daily Banner refresh and nightly backups against the same files.

```
Worker ──(Access service token + bearer)──▶ <gateway-host> ──▶ host cloudflared
       ──▶ 127.0.0.1:8787 ──▶ gateway container ──▶ ./data/db/{search,analytics}.sqlite
cron container (22:00 HST: yarn ingest daily · 04:00 HST: yarn db:backup) ──▶ same files
```

Design + rationale: `docs/superpowers/specs/2026-11-24-home-backend-design.md`.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | One image (Node 24 + sqlite3 + supercronic), build context = repo root |
| `compose.yaml` | `gateway` (loopback `127.0.0.1:8787`) and `cron` services, `./data` mount |
| `crontab` | supercronic schedule (TZ=Pacific/Honolulu) |
| `env.example` | Template for `deploy/home/.env` (git-ignored) |
| `cloudflared-ingress.example.yml` | Rule to add to the host's cloudflared config |

## Cutover runbook

Run steps 1 and 3–7 on the server from `deploy/home/`, and steps 2 and 8 from a
machine with wrangler auth.

1. **Build.** Clone the repo, then:
   ```bash
   cd deploy/home
   cp env.example .env            # set GATEWAY_SECRET=$(openssl rand -hex 32)
   mkdir -p data/db data/backups
   sudo chown -R 1000:1000 data   # the containers run as uid 1000 (node)
   docker compose build
   ```
2. **Export D1.** The export only reads, so it works while D1 is over its cap.
   ```bash
   cd web
   wrangler d1 export uh-course-search-db --remote --output search.sql
   wrangler d1 export uh-analytics-db --remote --output analytics.sql
   ```
   Copy both files to the server's `deploy/home/data/`.
3. **Import.**
   ```bash
   docker compose run --rm cron sh -c 'sqlite3 /data/db/search.sqlite < /data/search.sql'
   docker compose run --rm cron sh -c 'sqlite3 /data/db/analytics.sqlite < /data/analytics.sql'
   ```
4. **Verify row counts.** They must equal the 2026-11-24 baseline in the spec. Stop if any differ.
   ```bash
   docker compose run --rm cron sqlite3 /data/db/search.sqlite "
     SELECT 'term',COUNT(*) FROM term UNION ALL SELECT 'course_section',COUNT(*) FROM course_section
     UNION ALL SELECT 'section_detail',COUNT(*) FROM section_detail UNION ALL SELECT 'course',COUNT(*) FROM course
     UNION ALL SELECT 'section_faculty',COUNT(*) FROM section_faculty UNION ALL SELECT 'section_meeting',COUNT(*) FROM section_meeting;"
   ```
   Then confirm nothing is pending. Both commands must print `0 pending`:
   ```bash
   docker compose run --rm cron yarn db:migrate-sqlite --db search --file /data/db/search.sqlite --dryRun
   docker compose run --rm cron yarn db:migrate-sqlite --db analytics --file /data/db/analytics.sqlite --dryRun
   ```
   After that, delete `data/*.sql`.
5. **Start.**
   ```bash
   docker compose up -d
   curl -fsS 127.0.0.1:8787/healthz    # → ok
   ```
6. **Tunnel and Access.**
   - Add the rule from `cloudflared-ingress.example.yml` to the host cloudflared config.
   - Run `cloudflared tunnel route dns <tunnel> <gateway-host>`, then restart cloudflared.
   - In Zero Trust, create a service token, then a self-hosted Access application on `<gateway-host>` with a single **Service Auth** policy that allows only that token.
7. **Check through the tunnel** from another machine. This should return `n: 103` (the term count).
   ```bash
   curl -sS https://<gateway-host>/v1/query \
     -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
     -H "Authorization: Bearer $GATEWAY_SECRET" -H 'Content-Type: application/json' \
     -d '{"db":"search","batch":false,"statements":[{"sql":"SELECT COUNT(*) AS n FROM term","params":[]}]}'
   ```
8. **Point the Worker at it.**
   ```bash
   cd web
   wrangler secret put DB_GATEWAY_URL           # https://<gateway-host>
   wrangler secret put DB_GATEWAY_SECRET        # = GATEWAY_SECRET
   wrangler secret put CF_ACCESS_CLIENT_ID
   wrangler secret put CF_ACCESS_CLIENT_SECRET
   yarn deploy
   ```
   Load the site and run one search. `wrangler tail` should show no `DB gateway` errors.
9. **First refresh.** Run `docker compose exec cron yarn ingest daily` and confirm a new `sync_run` row. After this, the crontab runs it nightly.

**Rollback:** `wrangler secret delete DB_GATEWAY_URL` and then `yarn deploy` returns the Worker to the D1 bindings. Those are read-only while over the Free cap, and frozen at 2026-10-11. After 7 clean days, remove the `d1_databases` bindings from `wrangler.jsonc` and delete both D1 databases.

## Operations

- **Logs:** `docker compose logs -f gateway` shows one line per query (db, statement count, ms; never SQL or params). `docker compose logs -f cron` shows the refresh and backup output.
- **Schema changes:** after pulling a new migration, run `docker compose run --rm cron yarn db:migrate-sqlite --db search --file /data/db/search.sqlite` (or `--db analytics`). Then run `docker compose up -d --build`.
- **Restore:** `docker compose stop`, copy a `data/backups/<db>-YYYY-MM-DD.sqlite` over `data/db/<db>.sqlite`, delete its `-wal`/`-shm` files, then `docker compose up -d`.
- **Storage:** keep `./data` on a local disk. SQLite's WAL mode does not work on NFS/SMB mounts.
