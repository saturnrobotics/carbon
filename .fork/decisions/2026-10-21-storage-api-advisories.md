# Storage: storage-api 1.84.17 and a Kong gate for two critical advisories

Base: `saturn/main` at `924ad0b205` (#93 merged). Advisories published
2026-10-14, both critical, both against the `supabase/storage-api:v1.58.4` that
upstream's prod and dev compose files pin (upstream `main` had not moved it):

- **GHSA-8rrf-w776-x75g** (fixed in 1.80.2). Signed resumable (TUS) upload
  routes write with Storage's privileged database connection. 1.58.4 checks the
  `x-signature` token only when the raw `req.url` starts with
  `/upload/resumable/sign`, but the router matches the decoded path, so
  `/upload/resumable/%73ign` or an absolute-form target creates or overwrites
  any object with no credentials.
- **GHSA-67rp-h2mf-ph72** (fixed in 1.80.1). S3 protocol routes let the anon
  key read and write Iceberg table files.

Choices:

- **1.84.17, not 1.84.18.** 1.84.18 (2026-10-21, a config-reload fix) had no
  published image; 1.84.17 is the newest release with one. Changes from 1.58.4
  add no required variable and remove none Carbon sets; the S3, Iceberg, vector,
  versioning and lifecycle features default off except S3. 1.84.x's file-backend
  changes stage single-object writes before publishing them; pg pipelining is
  opt-in. Pinned by tag, as every Supabase service image here is.
- **Production pin in the renderer.** `storage_api.configure` replaces
  upstream's image only when upstream's is older, so a sync can raise it but
  never lower it below a schema Storage has migrated. Upstream's compose file and
  `kong.yml` stay unchanged. The dev compose file has no extension point and
  carries the one-line bump (an upstream candidate).
- **Unused APIs off.** `S3_PROTOCOL_ENABLED`, `ICEBERG_ENABLED`, `VECTOR_ENABLED`
  set to `"false"`. No Carbon code uses the S3 protocol, an S3 client, Iceberg
  or vectors.
- **Kong gate, judged on the forwarded path.** Kong 2.8.1 forwards a normalized
  path (`%73` decoded, dot segments and duplicate slashes resolved, absolute-form
  turned into origin-form, `%2F`/`%3F`/`%25` kept). The gate decodes that path
  until it stops changing, lowercases it and resolves segments, then refuses
  `/s3*` (403), `/upload/<x>/sign*` (403; Carbon never uses signed resumable
  uploads, and a bearer would not protect a route that ignores it), and any other
  `/upload*` request without exactly one `Bearer <JWT>` (401). OPTIONS passes
  unless it carries `X-HTTP-Method-Override`: Kong's cors plugin forwards any
  OPTIONS without `Access-Control-Request-Method`. Kong verifies no signature;
  Storage does. Carbon's only resumable upload
  (`apps/erp/app/utils/resumable-upload.ts`, tus-js-client) always sends the
  user's token. The jobs' `createSignedUploadUrl` writes go to
  `/object/upload/sign`, which is not gated.
- **Readiness.** `host-deploy.sh` proves from the ERP container that Storage's
  `/version` is at least `storage_api.PATCHED`, and that Kong answers the gate's
  403 for `/s3/` and 401 for an unauthenticated resumable create.

Verified locally (fresh `crbn` stack, synthetic company and user):

- At 1.58.4, directly against storage-api, both GHSA-8rrf shapes emptied a
  canary object and created a new one with no credentials. Through the dev Kong
  (no gate) the same shapes were refused: Kong's normalization already re-spells
  them, so the exposure was the internal network and any variant Kong passes
  through.
- 9 objects uploaded through every Carbon path at 1.58.4 (standard 2 KB and
  7 MB, TUS 300 KB, 13 MB in three requests, a 9 MB model into `temp-staging`,
  the company bucket, service role, a signed upload URL). After switching the
  image, Storage applied migrations 0061–0074 on start. All 9 read back
  byte-identical as the user, the service role and through signed URLs minted
  before the upgrade, and 45/45 objects across five sets at the end.
- At 1.84.17, new uploads through every path work via the dev Kong and the
  production-rendered Kong with the gate, including an interrupted TUS upload
  resumed with HEAD and PATCH and the browser preflight. Every exploit shape is
  refused directly (`Missing x-signature header`, S3 routes 404) and by the gate.
- Rollback: 1.58.4 starts on the migrated schema and reads every object, but
  every write fails with `42P10` because migration 0072 dropped
  `storage.bucketid_objname`, its `ON CONFLICT` target. Recreating the index (as
  `supabase_storage_admin`, valid while versioning is off) restores writes; 1.84.17
  then works with it present, and it can be dropped again. With 1.58.4 running
  behind the gate, the gate still refused every shape.
