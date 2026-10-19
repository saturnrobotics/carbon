# WAL-G archiving and PostgreSQL settings in private-lb mode

Base: `saturn/main` at `48d8db8d2f`. Specification: HQ plan 0015 §2 (PostgreSQL
settings), §7 (WAL-G) and Step 9, consumed by HQ plan 0017's private-lb mode. Only
`INGRESS_MODE=private-lb` changes; every file is fork-owned under
`contrib/deploying/gcp-tailscale/`, and no shared upstream file is touched.

In private-lb mode PostgreSQL runs with the owning platform's settings
(`max_connections=200`, `shared_buffers=1GB`, `effective_cache_size=3GB`,
`work_mem=8MB`, `maintenance_work_mem=256MB`, `wal_level=logical`,
`password_encryption=scram-sha-256`, `archive_mode=on`,
`archive_command='wal-g wal-push %p'`, `archive_timeout=60s`, a 4 GB memory limit,
`ssl=on` from the private listener). WAL-G archives to `gs://<PROJECT_ID>-pg-wal`,
and a host timer takes a base backup daily at 07:00 UTC.

Choices:

- **Command-line settings.** They override `postgresql.conf`, the image's
  `conf.d` and the `ALTER SYSTEM` values written at first initialization, so the
  rendered configuration is the effective one (`pg_settings.source` is
  `command line`).
- **Pinned release, verified on the host.** `wal_g.py` pins WAL-G v3.0.9
  (2026-08-20; the newest release at least two weeks old), asset
  `wal-g-pg-20.04-amd64`, sha256 `965a7147…c0c4eb` from the release's published
  `.sha256` file. Bootstrap installs it to `/var/lib/carbon/wal-g/v3.0.9/wal-g`
  and refuses a download, or an installed file, with other bytes. The version is
  in the mount path, so an upgrade changes the PostgreSQL definition and selects
  maintenance.
- **glibc binary in a musl image.** `supabase/postgres:15.14.1.112` is Alpine
  (musl) for both amd64 and arm64; PostgreSQL runs on glibc from the Nix store.
  WAL-G's PostgreSQL builds are glibc-linked (the 20.04 build needs only
  `GLIBC_2.29` from libc, libm, libpthread and libresolv). `wal-g-glibc.sh`,
  mounted as `/usr/local/bin/wal-g`, runs the binary with the newest
  `/nix/store/*-glibc-*/lib/ld-linux-*` loader and its own library path, so §2's
  `archive_command` works unchanged. No glibc loader means exit 1.
- **Bucket named after the project.** `<PROJECT_ID>-pg-wal`, like the
  `<VM_NAME>-ip` and `<VM_NAME>-data` conventions, keeps the deployment's value
  out of tracked files and needs no new configuration key.
- **Credentials.** None on disk. The env file holds settings only; WAL-G uses the
  service account's token from the metadata server. A bridge-network container
  reaches 169.254.169.254 through the host's masquerade like any other address
  (the Compose network is a plain bridge, not `internal`), and
  `GCE_METADATA_HOST` removes the DNS-based GCE detection.
- **No delete rights.** WAL-G's GCS uploader uploads `<object>_chunks/chunk0`,
  composes the object and then deletes the chunk, retrying failures with
  exponential backoff (16 retries, about 30 minutes, by default). The platform's
  account cannot delete and the bucket's retention policy forbids it, so
  `GCS_MAX_RETRIES=3` bounds each push to seconds; chunks stay until the
  bucket's lifecycle rule removes them. `WALG_UPLOAD_CONCURRENCY=2` bounds the
  50 MiB per-upload buffers inside PostgreSQL's memory limit.
- **Backups from the host.** `carbon-wal-g-backup.timer` (07:00 UTC, persistent)
  runs `carbon-wal-g-backup`, which waits up to ten minutes for PostgreSQL and
  runs `wal-g backup-push` as `postgres` in the container, as the superuser over
  the container's loopback. The unit has no dependency on Docker, so a run
  during a maintenance snapshot fails instead of starting Docker.
- **Ops Agent and labels.** Bootstrap installs `google-cloud-ops-agent` from
  Google's signed repository (major version 2) for the platform's disk alert. A
  created instance gets `app=hq,role=data`; an existing one is labeled once by
  hand (README).

Verification (local, 2026-10-19):

- The deployment tooling suite passes (295 tests, 271 before) under CI's pins
  (Python 3.13 with PyYAML 6.0.2, Ruff 0.4.1), as do `ruff check
  contrib/deploying`, ShellCheck on every script, `bash -n`, `git diff --check`,
  and the wrapper tests with dash as `sh`.
- **Tailscale mode is byte-identical.** One harness ran the base revision and this
  change over the same synthetic tailscale inputs (plain, explicit mode key,
  private listener, HQ sign-in): rendered stacks and files, release fingerprints,
  provisioning `gcloud` calls and bootstrap arguments. Both captures have the
  same sha256. A test also proves the hook is a no-op in that mode.
- **Production image** (`supabase/postgres:15.14.1.112`, arm64 locally, with the
  same release's `wal-g-pg-20.04-aarch64` build, sha256 checked). The rendered
  private-lb PostgreSQL service ran as rendered (published port removed). Every
  setting above was effective from the command line, with a 4 GiB limit. With
  no reachable metadata server nothing was marked archived and the `.ready`
  segments stayed. With a file archive the backlog archived as `wal_005/*.zst`;
  the real backup helper wrote `basebackups_005/*_backup_stop_sentinel.json`; a
  network-less scratch container with the same mounts restored it with
  `backup-fetch`, replayed later WAL with `wal-fetch` through the wrapper,
  promoted, and opened the vault. Against a GCS emulator behind a proxy that
  answers every DELETE with 403, a push took 2 s (4 refused deletes) and left
  `_chunks/chunk0`; WAL-G's default retries were still backing off after 90 s
  (11 refused deletes). A base backup over that path took 12 s.
- **amd64 image layout** read from the registry without pulling it: Alpine with
  `/lib/ld-musl-x86_64.so.1`, no `/lib64`, and Nix glibc loaders 2.39-5, 2.40-66
  and 2.40-218 at the path the wrapper searches.

Limits: the amd64 binary was not executed (pulling the amd64 image locally would
retag a shared image); its dependencies were read from its ELF headers. Metadata
reachability, GCS IAM and the retention policy's refusals are unobserved locally;
the first deployment proves them, and `pg_stat_archiver` shows failures. If a
push stops between writing a chunk and composing its object, every retry must
replace that chunk, which the account and the retention policy refuse, so
archiving stays on that segment until the bucket owner removes the stray chunk.
The `--labels` instance flag has no non-persisting provider validation.
