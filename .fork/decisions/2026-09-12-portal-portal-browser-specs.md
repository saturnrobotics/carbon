# Portal web app browser specs: citation links, and making the suite a gate

**Date:** 2026-09-12
**Scope:** the failing browser tests on the Task 18 branch
(`feat/portal-18-routing-portal`, PR #31) and the run-to-run variance
underneath them, which originates on `feat/portal-14-intake-review-ui`
(PR #26).
**Base:** `feat/portal-18-routing-portal` at `c4f21efc4f`.

Reproduced locally on the containerised suite before any change, on a second
synthetic stack (`portal-t18fix`, ports 4260/4361/4362/59960-59964, images
tagged `t18fix-v1`), leaving the stack already holding the shared ports
untouched. Baseline: `2 failed, 4 passed`, error text identical to CI's.

## The variance was the defect

Five iterations of the PR #26 suite, identical content, same stack, portal
recreated cold before each: **2/5 passed**, and the failures moved.

| Iteration | Outcome |
| --- | --- |
| 1 | `intake.spec.ts:161` — the URL-fetched document's text never appeared (1.5 min) |
| 2 | `intake.spec.ts:75` — `Selected: e2e-intake.pdf` absent; `manual-workflow.spec.ts:271` — `Published` absent |
| 3 | the same two |
| 4, 5 | all green |

Three distinct failing assertions across five runs of one tree is not a gate.
After the fixes: 5/5 on PR #26 (17.3-18.5 s) and 5/5 on PR #31 (20.4-21.1 s).

## Decisions

- **Evidence `sourceUri` stays absolute; the assertion was wrong.** The shared
  contract is `z.string().url()`, and the same field addresses live records in
  the applications that own them — a Carbon source returns the owning
  application's own link, on another origin — so a portal-relative path is not
  expressible. `EvidenceCard` also derives the removal path by parsing that
  URL. The origin is the query service's configured `PORTAL_ORIGIN`
  (a required deploy input), never a reflected request host, so a page served
  behind an identity proxy links to the canonical portal rather than an
  internal hostname. The spec now resolves the href and asserts BOTH the
  portal's own origin and the exact `/documents/:id/versions/:id` path, which
  is strictly stronger than the path-only regex it replaces: a leaked internal
  origin now fails the test. (It caught a real one — the query fixture's
  hard-coded `https://localhost:4200` while the portal was published on 4260.)

- **`window.__reactRouterManifest` is not a hydration signal.** It is assigned
  by an inline module script in the server-rendered HTML, after the route
  modules import, so it is set even when `entry.client.tsx` never loads at all
  (verified by blocking that one request: manifest present, React absent, the
  search button `disabled` after `fill`). The barrier now waits for
  `window.__reactRouterDataRouter`, which `HydratedRouter` assigns, and
  reloads — bounded, four loads — because a cold Vite dev server can
  invalidate `node_modules/.vite/deps` while the entry is being imported
  (`504 Outdated Optimize Dep`) and nothing retries it.

- **Nothing waits without a bound.** Playwright leaves `actionTimeout` and
  `navigationTimeout` unlimited, so one action that can never succeed spends
  the whole test budget and is then reported as whatever the cleanup block
  failed on — which is exactly why one defect surfaced as a 180 s timeout in
  one run and as an assertion in another. Bounded, a failure names the locator
  it waited for.

- **The browser suite cannot run its specs in parallel.** Every spec drives one
  synthetic company and the same two fixture users, and the gateway's test
  endpoints mutate them globally: `/__e2e/revoke/bob` deactivates the user,
  `/__e2e/grant/bob/{review,admin}` swaps the publisher's library grant,
  `/__e2e/fail-next-parser` arms a process-wide failure, and `/__e2e/cleanup`
  deletes every intake captured since the fixture started. `workers: 1` states
  that instead of leaving one spec's authorization experiment to surface as
  another spec's unexplained denial.

- **The dev server is warmed once, not by whichever spec ran first.** The first
  client load of a route is when its packages are discovered and pre-bundled;
  `globalSetup` now loads and hydrates `/` and `/intake` before any spec, so a
  portal that cannot hydrate says so once rather than as six different-looking
  failures.

- **A repeated question inside one conversation is deliberately a different
  cache key.** Restored follow-up context is part of the answer cache's scope,
  and the portal saves context after every answer, so the second identical ask
  carries the first answer's evidence and cannot hit what the first ask stored.
  The spec now clicks "Start a new question" before repeating, which is the
  faithful way to ask the same question again; the cache-hit assertion is
  unchanged. Whether a plain repeat SHOULD hit the cache is a product question
  for the branch author, not something a test change can settle.

- **The local stack takes a project name, image tag and ports.** Defaults
  reproduce the historical project, `manual-v1` tags and the fixed ports
  exactly (`docker compose config` with no overrides differs from the previous
  file only by the two new defaulted port variables), so CI is unchanged. This
  is why these specs shipped written-but-unrun: the harness pinned four
  origins that another stack already held.

## Where each fix landed

Everything except the citation assertion and the conversation/cache repeat
reproduces on PR #26, which merges first, so it was pushed there
(`feat/portal-14-intake-review-ui`, one commit, no force-push, no rebase)
rather than only downstream. PR #31 carries the same shared content plus its
own two: `query.spec.ts` does not exist on PR #26, and the conversation scope
that changes the cache key is PR #31's.

## Verification

| Command | Result |
| --- | --- |
| `pnpm --filter portal test:e2e` — PR #31, 5 cold iterations | 5/5, 6 passed each (20.4-21.1 s) |
| `pnpm --filter portal test:e2e` — PR #26, 5 cold iterations | 5/5, 4 passed each (17.3-18.5 s) |
| the same suite with every determinism fix reverted, 5 cold iterations | 2/5 — the table above |
| `pnpm --filter portal test` | 12 files, 47 passed (PR #31); 10 files, 34 passed (PR #26) |
| `pnpm --filter @carbon/portal test query grounding` | 9 files, 40 passed |
| `pnpm --filter portal-query test` | 14 files, 45 passed |
| `pnpm --filter portal-worker test` | 15 files, 41 passed (PR #31); 13 files, 33 passed (PR #26) |
| `turbo run typecheck` (portal, portal-query, @carbon/portal, portal-worker) | clean on both branches |
| `biome check --error-on-warnings` (changed TypeScript files) | no diagnostics |
| `docker compose config` with no overrides, before vs after | identical but the two defaulted port variables |

## Not done

- No product code changed. The cache-key and absolute-citation questions above
  are flagged for the branch author rather than decided here.
- The unfixed suite's failure rate was measured on PR #26's content only; PR
  #31's extra spec was not included in that baseline.
- Other unbounded waits are now bounded by the config rather than per call
  site, so `manual-workflow.spec.ts` still clicks links it has not asserted
  visible first. That is a diagnosability wart, not a race.
