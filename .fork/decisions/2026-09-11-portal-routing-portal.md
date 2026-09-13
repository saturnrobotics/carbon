# Portal bounded routing, synthesis and the portal interface (plan Task 18)

**Date:** 2026-09-11
**Scope:** Task 18 of `.fork/plans/2026-09-07-company-portal-platform.md`
(§1.7 budgets, §1.9 invariants, A05/A08/A09/A14).
**Base:** `feat/portal-12-source-adapters` at `ab3c5da5ef`, merged with
`feat/portal-16-retrieval-gaps`, `feat/portal-authz-07-read-gate` and
`feat/portal-14-intake-review-ui`.

## What was found (gap audit against the six steps)

| Step | Present on the merged tree | Gap filled here |
| --- | --- | --- |
| 1 Deterministic routing, capability registry | `routeQuery` (locate/read/command); structured intents as ad-hoc regexes inside `sources.server.ts` | `QUERY_CAPABILITIES`, a frozen registry (description, typed input, deadline, projection limits, `inference: none | answer`); `structuredIntent` moved into the router so one deterministic decision precedes every source, index or model call |
| 2 Direct locate result; cited answers or abstention | `executeReadQuery` with citation validation and abstention | Only a capability registered with `inference: "answer"` may reach a provider; locate cannot, by construction rather than by mode check |
| 3 Streaming with honest progress | none: one buffered JSON response end to end | NDJSON event stream (`query/stream.ts`) from the service, validated line by line in the BFF, read incrementally in the browser; every event is a real stage or the delivered result |
| 4 One input, cards, citations, choices, follow-up | search form and document cards; `mode` hard-coded to `locate`; claims, choices and entity cards not rendered | answer claims with `[n]` citations opening `sourceUri` (exact version and page), clarification choices that re-ask with `context.entityId`, live-record cards, "start a new question" |
| 5 Token accounting, hard budgets, compact conversation state | ceilings as literals in `vertex.server.ts`, `evidence.ts`, `answer.server.ts`; `conversationState` (Task 17) with no call site; user text already in POST bodies | `query/budgets.ts` (`QUERY_BUDGETS`, ledger, deterministic fit); a Redis-backed conversation store keyed by the verified principal, restored through `reauthorizeConversationState` |
| 6 Carbon navigation link | none | not done (below) |

## Decisions

- **The registry is the whole catalog.** `QUERY_CAPABILITIES` is built from
  nothing but its own module and deep-frozen at load. The router reads
  `request.text` and `mode` only; the query service asks the router once,
  before admission, sources, the index or a model. A unit test routes hostile
  text and checks the registry's JSON is unchanged and every mutation throws.
- **One frozen budget object.** `QUERY_BUDGETS` replaces every literal:
  the provider's 8000/800/8800 ceilings, the 7000-token evidence cap, the
  8-block and 40-candidate limits, the four-source limit, the 10 s request
  deadline and the conversation's 8-reference cap all read the same object,
  so no stage can be widened alone. `conservativeTokenCount` (UTF-8 bytes) is
  the ceiling everywhere a provider count is not available.
- **A stream carries nothing a JSON caller would not get.** Events are
  `progress` (`retrieval`/`sources`/`synthesis`, `started` or `partial`),
  `evidence` (authorized blocks, sent once, before any synthesis), the
  terminal `result` (the same value `executeReadQuery` returns) and a coded
  `error`. There is no placeholder text. The BFF re-validates every line
  against the shared schema and ends the stream with `query_unavailable` on
  the first line outside the contract; the browser withdraws shown evidence on
  an error event. A failure inside a started stream maps to three codes
  (`authorization_changed`, `request_deadline_exceeded`, `query_unavailable`)
  and never to a message.
- **Structured source work and step-up stay outside the stream.** The live
  source path runs before the response starts, so a source's
  `step_up_required` denial keeps its own 403 and the portal can still send
  the reader to `/step-up`.
- **Follow-up context is eight evidence ids, nothing else.** The service
  stores `conversationState` under a key derived from the verified company,
  actor and the client's opaque `conversationId`, for 30 minutes, in its own
  Redis store (the answer cache's 60 s TTL bound is unchanged;
  `createRedisCache` gained a `maxTtlSeconds` option). On reuse every id is
  re-read under the reader's row policy and live access (`authorizeIds`), and
  the prior evidence joins retrieval as one more ranking rather than replacing
  the fresh hits. The context ids enter the cache scope, so a question asked
  in context is a different cache key. A store failure means no context,
  never a failed delivery.
- **Ambiguity choices re-ask, they do not search again.** A choice sends the
  same text with `context.entityId`; the structured path reads that one
  record through the adapter's `getEntity` from the sources the intent would
  have searched. The received-manual resolver's clarifications are unchanged.
- **Cards say what they open.** A document card opens the immutable version
  (with the page fragment) and keeps "Download original"; a live-record card
  (`entityId` without `documentVersionId`) says "Open record" and links to the
  owning application, which re-authorizes on open.
- **Three HTTP bridges pipe bodies.** `writeWebResponse` in
  `request-boundary.server.ts` writes a fetch `Response` chunk by chunk; the
  production server, the worker's local fixture server and the Playwright
  gateway all use it, so a buffered JSON response is written exactly as before
  and a stream reaches the reader as it is produced.

## Merge notes

Conflicts hand-resolved: `packages/portal/src/sources/http.server.ts`
(Task 12's status-aware `boundedCall` now reads a 403 body for the structured
step-up code with the shared `readBounded`), `packages/portal/package.json`
(union of exports). Git rerere restored earlier resolutions for
`query.server.ts`, `QueryInput.tsx`, `routes.ts` and `package.json`; each was
diffed against both sides before it was kept. Merge fallout fixed in tests
only: three identity fixtures gained the `assurance` field Task 03 requires,
and `http.test.ts` now expects Task 12's `SourceTransportError("denied")`
for an ordinary 403. The MCP manifest digest was regenerated, not hand-edited.

## Verification (local, synthetic; containers `portal-t18-test` on 59980 and `portal-t18-cache` on 59983, removed afterwards)

Recorded in the PR body's verification table.

## Not done

- **Step 6, the Carbon navigation link.** It requires a change under
  `apps/erp/**`, which this task may not touch, and its gate — the portal's
  source-authorization browser spec (`authorization.spec.ts`) — lives on PR #25
  (Task 24), not on this tree.
- **The Docker browser e2e** (`apps/portal/tests/query.spec.ts`) was written
  but not run: the harness pins `https://localhost:4200`, `4301`, `4302` and
  `59910` as the only permitted fixture origins, and Task 19's shared
  `portal-manual-local` stack held all four for the whole session. Its
  assertions are the same ones the integration case proves at the service
  boundary (stream shape, evidence before result, follow-up context, denial
  for the other company).
- `evaluate -- suite=interactive` lives on PR #25 and is not on this tree.
- The router still makes no structured inference call; the plan allows at
  most one, and none is needed for the registered capabilities.
