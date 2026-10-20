# Kong's `authz_api` claim check and a shorter access-token lifetime

Base: `saturn/main` at `b8497b5cae` (after #82, HQ sign-in, and #84, the
authz projection and the token hook's `authz_api` claim).

Specification: HQ plan 0006B, Step 7 ("Kong and the hook"), B6 (caching and
revocation), B8 (Kong and GoTrue), Q5 (`anon` and `service_role`) and Q6 (the
access-token lifetime). Part of the RBAC change the operator approved for 0006B
on 2026-10-18 (see `2026-10-19-saturn-authz-projection.md`). Fork-owned
deployment tooling only; no shared upstream file changes.

## Design

- **Switch.** Private config `AUTHZ_API_CLAIM_REQUIRED` (`"true"`/`"false"`,
  default `"false"`), which requires `HQ_SIGN_IN_ENABLED`. Off, the rendered stack
  is byte-identical. Changing it changes Kong's definition and `kong.yml`, so
  `make deploy` selects coordinated maintenance.
- **Routes.** `authz_api_claim.py` classifies every gateway service by the
  upstream it forwards to: PostgREST `api:supabase.rest`, Storage
  `api:supabase.storage`, Realtime (socket and REST) `api:supabase.realtime`,
  the edge runtime `api:supabase.functions`; GoTrue (`/auth/v1/`, `/verify`)
  stays open because it issues and refreshes tokens. Rendering fails on an
  unclassified upstream, a service without a `url`, or any existing
  `pre-function` (a route-level or global one would override the check).
- **Mechanism.** A sandboxed `pre-function` (bundled with the pinned Kong
  2.8.1) on each gated service, rendered from `auth/kong-authz-api.lua` with
  `local REQUIRED = "<resource>"` prepended. `KONG_PLUGINS` gains
  `pre-function`; `KONG_UNTRUSTED_LUA=sandbox` and
  `KONG_UNTRUSTED_LUA_SANDBOX_REQUIRES=cjson.safe` (the probe of the 2.8.1
  sandbox showed `kong` and `ngx.decode_base64` available and no JSON decoder).
- **Rule.** Every credential the upstreams read is checked: the `Authorization`
  bearer, the `apikey` and `x-api-key` headers and the `apikey` query argument,
  every value of each. A credential that is not a JWT is 401. A token GoTrue
  issued (it always carries `session_id`) must list `REQUIRED` in its top-level
  `authz_api` array, else 403. `anon`, `service_role` and Carbon's server-signed
  tokens (no `session_id`) pass. No credential at all passes, as today.
- **Lifetime.** With HQ sign-in, `GOTRUE_JWT_EXP=900` (the template's is 3600);
  the bootstrap GoTrue keeps 3600.
- **Readiness.** With the switch on, `host-deploy.sh check_stack` signs two
  60-second GoTrue-shaped tokens for the nil user inside the ERP container (which
  already holds the JWT secret) and requires 403 without the claim and a pass
  with it, from `http://kong:8000/rest/v1/`.

## Where 0006B left a choice, or could not be followed as written

1. **`pre-function`, not the `jwt` plugin.** Kong's `jwt` plugin needs the
   secret as a consumer credential in `kong.yml`, keys consumers on `iss`, and
   refuses requests without a token. Kong instead decodes and holds no secret:
   PostgREST, Storage and Realtime verify every token with the JWT secret, and the
   fork's edge dispatcher verifies HS256 before any worker runs, so a token whose
   claim was edited fails upstream. B8's assumption is verified for
   `pre-function`, with the sandbox's `cjson.safe`.
2. **900 s, not Q6's 600 s.** ERP and MES refresh a token once 600 s or less
   remain (`REFRESH_ACCESS_TOKEN_THRESHOLD` in `packages/env`, and a hard-coded
   10 minutes in `packages/auth`'s browser provider). At 600 s every request
   would refresh and every GET would redirect to itself. 900 s leaves 300 s
   between refreshes. Reaching 600 s needs the threshold scaled to the lifetime
   in those two shared files (an auth change to propose separately).
   `test_render.py` reads both constants and fails if the lifetime leaves less
   than 300 s.
3. **Carbon's server-signed tokens keep their routes.** 0006B assumed GoTrue
   issues every `authenticated` token. `getUserScopedClient` also signs
   five-minute `role: authenticated` tokens (no `session_id`, no `authz_api`) for
   MCP OAuth, `/api/v1` workforce calls, download links, the workflow engine and
   Inngest procurement dispatch. They are created and used on Carbon's server,
   never returned to a client, and only holders of the JWT secret can make one, so
   they are treated like `service_role` (Q5); RLS still applies, and the
   projection empties a disabled person's permissions. Requiring the claim of them
   needs `getUserScopedClient` to add it from authz (a shared-file change).
4. **Realtime's socket.** realtime-js 2.80.0 opens
   `/realtime/v1/websocket?apikey=<anon>` and sends the person's token inside the
   socket (`phx_join`), where Kong cannot see it. Kong checks the socket's
   `apikey` and gates `/realtime/v1/api`; channels stay gated by RLS alone.
5. **The switch is deployment config.** Kong cannot read
   `carbon_private.authz_projection.enabled`. The operator enables the projection
   first and waits one access-token lifetime, so every live token carries the
   claim; enabling Kong's check first refuses every signed-in browser request.

## Callers through the gateway that keep today's routes (Q5)

- `service_role`: ERP and MES servers (`getCarbonServiceRole`: user admin,
  `getUser`, session refresh, API-key rate limits, plan gates, RLS bypasses),
  Inngest functions (served by ERP), edge functions calling other functions
  (`reschedule` from `trigger-rework` and `issue`; `batch-operations`), and the
  ops container's seed (`http://kong:8000`).
- `anon`: the Realtime socket's `apikey`, API-key clients (anon plus
  `carbon-key`), Postgres `pg_net` calls (`event-wake`, `trigger`),
  `util.invoke_edge_function` without a caller token, the `model-thumbnail` job,
  and the readiness check's `event-wake`.
- Server-signed `authenticated` tokens: the five `getUserScopedClient` callers
  above.
- No credential: public storage objects and the `image-resizer` and
  `logo-resizer` uploads.

## Steps

- [x] Probe Kong 2.8.1's sandbox in the pinned image (globals, `cjson.safe`,
      repeated `Authorization` refused by nginx with 400, CORS on denials).
- [x] `authz_api_claim.py`, `auth/kong-authz-api.lua`, render and deploy
      validation, config example; `GOTRUE_JWT_EXP=900` in `hq_sign_in.py`.
- [x] Render tests: off-state and staged-input byte identity, fail-closed inputs,
      every route's rule, only the gateway changes, unclassifiable gateways refused,
      the refresh-window constraint; deploy validation; release planning
      (maintenance, apps unchanged).
- [x] Production-image tests: `auth/test_kong_authz_api.py` (rendered Kong, real
      GoTrue and hook, synthetic authz) covers 0006B Step 7's three Accept lines
      and every exemption; seven mutations of the Lua (each rule removed or
      weakened) each fail it. `test_callback_redirects.py` checks the 900 s
      lifetime at sign-in and refresh, and that two parallel refreshes with one
      refresh token both succeed with the same successor.
- [x] Readiness probe in `check_stack`, run against a gated and an ungated Kong
      2.8.1 (passes and fails respectively).
- [ ] Operator: `make deploy` after merge (HQ sign-in is on, so GoTrue's
      lifetime changes; maintenance is selected automatically).
- [ ] After HQ's seed gate and the projection: wait 15 minutes, set
      `AUTHZ_API_CLAIM_REQUIRED`, `make deploy`, then verify on the tailnet that
      a person without `api:supabase.storage` gets 403 from `/storage/v1/` and
      reaches it once granted (HQ plan 0006B Verification).

## Residual risk

- Resumable (TUS) uploads take the access token once. The browser refreshes once
  10 minutes or less remain, checking every minute, so its token has about 8 to
  15 minutes left (8 to 60 before): the worst case is unchanged, but long uploads
  now outlive their token more often, fail part-way and must be retried. A
  follow-up can give the upload a token getter.
- Each refresh runs the hook; sessions now refresh about every 5 minutes instead
  of about every 50. The hook's cost against HQ's real `authz` functions is
  measured when HQ provisions them (0006B Q6).
- Server-signed tokens and the Realtime socket are not gated by Kong (above).
- A grant or revoke reaches Kong at the next refresh: within 15 minutes, plus
  the projection's minute for Carbon's own permissions.
