# Portal manual workflow and recovery verification

Use an isolated checkout and a uniquely named disposable stack. Never reuse an
existing developer stack or another task's volumes. Real documents, identities,
credentials and deployment configuration do not belong in tracked fixtures.

## Prepare

1. Read `.fork/agent-policy.md` and the current portal program status.
2. Inspect Git state, worktrees and `docker ps` before choosing unused ports and
   a unique stack name. Keep one coordinator responsible for the selected stack.
3. Run `corepack pnpm install --frozen-lockfile` and
   `corepack pnpm --filter @carbon/config build`. The portal test configuration
   imports that package's built output; an unbuilt config is a setup failure.
4. Export every stack variable from the "Running a second stack" example in
   `contrib/deploying/portal/README.md`, changing the name/tag/ports to unused
   values. Keep them exported for **all** build, test, stop and recovery commands.

## Browser journey

```bash
contrib/deploying/portal/build-images.sh e2e
PORTAL_E2E_PRESERVE_FIXTURE=1 contrib/deploying/portal/local-stack.sh test
```

The suite drives upload → actual PDF extraction → review → publish → search →
download. It verifies exact original bytes, revocation, cross-company denial,
deletion and duplicate prevention. It also tests synthetic workforce assertions
and deferred-route boundaries. The final SQL assertion must confirm that an
uploaded original and tombstone remain; seed documents do not satisfy it.

For startup repeatability, remove **only this task's** stack with
`local-stack.sh down`, then run the test command again. Record each cold result;
do not count a warm rerun as a cold boot.

Manual interaction uses the loopback fixture's `portal_e2e_actor` cookie
(`bob` or `alice`) in a dedicated browser context. The portal has no development
login form. Wait for actual client hydration before interacting. Select controls
by their labels: "Upload a manual", "Upload manual", "Source evidence",
"Title", "Manufacturer", "Part number", "Save review", "Publish manual",
"Search manuals" and "Download original". Do not copy real browser sessions.

## Recovery and cleanup

After the retained browser journey succeeds, stop the selected stack's services:

```bash
contrib/deploying/portal/local-stack.sh stop
python3 contrib/deploying/portal/verify-local-recovery.py --synthetic --disposable
```

The proof validates selected container/volume ownership, copies database and
object storage into fresh recovery targets, and compares object hashes and
generations, ACLs, roles and tombstones. Inspect resource cleanup separately;
success JSON is emitted before the cleanup block. Only the selected source's
volumes should remain, with no temporary recovery rows or target resources.

Restart and exercise the opposite fixture contract:

```bash
PORTAL_E2E_PRESERVE_FIXTURE=0 contrib/deploying/portal/local-stack.sh test
contrib/deploying/portal/local-stack.sh down
```

Normal mode must pass both the browser suite and the final assertion that this
run's captured intake/document rows are absent. Previously retained fixtures are
identified before the suite and excluded from both modes' assertions. Remove only this task's uniquely tagged images
when finished. Do not run the default-only `verify-local-lifecycle.sh` against a
named stack.

## Evidence limits

Record revision, commands, test counts, failures and cleanup checks in a concise
decision record. Keep raw logs under ignored `.fork/local/`. This stack uses real
PostgreSQL, Redis, extraction and emulated object storage, but fixture identity
and transport. It does not prove the Carbon HTTP receiver, managed Google sign-in,
GCP IAM, real document relevance, production rollout or production recovery.
The Carbon-connected workflow needs its own co-located schema and API proof.
