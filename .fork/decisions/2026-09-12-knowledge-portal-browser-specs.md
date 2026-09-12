# Knowledge portal browser specs: citation links and the manual-workflow regression

**Date:** 2026-09-12
**Scope:** the two failing browser tests on the Task 18 branch
(`feat/knowledge-18-routing-portal`, PR #31).
**Base:** `feat/knowledge-18-routing-portal` at `c4f21efc4f`.

Both failures were reproduced locally on the containerised suite before any
change, on a second synthetic stack (`knowledge-t18fix`, ports 4260/4361/4362/
59960-59964, images tagged `t18fix-v1`), leaving the stack already running on
the shared ports untouched. Baseline: `2 failed, 4 passed`, error text
identical to the CI report.

## Decisions

- **Evidence `sourceUri` stays absolute; the assertion was wrong.** The shared
  contract is `z.string().url()`, and the same field addresses live records in
  the applications that own them — a Carbon source returns the owning
  application's own link, on another origin — so a portal-relative path is not
  expressible. `EvidenceCard` also derives the removal path by parsing that
  URL. The origin is the query service's configured `KNOWLEDGE_PORTAL_ORIGIN`
  (a required deploy input), never a reflected request host, so a page served
  behind an identity proxy links to the canonical portal rather than an
  internal hostname. The spec now resolves the href and asserts BOTH the
  portal's own origin and the exact `/documents/:id/versions/:id` path, which
  is strictly stronger than the path-only regex it replaces: a leaked internal
  origin now fails the test.

- **`window.__reactRouterManifest` is not a hydration signal.** It is assigned
  by an inline module script in the server-rendered HTML, after the route
  modules import, so it is set even when `entry.client.tsx` never loads at all
  (verified by blocking that one request: manifest present, React absent).
  The barrier now waits for `window.__reactRouterDataRouter`, which
  `HydratedRouter` assigns, and reloads — bounded, four loads — because a cold
  Vite dev server can invalidate `node_modules/.vite/deps` while the entry is
  being imported (`504 Outdated Optimize Dep`) and nothing retries it.

- **The browser suite cannot run its specs in parallel.** Every spec drives one
  synthetic company and the same two fixture users, and the gateway's test
  endpoints mutate them globally: the grant swap, the user deactivation and the
  intake cleanup are all process-wide. `workers: 1` states that instead of
  leaving one spec's authorization experiment to surface as another spec's
  unexplained denial.

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
  is why the spec shipped written-but-unrun: the harness pinned four origins
  that another stack already held.

## Verification

| Command | Result |
| --- | --- |
| `pnpm --filter knowledge test:e2e` (containerised, cold portal) | 6 passed, 20.7s |
| `pnpm --filter knowledge test:e2e` (containerised, warm portal) | 6 passed, 19.6s |
| `pnpm --filter knowledge test` | 12 files, 47 passed |
| `pnpm --filter @carbon/knowledge test query grounding` | 9 files, 40 passed |
| `pnpm --filter knowledge-query test` | 14 files, 45 passed |
| `pnpm --filter knowledge-worker test` | 15 files, 41 passed |
| `turbo run typecheck` (knowledge, knowledge-query, @carbon/knowledge, knowledge-worker) | clean |
| `biome check --error-on-warnings` (7 changed TypeScript files) | no diagnostics |
| `docker compose config` with no overrides, before vs after | identical but the two defaulted port variables |

## Not done

- No product code changed. The cache-key and absolute-citation questions above
  are flagged for the branch author rather than decided here.
- Other unbounded `click()` calls remain in `manual-workflow.spec.ts` (the
  removal link, the upload buttons). They are not on either failure path, so
  they were left alone; any of them can still spend a whole test timeout if the
  element never appears.
