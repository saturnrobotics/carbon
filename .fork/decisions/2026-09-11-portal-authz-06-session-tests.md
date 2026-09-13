# Portal authorization Task 06: session and entry-path verification

**Date:** 2026-09-11
**Plan:** `.fork/plans/2026-09-11-portal-authorization.md`, Task 06
**Base:** `saturn/main` at `7464d10347`
**Proof delivered:** local unit proof only (no cloud configuration involved)

## Decision

A request whose host matches neither `ERP_URL` nor `MES_URL` no longer falls back
to the pre-split shared `carbon` cookie outside development. `resolveAuthCookieName`
in `packages/auth/src/services/session.server.ts` throws a 500 `Response` and writes
one `auth` log line naming the host. Development keeps the fallback and warns once
per host per process. "Development" is `NODE_ENV === "development"`, the same
predicate the cookie's `secure` flag already used, so `test` and `preview` fail
closed too; a deployment whose public host is not one of the two configured URLs
is a misconfiguration and now surfaces as one instead of as a cross-app cookie.

## Verified

- `pnpm --filter @carbon/auth test workforce-session`: 7 passed (3 new: production
  mismatch throws a 500 with exactly one error line carrying `{ host }`; a port
  mismatch on the ERP host is a mismatch; development falls back with one warning).
- `pnpm --dir apps/erp exec vitest run test/workforce-entry-path.test.ts`: 4 passed.
- `pnpm --dir apps/mes exec vitest run test/workforce-entry-path.test.ts`: 4 passed.
- Removing the `autoGoogleStarted` ref guard from the ERP login makes the
  "starts once" case fail (`toHaveBeenCalledOnce` sees two calls), so the guard is
  what the test measures.
- The entry-path tests use the real `@carbon/auth/session.server`, so the
  `carbon-erp` / `carbon-mes` pending-MFA cookie and the parent-domain
  `carbon=; Domain=example.com; …Expires=Thu, 01 Jan 1970` expiry are the strings
  production emits, and the pending session round-trips through
  `getPendingMfaSession` with the parked `redirectTo`.
- `pnpm exec turbo run typecheck --filter=@carbon/auth --filter=erp --filter=mes`:
  4 successful (after `react-router typegen` in each app, which a fresh worktree lacks).
- `auth-redis-resilience.test.ts` minted its cookie for `http://localhost/` against a
  mocked `ERP_URL` of `http://localhost:3000`; it now uses the configured host. Its
  subject (Redis failure tolerance) is unchanged.

## Not covered

- Biome's `apps/biome.jsonc` only includes `./**/app/**`; `apps/*/test/**` and the
  vitest configs are outside its scope by repo convention (the precedent
  `login-integration.test.ts` is equally unchecked). The new files were checked
  under a scratch copy of the root rules with `--error-on-warnings` and formatted
  to match; the repo config was not widened.
- `StrictMode` double-mount is simulated by replaying the captured `useMount`
  callbacks twice under `renderToStaticMarkup`; there is no DOM test runtime in
  the apps and none was added.
