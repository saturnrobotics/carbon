# Portal connected workflow: verification and remaining gates

Verified the merged repair integration at
`7e03ef5e2d65577dda5cd3b2463649f46cb12ee0` in a new checkout. The clean primary
`saturn/main` was fast-forwarded to that revision. No production application,
authentication, schema, credentials or cloud infrastructure was changed.

## Defects found and corrected

1. Recovery selected containers using the configured Compose project but copied
   the default project's storage volume. It now explicitly selects one project,
   validates container project/service and actual volume ownership before starting
   anything, and starts validated existing containers without recreating them.
   Five ownership regression tests failed before the fix and passed afterward.
2. The final workforce browser test ignored `PORTAL_E2E_PRESERVE_FIXTURE` and
   removed every captured intake, including earlier tests' retained originals.
   Three cold runs each passed all 24 tests but left zero captured intakes. The
   cleanup now honors the flag. A new post-suite SQL gate checks newly uploaded
   originals and tombstones in preservation mode and absence of this run's rows
   otherwise. It failed with exit 3 before the fix. Pre-existing retained IDs are
   snapshotted so old fixtures cannot mask a lost new fixture or cause a false
   cleanup failure after a service restart.

The existing portal CI browser job runs both preservation and normal cleanup
modes, so the preservation regression is exercised on subsequent changes rather
than depending on an agent remembering the optional flag.

## Executed evidence

| Check | Result and scope |
| --- | --- |
| Frozen pnpm install; config package build | Passed with pinned pnpm 10.33.4. The first portal test attempt could not load an unbuilt `@carbon/config`; building it resolved setup, without dependency changes. |
| Current four browser-harness image builds | Passed; dedicated image tags and disposable volumes. |
| Original merged browser suite, three cold runs | 24/24 each: 44.8 s, 38.9 s, 37.2 s. This alone missed the final cleanup defect. |
| Corrected preservation-mode browser suite | 24/24, 37.2 s, plus uploaded-original/tombstone postcondition. |
| Corrected cleanup mode on reused stack | 24/24, 38.0 s, plus run-scoped cleanup postcondition; earlier retained fixtures allowed. |
| Final preservation mode on reused stack | 24/24, 38.1 s, plus run-scoped preservation postcondition. Four separate database checks proved old uploads cannot mask lost new fixtures, new leftovers fail cleanup, and earlier retained rows are allowed. |
| Portal / query / portal / worker unit tests | 456 / 85 / 76 / 89 passed; no skipped tests in these four runs. |
| Scoped typecheck | Five tasks passed for portal, query, worker, shared portal and their task dependency. Portal typecheck repeated after its test change. |
| Deployment Python tests | 75 passed; Ruff clean; shell syntax and changed TypeScript Biome checks passed. |
| Local HTTP retrieval sample | 100 requests, concurrency 4, zero errors; p95 43.296 ms. Small synthetic corpus and local identity fixture; not a cloud or production-scale benchmark. |
| Database-only recovery | Restore preserved authorization, tombstones and rebuild candidates. |
| Combined database/object recovery | 16 objects / 6,788 bytes; exact generations and SHA-256, linked references, RLS reads, tombstones, roles, ownership, policies and ACLs preserved. |
| Recovery cleanup, checked separately | No recovery target containers, networks, volumes, temporary databases/rows or dump archives remained. |

## Real Carbon connection

An independently owned disposable runtime applied 1,016 Carbon migrations and
38 portal migrations in the same database. Enrollment succeeded against
Carbon's actual identifier helper grants. The unchanged Deno receipt function
posted and voided a synthetic receipt; actual ERP HTTP routes returned its items.

The query handler used real Redis and a separate `portal_read` login that was
explicitly denied access to Carbon's `public.user` table, with neither superuser
nor RLS-bypass privileges. It called the real ERP receiver for item resolution and
receipt reads and selected the exact reviewed manual version. Thirteen token and
identity attack cases returned the same opaque ERP 401; live inventory permission
removal returned 403 and restoration returned 200 without cache clearing.

Twelve query scenarios passed, including exact-version evidence, wrong company,
unenrolled identity, revoked/restored document grants, revision/date mismatch,
canonical deactivation, denial after reactivation until explicit reenrollment,
and abstention after actual receipt voiding. The untracked-lot setup first
returned a partial receipt projection; it was not a separately executed full-query
abstention test. Normal Carbon revision creation creates a new item ID; directly
mutating a referenced row for the mismatch control does not prove a defect in
that normal revision workflow.

Google certificate retrieval and service-token issuance were instrumented only
in ignored local launchers with newly generated test keys. Actual JWT crypto,
issuer/audience/access-level checks, authorization and ERP dispatch remained in
place. The manual for this join was a seeded reviewed version/chunk. The browser
suite separately proved upload/extraction/publication/download; this is not one
continuous uploaded-document-to-live-Carbon browser proof or Google sign-in proof.
The Carbon probe's owned containers, volumes, network and listeners were removed.

## What remains

- Representative document/corpus use and a continuous Carbon-connected browser
  pilot. Synthetic fixtures do not establish retrieval relevance for real work.
- Authorization Task 11: explicitly selected target and initial tester, real
  Google sign-in/assurance, IAP/private ingress, service IAM, GCS permissions,
  deployed revocation, rollout/rollback and production recovery.
- Reproduce remaining handoff findings before changing auth: step-up error
  classification and non-API-key bearer error semantics. The receipt reversal
  quantity remains fixed at zero and needs a separately reviewed semantic decision.
- Carbon source-outbox triggers remain deliberately detached. Do not describe
  incremental updates as active merely because a fixture installs them.
- Drive, vector retrieval/synthesis, commands, procurement and generic/MCP
  surfaces remain deferred. Kanban's current revision/cutover is a separate check.
- PR #38 was closed as superseded after comparing trunk behavior. PR #57's handoff
  still needs its pre-#56 merge instructions refreshed before adoption.

The roadmap and authorization plans now separate merged implementation from
acceptance. Reusable procedures are in
[local verification](../playbooks/portal-local-verification.md) and
[Carbon connection](../playbooks/portal-carbon-connected.md). Raw logs and
runtime inputs remain ignored under `.fork/local/`; no real company documents or
deployment credentials were used or published.
