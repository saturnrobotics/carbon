# Push HQ feed projections and entitlements

Base: `saturn/main` at `7886e86c7418bef90faa35fdffc4b307d5213c4d`.
Spec: `../specs/2026-10-18-hq-feed-exporter.md`. Counterpart: HQ plan 0006C.

All code lives in `contrib/deploying/gcp-tailscale/`. No shared upstream file,
schema, RLS, authentication or permission logic changes.

- [x] `hq_feed.py`: one read-only REPEATABLE READ snapshot as `service_role`,
      explicit projection, no-money guard, 8 MiB cap, HS256 token bound to the
      body hash, no-redirect/no-proxy POST, `--dry-run`, `--local-psql`.
- [x] `tailnet_routes.py`: `TAILNET_ACCEPT_ROUTES` allowlist validation; `apply`
      and `check` turn route acceptance off on any unexpected or overlapping
      route, or on unreadable tables.
- [x] Wiring: `deploy.py` validation and optional keys, `render.initialize_secrets`
      writes or removes the host-only key, `bootstrap.sh` applies route acceptance
      after unpacking the release, `host-deploy.sh finalize` installs or removes
      the timer, `prepare_release.MAINTENANCE_PATHS` owns both host files,
      examples and README.
- [x] Tests: payload shape, no-money keys and query identifiers, token claims and
      `body_sha256`, exact-body POST, redirect refusal, status handling, dry run
      sends nothing, log privacy, config validation, secret lifecycle, maintenance
      selection, host unit invariants, route enforcement. A disposable PostgreSQL
      (local 14 and `supabase/postgres:15.14.1.112`) runs the real query with
      column-level grants, so reading any money column fails.
- [x] Production-image boundary: in a disposable `supabase/postgres:15.14.1.112`
      container started like the deployment's, `supabase_admin` over 127.0.0.1
      switches to `service_role` and reads migration-created tables with RLS
      enabled.
- [x] Security review follow-up: key entitlements on the confirmed
      `auth.users.email` instead of the user-editable `public."user".email`, and
      drop and count disagreements. Add `carbon-tailnet-routes.timer`, which
      re-checks routes independently of the feed. A disposable
      `supabase/postgres` plus `supabase/gotrue:v2.189.0` stack confirmed that the
      migrated `auth.users` has `email_confirmed_at`, that `service_role` cannot read
      it, and that the admin two-column read works.
- [ ] Not verifiable locally: the `docker compose exec` and secrets-shim wrapper
      on the VM, systemd timer installation, Tailscale route installation on the
      VM, TLS to HQ, and HQ's acceptance of a push. These need HQ's endpoint (plan
      0006C), the tailnet grant and a reviewed deployment.
- [ ] Operator: set the key on both sides, set `HQ_INGEST_URL` and
      `TAILNET_ACCEPT_ROUTES`, grant `tag:carbon` TCP 443 to HQ's address, then
      `make deploy` from `saturn/main`. This selects coordinated maintenance once.
