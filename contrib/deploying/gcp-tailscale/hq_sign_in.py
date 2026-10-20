"""Optional sign-in through the HQ identity provider, with Google as break-glass.

HQ authenticates people with Google Workspace, applies its own app-entry policy,
and serves a Keycloak-compatible OpenID provider below ``<HQ_ISSUER>/oidc/keycloak``.
GoTrue's built-in Keycloak provider uses it with the authorization-code flow; the
token and userinfo calls go server to server over the tailnet, and the identity
comes only from userinfo. GoTrue records it as ``provider = 'keycloak'``.

HQ's origin is private configuration and the client secret is a deployment
secret mounted only into GoTrue. Google sign-in stays enabled unless
``GOOGLE_SIGN_IN_ENABLED`` is ``"false"``, which requires HQ sign-in, so a
deployment always keeps at least one way in. HQ's app gating applies only once
Google sign-in is off (cutover): until then a person HQ denies can still choose
Google. With HQ disabled the rendered stack is unchanged.

With HQ enabled, GoTrue also adopts HQ's session limits, so revoking someone in
HQ reaches Carbon: GoTrue refuses to refresh a session after the inactivity
timeout or the timebox, and Carbon then sends the person back through HQ.
Access tokens then live 15 minutes instead of an hour (HQ plan 0006B, B6 and
Q6), so once refreshes stop, or the token hook refuses a person authz has
disabled, API access ends within that lifetime. It cannot be shorter while
Carbon refreshes a token once 10 minutes or less remain
(``REFRESH_ACCESS_TOKEN_THRESHOLD`` and the browser's provider): at 10 minutes
every request would refresh and every page load would redirect to itself.

GoTrue copies HQ's userinfo claims, including ``hq_capabilities``, into user
metadata, which users can edit themselves. Those claims must never drive
authorization in Carbon; Carbon's roles and RLS stay authoritative.
"""

import re
import sys

CONFIG_KEYS = {"HQ_SIGN_IN_ENABLED", "HQ_ISSUER", "GOOGLE_SIGN_IN_ENABLED"}
SECRET_KEYS = {"HQ_OIDC_CARBON_SECRET"}
SECRET_NAME = "hq_oidc_carbon_secret"
CLIENT_ID = "carbon"
KEYCLOAK_PATH = "/oidc/keycloak"
ISSUER = re.compile(r"https://[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}")
MIN_SECRET_LENGTH = 32
# HQ's own session limits, as GoTrue v2.189.0 durations (GOTRUE_SESSIONS_*).
SESSION_TIMEBOX = "12h"
SESSION_INACTIVITY_TIMEOUT = "2h"
# GoTrue's access-token lifetime in seconds (GOTRUE_JWT_EXP; the template's is
# 3600). Carbon refreshes with 600 s left, so this leaves 300 s between refreshes.
ACCESS_TOKEN_LIFETIME = "900"
GATING_WARNING = (
    "Warning: HQ and Google sign-in are both enabled. HQ's app gating applies only once "
    "Google sign-in is off (cutover); until then a person HQ denies can still sign in with Google."
)


def _flag(config, key, default):
    value = config.get(key, default)
    if value not in ("true", "false"):
        raise ValueError(f"{key} must be true or false")
    return value == "true"


def validate(config):
    """Return (hq_enabled, google_enabled). Error messages never echo a value."""
    hq = _flag(config, "HQ_SIGN_IN_ENABLED", "false")
    google = _flag(config, "GOOGLE_SIGN_IN_ENABLED", "true")
    issuer = config.get("HQ_ISSUER", "")
    if not isinstance(issuer, str) or (issuer and not ISSUER.fullmatch(issuer)):
        raise ValueError("Invalid HQ_ISSUER; use the HQ origin, https://<host>, with no path or trailing slash")
    secret = config.get("HQ_OIDC_CARBON_SECRET", "")
    if not isinstance(secret, str) or len(secret) > 4096 or any(ord(c) < 33 or ord(c) == 127 for c in secret):
        raise ValueError("Invalid HQ_OIDC_CARBON_SECRET; use a single-line private value without spaces")
    if secret.startswith("replace-"):
        raise ValueError("HQ_OIDC_CARBON_SECRET is still the example placeholder; supply the secret or remove the key")
    if hq:
        if not issuer:
            raise ValueError("Set HQ_ISSUER before enabling HQ sign-in")
        if len(secret) < MIN_SECRET_LENGTH:
            raise ValueError(f"Supply HQ_OIDC_CARBON_SECRET (at least {MIN_SECRET_LENGTH} characters) before enabling HQ sign-in")
    if not hq and not google:
        raise ValueError("GOOGLE_SIGN_IN_ENABLED=false requires HQ_SIGN_IN_ENABLED=true; keep at least one sign-in method")
    return hq, google


def auth_providers(config):
    """Carbon's AUTH_PROVIDERS for ERP and MES: "google", "hq,google" or "hq"."""
    hq, google = validate(config)
    return ",".join(name for name, enabled in (("hq", hq), ("google", google)) if enabled)


def google_enabled(config):
    return "true" if validate(config)[1] else "false"


def configure(config, auth, directory, write_private):
    """Add the HQ provider to the serving GoTrue only.

    Call this after the bootstrap GoTrue copy is made: bootstrap never enables an
    OAuth provider and never mounts the client secret.
    """
    hq, google = validate(config)
    if not hq:
        return
    if google:
        print(GATING_WARNING, file=sys.stderr)
    path = directory / SECRET_NAME
    # The renderer's writer leaves the file 0444 in the root-only secrets directory.
    write_private(path, config["HQ_OIDC_CARBON_SECRET"])
    auth["secrets"].append(SECRET_NAME)
    auth["environment"].update({
        "GOTRUE_EXTERNAL_KEYCLOAK_ENABLED": "true",
        "GOTRUE_EXTERNAL_KEYCLOAK_CLIENT_ID": CLIENT_ID,
        "GOTRUE_EXTERNAL_KEYCLOAK_SECRET": "__HQ_OIDC_CARBON_SECRET__",
        "GOTRUE_EXTERNAL_KEYCLOAK_URL": config["HQ_ISSUER"] + KEYCLOAK_PATH,
        # Same callback as Google; GoTrue's URI allow list is unchanged.
        "GOTRUE_EXTERNAL_KEYCLOAK_REDIRECT_URI": "https://" + config["SUPABASE_HOST"] + "/auth/v1/callback",
        # Apply to every session on this GoTrue, Google break-glass included:
        # a refresh past either limit is refused and the person signs in again.
        "GOTRUE_SESSIONS_TIMEBOX": SESSION_TIMEBOX,
        "GOTRUE_SESSIONS_INACTIVITY_TIMEOUT": SESSION_INACTIVITY_TIMEOUT,
        # Revocation reaches the API within one access-token lifetime.
        "GOTRUE_JWT_EXP": ACCESS_TOKEN_LIFETIME,
    })
