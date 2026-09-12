# Explicit ticket commands: audit and gap closure (Task 20)

Branch `feat/knowledge-20-ticket-commands`, based on `feat/knowledge-18-routing-portal`;
Kanban branch of the same name, based on `feat/knowledge-authz-08-workforce-cutover`.

## What already existed

Most of the platform plan's Task 20 was in place before this task and was audited
rather than rewritten: the versioned `commandProposalSchema`, the ticket executor
and browser-side hash check, the portal `/api/commands`, `/api/transcribe` and
`/api/propose-command` gateways, knowledge-query's proposal handler (board and
initial column resolved only from the actor's authorized catalog, clarification
for an unresolved board, title or date, no first-board or first-column fallback),
the WAV-only 60-second transcription handler with a per-second budget, the
`knowledge-actions` service with its Dockerfile, and on the Kanban side the
`command_receipts` table with its unique `(workspace, actor, action, key)`
constraint and payload hash, the Alembic revision `64c6e3f658e1`, the
board-authorized single-transaction commit of ticket, activity, receipt and
outbox, and the `kanban.ticket.create` operation gate on the command path.
Capture no longer falls back to the first board: an unselected board with more
than one candidate is a validation error, and the model's confidence is an
optional field, not a constant.

## Gaps closed

- Lost-response recovery. Kanban gained `GET /api/commands/tickets/{key}`, an
  actor-scoped receipt lookup (404 when nothing committed), covered by the same
  `kanban.ticket.create` operation so a read-only caller cannot read command
  results either. The action service now recovers from a network failure,
  timeout or 5xx by reading that receipt and reports "did not commit; retry
  with the same key" on a 404, instead of guessing or re-sending.
- The `IntegrityError` retry in `create_ticket_command` re-reads the winning
  receipt once rather than recursing; an unrelated integrity failure propagates.
- Per-command re-authorization is a named boundary: `authorization.ts` in
  `knowledge-actions` refuses machine identities and any principal without
  `kanban.ticket.create`, so a `knowledge.read` query identity has no invocation
  right. Source round-trips carry a 10 s timeout.
- The action result now returns the effective fields the source committed
  (ticket id, board, column, title, due date) next to the ticket link.
- The Postgres concurrency suite binds the engine to the disposable database
  before import, applies the Alembic head through the application's own
  `migrate_database`, and skips itself when an earlier suite already bound the
  engine to SQLite. Previously it could only ever have run against SQLite.
- New Kanban tests: exact-board create access, non-initial column rejection,
  actor stamping and effective fields, receipt recovery and actor scoping, and
  an HTTP-level proof that a caller registered for `kanban.read`/`kanban.ui`
  is refused on both command paths in workforce mode.
- A service-boundary integration test starts the real Kanban backend (SQLite,
  explicit test mode, loopback port, throwaway directory) and drives
  `knowledge-actions` through it: initial column and actor, replay, four
  simultaneous retries producing one ticket, changed payload refused, an
  outsider refused on the exact board, and a lost response recovered. It runs
  only when `KNOWLEDGE_KANBAN_BACKEND_DIR` is set.

## Deliberately not done

- knowledge-query does not route `/v1/propose-command` or `/v1/transcribe`, and
  the portal renders no command or voice affordance. The approved manual-v1
  boundary states that voice and Kanban commands must not activate under the
  release configuration, `manual-workflow.test.tsx` pins the absent affordance,
  and `release-fence.test.ts` pins the absent provider wiring. Enabling them is
  a release-profile decision, not a gap in this task. The browser spec
  `tests/ticket-command.spec.ts` therefore pins the deferred state: no
  affordance, and `/api/commands` answers 503 for every request.
- The browser spec was not executed: the fixed e2e ports (4200, 4301, 4302,
  59910) are held by the shared local stack, which this task must not use.
- The central `knowledge.command` row is not written by the action service.
  Reconciliation today is the source receipt itself; a central record that
  reconciles from it needs the actions database role to be wired into the
  service, which is outside this task's ownership.

## Verification

Kanban: `make test-api` 66 passed, 1 skipped (the Postgres module, by design in
the mixed run); `tests/test_commands_postgres.py` alone against a disposable
`postgres:16-alpine` container on a loopback port: 2 passed, Alembic head
`64c6e3f658e1` applied, container removed. Carbon: `@carbon/knowledge test
command` 12 passed; `knowledge-actions test` unit suites passed plus the
Kanban-backed integration suite 5 passed when pointed at the sibling checkout;
`knowledge test` passed; scoped typecheck and strict Biome on the changed paths
passed. Exact counts are in the pull request.

## Follow-up: the browser spec asserted a refusal the release cannot produce (2026-09-12)

`tests/ticket-command.spec.ts` had never been executed — the section above says
so — and running it showed the deferral was pinned against the wrong mechanism.
The spec expected `POST /api/commands` to answer 503
`ticket_commands_not_configured`; it answers **404 from the catch-all**, because
`api.commands` is on the deferred-route list that
`test_production_web_route_manifest_excludes_deferred_routes`
(`contrib/deploying/knowledge/test_images.py`) enforces, so
`apps/knowledge/app/routes.ts` never registers it and `routes/unavailable.tsx`
answers instead.

**The spec was the wrong side.** The deferred state of this surface is ROUTE
ABSENCE, not a registered route that refuses. A React Router route manifest is a
build-time artifact, so absence is the stronger boundary and it is the one the
release fence already declares. The spec now asserts that: every request shape —
well-formed proposal, answer-shaped payload, foreign origin — and both sibling
routes (`api.propose-command`, `api.transcribe`) get the same 404 HTML, with a
positive control (`/api/query` → 422) proving the 404s are route absence rather
than a portal that refuses every POST.

The alternative was the Drive precedent: contribute the routes at build time
behind a flag that defaults off. Rejected on the merits. Drive gates a PAGE with
real behaviour that only exists when the route exists, and its spec proves ACLs,
revocation and reconciliation. Here the handler's refusals are already covered
over real `Request` objects by `app/routes/api.commands.test.ts`, so a flag would
buy only the env-guard branch — and it would cost the browser suite its ability
to say anything about the shipped portal, since the harness would no longer be
release-shaped for commands. Worse, gating `api.commands` alone yields an
incoherent profile: a command gateway with no route that can produce a proposal
and no affordance that can reach it. `release.py` admits neither
`KNOWLEDGE_ACTIONS_URL` nor `KNOWLEDGE_ACTIONS_AUDIENCE` on a `knowledge-web`
revision, so 503 is the only answer a release could give even after the route is
registered. Enabling commands stays a release decision.

Stated cost: the 503 branch is unreachable in every built image. It is no longer
untested — `api.commands.test.ts` now covers `action` directly (503 when any of
the three actions variables is missing, and delegation to the gateway when they
are all present).

Fence proof on the release-shaped build (`pnpm --filter knowledge build`, no
flags): the server bundle's route table is
`"", "", health, logout, step-up, api/query, api/items, intake, intake/:id,
documents/:documentId/versions/:versionId, documents/:documentId/remove, *` and
`api.commands` / `api/commands` / `forwardTicketCommand` /
`ticket_commands_not_configured` appear nowhere in `build/`. (The string
`kanban.ticket.create` does appear: that is the command PROPOSAL SCHEMA from
`@carbon/knowledge`, which the portal needs in order to recognise and refuse a
command-shaped answer. A validator, not a gateway.)

### The harness had to become runnable first

The spec was never run because the harness pinned whole origins by string
equality and fixed ports 4200/4301/4302/59910, which a long-lived stack held.
Fixing the assertion without fixing that would leave the cause in place. The
harness is now parameterised exactly as the Drive branch parameterised it —
`tests/loopback.ts` keeps the loopback guarantee (host, scheme, no credentials,
no path) and frees the port; `compose.local.yaml`, `local-stack.sh` and
`build-images.sh` take stack name, image prefix, image tag and every published
port from environment variables defaulting to the historical values, verified
byte-for-byte with `docker compose config`. `playwright.config.ts` also sets
`workers: 1`, since the specs share one database and `manual-workflow.spec.ts`
deactivates the shared reader mid-run. One latent bug fixed on the way:
`local-query.ts` hardcoded `https://localhost:4200` as the origin stamped onto
evidence `sourceUri` links, so a harness on another port handed the browser
download links pointing at whatever else held 4200.

### Two other specs are red, both pre-existing and independent — hand-off

Neither blocks `ticket-command.spec.ts`, and neither is touched here.

- `query.spec.ts:109` asserts the "Download original" href matches
  `/^\/documents\/[^/]+\/versions\/[^/]+$/`, i.e. a relative path. It cannot
  ever match: `assembleEvidence` builds `new URL(path, origin).toString()` and
  `evidenceSchema.sourceUri` is `z.string().url()`, so the value is absolute by
  contract, and `EvidenceCard` renders it verbatim. Whether the repair is
  "assert the pathname" (the idiom `manual-workflow.spec.ts` already uses) or
  "render a same-origin relative link" is a product call for the branch owner.
- `manual-workflow.spec.ts:152` asserts the repeated search is a cache hit.
  Running that spec alone moved the fixture counters `gets 7→9, hits 2→2,
  sets 5→7`: two searches, two misses, two sets — the repeat is not the same
  cache key. `cacheKey` contains no origin, so this is independent of the
  harness change; the likely cause is the conversation follow-up context added
  in Task 18 changing `intent`/`entities`, or an epoch bump from the publish
  landing between the two searches. Diagnosed, not fixed: "the second search
  should hit" may be a real product regression, and guessing would mask it.
