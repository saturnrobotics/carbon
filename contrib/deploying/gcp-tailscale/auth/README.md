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
`hq_capabilities` is recorded but not used yet: Carbon's own roles stay
authoritative.

The login page shows **Sign in with HQ** whenever `hq` is enabled. When it is the
only provider, a visitor sent to `/login` from a protected page (the URL carries
`redirectTo`) starts HQ sign-in automatically. A plain `/login`, such as the
page after signing out, shows the button instead of signing straight back in,
and a second automatic start in the same tab within a minute is skipped so a
refused sign-in cannot loop.

For user offboarding, deactivate the Carbon account and revoke its Supabase
sessions as well as disabling its Google Workspace account and removing their HQ
access. Supabase refreshes its own sessions without contacting Google or HQ on
every refresh. Existing access tokens remain valid until their configured
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
and refusals for another workspace and an unverified email. A real Google and HQ
sign-in from the tailnet remains a required deployment acceptance check.

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
