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
