# Fork records policy

These rules apply to every task retained on this fork, including ordinary feature
work. User instructions take precedence. Within the repository, this policy's
artifact paths override inherited `.ai/` write paths. Continue reading upstream
`.ai/lessons.md` and relevant package instructions.

Upstream synchronization is a separate concern with its own tooling and
documentation under `docs/fork/` and `scripts/fork/`; this file does not describe it.

## Start from known source

- Give each independent task an isolated worktree based on an explicit reviewed
  revision. Before editing, inspect `git status --short`, `git rev-parse HEAD`, and
  `git worktree list`. Confirm any prerequisite branch-only file exists at that
  revision. Missing prerequisites are a base-selection problem, not permission to
  recreate the absent feature.
- Assign one coordinator as the Git writer per worktree. Helpers may edit
  exclusively assigned files; only that coordinator stages, commits, switches
  branches, or changes shared Git state. Never change another agent's environment,
  test credentials, lockfile, database, or running services.
- Preserve unrelated working changes. Do not use blanket restore/reset/clean,
  automatic stash/pop, `git add -A`, or force-add ignored files. Record exact
  revisions and verification results without copying private runtime values.

## Own records separately

Use the following mapping whenever an inherited skill requests an artifact. This
mapping also applies to `/feature`, `/fix`, `/plan`, `/execute`, `/conductor`,
`/test`, `/self-review`, and `/writing-skills`; their other procedures still apply.

| Inherited destination | Fork destination |
| --- | --- |
| `.ai/lessons.md` additions | `.fork/lessons/{date}-{slug}.md`, one lesson per file |
| `.ai/specs/` (including `implemented/`) | `.fork/specs/` with the same suffix |
| `.ai/plans/` (including `improve/`) | `.fork/plans/` with the same suffix |
| `.ai/research/` | `.fork/research/` |
| `.ai/playbooks/` | `.fork/playbooks/`, synthetic reusable procedures only |
| `.ai/runs/`, `.ai/scratch/`, screenshots, process state | `.fork/local/`, ignored |
| Durable decisions and concise verified outcomes | `.fork/decisions/{date}-{slug}.md` |

Read both upstream and fork specs/lessons before designing related work. Do not
rewrite upstream records simply to add a fork note. Historical migrated records
under `.fork/decisions/archive/` are preserved evidence; create no new execution
logs there. Add lessons using `Context → Problem → Rule → Applies to`. Keep public
records synthetic and concise. Actual deployment inputs still belong in
`contrib/deploying/gcp-tailscale/.local/` or the deployment secret store.

## Verification

Never claim work is complete without running the applicable checks for the touched
packages and reading their output. A successful installer, no conflict markers, a
build, or a mocked test alone does not establish behavioral correctness. Never
bypass hooks, remove a required check, weaken a fixture, or add skip flags to get a
change through; if a required check cannot run, keep the change unpromoted and
report the missing evidence.

## Verify deployment boundaries before release

For changes to deployed behavior or deployment machinery, use this order:
**local production-image tests → provider validation → focused platform checks
→ full release → real user workflow verification**. The agent owns these checks;
the user should not need to repeat this instruction at each turn.

1. **Local proof first.** Use Carbon's existing local development and integration
   harnesses, then test the affected behavior in the actual production image with
   its deployed runtime version, architecture, entrypoint, real protocol client,
   and production-equivalent rendered configuration pointing to isolated synthetic
   destinations. Preserve other worktrees and running stacks. Cover failure paths,
   such as rejected certificates, wrong hosts, denied permissions, failed health
   probes, and state-preserving restart/rollback. A dev server, successful build,
   mocked response, or another client's successful connection is insufficient
   evidence for a production-image boundary.
2. **Validate the provider contract.** Check the exact rendered requests against
   the configured provider API/version, using its non-persisting validation or
   dry-run facility where available. Terraform validation/plan and mocked SDK
   responses do not prove provider acceptance; successful API validation does not
   prove actual startup. If no such facility exists, record that limitation and
   the smallest bounded platform check needed; do not claim the contract is
   verified or use a full release to discover request-shape errors.
3. **Probe only the remaining platform boundaries.** Exercise behavior that
   cannot be established locally, such as managed identity/IAP, private networking,
   and revision lifecycle, with bounded focused checks. Preserve serving traffic,
   access controls, persistent state, and recovery options. Use isolated resources
   or an unserved revision when appropriate, and verify cleanup. Real Google OAuth
   is needed for live identity proof; it is not a prerequisite for unrelated local
   tests or a reason to skip them. Mocks do not establish managed-platform behavior.
4. **Release and prove the workflow.** Run the canonical release only after all
   applicable earlier stages and normal source/CI gates pass. Then verify the
   affected real user workflow with synthetic data, including relevant denial and
   cleanup behavior. Health checks alone do not establish workflow correctness.

Keep a concise evidence record in an ignored private location. Identify the exact
source revision, image digest, runtime, configuration fingerprint/secret versions,
provider inputs/version, commands, and semantic results without logging secret
values. Mark each stage verified, blocked, or not applicable with a reason. Reuse
valid evidence when the complete relevant inputs and assumptions are unchanged
and canonical source/image provenance requirements permit it; invalidate affected
evidence when they change. Never relabel an old receipt with a new source revision
or skip a controller's required build. Do not add unrelated rebuilds or retests
beyond the applicable canonical requirements.

After a deployment failure, stop full-release retries: establish the root cause,
reproduce it at the smallest relevant boundary, prove a failing-then-passing
regression and any affected provider/platform contract, then retry through the
normal gates. If a boundary cannot be reproduced locally, retain the local proof
and use the bounded platform check; never substitute an unverified mock or silently
mark the stage passed. Do not weaken authentication, authorization, TLS, health
checks, fixtures, or CI to make a release pass.

Continue checks and fixes within the user's existing authorization; this policy
does not require repeated approval prompts. New destructive actions or changes
outside that scope still require authorization. These rules make evidence and gaps
explicit; they do not guarantee that every future deployment defect is prevented.
