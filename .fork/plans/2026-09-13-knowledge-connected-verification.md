# Knowledge connected workflow verification

Approved scope: reconcile the existing knowledge plans, verify the merged repairs
locally, and fix reproducible defects within that scope. Cloud provisioning,
production data, additional users and deferred feature activation are excluded.

Base: `7e03ef5e2d65577dda5cd3b2463649f46cb12ee0` (repair integration #56).
Use an isolated checkout and uniquely named disposable services. Existing
developer databases and other agents' containers are not verification targets.

- [x] Fast-forward the clean primary checkout to the reviewed repair integration.
- [x] Reconcile roadmap implementation status, acceptance evidence and open PRs.
- [x] Build current browser harness images; verify upload, extraction, review,
      publication, retrieval, immutable download and denial paths on cold stacks.
- [x] Exercise the Carbon receiver and receipt/manual lookup with the real Carbon
      schema and authorized API; state exactly which identity boundary is synthetic.
- [x] Verify isolated backup/restore preserves denied and tombstoned documents.
- [x] Reproduce discovered defects before minimal fixes; run scoped regression gates.
- [x] Record evidence and remaining deployment gates; review the public diff for
      a PR with no private runtime artifacts. Publication/check status belongs to
      the branch's GitHub PR, not a pre-publication completion claim here.

Verification uses the existing `contrib/deploying/knowledge/build-images.sh e2e`
and `local-stack.sh test` with explicit unique stack/tag/ports. Logs and temporary
fixtures belong under ignored `.fork/local/connected-verification/`. Record
commands, outcomes, negative controls, skipped checks and limitations in the final
decision record; a local fixture pass cannot certify Google IAM or production.
