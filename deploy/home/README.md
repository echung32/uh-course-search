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
| `compose.yaml` | `gateway` (loopback `127.0.0.1:8787`, mounts only `./data/db`) and `cron` (mounts all of `./data`, incl. backups) |
| `crontab` | supercronic schedule (TZ=Pacific/Honolulu) |
| `env.example` | Template for `deploy/home/.env` (git-ignored) |
| `cloudflared-ingress.example.yml` | Rule to add to the host's cloudflared config |

### Merging into an existing compose project

If the server already runs its services from a single compose file, copy the
`gateway` and `cron` service blocks into it instead of running this project. Then:

- Keep `build.context` pointing at the repo checkout (e.g. `$HOME/github/uh-course-search`) with `dockerfile: deploy/home/Dockerfile`.
- Rename the env file (e.g. `.env.uhcs`).
- Put the data wherever that host keeps app data.
- If an offsite backup tool (restic, …) already copies that location, **exclude the live `db/` directory**, since copying a SQLite file mid-write can give an inconsistent copy. Let the tool pick up the consistent nightly copies in `backups/` instead, and lower `BACKUP_KEEP_DAYS`.

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
6. **Tunnel and Access.** First check how the host's cloudflared is configured:
   `systemctl cat cloudflared`.
   - **Dashboard-managed tunnel**, where `ExecStart` runs `tunnel run --token …`.
     The local `config.yml` is ignored. In Zero Trust → Networks → Tunnels →
     your tunnel → Public Hostnames, add `<gateway-host>` → `http://127.0.0.1:8787`.
     Through the API, that means GET then PUT
     `/accounts/<acct>/cfd_tunnel/<id>/configurations` with the rule inserted before
     the catch-all. This also creates the DNS record. No restart or sudo is needed.
   - **Locally-managed tunnel**, where `ExecStart` uses `--config`. Add the rule from
     `cloudflared-ingress.example.yml` to that config. Then run
     `cloudflared tunnel route dns <tunnel> <gateway-host>` and restart cloudflared.
   - Either way, in Zero Trust, create a service token. Then create a self-hosted
     Access application on `<gateway-host>` with a single **Service Auth** policy
     that allows only that token.
7. **Check through the tunnel** from another machine. This should return `n: 103` (the term count).
   ```bash
   curl -sS https://<gateway-host>/v1/query \
     -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
     -H "Authorization: Bearer $GATEWAY_SECRET" -H 'Content-Type: application/json' \
     -d '{"db":"search","batch":false,"statements":[{"sql":"SELECT COUNT(*) AS n FROM term","params":[]}]}'
   ```
8. **Point the Worker at it.** Each `wrangler secret put` immediately redeploys
   the live Worker, and `DB_GATEWAY_URL` is the switch that turns the gateway on.
   So upload the three credentials **first** and the URL **last**. Otherwise the
   site queries the gateway without credentials, and gets 401s, until the rest land.
   ```bash
   cd web
   yarn deploy                                  # ships this branch's code (D1 still active: no URL yet)
   wrangler secret put DB_GATEWAY_SECRET        # = GATEWAY_SECRET
   wrangler secret put CF_ACCESS_CLIENT_ID
   wrangler secret put CF_ACCESS_CLIENT_SECRET
   wrangler secret put DB_GATEWAY_URL           # https://<gateway-host> — activates the gateway
   ```
   Load the site and run one search. `wrangler tail` should show no `DB gateway` errors.

   Then check the old Workflow cron. Open Dashboard → Workers & Pages →
   Workflows → `uh-course-search-refresh` → Triggers. `wrangler.jsonc` no longer
   sets a schedule, but an earlier deploy's cron can linger there. Remove it if
   present. It's harmless either way: while `DB_GATEWAY_URL` is set,
   `RefreshWorkflow` exits immediately (`src/workflows/refreshGuard.ts`), so it
   can't refresh alongside the home cron.
9. **First refresh.** Run `docker compose exec cron /app/deploy/home/run-daily.sh` and confirm a new `sync_run` row. After this, the crontab runs it nightly.

**Rollback:** `wrangler secret delete DB_GATEWAY_URL` and then `yarn deploy` returns the Worker to the D1 bindings. Those are read-only while over the Free cap, and frozen at 2026-10-11. After 7 clean days, remove the `d1_databases` bindings from `wrangler.jsonc` and delete both D1 databases.

## Operations

- **Logs:** `docker compose logs -f gateway` shows one line per query (db, statement count, ms; never SQL or params). `docker compose logs -f cron` shows the refresh and backup output.
- **Manual refresh:** `docker compose exec -d cron sh -c '/app/deploy/home/run-daily.sh > /data/daily-manual.log 2>&1'`. Always go through `run-daily.sh`, never bare `yarn ingest daily`. It holds `/data/.daily.lock`, so a manual run and the 22:00 cron can't overlap; whichever starts second logs "skipped" and exits.
- **Schema changes and updates.** Migrations are baked into the image, so build first and migrate from the new image. Only then restart the services onto it:
  ```bash
  git pull
  docker compose build
  docker compose run --rm cron yarn db:migrate-sqlite --db search --file /data/db/search.sqlite
  docker compose run --rm cron yarn db:migrate-sqlite --db analytics --file /data/db/analytics.sqlite
  docker compose up -d        # recreate gateway + cron on the new image
  ```
  Deploy the Worker only **after** migrating: Worker code that reads a new column 503s every search until the migration has run.
- **One-time: `0015` usual date ranges (Schedule column).** After migrating to `0015` (which also repairs NULL `section_meeting.begin_date` rows from `raw_json`), fill `term.usual_start_date/usual_end_date` for every term, then deploy the Worker:
  ```bash
  docker compose run --rm cron yarn ingest usual-dates     # or --term 202710 for one term
  ```
  Successful syncs keep mutable terms current after that. Until it runs, every meeting in the table shows its dates (the "no usual range" fallback).
- **Restore:** `docker compose stop`, copy a `data/backups/<db>-YYYY-MM-DD.sqlite` over `data/db/<db>.sqlite`, delete its `-wal`/`-shm` files, then `docker compose up -d`.
- **Storage:** keep `./data` on a local disk. SQLite's WAL mode does not work on NFS/SMB mounts.
