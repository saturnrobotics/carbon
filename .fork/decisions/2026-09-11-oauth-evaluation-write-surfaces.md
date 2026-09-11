# OAuth evaluation: Storage and Realtime write replays observed

Context: Task 06 of `.fork/plans/2026-09-07-company-knowledge-platform.md` recorded
the native-delegation adoption gate as failed, but its Storage and Realtime
write-replay rows were `untested` because the disposable stack was probed before
those services listened.

Decision: keep the gate verdict data-driven. The compose stack now healthchecks
Storage (`/status`) and Realtime (`/healthcheck`), seeds two Storage buckets after
Storage is healthy (`evaluation` with no INSERT policy, `evaluation-granted` with
authenticated INSERT, mirroring the privileged-RPC fixture), and the harness waits
on each surface before asserting. A write surface that returns no HTTP response is
recorded as `fail` with an `unreachable:` observation, never as `untested`.

Verified outcome (`evaluate.py --disposable --synthetic`, pinned images
gotrue v2.189.0, postgrest v13.0.8, storage-api v1.58.4, realtime v2.89.0,
edge-runtime v1.74.0; synthetic values only):

| Gate check | Observed | Status |
| --- | --- | --- |
| postgrest_dml_replay | 403 (RLS) | pass |
| postgrest_rpc_replay | 200 `mutated` | fail |
| storage_write_replay (no policy) | 400 body 403, no object written | pass |
| storage_write_replay_granted_policy | 200, object written | fail |
| realtime_write_replay (REST broadcast) | 202 Accepted (401 only without a token) | fail |
| privileged_function_replay | 200 | fail |
| gotrue_user_mutation_replay | 200 | fail |
| wrong_audience | 200 | fail |
| asymmetric_signing | HS256 | fail |

Adoption gate: **failed**. Readiness rows (`storage_health`, `storage_fixture`,
`realtime_health`) all pass, so every gate row is a real observation. Still
`untested` by design: `oidc_id_token_flow` (no signing key in the disposable stack)
and `firebase_live_config` (needs a separately authorized Firebase project).

Consequence: the IAP/workload-identity baseline stays selected; native Supabase
OAuth delegation is not adopted on this evidence. Storage and Realtime both admit a
read-scoped client token as a first-party session wherever a policy or the endpoint
admits `authenticated`, so a scoped-token design would need enforcement outside
those consumers, which Task 06 rules out as a broad custom proxy.
