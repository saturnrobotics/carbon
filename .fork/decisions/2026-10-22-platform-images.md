# Platform images: PostgreSQL 15.19, Realtime 2.147.1, no browser

Base: `saturn/main` at `900336c29a`. A 2026-10-22 sweep of the images that
`simple-docker-caddy/docker-compose.prod.yml` pins found:

- **supabase/postgres 15.14.1.112** (PostgreSQL 15.14, supautils 3.2.0): the
  PostgreSQL 15.15–15.19 security releases (CVE-2026-14662 to CVE-2026-14681 and
  others, CVSS up to 8.8 for code execution as the server's OS user by any
  SQL-capable role; CVE-2026-14664 is in the regular-expression engine that
  PostgREST's `match`/`imatch` filters reach) and supautils GHSA-5pqj-rc76-r669,
  GHSA-v9vh-54vv-7vfg, GHSA-vxh6-6m4g-c39q, GHSA-xj9m-rx42-rfc7 (a `postgres`
  role holder becomes superuser).
- **supabase/realtime v2.89.0**: GHSA-9vjf-j9f7-j42c (high: any broadcaster can
  forge protocol frames, `postgres_changes` included, to every client on a
  channel), GHSA-rcr8-2525-4r7p, GHSA-2rcv-vpjw-5g6c (fixed in 2.146.0).
- **supabase/edge-runtime v1.74.0**: crash fixes in 1.74.2 and 1.74.4 (no GHSA).
- **redis:7-alpine, caddy:2-alpine**: floating tags, so the VM keeps whatever it
  pulled first; 7.4.11 and 2.11.7 carry the 7.4 and 2.11 advisories' fixes.
- **browserless/chrome:1-puppeteer-21.3.6** (render.py): Chrome 117 from
  2023-10, a frozen product line with no patched release. The `thumbnail` edge
  function navigates it to any caller-supplied URL.

Choices:

- **Pins in the renderer, never backwards.** `service_images.configure` raises
  each image only while upstream pins older (a floating tag is compared with the
  release's same-length prefix), and fails on an unexpected repository or tag.
  Pinned by tag like every Supabase image here: a digest-only pull is listed
  without its tag, and `docker_prune.py` keeps images by tag.
  15.19.0.006, not 15.19.0.007 (pushed hours before this change).
- **No browser.** The service and `BROWSERLESS_WS_URL` are gone; the thumbnail
  function answers 500. 3D-model thumbnails were already failing: the
  `model-thumbnail` job calls the function with the anon key and `edge-main`
  refuses anon callers (403).
- **The config volume follows the image.** `pgconfig` (`/etc/postgresql-custom`)
  is a named volume, which Docker fills once; 15.19 would otherwise run with
  15.14's `supautils.conf` (no `supabase_privileged_role` in `reserved_roles`),
  extension scripts without the new search_path hardening, and no
  `conf.d/pg_net.conf`. `maintenance-apply` copies the image's files over it once
  per image while PostgreSQL is stopped, refusing an image that ships a
  `pgsodium_root.key` and failing if the key's checksum changes.
- **Extension updates.** `extension-updates.sql` updates `pg_net` (0.20.0 →
  0.20.4) and `vector` (0.8.0 → 0.8.2) after Carbon's SQL. `pg_graphql` 1.5.11
  has no update path to 1.6.2, and Carbon does not install it.
- **Readiness.** `check_stack` proves `server_version_num` is at least
  `service_images.POSTGRES_PATCHED` and waits for Realtime's `/healthcheck`.
- **Out of scope:** Kong 2.8.1 is end of life (OpenSSL 1.1.1) with no open
  advisory; moving to 3.x or Envoy is its own change. Inngest (1.19.4 → 1.47.0)
  and GoTrue (2.189.0 → 2.197.0) have no advisory against our versions.

Verified locally (linux/amd64 under Rosetta, the private-lb Postgres spec from
`private_postgres.configure` and `wal_g.configure`, networks without internet):

- 15.14.1.112 with every extension Carbon creates (plus pg_graphql, pgjwt and
  pgsodium) and data that uses them, then Realtime 2.89.0 healthy. A clean
  shutdown and 15.19.0.006 on the same volumes: no startup errors, same
  `shared_preload_libraries`, `server_version_num` 150019. `ALTER EXTENSION`
  succeeded for pg_net and vector. Vault and pgsodium data written on 15.14
  decrypted on 15.19; pg_net, pgmq, pg_cron, vector (hnsw), pg_trgm, hstore,
  pg_jsonschema, pgcrypto and uuid-ossp returned the same results. TLS and
  pg_hba behaved identically from the client subnet (non-SSL refused,
  `verify-full` over TLSv1.3).
- WAL-G v3.0.9 through `wal-g-glibc.sh` found the same glibc loader in both
  images; `wal-push` from `archive_command`, `backup-push` and `backup-list`
  worked against file storage, and a missing target failed closed.
- Realtime 2.147.1 applied its migrations and was healthy; 2.89.0 still started
  on the migrated schema. The amd64 2.147.1 image needed `+JMsingle true` under
  Rosetta only (the arm64 build booted without it).
- edge-runtime 1.74.0 and 1.77.8 answered every edge-main case identically.
- The `pgconfig` refresh, run as written in `host-deploy.sh` against a volume
  filled by 15.14.1.112 with a key: `supautils.conf` matched 15.19's afterwards,
  ownership was kept, the key's checksum was unchanged, and a second run did
  nothing.
