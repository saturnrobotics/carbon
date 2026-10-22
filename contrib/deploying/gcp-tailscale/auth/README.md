# Workspace authentication policy

The deployment enables only OAuth sign-in in GoTrue: Google Workspace, and
optionally the HQ identity provider through GoTrue's built-in Keycloak provider
(`provider = 'keycloak'`). Carbon's `AUTH_PROVIDERS` is `google`, `hq,google`
or `hq` to match. The application hides its email form and rejects email
login/signup actions when that provider is disabled. The database hook enforces
the access restriction before GoTrue issues tokens, including tokens requested
directly from Supabase.

`google-domain-hook.sql` installs a private deployment policy outside Carbon's
application migrations. It keeps its Google name because GoTrue's hook URI and
the release tooling refer to it. After GoTrue initializes its `auth` schema, and
before enabling login, apply it as the database administrator:

```sh
psql -X -v ON_ERROR_STOP=1 \
  -v allowed_email_domain="$AUTH_ALLOWED_GOOGLE_DOMAIN" \
  -f auth/google-domain-hook.sql
```

The deployment obtains that value from private configuration. The script is
transactional and repeatable. It never modifies application tables. The private
schema is excluded from PostgREST, and client roles cannot read its configuration
or execute its hook. Only `supabase_auth_admin` can invoke the hook; it cannot
change the policy.

Enable these GoTrue settings after installation:

```dotenv
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/carbon_private/google_domain_access_token
GOTRUE_EXTERNAL_GOOGLE_ENABLED=true   # false after the HQ cutover
GOTRUE_EXTERNAL_KEYCLOAK_ENABLED=true # only with HQ sign-in; see hq_sign_in.py
GOTRUE_EXTERNAL_EMAIL_ENABLED=false
GOTRUE_EXTERNAL_PHONE_ENABLED=false
GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false
GOTRUE_EXTERNAL_AZURE_ENABLED=false
GOTRUE_SAML_ENABLED=false
GOTRUE_DISABLE_SIGNUP=false
```

Keep **every other OAuth provider disabled**. Supabase's session authentication
method records OAuth (`amr` method `oauth`) without identifying which provider
authenticated that session. The hook therefore relies on Google and the HQ
Keycloak-compatible provider being the only enabled OAuth providers, and admits
an account holding a qualifying identity from either of them. The Google OAuth
application's audience must also be **Internal** within the Google Workspace
organization. This is a required second boundary, configured in Google Auth
Platform, not a browser `hd` hint.

The hook requires all of the following:

- An OAuth session, including its later token refresh and TOTP challenges.
- An exact match between the token's subject/email and the Supabase account,
  whose email is confirmed and on the configured domain.
- A `google` or `keycloak` identity with a verified email (JSON `true`)
  matching the account.
- The configured email domain and that identity's `custom_claims.hd` matching
  exactly. Consumer accounts, other domains and subdomains are rejected.

It reads trusted `auth.identities.identity_data`, never client-writable user
metadata. Empty configuration and missing claims fail closed. It preserves
Carbon's token claims, company membership and RLS behavior. First authorized
login can create a user; Carbon's existing ERP onboarding creates the
company. Further users still need company membership to access its records.
An invite's email link is not a login bypass: invited users sign in through an
enabled provider.

## Sign-in through HQ

HQ authenticates people with Google Workspace, decides whether they may enter
ERP or MES, and serves a Keycloak-compatible OpenID provider below
`<HQ_ISSUER>/oidc/keycloak`. GoTrue v2.189.0's Keycloak provider:

- sends the browser to `{URL}/protocol/openid-connect/auth` with
  `client_id=carbon`, `response_type=code`, `redirect_uri` set to the Supabase
  callback, `state`, and `scope` built from `profile email` plus any scopes the
  caller passes (Carbon passes `profile email`, so the scope repeats them). It
  sends no PKCE challenge and no nonce, and forwards unrecognized authorize
  parameters such as `redirect_to` unchanged;
- exchanges the code server to server at `{URL}/protocol/openid-connect/token`
  with the client secret, then reads `{URL}/protocol/openid-connect/userinfo`.
  The identity comes only from userinfo; any ID token is ignored;
- stores `sub`, `email`, `email_verified` (which must be a JSON boolean) and
  `name`, and keeps every other userinfo claim, such as `hd` and
  `hq_capabilities`, under `identity_data.custom_claims`.

GoTrue links identities automatically: a sign-in whose verified email matches an
existing account in its default linking domain (not an SSO account) adds the
`keycloak` identity to that account. An employee who has only signed in with
Google therefore gains an HQ identity on their first HQ sign-in, keeping their
Carbon user and memberships; nothing needs to be pre-seeded. Carbon's ERP and MES
callbacks match the account by email and do not check the provider.

GoTrue also copies HQ's userinfo claims, including `hq_capabilities`, into the
user's metadata, which users can edit themselves. `hq_capabilities` must
**never** drive authorization in Carbon: Carbon's roles, permissions and RLS stay
authoritative, and this hook reads only `auth.identities`, never user metadata.

**HQ's app gating applies only once Google sign-in is off (cutover).** While
Google stays enabled as break-glass, a person HQ denies can still choose
**Sign in with Google** and pass this hook if their Workspace account qualifies.
Rendering prints a warning while both are enabled.

With HQ enabled, GoTrue adopts HQ's session limits for every session it issues,
Google's included: `GOTRUE_SESSIONS_TIMEBOX=12h` and
`GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=2h`. GoTrue refuses to refresh a session
older than 12 hours or idle (unrefreshed) for 2 hours, and Carbon then clears its
cookie and sends the person back through `/login`, where HQ decides again. A
revocation in HQ therefore reaches Carbon within the 2-hour inactivity timeout
for an idle person, and at most 12 hours after sign-in for an active one, plus
the remaining life of the last access token (up to `GOTRUE_JWT_EXP`, which HQ
sign-in lowers from one hour to 15 minutes; ERP and MES refresh a token once 10
minutes or less remain, so it cannot be shorter).
Enabling HQ also ends existing sessions older than 12 hours at their next
refresh.

The login page shows **Sign in with HQ** whenever `hq` is enabled. When it is the
only provider, a visitor sent to `/login` from a protected page (the URL carries
`redirectTo`) starts HQ sign-in automatically. A plain `/login`, such as the
page after signing out, shows the button instead of signing straight back in,
and a second automatic start in the same tab within a minute is skipped so a
refused sign-in cannot loop.

For user offboarding, deactivate the Carbon account and revoke its Supabase
sessions as well as disabling its Google Workspace account and removing their HQ
access. Supabase refreshes its own sessions without contacting Google or HQ on
every refresh; only the session limits above bound how long a revoked person
keeps a session. Existing access tokens remain valid until their configured
expiry.

The tested GoTrue version is `supabase/gotrue:v2.189.0`. Its
[Google OIDC parser](https://github.com/supabase/auth/blob/v2.189.0/internal/api/provider/oidc.go)
preserves the validated `hd` claim as `custom_claims.hd`; its
[Keycloak provider](https://github.com/supabase/auth/blob/v2.189.0/internal/api/provider/keycloak.go)
keeps non-standard userinfo claims the same way; the
[OAuth callback](https://github.com/supabase/auth/blob/v2.189.0/internal/api/external.go)
stores provider email and verification in identity data, and
[account linking](https://github.com/supabase/auth/blob/v2.189.0/internal/models/linking.go)
decides when a new identity joins an existing account.
Supabase documents
[custom access-token hook inputs](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook)
and [self-hosted hook configuration](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-hooks).
Recheck those contracts before upgrading GoTrue.

Run the SQL regression suite with PostgreSQL's `initdb`, `pg_ctl` and `psql` on
`PATH`:

```sh
python3 contrib/deploying/gcp-tailscale/auth/test_google_domain_hook.py
```

The tests execute the installed hook as `supabase_auth_admin` in a temporary
cluster listening only on its own Unix socket. They exercise valid Google and HQ
login, refresh and MFA, domain/identity spoofing, non-OAuth methods, other
providers, missing claims, policy changes, repeatable installation and database
privileges. They do not connect to the application's database.

`test_callback_redirects.py` (Docker and PyYAML) runs the rendered production
GoTrue image with HQ sign-in enabled against a synthetic Keycloak-compatible
provider and the real hook: the authorize redirect, the server-to-server code
exchange, a new member's identity record, linking to an existing Google account,
refusals for another workspace and an unverified email, and refreshes refused
past the session timebox and inactivity timeout. A real Google and HQ
sign-in from the tailnet remains a required deployment acceptance check.

## Permissions managed by HQ

HQ's authz service (`hq-authz`, schema `authz` on the same Postgres) can become
the source of Carbon's permissions. Migration
`*_saturn-authz-projection.sql` adds the receiver and the lock, both off until
the operator turns them on after HQ's seed gate passes (authz's projection
equals `userPermission` for every seeded user):

```sql
-- as the database administrator; the origin is a private value
UPDATE carbon_private.authz_projection
   SET enabled = true, hq_origin = 'https://<HQ host>'
 WHERE singleton;
```

Once on:

- Every minute the Inngest job `saturn-authz-projection` sets each workforce
  user's `userPermission` row (users with a `google` or `keycloak` identity) to
  `authz.carbon_permissions(authz.subject_of_auth_user(<user>))`, writing only
  rows that differ, and then deletes those users' cached claims
  (`permissions:<uid>`) once Redis confirms. Unknown or disabled people get `{}`.
  Customers, suppliers and console operators are never projected.
- Guard triggers on `userPermission`, `employeeType` and
  `employeeTypePermission` refuse every other write with SQLSTATE 42501 ("Carbon
  permissions are managed by HQ"); deletes pass, and a new `userPermission` row
  (GoTrue's `create_public_user`) is written as the projection. Upstream
  migrations that edit permissions fail too; re-express them as authz seed
  changes. Turning the lock off restores Carbon's own editing.
- The ERP permission screens show what Carbon holds, read-only, with a link to
  `<HQ origin>/admin/access`; their actions, and the API/MCP employee-type
  tools, refuse.
- This hook adds a top-level `authz_api` claim (the `api:` resources authz
  grants, from `authz.capabilities(subject, 'api')`, never from user metadata)
  and refuses a token for a person authz does not know or has disabled.
- Once every live token carries the claim (one access-token lifetime after
  enabling), the deployment's `AUTHZ_API_CLAIM_REQUIRED` makes Kong require it
  per route: `api:supabase.rest`, `.storage`, `.realtime` and `.functions` for
  `/rest/v1/`, `/storage/v1/`, `/realtime/v1/` and `/functions/v1/`. See
  [API access managed by HQ](../README.md#api-access-managed-by-hq-optional).

HQ grants `carbon_authz_applier` EXECUTE (and USAGE on schema `authz`) on
`authz.subject_of_auth_user(uuid)`, `authz.carbon_permissions(text)` and
`authz.epoch()`, and `supabase_auth_admin` on `authz.subject_of_auth_user(uuid)`
and `authz.capabilities(text, text)`. Carbon grants authz's roles the
`carbon_private` functions listed in the migration's header, and `authz_owner`
alone `carbon_private.authz_identities()` (migration
`20261020154924_saturn-authz-identities`): `authz.subject_of_auth_user` reads a
user's `google` and `keycloak` identities through it, because GoTrue's
`auth.identities` has row level security on and no policy, so a grant on the
table reads nothing.

`packages/database/supabase/tests/saturn-authz-projection.test.sql` covers the
receiver, the lock and the grants on a migrated local database,
`saturn-authz-identities.test.sql` the identities reader; this directory's hook
suite covers the claim. `test_kong_authz_api.py` (Docker and
PyYAML) runs the rendered Kong in front of the rendered GoTrue, the real hook and
synthetic `authz` functions: storage answers 403 without `api:supabase.storage`
and is reached with it; grants and revokes take effect at the next refresh;
`authz_api` written into user metadata changes nothing; a disabled person cannot
refresh; anon, service_role and server-signed tokens keep their routes; every
credential location is checked; denials keep CORS headers.

`test_kong_storage_gate.py` (Docker and PyYAML) runs the rendered Kong in front
of a stub Storage that reports the path it received: Carbon's storage requests
reach Storage unchanged; the S3 protocol and signed resumable uploads are refused
in every spelling (percent-encoded, double-encoded, case, dot segments, duplicate
slashes, absolute-form targets); resumable uploads need a bearer, including an
OPTIONS request with a method override; denials keep CORS headers and
preflights pass. With the `authz_api` claim on, the gate runs first.

## Edge function boundary

The deployment mounts `edge-main/` instead of the development dispatcher. It
verifies the HS256 signature and expiry of Supabase bearer tokens **before**
creating any function worker, preventing forged `service_role` claims from
reaching functions that decode their caller's token. The shared permissions
helper also binds an authenticated user's permission lookup to that token's
subject. Service calls retain their existing behavior after verification.

The dispatcher sets the function import map explicitly and limits CORS to the
configured ERP/MES origins. OPTIONS returns preflight headers without executing
a worker. Its only bearer exceptions are the existing `image-resizer` and
`logo-resizer` POST uploads: these functions transform the submitted bytes and
do not read application data. They still require Tailscale network access.
The signed anon token can call only `event-wake`, matching Carbon's existing
database queue trigger. Every other function requires a signed authenticated
or service-role token.

With Node 22+ and workspace dependencies installed, exercise the dispatcher and
the real shared permission helper against a local PostgREST stub:

```sh
node --experimental-strip-types --test \
  contrib/deploying/gcp-tailscale/auth/test_edge_dispatcher.mjs
```

No external account or database is used. These tests cover signature/algorithm
forgery, token expiry, role validation, CORS, restricted anonymous access,
worker error sanitization, and attempts to request another user's permissions.
